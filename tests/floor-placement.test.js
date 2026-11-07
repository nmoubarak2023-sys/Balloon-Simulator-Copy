import test from "node:test";
import assert from "node:assert/strict";
import { placeSavedFloor } from "../src/floor-placement.js";
test("legacy saved floor moves all geometry and editable state together without mutating source", () => {
  const mesh = {
    positions: new Float64Array([1, 2, 0, 3, 4, 5]),
    indices: new Uint32Array([0, 1, 0]),
  };
  const frozen = { center: [1, 2, 5], raw: structuredClone(mesh) };
  const data = {
    result: {
      params: {
        floor: 0,
        curves: [[[1, 2, 3]]],
        frozen: { 0: structuredClone(frozen) },
        popEvents: [{ center: [1, 2, 0] }],
      },
      raw: mesh,
      zones: [{ raw: structuredClone(mesh) }],
      spheres: [{ center: [1, 2, 5], raw: structuredClone(mesh) }],
    },
    editing: {
      curves: [[[1, 2, 3]]],
      frozen: { 0: frozen },
      popEvents: [{ center: [1, 2, 0] }],
    },
  };
  const moved = placeSavedFloor(data, 60);
  assert.equal(moved.result.params.floor, 60);
  assert.deepEqual([...moved.result.raw.positions], [1, 2, 60, 3, 4, 65]);
  assert.equal(moved.result.zones[0].raw.positions[2], 60);
  assert.equal(moved.result.spheres[0].center[2], 65);
  assert.equal(moved.editing.frozen[0].raw.positions[2], 60);
  assert.equal(moved.result.params.frozen[0].center[2], 65);
  assert.equal(moved.editing.curves[0][0][2], 63);
  assert.equal(moved.result.params.popEvents[0].center[2], 60);
  assert.equal(data.result.raw.positions[2], 0);
  assert.equal(data.editing.frozen[0].center[2], 5);
  assert.deepEqual(placeSavedFloor(moved, 60), moved);
});
