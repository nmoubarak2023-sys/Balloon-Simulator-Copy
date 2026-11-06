// Reproduce and compare a user-supplied project without committing its contents.
import fs from "node:fs/promises";
import path from "node:path";
import Module from "manifold-3d";
import Rhino from "rhino3dm";
import { BalloonEngine, topology } from "../src/engine.js";
import { meshQuality, signedVolume } from "../src/mesh-quality.js";
import { addRhinoMesh, rhinoRaw } from "../src/rhino-io.js";
import { auditCrossings } from "../src/intersection-audit.js";
const project = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const directory = path.resolve(
  process.argv[3] || "../balloon-build-mesh-review",
);
await fs.mkdir(directory, { recursive: true });
const m = await Module();
m.setup();
const e = new BalloonEngine(m);
e.loadSession(project.session);
const tolerance = project.params.tolerance || 0.0001;
let sequential = e.boundary.setTolerance(tolerance);
for (const cutter of e.balloons) {
  const next = sequential.subtract(cutter);
  sequential.delete();
  sequential = next;
}
const old = e.raw(sequential);
sequential.delete();
const output = e.output("boolean", tolerance, "final"),
  raw = output.shells[0];
const r = await Rhino(),
  doc = new r.File3dm();
addRhinoMesh(r, doc, raw, "Balloon Build / conditioned cavities");
const bytes = doc.toByteArray();
await fs.writeFile(
  path.join(directory, "Balloon-Build-improved-cavities.3dm"),
  bytes,
);
const reopened = r.File3dm.fromByteArray(bytes),
  obj = reopened.objects().get(0),
  mesh = obj.geometry();
const report = {
  tolerance,
  sourceBoundary: meshQuality(e.rawBoundary),
  sourceBalloons: e.balloons.map((s) => meshQuality(e.raw(s))),
  previousSequential: meshQuality(old),
  previousCrossingAudit: auditCrossings(old, tolerance),
  updated: output.diagnostics,
  volumeBefore: signedVolume(old),
  volumeAfter: signedVolume(raw),
  rhinoRoundTrip: meshQuality(rhinoRaw(mesh)),
  checks: topology(raw),
  limitations: [
    "Stretched triangles remain; surface quality is not fully certified.",
    "Self-intersection freedom and fabrication readiness are not certified by edge topology alone.",
  ],
};
await fs.writeFile(
  path.join(directory, "mesh-quality-report.json"),
  JSON.stringify(
    report,
    (_, v) => (typeof v === "number" && !Number.isFinite(v) ? "unbounded" : v),
    2,
  ),
);
let objText = "o BalloonBuildCavities\n";
for (let i = 0; i < raw.positions.length; i += 3)
  objText += `v ${raw.positions[i]} ${raw.positions[i + 1]} ${raw.positions[i + 2]}\n`;
for (let i = 0; i < raw.indices.length; i += 3)
  objText += `f ${raw.indices[i] + 1} ${raw.indices[i + 1] + 1} ${raw.indices[i + 2] + 1}\n`;
await fs.writeFile(
  path.join(directory, "Balloon-Build-improved-cavities.obj"),
  objText,
);
console.log(
  JSON.stringify(
    {
      directory,
      previous: report.previousSequential,
      updated: output.diagnostics.after,
      rhinoRoundTrip: report.rhinoRoundTrip,
      elapsedMs: output.diagnostics.elapsedMs,
      volumeBefore: report.volumeBefore,
      volumeAfter: report.volumeAfter,
    },
    null,
    2,
  ),
);
mesh.delete();
obj.delete();
reopened.delete();
doc.delete();
e.clear();
