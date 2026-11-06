import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import { BalloonEngine } from "../src/engine.js";
const m = await Module();
m.setup();
const p = {
  count: 12,
  pointSeed: 42,
  radiusSeed: 17,
  radiusMin: 14,
  radiusMax: 24,
  quality: 80,
  clearance: 0.12,
  pressureEnabled: false,
};
function fixture(angle = 17) {
  const e = new BalloonEngine(m),
    box = m.Manifold.cube([120, 90, 65], true).rotate([
      angle,
      angle / 2,
      angle / 3,
    ]),
    raw = e.raw(box);
  box.delete();
  e.generate(raw, p, []);
  return e;
}
test("native operation copies preserve precision in tilted containers and support Freeze, Pop, and Merge", () => {
  let current = fixture();
  const transact = (fn) => {
    const copy = current.fork();
    try {
      const result = fn(copy);
      current.clear();
      current = copy;
      return result;
    } catch (err) {
      copy.clear();
      throw err;
    }
  };
  const initialVolume = current.balloons[0].volume();
  transact((e) => e.freeze(0));
  assert.equal(current.balloons[0].volume(), initialVolume);
  transact((e) => e.pop(1, 0));
  assert.equal(current.balloons.length, 11);
  assert.equal(current.meta[0].frozen, true);
  const pairs = [];
  for (let i = 1; i < current.balloons.length; i++)
    for (let j = i + 1; j < current.balloons.length; j++) {
      const gap = current.balloons[i].minGap(current.balloons[j], 3);
      if (gap < 3) pairs.push({ indices: [i, j], gap });
    }
  pairs.sort((a, b) => a.gap - b.gap);
  const merged = transact((e) => e.merge(pairs[0].indices));
  assert.equal(merged.balloons.length, 10);
  assert.equal(current.balloons[0].volume(), initialVolume);
  current.clear();
});
test("rounded JSON state reloads at sloped wall contacts, including pop pressure adjustment", () => {
  for (const angle of [17, 45]) {
    const e = fixture(angle),
      f = new BalloonEngine(m),
      state = JSON.parse(
        JSON.stringify(e.session(), (_, v) =>
          ArrayBuffer.isView(v) ? Array.from(v) : v,
        ),
      );
    f.loadSession(state);
    assert.equal(f.balloons.length, 12);
    f.pop(0, 0);
    f.changePopPressure(0.1);
    assert.equal(f.balloons.length, 11);
    assert.equal(f.popEvents.length, 1);
    e.clear();
    f.clear();
  }
});
test("saved-file rounding allowance still rejects substantial wall crossings and overlaps", () => {
  const e = fixture(),
    state = e.session(),
    f = new BalloonEngine(m);
  const outside = {
    ...state,
    balloons: state.balloons.map((raw, i) =>
      i
        ? raw
        : {
            ...raw,
            positions: Float32Array.from(
              raw.positions,
              (v, k) => v + (k % 3 === 0 ? 500 : 0),
            ),
          },
    ),
  };
  assert.throws(
    () => f.loadSession(outside),
    /larger than.*rounding tolerance/,
  );
  f.clear();
  const overlap = {
    ...state,
    balloons: state.balloons.map((raw, i) =>
      i === 1 ? state.balloons[0] : raw,
    ),
  };
  assert.throws(
    () => f.loadSession(overlap),
    /larger than.*rounding tolerance/,
  );
  e.clear();
  f.clear();
});
test("regeneration keeps native frozen geometry unchanged at tilted walls", () => {
  const e = fixture();
  e.freeze(0);
  const previous = e.session(),
    volume = e.balloons[0].volume(),
    next = new BalloonEngine(m);
  next.generate(
    previous.boundary,
    { ...p, pressureEnabled: true, strength: 5, influence: 25 },
    [
      [-50, 0, 0],
      [50, 0, 0],
    ],
  );
  next.adoptLifecycle(previous, e);
  const i = next.meta.findIndex((m) => m.id === "b0");
  assert.equal(next.balloons[i].volume(), volume);
  assert.equal(next.meta[i].frozen, true);
  e.clear();
  next.clear();
});
test("a saved frozen balloon at a tilted wall can be reloaded and regenerated", () => {
  const e = fixture();
  e.freeze(0);
  const loaded = new BalloonEngine(m),
    state = JSON.parse(
      JSON.stringify(e.session(), (_, v) =>
        ArrayBuffer.isView(v) ? Array.from(v) : v,
      ),
    );
  loaded.loadSession(state);
  const saved = loaded.session(),
    next = new BalloonEngine(m);
  next.generate(saved.boundary, p, []);
  next.adoptLifecycle(saved, loaded);
  const i = next.meta.findIndex((meta) => meta.id === "b0");
  assert.equal(next.balloons[i].volume(), loaded.balloons[0].volume());
  assert.equal(next.meta[i].frozen, true);
  e.clear();
  loaded.clear();
  next.clear();
});
test("reapplying an imported transform does not treat a rounding skin as a wall collision", () => {
  const e = fixture(),
    loaded = new BalloonEngine(m);
  loaded.loadSession(e.session());
  const index = loaded.balloons.findIndex((s, i) => !loaded.safe(i, s));
  assert(index >= 0, "Fixture must include a rounded sloped-wall contact.");
  const result = loaded.edit(index, loaded.edits[index].slice());
  assert.equal(result.clamped, false);
  assert(
    loaded.safe(index, loaded.balloons[index], loaded.positionErrorTolerance),
  );
  e.clear();
  loaded.clear();
});
