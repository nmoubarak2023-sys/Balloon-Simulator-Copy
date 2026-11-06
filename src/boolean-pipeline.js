import {
  prepareMesh,
  conditionMesh,
  meshQuality,
  signedVolume,
} from "./mesh-quality.js";
import { auditCrossings } from "./intersection-audit.js";
const clean = (q) =>
  q.finite &&
  !q.invalidFaces &&
  !q.degenerateFaces &&
  !q.duplicateFaces &&
  !q.boundaryEdges &&
  !q.nonManifoldEdges &&
  !q.inconsistentEdges;
export function buildCavities(
  engine,
  tolerance,
  quality = "final",
  progress = () => {},
) {
  if (!Number.isFinite(tolerance) || tolerance <= 0)
    throw Error("Boolean tolerance must be positive.");
  if (!["preview", "final"].includes(quality))
    throw Error("Unknown Boolean quality.");
  const start = performance.now(),
    owned = [];
  const own = (s) => (owned.push(s), s);
  const box = engine.boundary.boundingBox();
  const center = box.min.map((v, k) => (v + box.max[k]) / 2);
  const scale = Math.max(...box.max.map((v, k) => v - box.min[k]));
  const epsilon = tolerance / scale;
  const normalize = (s) =>
    own(own(s.translate(center.map((v) => -v))).scale(1 / scale));
  const world = (raw) => ({
    positions: Float64Array.from(
      raw.positions,
      (v, i) => v * scale + center[i % 3],
    ),
    indices: raw.indices,
  });
  try {
    progress(0.05, "Computing collective solid-minus-void Boolean…");
    // Handle overlapping cutters in one deferred batch; retain editable inputs.
    const container = own(normalize(engine.boundary).setTolerance(epsilon));
    const cutters = engine.balloons.map((s) =>
      own(normalize(s).setTolerance(epsilon)),
    );
    const result = own(engine.m.Manifold.difference([container, ...cutters]));
    engine.assert(result, "Boolean");
    let raw = engine.raw(result),
      before = meshQuality(world(raw)),
      candidate = result;
    let repairAccepted = false,
      repairVolume = 0;
    const allowedVolume = Math.max(1e-18, result.surfaceArea() * epsilon * 2);
    // Certify cleanup with the solid kernel; never export intermediate soup.
    for (
      let pass = 0;
      pass < 2 && !before.boundaryEdges && !before.invalidFaces;
      pass++
    ) {
      progress(
        0.25 + pass * 0.15,
        "Repairing quantized intersections and validating the solid…",
      );
      const prepared = prepareMesh(raw, epsilon);
      const mesh = new engine.m.Mesh({
        numProp: 3,
        vertProperties: prepared.positions,
        triVerts: prepared.indices,
        tolerance: epsilon,
      });
      mesh.merge();
      let repaired;
      try {
        repaired = own(new engine.m.Manifold(mesh));
      } catch {
        break;
      } // Preserve the exportable original with explicit warnings.
      if (repaired.status() !== "NoError" || repaired.isEmpty()) break;
      // Keep the repaired triangle surface, not the kernel's re-tessellation.
      // Reconstructing a nearly coplanar saved mesh can discard thin sheets.
      // Cleanup changes only tolerance-scale edges and zero-width connectivity;
      // new planar diagonals stay on the same surface. The kernel is a validator.
      const delta = Math.abs(signedVolume(prepared) - signedVolume(raw));
      const q = meshQuality(prepared),
        old = meshQuality(raw);
      if (
        delta > allowedVolume ||
        q.boundaryEdges ||
        q.nonManifoldEdges ||
        q.inconsistentEdges ||
        q.duplicateFaces ||
        q.degenerateFaces > old.degenerateFaces
      )
        break;
      raw = prepared;
      candidate = repaired;
      repairVolume = delta;
      repairAccepted = true;
      if (clean(q)) break;
    }
    progress(0.65, "Retriangulating planar patches while preserving creases…");
    let conditioning = {
      before: meshQuality(raw),
      after: meshQuality(raw),
      flips: 0,
      splits: 0,
      limited: false,
      raw,
    };
    if (quality === "final" && clean(conditioning.before)) {
      // No smoothing. Flips touch planar patches within the model tolerance.
      const flipped = conditionMesh(raw, { tolerance: epsilon, rounds: 0 });
      const length = 1 / 40;
      const refined =
        flipped.after.maxAspect > 1000
          ? flipped
          : conditionMesh(flipped.raw, {
              targetLength: length,
              tolerance: epsilon,
              rounds: 2,
            });
      // Reject refinement that increases skinny-face counts or the worst aspect.
      conditioning =
        refined.after.stretchedFaces <= flipped.after.stretchedFaces &&
        refined.after.maxAspect <= flipped.after.maxAspect
          ? {
              ...refined,
              flips:
                refined === flipped
                  ? flipped.flips
                  : refined.flips + flipped.flips,
              before: conditioning.before,
            }
          : flipped;
      raw = conditioning.raw;
    }
    raw = world(raw);
    const after = meshQuality(raw);
    progress(0.95, "Checking final mesh and export geometry…");
    const intersectionAudit =
      quality === "final" ? auditCrossings(raw, tolerance) : null;
    return {
      raw,
      quality,
      before,
      after,
      repairAccepted,
      repairVolume: repairVolume * scale ** 3,
      allowedVolume: allowedVolume * scale ** 3,
      coordinateNormalization: { center, scale },
      flips: conditioning.flips,
      splits: conditioning.splits,
      limited: conditioning.limited,
      kernelValid: candidate.status() === "NoError",
      intersectionAudit,
      elapsedMs: performance.now() - start,
    };
  } finally {
    for (const s of owned.reverse()) s.delete();
  }
}
