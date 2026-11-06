import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import { BalloonEngine } from "../src/engine.js";
import {
  GeometryHistory,
  UndoJournal,
  isUndoShortcut,
} from "../src/history.js";
const m = await Module();
m.setup();
const params = {
  count: 3,
  pointSeed: 42,
  radiusSeed: 17,
  radiusMin: 10,
  radiusMax: 10,
  quality: 48,
  clearance: 0.1,
  pressureEnabled: false,
};
function fixture() {
  const e = new BalloonEngine(m),
    box = m.Manifold.cube([120, 100, 80], true),
    raw = e.raw(box);
  box.delete();
  e.generate(raw, params, []);
  const state = e.session(),
    centers = [
      [-10, 0, 0],
      [10.1, 0, 0],
      [-10, 25, 0],
    ],
    balloons = centers.map((c) => {
      const s = m.Manifold.sphere(10, 48).translate(c),
        raw = e.raw(s);
      s.delete();
      return raw;
    });
  e.loadSession({ ...state, centers, balloons, base: balloons });
  return e;
}
test("dragged balloon reaches a position overlapping an unfrozen neighbor by deforming that neighbor", () => {
  const e = fixture(),
    before = e.balloons.map((s) => s.volume()),
    result = e.edit(0, [8, 0, 0, 1]);
  assert.equal(result.clamped, false);
  assert.equal(result.edits[0][0], 8);
  assert.equal(result.deformedNeighbors, 1);
  assert.equal(e.balloons[0].volume(), before[0]);
  assert(e.balloons[1].volume() < before[1]);
  assert.equal(e.balloons[2].volume(), before[2]);
  for (let i = 0; i < 3; i++) assert(e.safe(i, e.balloons[i]));
  e.clear();
});
test("frozen neighbors remain unchanged and can still limit a movement", () => {
  const e = fixture();
  e.freeze(1);
  const before = e.raw(e.balloons[1]),
    result = e.edit(0, [8, 0, 0, 1]);
  assert(result.clamped);
  assert(result.edits[0][0] < 0.11);
  assert.equal(result.deformedNeighbors, 0);
  assert.deepEqual(e.raw(e.balloons[1]), before);
  for (let i = 0; i < 3; i++) assert(e.safe(i, e.balloons[i]));
  e.clear();
});

test("contact dents recover on retreat without changing rest shapes or independent edits", () => {
  const e = fixture();
  e.edit(1, [0, 1, 0, 1]);
  const original = e.raw(e.balloons[1]);
  const base = e.raw(e.base[1]);
  for (let cycle = 0; cycle < 3; cycle++) {
    e.edit(0, [8, 0, 0, 1]);
    assert(e.balloons[1].volume() < 4000);
    assert.deepEqual(e.raw(e.base[1]), base);
    e.edit(0, [0, 0, 0, 1]);
    assert.deepEqual(e.raw(e.balloons[1]), original);
    assert.deepEqual(e.edits[1], [0, 1, 0, 1]);
    for (let i = 0; i < 3; i++) assert(e.safe(i, e.balloons[i]));
  }
  e.clear();
});

test("saved contact dents recover after reload and frozen dents stay locked", () => {
  const e = fixture();
  const volume = e.balloons[1].volume();
  e.edit(0, [8, 0, 0, 1]);
  const loaded = new BalloonEngine(m);
  loaded.loadSession(e.session());
  loaded.edit(0, [0, 0, 0, 1]);
  assert(Math.abs(loaded.balloons[1].volume() - volume) < volume * 1e-6);
  loaded.clear();
  e.freeze(1);
  const frozen = e.raw(e.balloons[1]);
  e.edit(0, [0, 0, 0, 1]);
  assert.deepEqual(e.raw(e.balloons[1]), frozen);
  e.clear();
});

