import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import {
  BalloonEngine,
  populate,
  canonical,
  topology,
  spatial,
} from "../src/engine.js";
import initRhino from "rhino3dm";
import { rhinoRaw, addRhinoMesh } from "../src/rhino-io.js";
const m = await Module();
m.setup();
function fixture() {
  const e = new BalloonEngine(m),
    s = m.Manifold.cube([120, 90, 65], true),
    raw = e.raw(s);
  s.delete();
  return { e, raw };
}
const params = {
  count: 12,
  pointSeed: 42,
  radiusSeed: 17,
  radiusMin: 14,
  radiusMax: 24,
  quality: 80,
  clearance: 0.12,
  pressureEnabled: false,
  strength: 8,
  influence: 25,
};
test("sampling is deterministic and strictly inside volume", () => {
  const { e, raw } = fixture(),
    a = populate(raw, 20, 42),
    b = populate(raw, 20, 42),
    c = populate(raw, 20, 43),
    s = spatial(raw);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert(a.every((p) => s.inside(p)));
  s.dispose();
  e.clear();
});
test("non-watertight Boolean output can be written to Rhino with explicit warnings", async () => {
  const { e, raw } = fixture();
  e.generate(raw, { ...params, count: 2, quality: 48 }, []);
  // Reproduce an open serialized result without weakening the solid kernel.
  const original = e.raw.bind(e);
  e.raw = (s) => {
    const result = original(s);
    return { ...result, indices: result.indices.slice(3) };
  };
  const output = e.output("boolean", 0.0001);
  assert.equal(output.incomplete, true);
  assert.equal(output.checks.closed, false);
  assert.match(output.message, /Export is allowed/);
  assert.equal(output.shells.length, 1);
  const r = await initRhino(),
    doc = new r.File3dm();
  addRhinoMesh(r, doc, output.shells[0], "Incomplete Boolean");
  const reopened = r.File3dm.fromByteArray(doc.toByteArray()),
    obj = reopened.objects().get(0),
    mesh = obj.geometry();
  assert.equal(topology(rhinoRaw(mesh)).closed, false);
  mesh.delete();
  obj.delete();
  reopened.delete();
  doc.delete();
  e.clear();
});
test("open boundary rejected", () => {
  const { e, raw } = fixture();
  assert.throws(
    () => canonical({ ...raw, indices: raw.indices.slice(3) }),
    /closed/,
  );
  e.clear();
});
test("full demo has closed nonoverlapping contained meshes, stable seeds, Boolean and shell semantics", () => {
  const { e, raw } = fixture();
  const a = e.generate(raw, params, []);
  assert.equal(a.balloons.length, 12);
  for (const b of a.balloons)
    assert.deepEqual(topology(b), {
      valid: true,
      closed: true,
      manifold: true,
    });
  assert(a.balloons.reduce((n, b) => n + b.indices.length / 3, 0) > 20000);
  for (let i = 0; i < e.balloons.length; i++) {
    assert(e.safe(i, e.balloons[i]));
  }
  const shell = e.output("shell", 0.0001);
  assert.equal(shell.shells.length, 13);
  const out = e.output("boolean", 0.0001);
  assert.deepEqual(out.checks, { valid: true, closed: true, manifold: true });
  const result = e.toSolid(out.shells[0]);
  const expected =
    e.boundary.volume() - e.balloons.reduce((v, b) => v + b.volume(), 0);
  assert(Math.abs(result.volume() - expected) < Math.abs(expected) * 1e-5);
  result.delete();
  const b = e.generate(raw, params, []);
  assert.deepEqual(a.balloons, b.balloons);
  e.clear();
});
test("curve pressure changes geometry and keeps invariants; individual moves clamp safely", () => {
  const { e, raw } = fixture();
  const p = { ...params, count: 5, quality: 48 },
    a = e.generate(raw, p, []),
    curve = [
      [-60, 0, 0],
      [60, 0, 0],
    ];
  const b = e.generate(
    raw,
    { ...p, pressureEnabled: true, strength: 12, influence: 50 },
    curve,
  );
  assert.notDeepEqual(a.balloons, b.balloons);
  for (let i = 0; i < 5; i++) assert(e.safe(i, e.balloons[i]));
  const edited = e.edit(0, [1000, 0, 0, 2]);
  assert(edited.clamped);
  assert(edited.edits[0][0] < 1000);
  assert(e.safe(0, e.balloons[0]));
  const reset = e.edit(0, [0, 0, 0, 1]);
  assert(reset.edits[0].every((v, i) => Math.abs(v - [0, 0, 0, 1][i]) < 1e-4));
  e.clear();
});
test("concave wall intersections are clipped, not just vertex tested", () => {
  const e = new BalloonEngine(m),
    a = m.Manifold.cube([100, 60, 60], true),
    b = m.Manifold.cube([50, 30, 80], true).translate([35, 20, 0]),
    container = a.subtract(b),
    raw = e.raw(container);
  const data = e.generate(raw, { ...params, count: 8, quality: 48 }, []);
  assert.equal(data.balloons.length, 8);
  for (let i = 0; i < 8; i++) assert(e.safe(i, e.balloons[i]));
  a.delete();
  b.delete();
  container.delete();
  e.clear();
});
test("Rhino .3dm mesh roundtrip preserves geometry", async () => {
  const r = await initRhino(),
    { e, raw } = fixture(),
    doc = new r.File3dm();
  addRhinoMesh(r, doc, raw, "Boundary");
  const bytes = doc.toByteArray(),
    read = r.File3dm.fromByteArray(bytes);
  assert.equal(read.objects().count, 1);
  const obj = read.objects().get(0),
    mesh = obj.geometry();
  assert(mesh instanceof r.Mesh);
  const restored = canonical(rhinoRaw(mesh));
  assert.deepEqual(topology(restored), {
    valid: true,
    closed: true,
    manifold: true,
  });
  assert.equal(restored.indices.length, raw.indices.length);
  assert.deepEqual(Array.from(restored.positions), Array.from(raw.positions));
  mesh.delete();
  obj.delete();
  doc.delete();
  read.delete();
  e.clear();
});
test("project restore preserves final edit records and geometry", () => {
  const { e, raw } = fixture();
  e.generate(raw, { ...params, count: 5 }, []);
  e.edit(0, [2, 1, 0, 0.9]);
  e.edit(2, [-1, 0, 0, 0.8]);
  const a = e.snapshot(),
    f = new BalloonEngine(m),
    b = f.restore(raw, { ...params, count: 5 }, [], a.edits);
  assert.deepEqual(a.edits, b.edits);
  for (let i = 0; i < a.balloons.length; i++) {
    assert.equal(a.balloons[i].indices.length, b.balloons[i].indices.length);
    assert(f.safe(i, f.balloons[i]));
  }
  e.clear();
  f.clear();
});
