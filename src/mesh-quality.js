// Surface-preserving mesh conditioning: no smoothing or projection onto an SDF.
const sub = (a, b) => a.map((v, k) => v - b[k]);
const dot = (a, b) => a.reduce((v, x, k) => v + x * b[k], 0);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const key = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
function face(p, t) {
  const [a, b, c] = t.map((i) => p.slice(3 * i, 3 * i + 3));
  const n = cross(sub(b, a), sub(c, a));
  const doubleArea = Math.hypot(...n);
  const lengths = [
    Math.hypot(...sub(b, a)),
    Math.hypot(...sub(c, b)),
    Math.hypot(...sub(a, c)),
  ];
  return {
    n,
    doubleArea,
    longest: Math.max(...lengths),
    quality: doubleArea
      ? (2 * Math.sqrt(3) * doubleArea) / lengths.reduce((s, x) => s + x * x, 0)
      : 0,
  };
}
function adjacency(tris) {
  const edges = new Map();
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const a = t[k],
        b = t[(k + 1) % 3],
        c = t[(k + 2) % 3],
        id = key(a, b);
      if (!edges.has(id)) edges.set(id, []);
      edges.get(id).push({ i, a, b, c });
    }
  });
  return edges;
}
function collapseRoundingEdges(p, triangles, tolerance) {
  let tris = triangles,
    collapsed = 0;
  for (let pass = 0; pass < 16; pass++) {
    const edges = adjacency(tris),
      neighbors = new Map(),
      stars = new Map();
    tris.forEach((t, i) =>
      t.forEach((a) => {
        if (!neighbors.has(a)) {
          neighbors.set(a, new Set());
          stars.set(a, []);
        }
        for (const b of t) if (a !== b) neighbors.get(a).add(b);
        stars.get(a).push(i);
      }),
    );
    const remap = new Map(),
      locked = new Set();
    for (const entries of edges.values()) {
      if (entries.length !== 2) continue;
      const { a, b } = entries[0];
      if (locked.has(a) || locked.has(b)) continue;
      const pa = p.slice(a * 3, a * 3 + 3),
        pb = p.slice(b * 3, b * 3 + 3);
      const distance = Math.hypot(...sub(pa, pb));
      if (distance > tolerance) continue;
      const common = [...neighbors.get(a)].filter((v) =>
        neighbors.get(b).has(v),
      );
      if (common.length !== 2 || !entries.every((e) => common.includes(e.c)))
        continue;
      const affected = [...new Set([...stars.get(a), ...stars.get(b)])];
      if (affected.some((i) => tris[i].some((v) => locked.has(v)))) continue;
      // Guard against inverting adjacent surfaces; only tolerance-scale edges
      // collapse, and the surviving endpoint stays at its original location.
      let safe = true;
      const replacementFaces = new Set();
      for (const i of affected) {
        const t = tris[i];
        if (t.includes(a) && t.includes(b)) continue;
        const changed = t.map((v) => (v === b ? a : v)),
          id = changed
            .slice()
            .sort((a, b) => a - b)
            .join(":");
        if (replacementFaces.has(id)) {
          safe = false;
          break;
        }
        replacementFaces.add(id);
        const old = face(p, t),
          next = face(p, changed);
        if (
          old.doubleArea > 0 &&
          (next.doubleArea === 0 || dot(old.n, next.n) <= 0)
        ) {
          safe = false;
          break;
        }
      }
      if (!safe) continue;
      remap.set(b, a);
      affected.forEach((i) => tris[i].forEach((v) => locked.add(v)));
      collapsed++;
    }
    if (!remap.size) break;
    tris = tris
      .map((t) => t.map((v) => remap.get(v) ?? v))
      .filter((t) => new Set(t).size === 3);
  }
  return { tris, collapsed };
}
function repairZeroEdges(p, tris) {
  const parent = Array.from({ length: p.length / 3 }, (_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (const t of tris)
    for (let k = 0; k < 3; k++) {
      const a = t[k],
        b = t[(k + 1) % 3];
      if (
        p[3 * a] === p[3 * b] &&
        p[3 * a + 1] === p[3 * b + 1] &&
        p[3 * a + 2] === p[3 * b + 2]
      )
        parent[root(b)] = root(a);
    }
  tris = tris.map((t) => t.map(root)).filter((t) => new Set(t).size === 3);
  // Split only oversubscribed edges, using a distinct midpoint for each paired
  // sheet. Without this, a zero-width handle can retain a four-face edge even
  // after its vertex fans have been separated.
  const crowded = adjacency(tris),
    mids = new Map();
  for (const entries of crowded.values()) {
    if (entries.length <= 2) continue;
    const forward = entries.filter((e) => e.a < e.b),
      reverse = entries.filter((e) => e.a > e.b);
    if (forward.length !== reverse.length) return null;
    for (const a of forward) {
      const b = reverse.shift(),
        mid = p.length / 3;
      for (let k = 0; k < 3; k++)
        p.push((p[a.a * 3 + k] + p[a.b * 3 + k]) * 0.5);
      mids.set(`${a.i}:${a.a}:${a.b}`, mid);
      mids.set(`${b.i}:${b.a}:${b.b}`, mid);
    }
  }
  if (mids.size) {
    const next = [];
    tris.forEach(([a, b, c], i) => {
      const ab = mids.get(`${i}:${a}:${b}`),
        bc = mids.get(`${i}:${b}:${c}`),
        ca = mids.get(`${i}:${c}:${a}`);
      const mask =
        Number(ab !== undefined) +
        2 * Number(bc !== undefined) +
        4 * Number(ca !== undefined);
      const patterns = {
        0: [[a, b, c]],
        1: [
          [a, ab, c],
          [ab, b, c],
        ],
        2: [
          [b, bc, a],
          [bc, c, a],
        ],
        4: [
          [c, ca, b],
          [ca, a, b],
        ],
        3: [
          [b, bc, ab],
          [a, ab, c],
          [ab, bc, c],
        ],
        6: [
          [c, ca, bc],
          [b, bc, a],
          [bc, ca, a],
        ],
        5: [
          [a, ab, ca],
          [c, ca, b],
          [ca, ab, b],
        ],
        7: [
          [a, ab, ca],
          [ab, b, bc],
          [ca, bc, c],
          [ab, bc, ca],
        ],
      };
      next.push(...patterns[mask]);
    });
    tris = next;
  }
  // Pair directed halfedges and rebuild vertices from connected corner fans.
  // This splits zero-width pinches into independent sheets, rather than leaving
  // zero-area bridge triangles or welding unrelated nearby cavity walls.
  const corners = Array.from({ length: tris.length * 3 }, (_, i) => i);
  const cr = (i) => (corners[i] === i ? i : (corners[i] = cr(corners[i])));
  const join = (a, b) => {
    corners[cr(a)] = cr(b);
  };
  const edges = new Map();
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const a = t[k],
        b = t[(k + 1) % 3],
        id = key(a, b);
      if (!edges.has(id)) edges.set(id, []);
      edges.get(id).push({ a, b, i, k });
    }
  });
  for (const entries of edges.values()) {
    const forward = entries.filter((e) => e.a < e.b),
      reverse = entries.filter((e) => e.a > e.b);
    if (forward.length !== reverse.length) return null;
    for (const a of forward) {
      const n = face(p, tris[a.i]).n;
      let best = 0,
        score = -Infinity;
      reverse.forEach((b, k) => {
        const other = face(p, tris[b.i]).n;
        const s =
          dot(n, other) /
          Math.max(Number.MIN_VALUE, Math.hypot(...n) * Math.hypot(...other));
        if (s > score) {
          score = s;
          best = k;
        }
      });
      const b = reverse.splice(best, 1)[0];
      join(a.i * 3 + a.k, b.i * 3 + ((b.k + 1) % 3));
      join(a.i * 3 + ((a.k + 1) % 3), b.i * 3 + b.k);
    }
  }
  const map = new Map(),
    positions = [],
    triangles = [];
  tris.forEach((t, i) =>
    triangles.push(
      t.map((v, k) => {
        const r = cr(i * 3 + k);
        if (!map.has(r)) {
          map.set(r, positions.length / 3);
          positions.push(...p.slice(v * 3, v * 3 + 3));
        }
        return map.get(r);
      }),
    ),
  );
  return { positions, triangles };
}
export function meshQuality(raw) {
  const p = Array.from(raw.positions),
    tris = [],
    seen = new Set();
  let invalidFaces = 0,
    duplicateFaces = 0,
    degenerateFaces = 0,
    maxAspect = 0,
    stretchedFaces = 0,
    longestEdge = 0;
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  p.forEach((v, i) => {
    min[i % 3] = Math.min(min[i % 3], v);
    max[i % 3] = Math.max(max[i % 3], v);
  });
  const span = Math.hypot(...max.map((v, k) => v - min[k]));
  const areaFloor = Math.max(Number.MIN_VALUE, span * span * 1e-14);
  for (let i = 0; i < raw.indices.length; i += 3) {
    const t = Array.from(raw.indices.slice(i, i + 3));
    if (
      t.length !== 3 ||
      t.some((v) => !Number.isInteger(v) || v < 0 || v * 3 + 2 >= p.length)
    ) {
      invalidFaces++;
      continue;
    }
    tris.push(t);
    const id = t
      .slice()
      .sort((a, b) => a - b)
      .join(":");
    if (seen.has(id)) duplicateFaces++;
    seen.add(id);
    const f = face(p, t),
      aspect = f.quality ? 1 / f.quality : Infinity;
    if (f.doubleArea <= areaFloor || new Set(t).size < 3) degenerateFaces++;
    maxAspect = Math.max(maxAspect, aspect);
    longestEdge = Math.max(longestEdge, f.longest);
    if (aspect > 20) stretchedFaces++;
  }
  let boundaryEdges = 0,
    nonManifoldEdges = 0,
    inconsistentEdges = 0;
  for (const entries of adjacency(tris).values()) {
    if (entries.length === 1) boundaryEdges++;
    if (entries.length > 2) nonManifoldEdges++;
    if (entries.length === 2 && entries[0].a === entries[1].a)
      inconsistentEdges++;
  }
  return {
    vertices: p.length / 3,
    triangles: tris.length,
    invalidFaces,
    duplicateFaces,
    degenerateFaces,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
    maxAspect,
    stretchedFaces,
    longestEdge,
    finite: p.every(Number.isFinite),
  };
}
export function signedVolume(raw) {
  const p = raw.positions,
    idx = raw.indices;
  // Translate the origin for numerical stability on offset architectural models.
  const o = Array.from(p.slice(0, 3));
  let volume = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = Array.from(idx.slice(i, i + 3), (j) =>
      sub(Array.from(p.slice(j * 3, j * 3 + 3)), o),
    );
    volume += dot(a, cross(b, c)) / 6;
  }
  return volume;
}

