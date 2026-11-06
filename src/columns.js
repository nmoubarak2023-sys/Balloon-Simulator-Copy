// Roof queries and collision candidates use the actual edited mesh surfaces.
export function roofSampler(raw, cellSize = 5) {
  const bins = new Map(),
    p = raw.positions,
    ids = raw.indices;
  const key = (x, y) => `${x}:${y}`;
  for (let i = 0; i < ids.length; i += 3) {
    const a = Array.from(p.slice(ids[i] * 3, ids[i] * 3 + 3)),
      b = Array.from(p.slice(ids[i + 1] * 3, ids[i + 1] * 3 + 3)),
      c = Array.from(p.slice(ids[i + 2] * 3, ids[i + 2] * 3 + 3));
    const d = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (d <= 1e-10) continue;
    const t = { a, b, c, d };
    for (
      let x = Math.floor(Math.min(a[0], b[0], c[0]) / cellSize);
      x <= Math.floor(Math.max(a[0], b[0], c[0]) / cellSize);
      x++
    )
      for (
        let y = Math.floor(Math.min(a[1], b[1], c[1]) / cellSize);
        y <= Math.floor(Math.max(a[1], b[1], c[1]) / cellSize);
        y++
      ) {
        const k = key(x, y);
        if (!bins.has(k)) bins.set(k, []);
        bins.get(k).push(t);
      }
  }
  return (x, y) => {
    let z = -Infinity;
    for (const { a, b, c, d } of bins.get(
      key(Math.floor(x / cellSize), Math.floor(y / cellSize)),
    ) || []) {
      const u = ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / d;
      const v = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / d;
      if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7)
        z = Math.max(z, a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
    }
    return Number.isFinite(z) ? z : null;
  };
}
export function collisionSites(result) {
  const { raw, spheres, params } = result,
    floor = params.floor;
  const sample = roofSampler(raw),
    native = spheres.map((s) => (s.raw ? roofSampler(s.raw) : null));
  const owner = (x, y) => {
    let best = -Infinity,
      id = -1;
    spheres.forEach((s, i) => {
      const q =
        s.radius * s.radius - (x - s.center[0]) ** 2 - (y - s.center[1]) ** 2;
      const z = native[i]
        ? native[i](x, y)
        : q >= 0
          ? s.center[2] + Math.sqrt(q)
          : -Infinity;
      if (z !== null && z > best) {
        best = z;
        id = i;
      }
    });
    return id;
  };
  const p = raw.positions,
    ids = raw.indices,
    owners = new Map(),
    candidates = [];
  const at = (i) => Array.from(p.slice(i * 3, i * 3 + 3));
  for (let k = 0; k < ids.length; k += 3) {
    const ii = Array.from(ids.slice(k, k + 3)),
      v = ii.map(at);
    const area =
      (v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) -
      (v[1][1] - v[0][1]) * (v[2][0] - v[0][0]);
    if (area <= 1e-9 || Math.max(...v.map((v) => v[2])) <= floor + 1e-5)
      continue;
    const oo = ii.map((i, j) => {
      if (!owners.has(i)) owners.set(i, owner(v[j][0], v[j][1]));
      return owners.get(i);
    });
    const unique = [...new Set(oo)].filter((i) => i >= 0).sort((a, b) => a - b);
    if (unique.length < 2) continue;
    const x = v.reduce((s, v) => s + v[0], 0) / 3,
      y = v.reduce((s, v) => s + v[1], 0) / 3,
      z = sample(x, y);
    if (z === null || z <= floor + params.spacing * 0.5) continue;
    candidates.push({
      x,
      y,
      z,
      kind: unique.length >= 3 ? "junction" : "seam",
      balloons: unique.map((i) => result.ids[i]),
      key: unique.join(":"),
    });
  }
  // Junctions first, then low points along each visible collision seam.
  candidates.sort(
    (a, b) =>
      (a.kind === "junction" ? 0 : 1) - (b.kind === "junction" ? 0 : 1) ||
      a.z - b.z,
  );
  const sites = [],
    separation = Math.max(params.spacing * 2, params.width / 20);
  for (const c of candidates) {
    if (sites.some((s) => Math.hypot(s.x - c.x, s.y - c.y) < separation))
      continue;
    sites.push({ ...c, id: sites.length });
    if (sites.length >= 200) break;
  }
  return sites;
}
// Cubic meridian: vertical at the foot, tangent to the canopy at the rim.
export function trumpetProfile(
  t,
  bottomRadius,
  topRadius,
  height,
  roofSlope,
  blend,
) {
  const delta = topRadius - bottomRadius,
    r2 = bottomRadius + delta * (0.2 + 0.3 * (1 - blend));
  const z1 = height * (0.45 + 0.25 * blend),
    z2 = height - roofSlope * (topRadius - r2),
    q = 1 - t;
  return [
    q * q * q * bottomRadius +
      3 * q * q * t * bottomRadius +
      3 * q * t * t * r2 +
      t * t * t * topRadius,
    3 * q * q * t * z1 + 3 * q * t * t * z2 + t * t * t * height,
  ];
}
export function columnMesh(source, site, settings) {
  const floor = source.params.floor,
    sample = roofSampler(source.raw),
    { radius, flare, blend } = settings;
  const bottomRadius = settings.bottomRadius ?? radius;
  if (
    ![radius, flare, blend, bottomRadius].every(Number.isFinite) ||
    bottomRadius <= 0 ||
    radius <= 0 ||
    flare < radius ||
    blend <= 0 ||
    blend >= 1
  )
    throw Error("Check column radius, flare radius and blend height.");
  const top = sample(site.x, site.y);
  if (top === null || top - floor < radius * 0.5)
    throw Error("This collision has insufficient height for a column.");
  // Contract the flare near footprint edges rather than extending beyond the roof.
  let reach = flare;
  const sides = 64,
    regularRows = 64;
  const outline = () =>
    Array.from({ length: sides }, (_, i) => {
      const a = (i * 2 * Math.PI) / sides;
      return sample(site.x + reach * Math.cos(a), site.y + reach * Math.sin(a));
    });
  let heights = outline();
  for (
    let i = 0;
    i < 30 && heights.some((z) => z === null || z <= floor + 1e-5);
    i++
  ) {
    reach *= 0.85;
    heights = outline();
  }
  if (reach < 0.1 || heights.some((z) => z === null || z <= floor + 1e-5))
    throw Error(
      "Too close to the footprint edge. Reduce shaft and flare radii.",
    );
  const p = [],
    idx = [],
    rows = regularRows;
  const capRings = 16;
  const slopes = heights.map((height, i) => {
    const a = (i * 2 * Math.PI) / sides,
      inner = (reach * (capRings - 1)) / capRings;
    const inside = sample(
      site.x + inner * Math.cos(a),
      site.y + inner * Math.sin(a),
    );
    if (inside === null)
      throw Error("The canopy crosses the footprint. Reduce the top radius.");
    return (height - inside) / (reach - inner);
  });
  for (let j = 0; j <= rows; j++) {
    const t = j / rows;
    for (let i = 0; i < sides; i++) {
      const a = (i * 2 * Math.PI) / sides;
      const [r, h] = trumpetProfile(
        t,
        bottomRadius,
        reach,
        heights[i] - floor,
        slopes[i],
        blend,
      );
      const x = site.x + r * Math.cos(a),
        y = site.y + r * Math.sin(a),
        roof = sample(x, y);
      if (roof === null)
        throw Error(
          "Column crosses the roof footprint. Reduce the bottom or top radius.",
        );
      const z = floor + h;
      if (z > roof + 1e-5 || z < floor - 1e-5)
        throw Error(
          "The roof is too steep for this smooth blend. Reduce the top radius or curvature.",
        );
      p.push(x, y, z);
    }
  }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < sides; i++) {
      const a = j * sides + i,
        b = j * sides + ((i + 1) % sides),
        c = b + sides,
        d = a + sides;
      idx.push(a, b, c, a, c, d);
    }
  // Sample the roof across the entire cap instead of fanning a flat disc.
  let outer = rows * sides;
  for (let ring = capRings - 1; ring >= 1; ring--) {
    const inner = p.length / 3,
      r = (reach * ring) / capRings;
    for (let i = 0; i < sides; i++) {
      const a = (i * 2 * Math.PI) / sides,
        x = site.x + r * Math.cos(a),
        y = site.y + r * Math.sin(a),
        z = sample(x, y);
      if (z === null)
        throw Error("The canopy crosses the footprint. Reduce the top radius.");
      p.push(x, y, z);
    }
    for (let i = 0; i < sides; i++) {
      const n = (i + 1) % sides;
      idx.push(
        outer + i,
        outer + n,
        inner + n,
        outer + i,
        inner + n,
        inner + i,
      );
    }
    outer = inner;
  }
  const bottom = p.length / 3;
  p.push(site.x, site.y, floor);
  const cap = p.length / 3;
  p.push(site.x, site.y, top);
  for (let i = 0; i < sides; i++) {
    const n = (i + 1) % sides;
    idx.push(bottom, n, i, cap, outer + i, outer + n);
  }
  return {
    positions: new Float64Array(p),
    indices: new Uint32Array(idx),
    effectiveFlare: reach,
    rings: rows + 1,
    sides,
  };
}
