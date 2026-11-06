import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import { BalloonEngine } from "../src/engine.js";
import { prepareMesh, meshQuality } from "../src/mesh-quality.js";
import {
  removeNumericalSheets,
  precisionOutput,
} from "../src/precision-client.js";
const m = await Module();
m.setup();

test("numerical-sheet filtering preserves real 0.08321 walls while removing closed sub-tolerance sheets", () => {
  const e = new BalloonEngine(m),
    thin = m.Manifold.cube([10, 10, 0.08321]),
    noise = m.Manifold.cube([1, 1, 1e-6]).translate([20, 0, 0]);
  const a = e.raw(thin),
    b = e.raw(noise);
  const raw = {
    positions: Float64Array.from([...a.positions, ...b.positions]),
    indices: Uint32Array.from([
      ...a.indices,
      ...b.indices.map((i) => i + a.positions.length / 3),
    ]),
  };
  const result = removeNumericalSheets(raw, 1e-4);
  assert.equal(result.raw.indices.length, a.indices.length);
  assert(
    result.report.some((r) => !r.removed && Math.abs(r.width - 0.08321) < 1e-7),
  );
  assert(result.report.some((r) => r.removed));
  assert.equal(meshQuality(result.raw).boundaryEdges, 0);
  thin.delete();
  noise.delete();
});

test("open disconnected sheets remain available for inspection", () => {
  const raw = {
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
  assert.equal(removeNumericalSheets(raw, 1e-4).raw.indices.length, 3);
});

test("double precision cleanup retains sub-float32 coordinates and does not weld across thin walls", () => {
  const e = new BalloonEngine(m),
    box = m.Manifold.cube([10, 10, 0.08321]);
  const raw = e.raw(box);
  raw.positions = Float64Array.from(
    raw.positions,
    (v, i) => v + 10000 + (i % 3 === 0 ? 1e-8 : 0),
  );
  const result = prepareMesh(raw, 1e-4, {
    precision: "double",
    regularizeTiny: true,
  });
  assert(result.positions instanceof Float64Array);
  assert.equal(meshQuality(result).boundaryEdges, 0);
  assert.equal(result.indices.length, raw.indices.length);
  assert.equal(
    Math.min(...result.positions.filter((_, i) => i % 3 === 0)),
    10000.00000001,
  );
  box.delete();
});

test("unavailable precision service gives actionable error and leaves editable solids untouched", async () => {
  const e = new BalloonEngine(m);
  e.boundary = m.Manifold.cube([30, 30, 30]);
  e.balloons = [m.Manifold.sphere(3, 16).translate([10, 10, 10])];
  const volume = e.balloons[0].volume(),
    original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error("offline");
  };
  try {
    await assert.rejects(
      () => precisionOutput(e, 1e-4),
      /Start-Balloon-Precision.cmd/,
    );
    assert.equal(e.balloons[0].volume(), volume);
  } finally {
    globalThis.fetch = original;
    e.clear();
  }
});