// Flip only convex, coplanar pairs. Sharp intersections and curved facets are locked.
function improvePlanarEdges(p, tris, maxPasses = 8, tolerance = 0) {
  let flips = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const edges = adjacency(tris),
      touched = new Set();
    let changed = 0;
    for (const entries of edges.values()) {
      if (entries.length !== 2) continue;
      const [u, v] = entries;
      if (
        touched.has(u.i) ||
        touched.has(v.i) ||
        u.a !== v.b ||
        u.b !== v.a ||
        u.c === v.c ||
        edges.has(key(u.c, v.c))
      )
        continue;
      const f = face(p, tris[u.i]),
        g = face(p, tris[v.i]);
      const product = f.doubleArea * g.doubleArea;
      if (product && dot(f.n, g.n) / product < 1 - 1e-10) {
        const pa = p.slice(u.a * 3, u.a * 3 + 3),
          pc = p.slice(u.c * 3, u.c * 3 + 3),
          pd = p.slice(v.c * 3, v.c * 3 + 3);
        // Quantized planar CSG patches need a distance-based test as well as
        // normals: skinny triangles amplify tiny coordinate-rounding errors.
        if (
          dot(f.n, g.n) / product < 0.996 ||
          Math.abs(dot(sub(pd, pa), f.n)) / f.doubleArea > tolerance ||
          Math.abs(dot(sub(pc, pa), g.n)) / g.doubleArea > tolerance
        )
          continue;
      }
      if (!f.doubleArea && !g.doubleArea) continue;
      const a = [u.c, v.c, u.b],
        b = [v.c, u.c, u.a],
        fa = face(p, a),
        fb = face(p, b);
      // Same orientation and equal summed area ensure the new diagonal is inside.
      const reference = f.doubleArea ? f.n : g.n;
      if (
        dot(reference, fa.n) <= 0 ||
        dot(reference, fb.n) <= 0 ||
        Math.abs(fa.doubleArea + fb.doubleArea - f.doubleArea - g.doubleArea) >
          Math.max(
            (f.doubleArea + g.doubleArea) * 1e-9,
            tolerance * (f.longest + g.longest),
          )
      )
        continue;
      if (
        Math.min(fa.quality, fb.quality) <=
        Math.min(f.quality, g.quality) * (1 + 1e-5)
      )
        continue;
      tris[u.i] = a;
      tris[v.i] = b;
      touched.add(u.i);
      touched.add(v.i);
      changed++;
      // Reserve the new diagonal during this pass, including for other pairs
      // whose faces are disjoint but whose opposite vertices are identical.
      edges.set(key(u.c, v.c), []);
    }
    flips += changed;
    if (!changed) break;
  }
  return flips;
}

