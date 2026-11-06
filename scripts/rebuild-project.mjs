import fs from "node:fs/promises";
import path from "node:path";
import Module from "manifold-3d";
import Rhino from "rhino3dm";
import { BalloonEngine, topology } from "../src/engine.js";
import { meshQuality } from "../src/mesh-quality.js";
import { addRhinoMesh, rhinoRaw } from "../src/rhino-io.js";
const project = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const resolution = Number(process.argv[3] || 160);
const directory = path.resolve(
  process.argv[4] || "../balloon-build-volume-review",
);
await fs.mkdir(directory, { recursive: true });
const m = await Module();
m.setup();
const engine = new BalloonEngine(m);
engine.loadSession(project.session);
const output = engine.output(
  "boolean",
  project.params.tolerance || 0.0001,
  "rebuild",
  () => {},
  resolution,
);
const raw = output.shells[0],
  r = await Rhino(),
  doc = new r.File3dm();
addRhinoMesh(r, doc, raw, "Balloon Build / approximate volume reconstruction");
const bytes = doc.toByteArray();
await fs.writeFile(
  path.join(directory, "Balloon-Build-volume-rebuild.3dm"),
  bytes,
);
const read = r.File3dm.fromByteArray(bytes),
  obj = read.objects().get(0),
  mesh = obj.geometry();
const reference = m.Manifold.difference([engine.boundary, ...engine.balloons]);
const report = {
  ...output.diagnostics,
  checks: topology(raw),
  rhinoRoundTrip: meshQuality(rhinoRaw(mesh)),
  referenceVolume: reference.volume(),
  volumeChangePercent:
    (100 * (output.diagnostics.volume - reference.volume())) /
    reference.volume(),
};
await fs.writeFile(
  path.join(directory, "volume-rebuild-report.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
reference.delete();
mesh.delete();
obj.delete();
read.delete();
doc.delete();
engine.clear();
