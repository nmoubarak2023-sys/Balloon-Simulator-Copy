import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import { BalloonEngine, topology } from "../src/engine.js";
import initRhino from "rhino3dm";
import { addRhinoMesh, rhinoRaw } from "../src/rhino-io.js";
const m = await Module();
m.setup();
const params = {
  count: 4,
  pointSeed: 42,
  radiusSeed: 17,
  radiusMin: 10,
  radiusMax: 10,
  quality: 48,
  clearance: 0.1,
  pressureEnabled: false,
  strength: 6,
  influence: 20,
};
function fixture() {
  const e = new BalloonEngine(m),
    box = m.Manifold.cube([120, 120, 80], true),
    boundary = e.raw(box);
  box.delete();
  e.generate(boundary, params, []);
  const state = e.session(),
    centers = [
      [-10, 0, 0],
      [10.1, 0, 0],
      [-10, 20.1, 0],
      [35, 35, 0],
    ],
    balloons = centers.map((c) => {
      const s = m.Manifold.sphere(10, 48).translate(c),
        raw = e.raw(s);
      s.delete();
      return raw;
    });
  state.balloons = balloons;
  state.base = balloons;
  state.centers = centers;
  e.loadSession(state);
  return e;
}
test("Pop removes the target, dents unfrozen neighbors only, and slider adjustments do not accumulate", () => {
  const e = fixture();
  e.freeze(2);
  const original = e.session(),
    frozen = e.balloons[2].volume(),
    far = e.balloons[3].volume(),
    neighbor = e.balloons[1].volume();
  const result = e.pop(0, 0.2);
  assert.equal(result.balloons.length, 3);
  assert.deepEqual(result.popped, [0]);
  assert(e.balloons[0].volume() < neighbor);
  assert.equal(e.balloons[1].volume(), frozen);
  assert.equal(e.balloons[2].volume(), far);
  const weak = e.balloons[0].volume();
  e.changePopPressure(0.8);
  assert(e.balloons[0].volume() < weak);
  assert.equal(e.popEvents.length, 1);
  e.changePopPressure(0);
  assert(Math.abs(e.balloons[0].volume() - neighbor) < 1e-6);
  assert.equal(e.meta[1].frozen, true);
  assert.deepEqual(
    e.raw(e.balloons[1]).positions,
    original.balloons[2].positions,
  );
  for (let i = 0; i < e.balloons.length; i++) assert(e.safe(i, e.balloons[i]));
  e.clear();
});
test("Freeze blocks direct transformations and survives curve regeneration and nearby pops", () => {
  const e = fixture();
  e.freeze(2);
  assert.throws(() => e.edit(2, [2, 0, 0, 1]), /frozen/);
  assert.throws(() => e.pop(2, 0.2), /frozen/);
  assert.throws(() => e.merge([1, 2]), /frozen/);
  e.pop(0, 0.5);
  const previous = e.session(),
    frozenIndex = previous.meta.findIndex((v) => v.id === "b2"),
    frozen = previous.balloons[frozenIndex];
  const next = new BalloonEngine(m);
  next.generate(previous.boundary, { ...params, pressureEnabled: true }, [
    [-50, 0, 0],
    [50, 0, 0],
  ]);
  next.adoptLifecycle(previous);
  const index = next.meta.findIndex((v) => v.id === "b2");
  assert.equal(next.meta[index].frozen, true);
  assert.deepEqual(next.raw(next.balloons[index]).positions, frozen.positions);
  assert(!next.meta.some((v) => v.members.includes(0)));
  for (let i = 0; i < next.balloons.length; i++)
    assert(next.safe(i, next.balloons[i]));
  next.freeze(index);
  assert.equal(next.meta[index].frozen, false);
  e.clear();
  next.clear();
});
test("Merge fills a contact gap and produces one solid, with no interior shell interface", () => {
  const e = fixture(),
    before = e.balloons[0].volume() + e.balloons[1].volume();
  const result = e.merge([0, 1]);
  assert.equal(result.balloons.length, 3);
  assert.deepEqual(result.meta[0].members, [0, 1]);
  const parts = e.balloons[0].decompose();
  assert.equal(parts.length, 1);
  parts.forEach((p) => p.delete());
  assert(e.balloons[0].volume() > before);
  assert.deepEqual(topology(result.balloons[0]), {
    valid: true,
    closed: true,
    manifold: true,
  });
  for (let i = 0; i < 3; i++) assert(e.safe(i, e.balloons[i]));
  const out = e.output("boolean", 0.0001);
  assert.equal(out.mode, "boolean");
  e.clear();
});
test("distant or frozen balloons cannot be merged and existing geometry is preserved", () => {
  const e = fixture(),
    before = e.session();
  assert.throws(() => e.merge([0, 3]), /closer|nearby/);
  assert.deepEqual(e.session().balloons, before.balloons);
  e.freeze(0);
  assert.throws(() => e.merge([0, 1]), /frozen/);
  e.clear();
});
test("project state preserves merged/frozen/popped geometry and exports the merged Rhino volume", async () => {
  const e = fixture();
  e.merge([0, 1]);
  e.freeze(0);
  e.pop(1, 0.5);
  const state = JSON.parse(
      JSON.stringify(e.session(), (_, v) =>
        ArrayBuffer.isView(v) ? Array.from(v) : v,
      ),
    ),
    restored = new BalloonEngine(m);
  restored.loadSession(state);
  assert.deepEqual(restored.meta, e.meta);
  assert.deepEqual(restored.popped, [2]);
  assert.equal(restored.balloons.length, 2);
  assert(
    Math.abs(restored.balloons[0].volume() - e.balloons[0].volume()) < 1e-6,
  );
  const r = await initRhino(),
    doc = new r.File3dm();
  addRhinoMesh(r, doc, restored.raw(restored.balloons[0]), "Merged");
  const read = r.File3dm.fromByteArray(doc.toByteArray()),
    obj = read.objects().get(0),
    mesh = obj.geometry();
  assert.equal(topology(rhinoRaw(mesh)).closed, true);
  mesh.delete();
  obj.delete();
  read.delete();
  doc.delete();
  e.clear();
  restored.clear();
});
test("popping all balloons leaves an exportable original boundary", () => {
  const e = fixture();
  while (e.balloons.length) e.pop(0, 0);
  assert.equal(e.snapshot().balloons.length, 0);
  assert.equal(e.output("shell", 0.0001).shells.length, 1);
  const out = e.output("boolean", 0.0001);
  assert.equal(out.checks.closed, true);
  e.clear();
});
test("several touching neighbors merge into one connected group", () => {
  const e = fixture(),
    result = e.merge([0, 1, 2]);
  assert.equal(result.balloons.length, 2);
  assert.deepEqual(result.meta[0].members, [0, 1, 2]);
  const pieces = e.balloons[0].decompose();
  assert.equal(pieces.length, 1);
  pieces.forEach((p) => p.delete());
  assert(e.safe(0, e.balloons[0]));
  e.clear();
});
test("the default generated contact gap can be merged, not just sphere fixtures", () => {
  const e = new BalloonEngine(m),
    box = m.Manifold.cube([120, 90, 65], true),
    raw = e.raw(box);
  box.delete();
  e.generate(
    raw,
    {
      ...params,
      count: 12,
      radiusMin: 14,
      radiusMax: 24,
      quality: 80,
      clearance: 0.12,
    },
    [],
  );
  let pair,
    best = Infinity;
  for (let i = 0; i < 12; i++)
    for (let j = i + 1; j < 12; j++) {
      const gap = e.balloons[i].minGap(e.balloons[j], 5);
      if (gap < best) {
        best = gap;
        pair = [i, j];
      }
    }
  const result = e.merge(pair);
  assert.equal(result.balloons.length, 11);
  assert(e.safe(result.selectedIndex, e.balloons[result.selectedIndex]));
  e.clear();
});
test("a boundary change cannot silently move or trim frozen geometry", () => {
  const e = fixture();
  e.freeze(0);
  const saved = e.session(),
    next = new BalloonEngine(m),
    box = m.Manifold.cube([20, 20, 20], true).translate([35, 35, 0]),
    raw = next.raw(box);
  box.delete();
  next.generate(raw, { ...params, count: 1, radiusMin: 3, radiusMax: 4 }, []);
  assert.throws(() => next.adoptLifecycle(saved), /frozen balloon/);
  assert.deepEqual(e.session().balloons, saved.balloons);
  e.clear();
  next.clear();
});
