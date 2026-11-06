// Local reproduction utility; never commit the user's project geometry.
import fs from "node:fs/promises";
import path from "node:path";
import Module from "manifold-3d";
import Rhino from "rhino3dm";
import { BalloonEngine } from "../src/engine.js";
import { precisionOutput } from "../src/precision-client.js";
import { meshQuality } from "../src/mesh-quality.js";
import { addRhinoMesh, rhinoRaw } from "../src/rhino-io.js";
const project = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const directory = path.resolve(
  process.argv[3] || "../balloon-build-precision-review",
);
await fs.mkdir(directory, { recursive: true });
const m = await Module();
m.setup();
const engine = new BalloonEngine(m);
engine.loadSession(project.session);
// Node tests emulate only the browser Origin header; the service remains local.
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) =>
  originalFetch(url, {
    ...options,
    headers: { ...options.headers, Origin: "http://127.0.0.1:5174" },
  });
try {
  const result = await precisionOutput(
    engine,
    project.params.tolerance || 1e-4,
    (_, text) => console.log(text),
  );
  const raw = result.shells[0],
    r = await Rhino(),
    doc = new r.File3dm();
  addRhinoMesh(r, doc, raw, "Balloon Build / thin-wall precision cavities");
  const bytes = doc.toByteArray();
  await fs.writeFile(
    path.join(directory, "Balloon-Build-precision-cavities.3dm"),
    bytes,
  );
  const roundtrip = r.File3dm.fromByteArray(bytes),
    mesh = roundtrip.objects().get(0).geometry(),
    reopened = rhinoRaw(mesh);
  const identical =
    raw.positions.every((v, i) => v === reopened.positions[i]) &&
    raw.indices.every((v, i) => v === reopened.indices[i]);
  const report = {
    ...result,
    shells: undefined,
    rhinoRoundTrip: meshQuality(reopened),
    rhinoCoordinatesAndConnectivityIdentical: identical,
  };
  await fs.writeFile(
    path.join(directory, "quality-report.json"),
    JSON.stringify(report, null, 2),
  );
  await fs.writeFile(
    path.join(directory, "surface.json"),
    JSON.stringify(raw, (_, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v)),
  );
  console.log(
    JSON.stringify({
      checks: result.checks,
      after: result.diagnostics.after,
      audit: result.diagnostics.intersectionAudit,
      rhinoIdentical: identical,
    }),
  );
  mesh.delete();
  roundtrip.delete();
  doc.delete();
} finally {
  globalThis.fetch = originalFetch;
  engine.clear();
}
