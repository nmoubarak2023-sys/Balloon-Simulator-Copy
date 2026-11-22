import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import {
  booleanFloors,
  checkedRaw,
  rawSolid,
  retainedShell,
  cutterSolid,
  joinBooleanPieces,
} from "../src/boolean-model.js";
import { segmentHitsVoid, supportSites } from "../src/boolean-supports.js";
const m = await Module();
m.setup();
const cutter = {
  position: [0, 0, 5],
  size: [12, 10, 30],
  rotation: [0, 15, 20],
  quality: 48,
  enabled: true,
  mode: "void",
  thickness: 0.5,
  offset: "outward",
  floors: [0],
  targets: ["vaults", "slabs", "columns", "walls"],
};
test("joined void-only export has no material inside the cutter and keeps untargeted slabs whole", () => {
  const block = m.Manifold.cube([30, 30, 20], true);
  const floor = {
    index: 0,
    name: "F1",
    raw: checkedRaw(block),
    elevation: 0,
    perimeter: [
      [-15, -15],
      [15, -15],
      [15, 15],
      [-15, 15],
    ],
  };
  const output = booleanFloors(m, [floor], [cutter], 1)[0];
  const joinedRaw = joinBooleanPieces(m, output.pieces);
  const joined = rawSolid(m, joinedRaw);
  const tool = cutterSolid(m, cutter);
  const intersection = joined.intersect(tool);
  assert(Math.abs(intersection.volume()) < tool.volume() * 1e-7);
  const interior = cutterSolid(m, cutter, -0.001);
  const interiorHit = joined.intersect(interior);
  assert(Math.abs(interiorHit.volume()) < 1e-8);
  interiorHit.delete();
  interior.delete();
  intersection.delete();
  joined.delete();
  tool.delete();
  const vaultOnly = booleanFloors(
    m,
    [floor],
    [{ ...cutter, mode: "shell", targets: ["vaults"] }],
    1,
  )[0];
  const slab = rawSolid(
    m,
    vaultOnly.pieces.find((p) => p.name.endsWith("SLAB")).raw,
  );
  assert(Math.abs(slab.volume() - 900) < 1e-4);
  const shell = retainedShell(m, { ...cutter, mode: "shell" });
  const assembly = joinBooleanPieces(m, [
    ...vaultOnly.pieces,
    { raw: checkedRaw(shell) },
  ]);
  assert(assembly.indices.length > 0);
  shell.delete();
  slab.delete();
  block.delete();
});
test("Boolean cuts close vaults, slabs and supports and preserve untargeted floors", () => {
  const cube = m.Manifold.cube([30, 30, 20], true),
    raw = checkedRaw(cube);
  const floors = [0, 1].map((index) => ({
    index,
    name: "F" + index,
    elevation: 0,
    perimeter: [
      [-15, -15],
      [15, -15],
      [15, 15],
      [-15, 15],
    ],
    raw,
    columns: [raw],
    walls: [raw],
  }));
  const result = booleanFloors(m, floors, [cutter], 1);
  assert.equal(result[0].pieces.length, 4);
  const cut = rawSolid(m, result[0].raw);
  assert(cut.volume() < cube.volume());
  cut.delete();
  const same = rawSolid(m, result[1].raw);
  assert(Math.abs(same.volume() - cube.volume()) < 1e-3);
  same.delete();
  for (const floor of result)
    for (const piece of floor.pieces) {
      const solid = rawSolid(m, piece.raw);
      assert.equal(solid.status(), "NoError");
      solid.delete();
    }
  cube.delete();
});
test("All three shell offsets generate closed hollow solids and unsafe inward offsets fail", () => {
  const tool = cutterSolid(m, cutter);
  for (const offset of ["outward", "inward", "centered"]) {
    const shell = retainedShell(m, { ...cutter, offset });
    assert(shell.volume() > 0);
    assert(shell.volume() < tool.volume());
    assert(checkedRaw(shell).indices.length > 0);
    shell.delete();
  }
  assert.throws(
    () => retainedShell(m, { ...cutter, offset: "inward", thickness: 20 }),
    /too large/,
  );
  tool.delete();
});
test("Void exclusions split wall ridges and exclude column sites", () => {
  const c = { ...cutter, rotation: [0, 0, 0], size: [4, 4, 20] };
  assert(segmentHitsVoid([0, 0, -10], [0, 0, 20], c));
  assert(!segmentHitsVoid([10, 0, -10], [10, 0, 20], c));
  const source = { booleanCutters: [c], booleanFloor: 0, params: { floor: 0 } };
  const path = Array.from({ length: 21 }, (_, i) => [i - 10, 0, 10]);
  const result = supportSites([{ path, id: 0 }], source, true);
  assert.equal(result.length, 2);
  assert.equal(
    supportSites(
      [
        { x: 0, y: 0, z: 10 },
        { x: 10, y: 0, z: 10 },
      ],
      source,
      false,
    ).length,
    1,
  );
});

