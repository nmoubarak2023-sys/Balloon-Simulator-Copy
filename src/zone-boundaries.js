import { roofSampler } from "./columns.js";
import { inLoops } from "./zones.js";
const cache = new WeakMap();
export function sharedBoundaries(boundary) {
  if (!boundary) return [];
  if (cache.has(boundary)) return cache.get(boundary);
  const edges = boundary.zones.map((z) =>
    z.loops.flatMap((loop) =>
      loop.map((a, i) => [a, loop[(i + 1) % loop.length]]),
    ),
  );
  const scale = Math.max(
      boundary.bounds?.width ?? 1,
      boundary.bounds?.height ?? 1,
      1,
    ),
    tol = scale * 1e-6;
  const found = [];
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const segments = [];
      for (const [a, b] of edges[i]) {
        const dx = b[0] - a[0],
          dy = b[1] - a[1],
          len = Math.hypot(dx, dy);
        if (len < tol) continue;
        for (const [c, d] of edges[j]) {
          if (
            Math.min(c[0], d[0]) > Math.max(a[0], b[0]) + tol ||
            Math.max(c[0], d[0]) < Math.min(a[0], b[0]) - tol ||
            Math.min(c[1], d[1]) > Math.max(a[1], b[1]) + tol ||
            Math.max(c[1], d[1]) < Math.min(a[1], b[1]) - tol
          )
            continue;
          if (
            Math.abs((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) > tol * len ||
            Math.abs((d[0] - a[0]) * dy - (d[1] - a[1]) * dx) > tol * len
          )
            continue;
          const t = (p) =>
              ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len),
            lo = Math.max(0, Math.min(t(c), t(d))),
            hi = Math.min(1, Math.max(t(c), t(d)));
          if ((hi - lo) * len > tol)
            segments.push([
              [a[0] + lo * dx, a[1] + lo * dy],
              [a[0] + hi * dx, a[1] + hi * dy],
            ]);
        }
      }
      if (segments.length)
        found.push({ id: `${i}:${j}`, zones: [i, j], segments });
    }
  cache.set(boundary, found);
  return found;
}
export function boundaryRules(boundary, settings, zone) {
  return sharedBoundaries(boundary)
    .filter((e) => e.zones.includes(zone))
    .flatMap((e) => {
      const rule = settings?.[e.id];
      if (!rule || rule.mode === "open") return [];
      if (!["soft", "defined"].includes(rule.mode))
        throw Error("UNKNOWN ZONE BOUNDARY TYPE.");
      const width = rule.width ?? 12,
        height = rule.height ?? 8;
      if (
        !Number.isFinite(width) ||
        width < 2 ||
        width > 100 ||
        !Number.isFinite(height) ||
        height < 1 ||
        height > 100
      )
        throw Error(
          "USE TRANSITION WIDTH 2–100 FT AND VALLEY HEIGHT 1–100 FT.",
        );
      return [
        {
          ...rule,
          width,
          height,
          segments: e.segments,
          neighborLoops: boundary.zones[e.zones.find((i) => i !== zone)].loops,
        },
      ];
    });
}
export function boundaryDistance([x, y], segments) {
  let distance = Infinity;
  for (const [a, b] of segments) {
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      t = Math.max(
        0,
        Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)),
      );
    distance = Math.min(
      distance,
      Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy),
    );
  }
  return distance;
}
// Work on native solids, so trimming also creates closed cut faces for export.
// Ownership/deletion stays with the caller's normal Manifold lifetime scope.
export function connectedBoundaryBalloon(solid, center, own) {
  const pieces = solid.decompose();
  if (pieces.length < 2) {
    pieces.forEach((p) => p.delete());
    return solid;
  }
  let chosen = null,
    best = -Infinity;
  for (const p of pieces) {
    own(p);
    let contains = false;
    if (center) {
      const slice = own(p.slice(center[2]));
      contains = inLoops(center.slice(0, 2), slice.toPolygons());
    }
    const score = (contains ? 1e30 : 0) + p.volume();
    if (score > best) {
      best = score;
      chosen = p;
    }
  }
  return chosen;
}
export function applyBoundaryRules(m, solid, rules, floor, own, center) {
  for (const rule of rules ?? []) {
    if (rule.mode === "soft") {
      solid = own(solid.refineToLength(Math.max(1, rule.width / 4)));
      const mesh = solid.getMesh(),
        roof = roofSampler({
          positions: mesh.vertProperties,
          indices: mesh.triVerts,
        });
      solid = own(
        solid.warp((v) => {
          if (v[2] <= floor) return;
          const u = Math.min(
            1,
            boundaryDistance(v, rule.segments) / rule.width,
          );
          if (u === 1) return;
          const top = roof(v[0], v[1]);
          if (top === null || top <= floor) return;
          const blend = u * u * u * (10 + u * (-15 + 6 * u)),
            near = Math.min(1, rule.height / (top - floor));
          v[2] = floor + (v[2] - floor) * (near + (1 - near) * blend);
        }),
      );
    }
    const bounds = solid.boundingBox(),
      span = Math.max(1, bounds.max[2] - bounds.min[2]) + 10;
    const cross = own(new m.CrossSection(rule.neighborLoops, "EvenOdd"));
    const neighbor = own(
      own(cross.extrude(span * 3)).translate([0, 0, bounds.min[2] - span]),
    );
    solid = own(solid.subtract(neighbor));
    if (!solid.isEmpty()) solid = connectedBoundaryBalloon(solid, center, own);
  }
  return solid;
}
