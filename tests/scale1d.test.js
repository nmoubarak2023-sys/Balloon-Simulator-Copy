import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import { BalloonEngine, bounds } from "../src/engine.js";
import { structuredSphere } from "../src/balloon-surface.js";
import { scaleAxisEdit, validBalloonEdit } from "../src/balloon-edit.js";
import { draggedEdit } from "../src/interaction.js";
import { voronoiBuild } from "../src/voronoi-engine.js";
const m = await Module();
m.setup();
test("Scale1D changes only one world dimension and preserves position and uniform scale", () => {
  const e = new BalloonEngine(m),
    box = m.Manifold.cube([100, 100, 100], true);
  e.boundary = box;
  e.rawBoundary = e.raw(box);
  e.base = [e.toSolid(structuredSphere(10, 48))];
  e.balloons = [e.base[0].translate([0, 0, 0])];
  e.edits = [[2, 3, 4, 1.2]];
  e.centers = [[0, 0, 0]];
  e.initLifecycle({ count: 1, quality: 48 });
  e.balloons[0].delete();
  e.balloons[0] = e.candidate(0, e.edits[0]);
  const before = bounds(e.raw(e.balloons[0]));
  const changed = e.edit(0, scaleAxisEdit(e.edits[0], 0, 1.5)),
    after = bounds(e.raw(e.balloons[0]));
  assert.equal(changed.clamped, false);
  assert.ok(Math.abs(after.span[0] - before.span[0] * 1.5) < 1e-5);
  for (const k of [1, 2])
    assert.ok(Math.abs(after.span[k] - before.span[k]) < 1e-5);
  for (let k = 0; k < 3; k++)
    assert.ok(Math.abs(after.center[k] - before.center[k]) < 1e-5);
  assert.equal(e.edits[0][3], 1.2);
  const restored = new BalloonEngine(m);
  restored.loadSession(e.session());
  assert.deepEqual(restored.edits, e.edits);
  assert.equal(restored.safe(0, restored.balloons[0]), true);
  restored.clear();
  e.clear();
});
test("axis scales persist through move and uniform canvas commands, with legacy edits supported", () => {
  const edit = scaleAxisEdit([1, 2, 3, 1], 2, 1.6),
    moved = draggedEdit(edit, [2, 0, 0], 1.2);
  assert.deepEqual(moved, [3, 2, 3, 1.2, 1, 1, 1.6]);
  assert.deepEqual(
    draggedEdit(edit, [0, 0, 0], 1, [1, 0.5, 1]),
    [1, 2, 3, 1, 1, 0.5, 1.6],
  );
  assert.ok(validBalloonEdit([0, 0, 0, 1]));
  assert.ok(validBalloonEdit(edit));
  assert.equal(validBalloonEdit([0, 0, 0, 1, 0, 1, 1]), false);
});
test("Voronoi axis scaling updates only the chosen balloon dimension and retains closed output", () => {
  const p = {
    width: 40,
    height: 25,
    count: 5,
    seed: 42,
    index: 0,
    selected: 1,
    radiusMin: 8,
    radiusMax: 8,
    radiusSeed: 17,
    floor: 0,
    spacing: 2,
    smoothing: 4,
  };
  // Use native pressure path for both comparisons so tessellation is identical.
  const pressure = {
    pressureEnabled: true,
    strength: 1,
    influence: 12,
    curves: [
      [
        [0, 0, 0],
        [40, 25, 0],
      ],
    ],
  };
  const base = voronoiBuild(m, { ...p, ...pressure }),
    id = base.ids[0];
  const scaled = voronoiBuild(m, {
    ...p,
    ...pressure,
    edits: { [id]: [0, 0, 0, 1, 1.4, 1, 1] },
  });
  const a = bounds(base.spheres[0].raw),
    b = bounds(scaled.spheres[0].raw);
  assert.ok(Math.abs(b.span[0] - a.span[0] * 1.4) < 1e-4);
  assert.ok(Math.abs(b.span[1] - a.span[1]) < 1e-5);
  assert.ok(Math.abs(b.span[2] - a.span[2]) < 1e-5);
  assert.equal(scaled.closed, true);
  assert.deepEqual(scaled.ids, base.ids);
});
