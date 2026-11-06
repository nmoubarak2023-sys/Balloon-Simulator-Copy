export function validateCurves(curves) {
  if (
    !Array.isArray(curves) ||
    curves.length < 1 ||
    curves.length > 5 ||
    curves.some(
      (c) =>
        !Array.isArray(c) ||
        c.length < 2 ||
        c.length > 200 ||
        c.some(
          (p) =>
            !Array.isArray(p) ||
            p.length !== 3 ||
            p.some((v) => !Number.isFinite(v)),
        ),
    )
  )
    throw Error("Use 1–5 curves, each with 2–200 finite XYZ points.");
  return curves.map((c) => c.map((p) => p.slice()));
}
export function iterationSummary(project) {
  return {
    name: project.iterationName || project.fileName,
    savedAt: project.savedAt,
    generatedSettings: project.params,
    currentControlSettings: project.controlSettings || project.params,
    curves: project.curves || [project.points],
    clipping: project.clipping,
    balloons: (project.session?.balloons || []).map((mesh, i) => ({
      balloon: i + 1,
      center: project.session.centers[i],
      currentCenter: project.session.centers[i].map(
        (v, k) => v + project.session.edits[i][k],
      ),
      bounds: [0, 1, 2].map((k) => {
        let min = Infinity,
          max = -Infinity;
        for (let j = k; j < mesh.positions.length; j += 3) {
          min = Math.min(min, mesh.positions[j]);
          max = Math.max(max, mesh.positions[j]);
        }
        return { axis: ["X", "Y", "Z"][k], min, max, size: max - min };
      }),
      transform: project.session.edits[i],
      frozen: !!project.session.meta[i].frozen,
      members: project.session.meta[i].members,
      vertices: mesh.positions.length / 3,
      triangles: mesh.indices.length / 3,
    })),
  };
}
function database() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("balloon-build-iterations", 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore("iterations", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function iterationStore(action, value) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(
          "iterations",
          action === "list" || action === "get" ? "readonly" : "readwrite",
        ),
        store = tx.objectStore("iterations");
      const req =
        action === "list"
          ? store.getAll()
          : action === "get"
            ? store.get(value)
            : action === "delete"
              ? store.delete(value)
              : store.put(value);
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("Iteration storage failed."));
    });
  } finally {
    db.close();
  }
}