test("popping a contact source releases its temporary dent at zero pop pressure", () => {
  const e = fixture();
  const original = e.raw(e.balloons[1]);
  e.edit(0, [8, 0, 0, 1]);
  e.pop(0, 0);
  assert.deepEqual(e.raw(e.balloons[0]), original);
  e.clear();
});
test("wall constraints and minimum neighbor volume prevent destructive movements", () => {
  const e = fixture(),
    v = e.balloons[1].volume(),
    result = e.edit(0, [20, 0, 0, 1]);
  assert(result.clamped);
  assert(e.balloons[1].volume() >= v * 0.019999);
  assert(e.safe(0, e.balloons[0]));
  const wall = e.edit(0, [500, 0, 0, 1]);
  assert(wall.clamped);
  assert(wall.edits[0][0] < 500);
  for (let i = 0; i < 3; i++) assert(e.safe(i, e.balloons[i]));
  e.clear();
});
test("Undo restores the moving balloon and every neighbor in one native-precision step", () => {
  const h = new GeometryHistory(),
    original = fixture(),
    before = original.session(),
    volumes = original.balloons.map((s) => s.volume()),
    next = original.fork();
  next.edit(0, [8, 0, 0, 1]);
  let current = h.commit(original, next, "Move balloon");
  assert.equal(h.past.length, 1);
  current = h.undo(current);
  assert.deepEqual(current.session().balloons, before.balloons);
  assert.deepEqual(current.edits, before.edits);
  assert.deepEqual(
    current.balloons.map((s) => s.volume()),
    volumes,
  );
  current.clear();
  h.clear();
});
test("Undo reverses Pop, Freeze, and Merge while retaining previous state", () => {
  const h = new GeometryHistory();
  let current = fixture();
  const original = current.session();
  const transact = (label, fn) => {
    const next = current.fork();
    try {
      fn(next);
      current = h.commit(current, next, label);
    } catch (err) {
      next.clear();
      throw err;
    }
  };
  transact("Freeze", (e) => e.freeze(0));
  transact("Pop", (e) => e.pop(1, 0.25));
  assert.equal(current.balloons.length, 2);
  current = h.undo(current);
  assert.equal(current.balloons.length, 3);
  assert.equal(current.meta[0].frozen, true);
  current = h.undo(current);
  assert.equal(current.meta[0].frozen, false);
  transact("Merge", (e) => e.merge([0, 1]));
  assert.equal(current.balloons.length, 2);
  current = h.undo(current);
  assert.deepEqual(current.session().balloons, original.balloons);
  assert.deepEqual(current.meta, original.meta);
  current.clear();
  h.clear();
});
test("native undo history is bounded and empty Undo leaves current geometry intact", () => {
  const h = new GeometryHistory(2),
    first = fixture();
  let current = first;
  for (let i = 0; i < 3; i++) {
    const next = current.fork();
    next.freeze(0);
    current = h.commit(current, next, "Freeze");
  }
  assert.equal(h.past.length, 2);
  assert.equal(first.boundary, null);
  current = h.undo(current);
  assert.equal(current.meta[0].frozen, false);
  current = h.undo(current);
  assert.equal(current.meta[0].frozen, true);
  assert.throws(() => h.undo(current), /no model action/);
  assert(current.boundary);
  current.clear();
  h.clear();
});
test("UI and model undo entries share one ordered and bounded journal", () => {
  const j = new UndoJournal(2);
  j.push({ kind: "model", label: "Pop" });
  j.push({ kind: "ui", label: "Pressure slider" });
  j.push({ kind: "model", label: "Move" });
  assert.equal(j.length, 2);
  assert.equal(j.pop().label, "Move");
  assert.equal(j.pop().label, "Pressure slider");
  assert.equal(j.length, 0);
});
test("Ctrl+Z activates model Undo except during native text editing or redo shortcut", () => {
  const key = {
    key: "z",
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    target: { tagName: "CANVAS" },
  };
  assert(isUndoShortcut(key));
  assert(
    isUndoShortcut({ ...key, target: { tagName: "INPUT", type: "range" } }),
  );
  assert(
    !isUndoShortcut({ ...key, target: { tagName: "INPUT", type: "number" } }),
  );
  assert(!isUndoShortcut({ ...key, target: { tagName: "TEXTAREA" } }));
  assert(!isUndoShortcut({ ...key, target: { isContentEditable: true } }));
  assert(!isUndoShortcut({ ...key, shiftKey: true }));
  assert(!isUndoShortcut({ ...key, ctrlKey: false }));
});
test("Undo generation restores the previous boundary, parameters, and field geometry", () => {
  const h = new GeometryHistory(),
    original = fixture(),
    state = original.session(),
    next = new BalloonEngine(m),
    box = m.Manifold.cube([80, 75, 60], true).rotate([0, 0, 90]);
  next.generate(
    next.raw(box),
    { ...params, count: 2, radiusMin: 7, radiusMax: 9 },
    [],
  );
  box.delete();
  let current = h.commit(original, next, "Generate");
  assert.equal(current.balloons.length, 2);
  current = h.undo(current);
  assert.equal(current.balloons.length, 3);
  assert.deepEqual(current.params, state.params);
  assert.deepEqual(current.session().boundary, state.boundary);
  assert.deepEqual(current.session().balloons, state.balloons);
  current.clear();
  h.clear();
});
