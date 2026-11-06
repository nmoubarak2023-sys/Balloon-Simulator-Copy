import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import { BalloonEngine, closestPolyline } from "../src/engine.js";
import { validateCurves, iterationSummary } from "../src/iterations.js";
const m = await Module();
m.setup();
test("multiple attractors do not create a phantom segment between separate curves", () => {
  const a = [
      [-10, -1, 0],
      [-10, 1, 0],
    ],
    b = [
      [10, -1, 0],
      [10, 1, 0],
    ];
  assert.equal(closestPolyline([0, 0, 0], [a, b]), 10);
  assert.equal(closestPolyline([10, 0, 0], [a, b]), 0);
  assert.equal(closestPolyline([0, 0, 0], a), 10);
});
test("curve validation accepts five independent curves and rejects excessive or malformed data", () => {
  const curves = Array.from({ length: 5 }, (_, i) => [
    [i, 0, 0],
    [i, 1, 0],
  ]);
  const copy = validateCurves(curves);
  copy[0][0][0] = 99;
  assert.equal(curves[0][0][0], 0);
  assert.throws(() => validateCurves([...curves, curves[0]]));
  assert.throws(() =>
    validateCurves([
      [
        [NaN, 0, 0],
        [1, 0, 0],
      ],
    ]),
  );
});
test("a second curve affects pressure and saved session geometry survives restoration", () => {
  const e = new BalloonEngine(m),
    box = m.Manifold.cube([40, 40, 40], true),
    raw = e.raw(box);
  box.delete();
  const p = {
    count: 3,
    pointSeed: 42,
    radiusMin: 8,
    radiusMax: 10,
    radiusSeed: 17,
    quality: 32,
    clearance: 0.1,
    strength: 4,
    influence: 30,
    pressureEnabled: true,
  };
  const far = [
      [-100, -100, 0],
      [-100, 100, 0],
    ],
    near = [
      [-20, 0, 0],
      [20, 0, 0],
    ];
  e.generate(raw, p, [far]);
  const before = e.balloons.reduce((s, b) => s + b.volume(), 0);
  e.generate(raw, p, [far, near]);
  const after = e.balloons.reduce((s, b) => s + b.volume(), 0);
  assert(after < before);
  const state = e.session(),
    restored = new BalloonEngine(m);
  restored.loadSession(state);
  assert(
    Math.abs(restored.balloons.reduce((s, b) => s + b.volume(), 0) - after) <
      after * 1e-7,
  );
  e.clear();
  restored.clear();
});
test("iteration report distinguishes generated settings and unapplied sliders and reports actual arrangement", () => {
  const report = iterationSummary({
    params: { count: 1 },
    controlSettings: { count: 2 },
    curves: [
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
    ],
    session: {
      balloons: [{ positions: [0, 0, 0, 2, 3, 4], indices: [] }],
      centers: [[1, 2, 3]],
      edits: [[5, 6, 7, 1]],
      meta: [{ frozen: true, members: [0] }],
    },
  });
  assert.equal(report.generatedSettings.count, 1);
  assert.equal(report.currentControlSettings.count, 2);
  assert.deepEqual(report.balloons[0].currentCenter, [6, 8, 10]);
  assert.equal(report.balloons[0].bounds[2].size, 4);
});
