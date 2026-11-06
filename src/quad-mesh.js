// Remove compatible triangle diagonals, then split the resulting polygons into quads.
// Shared edge midpoints preserve connectivity, including along sharp boundaries.
// UI geometry snapshots are immutable; reuse topology during canvas dragging.
const cache = new WeakMap();
export function quadMesh(raw) {
  if (raw.quads) return raw;
  if (cache.has(raw)) return cache.get(raw);
  const positions = Array.from(raw.positions),
    quads = [],
    edges = new Map();
  const normals = Array(raw.positions.length).fill(0);
  for (let i = 0; i < raw.indices.length; i += 3) {
    const [a, b, c] = Array.from(raw.indices.slice(i, i + 3), (v) => v * 3),
      p = raw.positions;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2],
      vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    for (const j of [a, b, c])
      for (let k = 0; k < 3; k++) normals[j + k] += n[k];
  }
  function normalizeAt(i) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    for (let k = 0; k < 3; k++) normals[i + k] /= l;
  }
  for (let i = 0; i < normals.length; i += 3) normalizeAt(i);
  function averagedNormal(ids) {
    const i = normals.length;
    for (let k = 0; k < 3; k++)
      normals.push(
        ids.reduce((n, j) => n + normals[j * 3 + k], 0) / ids.length,
      );
    normalizeAt(i);
  }
  function midpoint(a, b) {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (edges.has(key)) return edges.get(key);
    const index = positions.length / 3;
    for (let k = 0; k < 3; k++)
      positions.push(
        positions[a * 3 + k] +
          (positions[b * 3 + k] - positions[a * 3 + k]) / 2,
      );
    averagedNormal([a, b]);
    edges.set(key, index);
    return index;
  }
  const triangles = [],
    adjacency = new Map(),
    candidates = [];
  const edgeKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const point = (i) => positions.slice(i * 3, i * 3 + 3);
  const sub = (a, b) => a.map((v, k) => v - b[k]);
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a, b) => a.reduce((v, x, k) => v + x * b[k], 0);
  for (let i = 0; i < raw.indices.length; i += 3) {
    const face = Array.from(raw.indices.slice(i, i + 3)),
      id = triangles.length;
    triangles.push(face);
    for (let k = 0; k < 3; k++) {
      const a = face[k],
        b = face[(k + 1) % 3],
        c = face[(k + 2) % 3],
        key = edgeKey(a, b);
      if (!adjacency.has(key)) adjacency.set(key, []);
      adjacency.get(key).push({ id, a, b, c });
    }
  }
  for (const uses of adjacency.values()) {
    if (uses.length !== 2) continue;
    const [u, v] = uses;
    if (u.a !== v.b || u.b !== v.a || u.c === v.c) continue;
    const face = [u.a, v.c, u.b, u.c],
      p = face.map(point);
    const n1 = cross(sub(point(u.b), point(u.a)), sub(point(u.c), point(u.a))),
      n2 = cross(sub(point(v.b), point(v.a)), sub(point(v.c), point(v.a)));
    const l1 = Math.hypot(...n1),
      l2 = Math.hypot(...n2);
    if (!l1 || !l2 || dot(n1, n2) / (l1 * l2) < Math.cos(Math.PI / 4)) continue;
    const normal = n1.map((v, k) => v + n2[k]);
    let score = 0,
      valid = true;
    const lengths = [];
    for (let k = 0; k < 4; k++) {
      const e1 = sub(p[(k + 1) % 4], p[k]),
        e2 = sub(p[(k + 3) % 4], p[k]);
      const l = Math.hypot(...e1),
        r = Math.hypot(...e2);
      if (
        !l ||
        !r ||
        dot(cross(e1, e2), normal) <= Math.hypot(...normal) * l * r * 1e-12
      ) {
        valid = false;
        break;
      }
      lengths.push(l);
      score += Math.abs(dot(e1, e2) / (l * r));
    }
    if (!valid) continue;
    score += Math.max(...lengths) / Math.min(...lengths) - 1;
    candidates.push({ ids: [u.id, v.id], face, diagonal: [u.a, u.b], score });
  }
  candidates.sort(
    (a, b) => a.score - b.score || a.ids[0] - b.ids[0] || a.ids[1] - b.ids[1],
  );
  const matches = new Map(),
    graph = Array.from({ length: triangles.length }, () => []);
  for (const c of candidates) {
    for (const id of c.ids) graph[id].push(c);
    if (!c.ids.some((id) => matches.has(id)))
      for (const id of c.ids) matches.set(id, c);
  }
  // Recover adjacent pairs left stranded by greedy quality ordering, especially
  // in narrow Boolean strips. Alternating paths change connectivity only.
  function augment(id, seen, depth) {
    if (depth === 0) return null;
    for (const edge of graph[id]) {
      const other = edge.ids[0] === id ? edge.ids[1] : edge.ids[0];
      if (seen.has(other) || matches.get(id) === edge) continue;
      const match = matches.get(other);
      if (!match) return [edge];
      const next = match.ids[0] === other ? match.ids[1] : match.ids[0];
      if (seen.has(next)) continue;
      const visited = new Set(seen);
      visited.add(other);
      visited.add(next);
      const path = augment(next, visited, depth - 1);
      if (path) return [edge, ...path];
    }
    return null;
  }
  for (let pass = 0; pass < 2; pass++)
    for (let id = 0; id < triangles.length; id++)
      if (!matches.has(id)) {
        const path = augment(id, new Set([id]), 4);
        if (path)
          for (const c of path)
            for (const vertex of c.ids) matches.set(vertex, c);
      }
  const used = new Set(matches.keys()),
    polygons = [...new Set(matches.values())];
  triangles.forEach((face, id) => {
    if (!used.has(id)) polygons.push({ face });
  });
  for (const { face, diagonal } of polygons) {
    const mids = face.map((v, k) => midpoint(v, face[(k + 1) % face.length]));
    const center = positions.length / 3;
    const centerIds = diagonal || face;
    for (let k = 0; k < 3; k++) {
      const base = positions[centerIds[0] * 3 + k];
      positions.push(
        base +
          centerIds.reduce((n, j) => n + positions[j * 3 + k] - base, 0) /
            centerIds.length,
      );
    }
    averagedNormal(centerIds);
    for (let k = 0; k < face.length; k++)
      quads.push(
        face[k],
        mids[k],
        center,
        mids[(k + face.length - 1) % face.length],
      );
  }
  const result = {
    positions: new Float64Array(positions),
    quads: new Uint32Array(quads),
    normals: new Float32Array(normals),
    pairedTriangles: used.size,
  };
  cache.set(raw, result);
  return result;
}

export function quadObj(raw, name = "QuadMesh", offset = 1) {
  const q = quadMesh(raw),
    lines = [`o ${name.replace(/[\r\n]/g, " ")}`];
  for (let i = 0; i < q.positions.length; i += 3)
    lines.push(
      `v ${q.positions[i]} ${q.positions[i + 1]} ${q.positions[i + 2]}`,
    );
  for (let i = 0; i < q.normals.length; i += 3)
    lines.push(`vn ${q.normals[i]} ${q.normals[i + 1]} ${q.normals[i + 2]}`);
  lines.push("s 1");
  for (let i = 0; i < q.quads.length; i += 4)
    lines.push(
      `f ${Array.from(q.quads.slice(i, i + 4), (v) => `${v + offset}//${v + offset}`).join(" ")}`,
    );
  return { text: lines.join("\n") + "\n", vertices: q.positions.length / 3 };
}