test("Boolean mesh conversion preserves precise rotated intersection coordinates", () => {
  const base = m.Manifold.cube([2, 2, 2], true);
  const rotated = base.rotate([0, 0, 45]);
  const placed = rotated.translate([500.123456789, 75.987654321, 42]);
  try {
    const raw = checkedRaw(placed);
    const x = Array.from(raw.positions).filter((_, i) => i % 3 === 0);
    assert.ok(Math.abs(Math.max(...x) - (500.123456789 + Math.SQRT2)) < 1e-10);
    assert.ok(Math.abs(Math.min(...x) - (500.123456789 - Math.SQRT2)) < 1e-10);
  } finally {
    placed.delete();
    rotated.delete();
    base.delete();
  }
});

test("local sliver cleanup preserves a closed solid without scanning unrelated edge fans", async () => {
  const { repairBooleanSlivers } = await import("../src/boolean-slivers.js");
  const { meshQuality, signedVolume } = await import("../src/mesh-quality.js");
  const cube = m.Manifold.cube([20, 20, 20], true);
  const raw = checkedRaw(cube);
  cube.delete();
  const p = Array.from(raw.positions),
    original = Array.from(raw.indices);
  const a = original[0],
    b = original[1],
    n = p.length / 3;
  for (let k = 0; k < 3; k++)
    p.push(p[a * 3 + k] + (p[b * 3 + k] - p[a * 3 + k]) * 1e-14);
  const idx = [];
  for (let i = 0; i < original.length; i += 3) {
    const t = original.slice(i, i + 3);
    let split = false;
    for (let k = 0; k < 3; k++) {
      const u = t[k],
        v = t[(k + 1) % 3],
        w = t[(k + 2) % 3];
      if ((u === a && v === b) || (u === b && v === a)) {
        idx.push(u, n, w, n, v, w);
        split = true;
        break;
      }
    }
    if (!split) idx.push(...t);
  }
  const damaged = {
    positions: Float64Array.from(p),
    indices: Uint32Array.from(idx),
  };
  assert.ok(meshQuality(damaged).degenerateFaces > 0);
  const repaired = repairBooleanSlivers(damaged, 0.00001),
    audit = meshQuality(repaired);
  assert.equal(audit.degenerateFaces, 0);
  assert.equal(audit.boundaryEdges, 0);
  assert.equal(audit.nonManifoldEdges, 0);
  assert.equal(audit.inconsistentEdges, 0);
  assert.ok(Math.abs(signedVolume(repaired) - signedVolume(raw)) < 1e-8);
});

test('large-building audit distinguishes tiny valid faces from zero-area faces', async () => {
  const {meshQuality}=await import('../src/mesh-quality.js');
  const raw={positions:Float64Array.from([0,0,0,1000,0,0,0,1000,0,0,0,1000,1200,0,0,1200.00001,0,0,1200,.00001,0,1200,0,.00001]),indices:Uint32Array.from([0,2,1,0,1,3,0,3,2,1,2,3,4,6,5,4,5,7,4,7,6,5,6,7])};
  const audit=meshQuality(raw);assert.equal(audit.degenerateFaces,0);assert.equal(audit.boundaryEdges,0);assert.ok(audit.tinyFaces>0);
  const broken={...raw,indices:Uint32Array.from([...raw.indices,0,0,1])};assert.ok(meshQuality(broken).degenerateFaces>0);
});
