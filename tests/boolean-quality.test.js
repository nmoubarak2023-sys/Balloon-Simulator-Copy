import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import Rhino from "rhino3dm";
import { BalloonEngine, topology } from "../src/engine.js";
import {
  meshQuality,
  signedVolume,
  conditionMesh,
} from "../src/mesh-quality.js";
import { addRhinoMesh, rhinoRaw } from "../src/rhino-io.js";
import { auditCrossings } from "../src/intersection-audit.js";
const m = await Module();
m.setup();
const scenarios = {
  single: () => [m.Manifold.sphere(12, 48)],
  overlapping: () =>
    [-6, 6].map((x) => m.Manifold.sphere(12, 48).translate([x, 0, 0])),
  complex: () =>
    Array.from({ length: 7 }, (_, i) =>
      m.Manifold.sphere(10, 48).translate([
        Math.cos(i) * 10,
        Math.sin(i) * 10,
        ((i % 3) - 1) * 3,
      ]),
    ),
  creased: () => [
    m.Manifold.sphere(14, 64)
      .warp((v) => {
        v[2] *= v[0] > 0 ? 0.5 : 1;
      })
      .trimByPlane([1, 0, 0], -6),
  ],
  boundary: () => [m.Manifold.sphere(16, 64).translate([20, 0, 0])],
  tangent: () => [
    m.Manifold.sphere(10, 48).translate([20, 0, 0]),
    m.Manifold.cube([10, 10, 10], true).translate([25, 0, 0]),
  ],
  highResolution: () => [
    m.Manifold.sphere(14, 128),
    m.Manifold.sphere(10, 96).translate([15, 0, 0]),
  ],
};
for (const [name, make] of Object.entries(scenarios))
  test(`Boolean quality: ${name} preserves intended volume and closed oriented topology`, () => {
    const e = new BalloonEngine(m);
    e.boundary = m.Manifold.cube([60, 60, 60], true);
    e.rawBoundary = e.raw(e.boundary);
    e.balloons = make();
    const original = e.balloons.map((s) => e.raw(s)),
      reference = m.Manifold.difference([e.boundary, ...e.balloons]);
    const output = e.output("boolean", 1e-5, "final"),
      raw = output.shells[0],
      q = meshQuality(raw);
    assert.deepEqual(topology(raw), {
      valid: true,
      closed: true,
      manifold: true,
    });
    assert.equal(q.degenerateFaces, 0);
    assert.equal(q.duplicateFaces, 0);
    assert.equal(q.nonManifoldEdges, 0);
    assert.equal(q.inconsistentEdges, 0);
    assert.equal(output.diagnostics.intersectionAudit.properCrossings, 0);
    assert(
      Math.abs(signedVolume(raw) - reference.volume()) <
        Math.max(1e-3, reference.volume() * 1e-6),
    );
    // Solid-minus-void set membership, rather than only signed-volume equality.
    const reconstructed = e.toSolid(raw),
      extra = reconstructed.subtract(reference),
      missing = reference.subtract(reconstructed);
    assert(
      extra.volume() + missing.volume() <
        Math.max(0.01, reference.volume() * 1e-5),
    );
    assert.deepEqual(
      e.balloons.map((s) => e.raw(s)),
      original,
    );
    reconstructed.delete();
    extra.delete();
    missing.delete();
    reference.delete();
    e.clear();
  });

test("conditioning improves planar triangulation without moving sharp box corners", () => {
  const e = new BalloonEngine(m),
    s = m.Manifold.cube([100, 20, 10], true),
    raw = e.raw(s);
  const out = conditionMesh(raw, { targetLength: 10, tolerance: 1e-8 });
  assert.deepEqual(topology(out.raw), {
    valid: true,
    closed: true,
    manifold: true,
  });
  assert(Math.abs(signedVolume(out.raw) - signedVolume(raw)) < 1e-8);
  for (let i = 0; i < raw.positions.length; i += 3) {
    const v = Array.from(raw.positions.slice(i, i + 3));
    assert(
      Array.from({ length: out.raw.positions.length / 3 }, (_, j) =>
        Array.from(out.raw.positions.slice(j * 3, j * 3 + 3)),
      ).some((p) => p.every((x, k) => x === v[k])),
    );
  }
  s.delete();
  e.clear();
});

test("final Boolean Rhino round trip keeps exact triangle connectivity and coordinates", async () => {
  const r = await Rhino(),
    e = new BalloonEngine(m);
  e.boundary = m.Manifold.cube([60, 60, 60], true);
  e.rawBoundary = e.raw(e.boundary);
  e.balloons = scenarios.overlapping();
  const output = e.output("boolean", 1e-5),
    raw = output.shells[0],
    doc = new r.File3dm();
  addRhinoMesh(r, doc, raw, "Verified cavities");
  const reopened = r.File3dm.fromByteArray(doc.toByteArray()),
    obj = reopened.objects().get(0),
    mesh = obj.geometry(),
    again = rhinoRaw(mesh);
  assert.deepEqual(Array.from(again.indices), Array.from(raw.indices));
  assert.deepEqual(Array.from(again.positions), Array.from(raw.positions));
  assert.deepEqual(topology(again), {
    valid: true,
    closed: true,
    manifold: true,
  });
  mesh.delete();
  obj.delete();
  reopened.delete();
  doc.delete();
  e.clear();
});

test("reports damaged or extremely thin geometry rather than silently certifying surface quality", () => {
  const e = new BalloonEngine(m);
  e.boundary = m.Manifold.cube([60, 60, 60], true);
  e.rawBoundary = e.raw(e.boundary);
  e.balloons = [m.Manifold.sphere(10, 48)];
  const output = e.output("boolean", 1e-5, "preview");
  assert(output.diagnostics.after);
  assert(output.message.includes("Degenerate:"));
  assert.throws(() => e.output("boolean", -1), /positive/);
  e.clear();
});

test("geometric audit detects intersecting interiors which edge checks alone miss", () => {
  const raw = {
    positions: new Float64Array([
      -1, -1, 0, 1, -1, 0, 0, 1, 0, 0, -0.5, -1, 0, -0.5, 1, 0.5, 0.5, 0,
    ]),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
  };
  assert.equal(auditCrossings(raw, 1e-6).properCrossings, 1);
});
