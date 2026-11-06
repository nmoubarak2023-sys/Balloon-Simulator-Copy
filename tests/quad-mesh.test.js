import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import initRhino from "rhino3dm";
import { BalloonEngine, topology } from "../src/engine.js";
import { quadMesh, quadObj } from "../src/quad-mesh.js";
import { addRhinoQuadMesh, rhinoRaw } from "../src/rhino-io.js";

const m = await Module();
m.setup();
const engine = new BalloonEngine(m);
const ball = m.Manifold.sphere(12, 32),
  raw = engine.raw(ball);
ball.delete();
function triangulate(q) {
  const indices = [];
  for (let i = 0; i < q.quads.length; i += 4) {
    const [a, b, c, d] = q.quads.slice(i, i + 4);
    indices.push(a, b, c, a, c, d);
  }
  return { positions: q.positions, indices: new Uint32Array(indices) };
}
function volume(raw) {
  let v = 0;
  const p = raw.positions;
  for (let i = 0; i < raw.indices.length; i += 3) {
    const [a, b, c] = Array.from(raw.indices.slice(i, i + 3), (j) => j * 3);
    v +=
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) +
        p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
      6;
  }
  return v;
}
test("all-quad conversion preserves closed surface, orientation, volume and source vertices", () => {
  const before = raw.positions.slice(),
    q = quadMesh(raw),
    tri = triangulate(q);
  assert.ok(q.quads.length / 4 < raw.indices.length);
  assert.ok(q.pairedTriangles > (raw.indices.length / 3) * 0.8);
  assert.deepEqual(raw.positions, before);
  assert.deepEqual(
    Array.from(q.positions.slice(0, before.length)),
    Array.from(before),
  );
  const edges = new Map();
  for (let i = 0; i < q.quads.length; i += 4) {
    const f = Array.from(q.quads.slice(i, i + 4));
    assert.equal(new Set(f).size, 4);
    for (let k = 0; k < 4; k++) {
      const a = f[k],
        b = f[(k + 1) % 4],
        key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  assert.ok([...edges.values()].every((n) => n === 2));
  assert.equal(topology(tri).closed, true);
  assert.ok(Math.abs(volume(tri) - volume(raw)) < 1e-7);
  assert.equal(q.normals.length, q.positions.length);
  for (let i = 0; i < q.normals.length; i += 3)
    assert.ok(Math.abs(Math.hypot(...q.normals.slice(i, i + 3)) - 1) < 1e-6);
});
test("quad OBJ includes four corners and smooth normal references with correct assembly offsets", () => {
  const first = quadObj(raw, "one"),
    second = quadObj(raw, "two", first.vertices + 1);
  for (const text of [first.text, second.text])
    for (const line of text.split("\n").filter((l) => l.startsWith("f "))) {
      const f = line.split(" ").slice(1);
      assert.equal(f.length, 4);
      assert.ok(f.every((v) => /^\d+\/\/\d+$/.test(v)));
    }
  const face = second.text.split("\n").find((l) => l.startsWith("f "));
  assert.ok(
    face
      .split(" ")
      .slice(1)
      .every((v) => Number(v.split("//")[0]) > first.vertices),
  );
});
test("Rhino export round trip contains exclusively genuine quads with smooth vertex normals", async () => {
  const r = await initRhino(),
    doc = new r.File3dm();
  addRhinoQuadMesh(r, doc, raw, "Quad balloon");
  const copy = r.File3dm.fromByteArray(doc.toByteArray()),
    obj = copy.objects().get(0),
    mesh = obj.geometry();
  assert.equal(mesh.faces().count, quadMesh(raw).quads.length / 4);
  for (let i = 0; i < mesh.faces().count; i++)
    assert.equal(new Set(mesh.faces().get(i)).size, 4);
  assert.equal(mesh.normals().count, mesh.vertices().count);
  assert.equal(mesh.isClosed, true);
  assert.ok(Math.abs(volume(rhinoRaw(mesh)) - volume(raw)) < 1e-7);
  mesh.delete();
  obj.delete();
  copy.delete();
  doc.delete();
});

test("a triangulated rectangle loses its internal diagonal in the quad layout", () => {
  const raw = {
    positions: new Float64Array([0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  const q = quadMesh(raw);
  assert.equal(q.pairedTriangles, 2);
  assert.equal(q.quads.length / 4, 4);
  for (let i = 0; i < q.quads.length; i += 4)
    for (let k = 0; k < 4; k++) {
      const a = q.quads[i + k],
        b = q.quads[i + ((k + 1) % 4)],
        p = q.positions;
      const onDiagonal = (j) => Math.abs(p[j * 3] / 2 - p[j * 3 + 1]) < 1e-12;
      assert.ok(
        !(onDiagonal(a) && onDiagonal(b)),
        "original diagonal must not appear among quad edges",
      );
    }
});
