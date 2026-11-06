import test from "node:test";
import assert from "node:assert/strict";
import { Matrix4, Quaternion, Vector3 } from "three";
import Module from "manifold-3d";
import {
  transformMesh,
  draggedEdit,
  uniformFactor,
  rotationMatrix,
  rotateClippingPlane,
} from "../src/interaction.js";
import { BalloonEngine, topology } from "../src/engine.js";
test("exact clipping increments rotate about world axes without moving or enabling the plane", () => {
  const start = {
    enabled: false,
    position: [12, -3, 8],
    quaternion: [0, 0, 0, 1],
  };
  const quarter = rotateClippingPlane(start, "X", 90);
  const normal = new Vector3(0, 0, 1).applyQuaternion(
    new Quaternion().fromArray(quarter.quaternion),
  );
  assert(normal.distanceTo(new Vector3(0, -1, 0)) < 1e-12);
  assert.deepEqual(quarter.position, start.position);
  assert.equal(quarter.enabled, false);
  let state = start;
  for (let i = 0; i < 4; i++) state = rotateClippingPlane(state, "Y", 90);
  assert(
    new Vector3(0, 0, 1)
      .applyQuaternion(new Quaternion().fromArray(state.quaternion))
      .distanceTo(new Vector3(0, 0, 1)) < 1e-12,
  );
  assert.throws(() => rotateClippingPlane(start, "Q", 90));
  assert.throws(() => rotateClippingPlane(start, "X", NaN));
});
test("exact degree presets rotate about the model center on each world axis", () => {
  const raw = {
      positions: new Float32Array([12, 23, 34]),
      indices: new Uint32Array(),
    },
    center = [10, 20, 30];
  for (const [axis, degrees, expected] of [
    ["Z", 90, [7, 22, 34]],
    ["Z", 180, [8, 17, 34]],
    ["Z", -90, [13, 18, 34]],
    ["X", 90, [12, 16, 33]],
    ["Y", 90, [14, 23, 28]],
  ])
    assert.deepEqual(
      Array.from(
        transformMesh(raw, rotationMatrix(center, axis, degrees)).positions,
      ),
      expected,
    );
  let rotated = raw;
  for (let i = 0; i < 4; i++)
    rotated = transformMesh(rotated, rotationMatrix(center, "Z", 90));
  assert.deepEqual(rotated.positions, raw.positions);
  assert.throws(() => rotationMatrix(center, "A", 90), /axis/);
  assert.throws(() => rotationMatrix(center, "Z", NaN), /finite/);
});
test("rotation changes imported mesh coordinates about its center and preserves closed volume", async () => {
  const m = await Module();
  m.setup();
  const e = new BalloonEngine(m),
    box = m.Manifold.cube([120, 90, 65], true).translate([20, 30, 40]),
    raw = e.raw(box),
    center = new Vector3(20, 30, 40),
    matrix = new Matrix4()
      .compose(
        center,
        new Quaternion().setFromAxisAngle(
          new Vector3(1, 1, 0).normalize(),
          0.6,
        ),
        new Vector3(1, 1, 1),
      )
      .multiply(new Matrix4().makeTranslation(-20, -30, -40)),
    rotated = transformMesh(raw, matrix.toArray()),
    solid = e.toSolid(rotated);
  assert.notDeepEqual(raw.positions, rotated.positions);
  assert.deepEqual(topology(rotated), {
    valid: true,
    closed: true,
    manifold: true,
  });
  assert(Math.abs(solid.volume() - box.volume()) < box.volume() * 1e-6);
  e.generate(
    rotated,
    {
      count: 6,
      pointSeed: 42,
      radiusSeed: 17,
      radiusMin: 14,
      radiusMax: 24,
      quality: 48,
      clearance: 0.12,
      pressureEnabled: false,
    },
    [],
  );
  for (let i = 0; i < 6; i++) assert(e.safe(i, e.balloons[i]));
  box.delete();
  solid.delete();
  e.clear();
});
test("successive canvas drags use accepted offsets and uniform scaling", () => {
  assert.deepEqual(
    draggedEdit([4, -2, 1, 0.8], [2, 3, -4], 1.5),
    [6, 1, -3, 1.2000000000000002],
  );
  assert.equal(uniformFactor([1, 1.5, 1]), 1.5);
  assert.equal(uniformFactor([0.7, 1, 1]), 0.7);
  assert.equal(draggedEdit([0, 0, 0, 2], [0, 0, 0], 5)[3], 3);
  assert.throws(() => draggedEdit([0, 0, 0, 1], [NaN, 0, 0]), /Invalid/);
});
