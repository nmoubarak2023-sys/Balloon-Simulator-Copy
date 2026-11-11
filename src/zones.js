import cdt2d from "cdt2d";
export const polygonArea = (p) =>
  p.reduce((s, a, i) => {
    const b = p[(i + 1) % p.length];
    return s + a[0] * b[1] - b[0] * a[1];
  }, 0) / 2;
export function inLoops(p, loops) {
  let hit = false;
  for (const loop of loops)
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i],
        b = loop[j];
      if (
        a[1] > p[1] !== b[1] > p[1] &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
      )
        hit = !hit;
    }
  return hit;
}
export function loopBounds(loops) {
  const ps = loops.flat(),
    min = [Infinity, Infinity],
    max = [-Infinity, -Infinity];
  for (const p of ps)
    for (let k = 0; k < 2; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  return { min, max, width: max[0] - min[0], height: max[1] - min[1] };
}
const edgeKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export function partitionCurves(
  curves,
  { elevation = 0, sourceName = "Rhino curves", tolerance } = {},
) {
  if (!Array.isArray(curves) || !curves.length || curves.length > 200)
    throw Error(
      "Import 1–200 planar Rhino curves, including one closed perimeter.",
    );
  for (const c of curves)
    if (
      !Array.isArray(c.points) ||
      c.points.length < 2 ||
      c.points.some(
        (p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite),
      )
    )
      throw Error("Invalid boundary curve coordinates.");
  const closed = curves
    .filter((c) => c.closed && c.points.length >= 3)
    .sort(
      (a, b) =>
        Math.abs(polygonArea(b.points)) - Math.abs(polygonArea(a.points)),
    );
  if (!closed.length)
    throw Error(
      "No closed outer perimeter found. Join and close the perimeter in Rhino.",
    );
  const perimeter = closed[0].points.map((p) => p.slice()),
    bounds = loopBounds([perimeter]);
  if (bounds.width <= 0 || bounds.height <= 0)
    throw Error("The perimeter has no usable area.");
  const tol =
    tolerance ?? Math.max(1e-6, Math.max(bounds.width, bounds.height) * 1e-6);
  const segs = [];
  for (const c of curves) {
    const p = c.points;
    for (let i = 0; i < p.length - (c.closed ? 0 : 1); i++) {
      const a = p[i],
        b = p[(i + 1) % p.length];
      if (Math.hypot(...sub(a, b)) > tol) segs.push({ a, b, ts: [0, 1] });
    }
  }
  if (segs.length > 6000)
    throw Error(
      "Boundary curves are too detailed. Simplify them in Rhino before importing.",
    );
  function add(s, t) {
    if (t >= -1e-8 && t <= 1 + 1e-8) s.ts.push(Math.max(0, Math.min(1, t)));
  }
  function project(p, s) {
    const d = sub(s.b, s.a),
      t =
        ((p[0] - s.a[0]) * d[0] + (p[1] - s.a[1]) * d[1]) /
        (d[0] * d[0] + d[1] * d[1]);
    const q = [s.a[0] + t * d[0], s.a[1] + t * d[1]];
    return { t, d: Math.hypot(...sub(q, p)) };
  }
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i],
        b = segs[j];
      if (
        Math.max(a.a[0], a.b[0]) + tol < Math.min(b.a[0], b.b[0]) ||
        Math.max(b.a[0], b.b[0]) + tol < Math.min(a.a[0], a.b[0]) ||
        Math.max(a.a[1], a.b[1]) + tol < Math.min(b.a[1], b.b[1]) ||
        Math.max(b.a[1], b.b[1]) + tol < Math.min(a.a[1], a.b[1])
      )
        continue;
      const u = sub(a.b, a.a),
        v = sub(b.b, b.a),
        w = sub(b.a, a.a),
        d = cross(u, v);
      if (Math.abs(d) > 1e-12 * Math.hypot(...u) * Math.hypot(...v)) {
        const t = cross(w, v) / d,
          q = cross(w, u) / d;
        if (t >= 0 && t <= 1 && q >= 0 && q <= 1) {
          add(a, t);
          add(b, q);
        }
      }
      for (const p of [a.a, a.b]) {
        const q = project(p, b);
        if (q.d <= tol && q.t >= 0 && q.t <= 1) add(b, q.t);
      }
      for (const p of [b.a, b.b]) {
        const q = project(p, a);
        if (q.d <= tol && q.t >= 0 && q.t <= 1) add(a, q.t);
      }
    }
  const points = [],
    buckets = new Map();
  function vertex(p) {
    const gx = Math.floor(p[0] / tol),
      gy = Math.floor(p[1] / tol);
    for (let x = gx - 1; x <= gx + 1; x++)
      for (let y = gy - 1; y <= gy + 1; y++)
        for (const i of buckets.get(`${x}:${y}`) ?? [])
          if (Math.hypot(...sub(points[i], p)) <= tol) return i;
    const id = points.length;
    points.push(p);
    const k = `${gx}:${gy}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(id);
    return id;
  }
  const edges = new Map();
  for (const s of segs) {
    s.ts.sort((a, b) => a - b);
    for (let j = 1; j < s.ts.length; j++) {
      const at = (t) => [
          s.a[0] + t * (s.b[0] - s.a[0]),
          s.a[1] + t * (s.b[1] - s.a[1]),
        ],
        a = vertex(at(s.ts[j - 1])),
        b = vertex(at(s.ts[j]));
      if (a !== b) edges.set(edgeKey(a, b), [a, b]);
    }
  }
  let tris;
  try {
    tris = cdt2d(points, [...edges.values()], {
      exterior: true,
      interior: true,
    }).filter((t) =>
      inLoops(
        [
          t.reduce((s, i) => s + points[i][0], 0) / 3,
          t.reduce((s, i) => s + points[i][1], 0) / 3,
        ],
        [perimeter],
      ),
    );
  } catch {
    throw Error(
      "Could not form zones. Repair intersecting or nearly overlapping curves in Rhino.",
    );
  }
  if (!tris.length)
    throw Error(
      "The perimeter could not be filled. Check for self intersections.",
    );
  const parent = tris.map((_, i) => i),
    root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i]))),
    adj = new Map();
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(t[k], t[(k + 1) % 3]);
      if (adj.has(key) && !edges.has(key)) parent[root(i)] = root(adj.get(key));
      else adj.set(key, i);
    }
  });
  const groups = new Map();
  tris.forEach((t, i) => {
    const r = root(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  });
  let zones = [];
  for (const group of groups.values()) {
    const boundaryEdges = new Map();
    let area = 0,
      cx = 0,
      cy = 0;
    for (let t of group) {
      let a = polygonArea(t.map((i) => points[i]));
      if (a < 0) {
        t = [t[0], t[2], t[1]];
        a = -a;
      }
      area += a;
      cx += (a * t.reduce((s, i) => s + points[i][0], 0)) / 3;
      cy += (a * t.reduce((s, i) => s + points[i][1], 0)) / 3;
      for (let k = 0; k < 3; k++) {
        const u = t[k],
          v = t[(k + 1) % 3],
          key = edgeKey(u, v);
        if (boundaryEdges.has(key)) boundaryEdges.delete(key);
        else boundaryEdges.set(key, [u, v]);
      }
    }
    if (area <= tol * tol) continue;
    const next = new Map([...boundaryEdges.values()]);
    const loops = [];
    while (next.size) {
      const start = next.keys().next().value,
        loop = [];
      let at = start;
      for (let guard = 0; guard <= boundaryEdges.size; guard++) {
        loop.push(points[at]);
        const to = next.get(at);
        next.delete(at);
        if (to === undefined)
          throw Error(
            "A zone has an open boundary. Join its endpoints in Rhino.",
          );
        at = to;
        if (at === start) break;
      }
      if (at !== start) throw Error("A zone boundary could not be closed.");
      loops.push(loop);
    }
    zones.push({ loops, area, center: [cx / area, cy / area] });
  }
  zones.sort((a, b) => b.center[1] - a.center[1] || a.center[0] - b.center[0]);
  const sum = zones.reduce((s, z) => s + z.area, 0),
    outerArea = Math.abs(polygonArea(perimeter));
  if (Math.abs(sum - outerArea) > Math.max(tol * outerArea, 1e-5))
    throw Error(
      "Zones do not cover the perimeter consistently. Repair the boundary curves.",
    );
  let fragmentWarning;
  if (zones.length > 20 && closed.length === curves.length) {
    // Independently sampled closed outlines can leave slivers along shared edges.
    const substantial = zones.filter((zone) => zone.area > outerArea * 0.0003);
    const fragmentArea =
      sum - substantial.reduce((area, zone) => area + zone.area, 0);
    if (substantial.length && fragmentArea <= outerArea * 0.001) {
      fragmentWarning =
        "Ignored " +
        (zones.length - substantial.length) +
        " tiny fragments along shared curve edges.";
      zones = substantial;
    }
  }
  if (zones.length > 20)
    throw Error(`Detected ${zones.length} zones. Use no more than 20 zones per perimeter.`);
  return {
    perimeter,
    dividers: curves
      .filter((c) => c !== closed[0])
      .map((c) => ({ points: c.points, closed: !!c.closed })),
    zones: zones.map((z, i) => ({ ...z, id: i, name: `Zone ${i + 1}` })),
    bounds,
    elevation,
    tolerance: tol,
    sourceName,
    units: "feet",
    warnings: fragmentWarning
      ? [fragmentWarning]
      : curves.length > 1 && zones.length === 1
        ? [
            "Divider curves do not close any zones. Snap their endpoints to the perimeter or to another divider in Rhino.",
          ]
        : [],
  };
}
export function demoBoundary() {
  return partitionCurves(
    [
      {
        closed: true,
        points: [
          [0, 0],
          [60, 0],
          [80, 15],
          [72, 42],
          [58, 50],
          [25, 46],
          [0, 30],
        ],
      },
      {
        points: [
          [0, 30],
          [72, 42],
        ],
      },
      {
        points: [
          [35, 0],
          [35, 36],
        ],
      },
    ],
    { sourceName: "Example floor perimeter and zones" },
  );
}
