import test from "node:test";
import assert from "node:assert/strict";
import * as T from "three";
import {
  createProcessCodec,
  validateBuildScript,
} from "../src/process-codec.js";
import {
  captureProcessView,
  captureCamera,
  applyCamera,
} from "../src/process-view.js";
test("portable script deduplicates mesh buffers and restores project Maps and exact coordinates", async () => {
  const codec = createProcessCodec();
  const positions = new Float64Array([500.0000001, -25, 65, 501, 0, 65]);
  const state = {
    floors: new Map([
      [3, { raw: { positions, indices: new Uint32Array([0, 1, 0]) } }],
    ]),
    duplicate: new Float64Array(positions),
    missing: undefined,
  };
  const encoded = await codec.encode(state);
  assert.equal(Object.keys(codec.assets()).length, 2);
  const file = JSON.parse(
    JSON.stringify({ state: encoded, assets: codec.assets() }),
  );
  const restored = createProcessCodec(file.assets).decode(file.state);
  assert.deepEqual(restored, state);
  assert.equal(restored.floors.get(3).raw.positions[0], 500.0000001);
  assert.throws(
    () => createProcessCodec().decode({ $asset: "missing" }),
    /missing/,
  );
});
test("recorded scene preserves clipping, hidden geometry, object orientation and camera", () => {
  const root = new T.Group();
  root.position.set(500, 20, 65);
  const mesh = new T.Mesh(
    new T.BoxGeometry(10, 20, 30),
    new T.MeshStandardMaterial({
      color: 0xff5284,
      opacity: 0.3,
      transparent: true,
    }),
  );
  mesh.material.clippingPlanes = [new T.Plane(new T.Vector3(0, 0, -1), 70)];
  root.add(mesh);
  const hidden = mesh.clone();
  hidden.visible = false;
  root.add(hidden);
  const camera = new T.PerspectiveCamera(38, 1, 0.01, 10000);
  camera.up.set(0, 0, 1);
  camera.position.set(600, -100, 120);
  camera.lookAt(500, 20, 65);
  const orbit = { target: new T.Vector3(500, 20, 65) };
  const frame = captureProcessView({
    roots: [root],
    camera,
    orbit,
    workspace: "BOOLEAN",
  });
  assert.equal(frame.objects.length, 1);
  assert.equal(frame.objects[0].matrix[12], 500);
  assert.deepEqual(frame.objects[0].planes, [[0, 0, -1, 70]]);
  const playback = new T.PerspectiveCamera(),
    playOrbit = { target: new T.Vector3() };
  applyCamera(playback, playOrbit, frame.camera);
  assert.deepEqual(captureCamera(playback, playOrbit), frame.camera);
  mesh.geometry.dispose();
  mesh.material.dispose();
});
test("build script imports validate format and reject empty or unrelated files", () => {
  assert.throws(() => validateBuildScript({ format: "other" }), /valid/);
  assert.throws(
    () =>
      validateBuildScript({
        format: "balloon-build-script",
        version: 1,
        steps: [],
        assets: {},
      }),
    /valid/,
  );
  assert.equal(
    validateBuildScript({
      format: "balloon-build-script",
      version: 1,
      steps: [{ time: 0, label: "START", view: {} }],
      assets: {},
    }).version,
    1,
  );
});