export function prepareMesh(
  raw,
  tolerance = 0,
  {
    collapse = true,
    flip = true,
    precision = "single",
    regularizeTiny = false,
  } = {},
) {
  let p = Array.from(raw.positions);
  let tris = Array.from({ length: raw.indices.length / 3 }, (_, i) =>
    Array.from(raw.indices.slice(i * 3, i * 3 + 3)),
  );
  const before = meshQuality(raw);
  if (regularizeTiny && tolerance > 0 && !before.invalidFaces) {
    const original = p.slice(),
      parent = Array.from({ length: p.length / 3 }, (_, i) => i),
      members = new Map();
    const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    for (const t of tris) {
      const f = face(p, t);
      if (f.quality >= 0.01 && f.doubleArea > 1e-10) continue;
      let pair = null,
        length = Infinity;
      for (let k = 0; k < 3; k++) {
        const a = root(t[k]),
          b = root(t[(k + 1) % 3]);
        if (a === b) continue;
        const d = Math.hypot(
          ...sub(p.slice(a * 3, a * 3 + 3), p.slice(b * 3, b * 3 + 3)),
        );
        if (d < length) {
          length = d;
          pair = [a, b];
        }
      }
      if (!pair || length > tolerance * 2) continue;
      const [a, b] = pair,
        group = [...(members.get(a) || [a]), ...(members.get(b) || [b])];
      const midpoint = [0, 1, 2].map((k) => (p[a * 3 + k] + p[b * 3 + k]) / 2);
      if (
        group.some(
          (i) =>
            Math.hypot(...sub(original.slice(i * 3, i * 3 + 3), midpoint)) >
            tolerance,
        )
      )
        continue;
      parent[b] = a;
      members.set(a, group);
      members.delete(b);
      for (const i of group)
        for (let k = 0; k < 3; k++) p[i * 3 + k] = midpoint[k];
    }
  }
  if (before.degenerateFaces && !before.invalidFaces && before.finite) {
    const repaired = repairZeroEdges(p, tris);
    if (repaired) {
      p = repaired.positions;
      tris = repaired.triangles;
    }
  }
  const cleaned = collapse
    ? collapseRoundingEdges(p, tris, tolerance)
    : { tris, collapsed: 0 };
  tris = cleaned.tris;
  // Cancel opposite coincident faces as a zero-volume oriented membrane.
  const duplicates = new Map(),
    remove = new Set();
  tris.forEach((t, i) => {
    const id = t
      .slice()
      .sort((a, b) => a - b)
      .join(":");
    if (!duplicates.has(id)) {
      duplicates.set(id, i);
      return;
    }
    const j = duplicates.get(id),
      other = tris[j];
    const opposite = [0, 1, 2].some(
      (k) =>
        t[0] === other[k] &&
        t[1] === other[(k + 2) % 3] &&
        t[2] === other[(k + 1) % 3],
    );
    // Opposite coincident triangles cancel as an oriented surface chain. This
    // removes only zero-thickness internal membranes, with zero volume change.
    if (opposite) {
      remove.add(i);
      remove.add(j);
      duplicates.delete(id);
    }
  });
  tris = tris.filter((_, i) => !remove.has(i));
  if (flip) improvePlanarEdges(p, tris, 16);
  return {
    positions:
      precision === "double" ? new Float64Array(p) : new Float32Array(p),
    indices: new Uint32Array(tris.flat()),
  };
}
export function conditionMesh(
  raw,
  {
    targetLength,
    tolerance = 0,
    maxTriangles = 400000,
    rounds = 3,
    allowTiny = false,
  } = {},
) {
  const p = Array.from(raw.positions);
  let tris = Array.from({ length: raw.indices.length / 3 }, (_, i) =>
    Array.from(raw.indices.slice(i * 3, i * 3 + 3)),
  );
  const before = meshQuality(raw),
    cleanedRaw = raw;
  const initial = meshQuality(cleanedRaw);
  // Do not silently delete damaged triangles: removing them can open a valid solid.
  if (
    !initial.finite ||
    initial.invalidFaces ||
    initial.duplicateFaces ||
    (initial.degenerateFaces && !allowTiny) ||
    initial.boundaryEdges ||
    initial.nonManifoldEdges ||
    initial.inconsistentEdges
  )
    return { raw, before, after: before, flips: 0, splits: 0, limited: false };
  let flips = improvePlanarEdges(p, tris, 32, tolerance);
  let splits = 0,
    limited = false;
  for (let round = 0; round < rounds && targetLength > 0; round++) {
    const marked = new Map();
    for (const t of tris) {
      const f = face(p, t);
      // Target elongated CSG fans, not already well-shaped curved triangles.
      if (f.quality >= 0.2 || f.longest <= targetLength * 1.5) continue;
      for (let k = 0; k < 3; k++) {
        const a = t[k],
          b = t[(k + 1) % 3];
        if (
          Math.hypot(
            ...sub(p.slice(a * 3, a * 3 + 3), p.slice(b * 3, b * 3 + 3)),
          ) >
          targetLength * 1.5
        )
          marked.set(key(a, b), [a, b]);
      }
    }
    if (!marked.size) break;
    // Conservative upper bound; never cut off faces to satisfy the budget.
    if (tris.length + marked.size * 2 > maxTriangles) {
      limited = true;
      break;
    }
    const mid = new Map();
    for (const [id, [a, b]] of marked) {
      mid.set(id, p.length / 3);
      for (let k = 0; k < 3; k++) p.push((p[3 * a + k] + p[3 * b + k]) * 0.5);
    }
    const next = [];
    for (const t of tris) {
      const [a, b, c] = t,
        ab = mid.get(key(a, b)),
        bc = mid.get(key(b, c)),
        ca = mid.get(key(c, a));
      const mask =
        Number(ab !== undefined) +
        2 * Number(bc !== undefined) +
        4 * Number(ca !== undefined);
      const patterns = {
        0: [[a, b, c]],
        1: [
          [a, ab, c],
          [ab, b, c],
        ],
        2: [
          [b, bc, a],
          [bc, c, a],
        ],
        4: [
          [c, ca, b],
          [ca, a, b],
        ],
        3: [
          [b, bc, ab],
          [a, ab, c],
          [ab, bc, c],
        ],
        6: [
          [c, ca, bc],
          [b, bc, a],
          [bc, ca, a],
        ],
        5: [
          [a, ab, ca],
          [c, ca, b],
          [ca, ab, b],
        ],
        7: [
          [a, ab, ca],
          [ab, b, bc],
          [ca, bc, c],
          [ab, bc, ca],
        ],
      };
      next.push(...patterns[mask]);
    }
    splits += marked.size;
    tris = next;
    flips += improvePlanarEdges(p, tris, 24, tolerance);
  }
  const result = {
    positions: new Float64Array(p),
    indices: new Uint32Array(tris.flat()),
  };
  const after = meshQuality(result);
  // Float32 midpoint rounding may collapse microscopic edges. Keep the original
  // checked mesh rather than exporting a remesher-induced hole or zero-area face.
  if (
    after.degenerateFaces > (allowTiny ? before.degenerateFaces : 0) ||
    after.duplicateFaces ||
    after.boundaryEdges ||
    after.nonManifoldEdges ||
    after.inconsistentEdges
  )
    return { raw, before, after: before, flips: 0, splits: 0, limited: true };
  return { raw: result, before, after, flips, splits, limited };
}
