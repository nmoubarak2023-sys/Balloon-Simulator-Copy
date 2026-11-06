import {
  prepareMesh,
  conditionMesh,
  meshQuality,
  signedVolume,
} from "./mesh-quality.js";
import { auditCrossings } from "./intersection-audit.js";

export const PRECISION_URL = "http://127.0.0.1:8789";

// Remove only disconnected numerical membranes contained in a sub-tolerance
// slab. Never remove connected details or components merely because small.
export function removeNumericalSheets(raw, tolerance) {
  const p = raw.positions,
    t = raw.indices,
    n = t.length / 3;
  const parent = Array.from({ length: n }, (_, i) => i);
  const root = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const seen = new Map();
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      const a = t[i * 3 + k],
        b = t[i * 3 + ((k + 1) % 3)],
        key = Math.min(a, b) + ":" + Math.max(a, b);
      if (seen.has(key)) parent[root(i)] = root(seen.get(key));
      else seen.set(key, i);
    }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const k = root(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  const removed = new Set(),
    report = [];
  for (const group of groups.values()) {
    if (group.length > 1000) continue;
    const vertices = [
      ...new Set(group.flatMap((f) => Array.from(t.slice(f * 3, f * 3 + 3)))),
    ];
    let width = Infinity;
    for (const f of group) {
      const [a, b, c] = Array.from(t.slice(f * 3, f * 3 + 3), (i) =>
        Array.from(p.slice(i * 3, i * 3 + 3)),
      );
      const u = b.map((x, k) => x - a[k]),
        v = c.map((x, k) => x - a[k]);
      const normal = [
          u[1] * v[2] - u[2] * v[1],
          u[2] * v[0] - u[0] * v[2],
          u[0] * v[1] - u[1] * v[0],
        ],
        len = Math.hypot(...normal);
      if (!len) continue;
      let lo = Infinity,
        hi = -Infinity;
      for (const i of vertices) {
        const d = normal.reduce(
          (s, x, k) => s + (x * (p[i * 3 + k] - a[k])) / len,
          0,
        );
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
      width = Math.min(width, hi - lo);
    }
    // Open sheets are retained for inspection, rather than silently erased.
    const componentEdges = new Map();
    for (const f of group)
      for (let k = 0; k < 3; k++) {
        const a = t[f * 3 + k],
          b = t[f * 3 + ((k + 1) % 3)],
          key = Math.min(a, b) + ":" + Math.max(a, b);
        componentEdges.set(key, (componentEdges.get(key) || 0) + 1);
      }
    const remove =
      width < tolerance && [...componentEdges.values()].every((n) => n === 2);
    report.push({ faces: group.length, width, removed: remove });
    if (remove) for (const f of group) removed.add(f);
  }
  return {
    raw: {
      positions: new Float64Array(p),
      indices: Uint32Array.from(
        t.filter((_, i) => !removed.has(Math.floor(i / 3))),
      ),
    },
    report,
  };
}

export function finishPrecision(raw, tolerance) {
  const before = meshQuality(raw);
  const prepared = prepareMesh(raw, tolerance, {
    precision: "double",
    flip: false,
  });
  const filtered = removeNumericalSheets(prepared, tolerance);
  const repaired = prepareMesh(filtered.raw, tolerance, {
    precision: "double",
    regularizeTiny: true,
    flip: false,
  });
  const final = conditionMesh(repaired, {
    tolerance: 0,
    rounds: 0,
    allowTiny: true,
  }).raw;
  return {
    raw: final,
    before,
    after: meshQuality(final),
    removedSheets: filtered.report,
    volume: signedVolume(final),
    intersectionAudit: auditCrossings(final, tolerance, 10000000),
  };
}

export async function precisionOutput(engine, tolerance, progress = () => {}) {
  if (!engine.boundary || !engine.balloons.length)
    throw Error("Generate balloons first.");
  if (!Number.isFinite(tolerance) || tolerance <= 0)
    throw Error("Tolerance must be positive.");
  const box = engine.boundary.boundingBox(),
    center = box.min.map((v, k) => (v + box.max[k]) / 2);
  const scale = Math.max(...box.max.map((v, k) => v - box.min[k]));
  const meshes = [
    engine.rawBoundary || engine.raw(engine.boundary),
    ...engine.balloons.map((s) => engine.raw(s)),
  ].map((source) => {
    // Normalize in double precision before the one intentional kernel input
    // quantization; transforming a Manifold first changes intersection caps.
    const normalized = {
      positions: Float64Array.from(
        source.positions,
        (v, k) => (v - center[k % 3]) / scale,
      ),
      indices: source.indices,
    };
    const raw = prepareMesh(normalized, tolerance / scale);
    return {
      positions: Array.from(raw.positions),
      indices: Array.from(raw.indices),
    };
  });
  const jobId = crypto.randomUUID();
  progress(0.05, "Native precision Boolean and constrained remeshing…", jobId);
  let response;
  try {
    response = await fetch(PRECISION_URL + "/boolean", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId,
        meshes,
        transform: { center, scale },
        tolerance,
      }),
    });
  } catch {
    throw Error(
      "Start Start-Balloon-Precision.cmd, then build Precision output again. The local engine could not be reached.",
    );
  }
  const native = await response.json();
  if (!response.ok) throw Error(native.error || "Precision engine failed.");
  progress(0.85, "Validating precision surface and thin numerical sheets…");
  const diagnostics = finishPrecision(
    {
      positions: new Float64Array(native.positions),
      indices: new Uint32Array(native.indices),
    },
    tolerance,
  );
  const q = diagnostics.after;
  const checks = {
    valid:
      q.finite && !q.invalidFaces && !q.degenerateFaces && !q.duplicateFaces,
    closed: !q.boundaryEdges,
    manifold: !q.nonManifoldEdges && !q.inconsistentEdges,
  };
  const incomplete =
    !checks.valid ||
    !checks.closed ||
    !checks.manifold ||
    diagnostics.intersectionAudit.properCrossings > 0;
  return {
    mode: "boolean",
    quality: "precision",
    shells: [diagnostics.raw],
    checks,
    incomplete,
    qualityWarning: incomplete || q.stretchedFaces > 0,
    diagnostics: {
      ...diagnostics,
      raw: undefined,
      nativeEngine: native.nativeEngine,
      tolerance,
      cutterOutsetMaximum: native.cutterOutsetMaximum,
      remeshSurfaceDistance: native.remeshSurfaceDistance,
      contactGap: engine.params?.clearance,
      coordinateNormalization: { center, scale },
    },
    message: `Precision surface · Degenerate: ${q.degenerateFaces} · Open edges: ${q.boundaryEdges} · Nonmanifold edges: ${q.nonManifoldEdges} · Suspected crossings: ${diagnostics.intersectionAudit.properCrossings}${diagnostics.intersectionAudit.truncated ? " (partial audit)" : ""}. ${q.stretchedFaces} stretched triangles remain; inspect the surface. Contact-gap setting retained; numerical adjustments use the supplied tolerance.`,
  };
}
