import * as T from "three";
import { MeshBVH } from "three-mesh-bvh";
import { meshQuality, signedVolume } from "./mesh-quality.js";
import { auditCrossings } from "./intersection-audit.js";
const occupied = (lo, hi) => (lo & 1) !== 0 && (lo & ~1) === 0 && hi === 0;
const corners = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];
// The same body diagonal is used everywhere; shared grid faces have identical
// diagonals. This prevents the cracks and ambiguous faces of unconstrained CSG.
const tetrahedra = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];
function quality(p, a, b, c) {
  const u = [0, 1, 2].map((k) => p[b * 3 + k] - p[a * 3 + k]),
    v = [0, 1, 2].map((k) => p[c * 3 + k] - p[a * 3 + k]);
  const area = Math.hypot(
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  );
  const sum =
    u.reduce((s, x) => s + x * x, 0) +
    v.reduce((s, x) => s + x * x, 0) +
    u.reduce((s, x, k) => s + (x - v[k]) ** 2, 0);
  return sum ? area / sum : 0;
}
export function rebuildVolume(engine, resolution = 160, progress = () => {}) {
  if (!Number.isInteger(resolution) || resolution < 32 || resolution > 256)
    throw Error("Rebuild resolution must be an integer from 32 to 256.");
  const start = performance.now(),
    box = engine.boundary.boundingBox();
  const scale = Math.max(...box.max.map((v, k) => v - box.min[k]));
  const center = box.min.map((v, k) => (v + box.max[k]) / 2),
    h = 1 / resolution;
  const min = box.min.map((v, k) => (v - center[k]) / scale - h * 2.27183);
  const dims = box.max.map(
    (v, k) => Math.ceil(((v - center[k]) / scale - min[k]) / h) + 4,
  );
  const [nx, ny, nz] = dims,
    stride = nx * ny,
    size = stride * nz;
  if (size > 20000000)
    throw Error("Rebuild grid exceeds its memory budget. Reduce resolution.");
  const raws = [
    engine.rawBoundary,
    ...engine.balloons.map((s) => engine.raw(s)),
  ];
  if (raws.length > 64)
    throw Error("Volume rebuild supports up to 63 cutters.");
  const positions = [],
    indices = [],
    source = [];
  raws.forEach((raw, sid) => {
    const base = positions.length / 3;
    for (let i = 0; i < raw.positions.length; i++)
      positions.push((raw.positions[i] - center[i % 3]) / scale);
    for (let i = 0; i < raw.indices.length; i += 3) {
      indices.push(
        base + raw.indices[i],
        base + raw.indices[i + 1],
        base + raw.indices[i + 2],
      );
      source.push(sid);
    }
  });
  const g = new T.BufferGeometry();
  g.setAttribute(
    "position",
    new T.BufferAttribute(new Float64Array(positions), 3),
  );
  g.setIndex(new T.BufferAttribute(new Uint32Array(indices), 1));
  const tree = new MeshBVH(g, { indirect: true });
  const normals = new Float64Array(indices.length),
    a = new T.Vector3(),
    b = new T.Vector3(),
    c = new T.Vector3();
  for (let i = 0; i < indices.length; i += 3) {
    a.fromArray(positions, indices[i] * 3);
    b.fromArray(positions, indices[i + 1] * 3);
    c.fromArray(positions, indices[i + 2] * 3);
    b.sub(a);
    c.sub(a);
    b.cross(c).normalize().toArray(normals, i);
  }
  const ray = new T.Ray(),
    sign = new Uint8Array(size),
    distances = new Float32Array(size);
  distances.fill(NaN);
  const position = (id) => [
    min[0] + (id % nx) * h,
    min[1] + (Math.floor(id / nx) % ny) * h,
    min[2] + Math.floor(id / stride) * h,
  ];
  function applyGroup(hits, first, last, low, high) {
    const flags = new Map();
    for (let i = first; i < last; i++) {
      const hit = hits[i],
        sid = source[hit.faceIndex],
        flag = normals[hit.faceIndex * 3] < 0 ? 1 : 2;
      flags.set(sid, (flags.get(sid) || 0) | flag);
    }
    for (const [sid, flag] of flags) {
      if (flag === 3) continue;
      const bit = 1 << (sid % 32);
      if (sid < 32) low = flag === 1 ? low | bit : low & ~bit;
      else high = flag === 1 ? high | bit : high & ~bit;
    }
    return [low >>> 0, high >>> 0];
  }
  const q = new T.Vector3();
  function field(id) {
    if (Number.isNaN(distances[id])) {
      q.fromArray(position(id));
      const hit = tree.closestPointToPoint(q, {}, 0, h * 4);
      // Keep the zero set away from grid vertices to prevent subpixel slivers.
      // This regularization is 1% of a cell, explicitly inside the grid budget.
      distances[id] =
        (sign[id] ? -1 : 1) * Math.max(h * 0.01, hit ? hit.distance : h * 4);
    }
    return distances[id];
  }
  const points = [],
    triangles = [],
    edgeVertices = new Map();
  function edge(a, b) {
    const key = Math.min(a, b) * size + Math.max(a, b);
    if (edgeVertices.has(key)) return edgeVertices.get(key);
    const fa = field(a),
      fb = field(b),
      t = fa / (fa - fb),
      pa = position(a),
      pb = position(b),
      v = points.length / 3;
    for (let k = 0; k < 3; k++) points.push(pa[k] + t * (pb[k] - pa[k]));
    edgeVertices.set(key, v);
    return v;
  }
  function triangle(a, b, c, direction) {
    const u = [0, 1, 2].map((k) => points[b * 3 + k] - points[a * 3 + k]),
      v = [0, 1, 2].map((k) => points[c * 3 + k] - points[a * 3 + k]);
    const n = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    if (n.reduce((s, x, k) => s + x * direction[k], 0) < 0)
      triangles.push(a, c, b);
    else triangles.push(a, b, c);
  }
  try {
    progress(0.02, "Sampling the container minus all balloon volumes…");
    for (let z = 0; z < nz; z++) {
      if (z % 4 === 0)
        progress(
          0.05 + (0.3 * z) / nz,
          "Classifying solid and cavity volumes…",
        );
      for (let y = 0; y < ny; y++) {
        ray.origin.set(min[0] - h, min[1] + y * h, min[2] + z * h);
        ray.direction.set(1, 0, 0);
        const hits = tree
          .raycast(ray, T.DoubleSide)
          .filter((hit) => Math.abs(normals[hit.faceIndex * 3]) > 1e-12)
          .sort((a, b) => a.distance - b.distance);
        let cursor = 0,
          low = 0,
          high = 0;
        for (let x = 0; x < nx; x++) {
          while (cursor < hits.length && hits[cursor].distance <= (x + 1) * h) {
            let end = cursor + 1;
            while (
              end < hits.length &&
              Math.abs(hits[end].distance - hits[cursor].distance) < h * 1e-7
            )
              end++;
            [low, high] = applyGroup(hits, cursor, end, low, high);
            cursor = end;
          }
          sign[z * stride + y * nx + x] = occupied(low, high) ? 1 : 0;
        }
      }
    }
    for (let z = 0; z < nz - 1; z++) {
      if (z % 4 === 0)
        progress(
          0.35 + (0.4 * z) / nz,
          "Extracting a conforming curved solid surface…",
        );
      for (let y = 0; y < ny - 1; y++)
        for (let x = 0; x < nx - 1; x++) {
          const id = z * stride + y * nx + x,
            ids = corners.map(([a, b, c]) => id + a + b * nx + c * stride);
          if (ids.every((i) => sign[i] === sign[ids[0]])) continue;
          for (const tetra of tetrahedra) {
            const inside = tetra.filter((k) => sign[ids[k]]),
              outside = tetra.filter((k) => !sign[ids[k]]);
            if (!inside.length || !outside.length) continue;
            const ci = inside
              .map((k) => position(ids[k]))
              .reduce(
                (a, p) => a.map((v, k) => v + p[k] / inside.length),
                [0, 0, 0],
              );
            const co = outside
              .map((k) => position(ids[k]))
              .reduce(
                (a, p) => a.map((v, k) => v + p[k] / outside.length),
                [0, 0, 0],
              );
            const direction = co.map((v, k) => v - ci[k]);
            if (inside.length === 1 || outside.length === 1) {
              const single = inside.length === 1 ? inside[0] : outside[0],
                others = inside.length === 1 ? outside : inside;
              triangle(
                ...others.map((k) => edge(ids[single], ids[k])),
                direction,
              );
            } else {
              const [i, j] = inside,
                [u, v] = outside;
              const a = edge(ids[i], ids[u]),
                b = edge(ids[i], ids[v]),
                c = edge(ids[j], ids[v]),
                d = edge(ids[j], ids[u]);
              if (
                Math.min(quality(points, a, b, c), quality(points, a, c, d)) >=
                Math.min(quality(points, a, b, d), quality(points, b, c, d))
              ) {
                triangle(a, b, c, direction);
                triangle(a, c, d, direction);
              } else {
                triangle(a, b, d, direction);
                triangle(b, c, d, direction);
              }
            }
          }
        }
    }
    if (!triangles.length)
      throw Error("No solid surface resolved. Increase rebuild resolution.");
    if (triangles.length / 3 > 1500000)
      throw Error(
        "Rebuilt mesh exceeds 1.5 million triangles. Reduce resolution.",
      );
    const raw = {
      positions: Float64Array.from(points, (v, i) => v * scale + center[i % 3]),
      indices: new Uint32Array(triangles),
    };
    progress(0.85, "Checking rebuilt mesh quality and intersections…");
    const after = meshQuality(raw),
      intersectionAudit = auditCrossings(
        raw,
        Math.max(scale * h * 1e-5, 1e-8),
        20000000,
      );
    return {
      raw,
      quality: "rebuild",
      after,
      before: null,
      intersectionAudit,
      elapsedMs: performance.now() - start,
      resolution,
      cellSize: scale * h,
      grid: dims,
      volume: signedVolume(raw),
      approximation: true,
      featureWarning: `Features and walls narrower than ${(2 * scale * h).toPrecision(3)} model units may merge or disappear. Sharp details are approximated at the grid scale; this is not an exact Boolean.`,
      kernelValid: false,
      flips: 0,
      splits: 0,
      limited: false,
    };
  } finally {
    g.dispose();
  }
}
