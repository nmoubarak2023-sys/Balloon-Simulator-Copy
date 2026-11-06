import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import Rhino from "rhino3dm";
import { BalloonEngine, topology } from "../src/engine.js";
import { rhinoRaw, addRhinoMesh } from "../src/rhino-io.js";
const m = await Module();
m.setup();
for (const [name, centers] of [
  ["single", [[0, 0, 0]]],
  [
    "overlapping",
    [
      [-5, 0, 0],
      [5, 0, 0],
    ],
  ],
  ["wall contact", [[26, 0, 0]]],
]) {
  test(`volume rebuild ${name}: bounded triangles and closed oriented solid`, () => {
    const e = new BalloonEngine(m);
    e.boundary = m.Manifold.cube([60, 50, 40], true);
    e.rawBoundary = e.raw(e.boundary);
    e.balloons = centers.map((c) => m.Manifold.sphere(12, 48).translate(c));
    const before = e.balloons.map((s) => e.raw(s)),
      exact = m.Manifold.difference([e.boundary, ...e.balloons]);
    const output = e.output("boolean", 1e-4, "rebuild", () => {}, 40),
      q = output.diagnostics.after;
    assert.deepEqual(topology(output.shells[0]), {
      valid: true,
      closed: true,
      manifold: true,
    });
    assert.equal(q.degenerateFaces, 0);
    assert.equal(q.duplicateFaces, 0);
    assert.equal(q.nonManifoldEdges, 0);
    assert(
      q.longestEdge <= Math.sqrt(3) * output.diagnostics.cellSize * (1 + 1e-8),
    );
    assert(
      Math.abs(output.diagnostics.volume - exact.volume()) / exact.volume() <
        0.04,
    );
    assert.equal(output.diagnostics.approximation, true);
    assert.match(output.message, /not an exact Boolean/);
    assert.deepEqual(
      e.balloons.map((s) => e.raw(s)),
      before,
    );
    exact.delete();
    e.clear();
  });
}
test("rebuild preserves a box-scale volume and rejects unbounded grid settings", () => {
  const e = new BalloonEngine(m);
  e.boundary = m.Manifold.cube([60, 50, 40], true);
  e.rawBoundary = e.raw(e.boundary);
  const o = e.output("boolean", 1e-4, "rebuild", () => {}, 32);
  assert(
    Math.abs(o.diagnostics.volume - e.boundary.volume()) / e.boundary.volume() <
      0.02,
  );
  assert.throws(
    () => e.output("boolean", 1e-4, "rebuild", () => {}, 1000),
    /32 to 256/,
  );
  e.clear();
});
test("rebuilt Rhino mesh retains the exact reconstructed coordinates and connectivity", async () => {
  const r = await Rhino(),
    e = new BalloonEngine(m);
  e.boundary = m.Manifold.cube([60, 50, 40], true);
  e.rawBoundary = e.raw(e.boundary);
  e.balloons = [m.Manifold.sphere(12, 48).translate([24, 0, 0])];
  const o = e.output("boolean", 1e-4, "rebuild", () => {}, 32),
    raw = o.shells[0],
    doc = new r.File3dm();
  addRhinoMesh(r, doc, raw, "Rebuilt cavity");
  const read = r.File3dm.fromByteArray(doc.toByteArray()),
    obj = read.objects().get(0),
    mesh = obj.geometry();
  const again = rhinoRaw(mesh);
  assert.deepEqual(again.positions, raw.positions);
  assert.deepEqual(again.indices, raw.indices);
  assert.deepEqual(topology(again), {
    valid: true,
    closed: true,
    manifold: true,
  });
  mesh.delete();
  obj.delete();
  read.delete();
  doc.delete();
  e.clear();
});
