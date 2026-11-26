import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import { columnGridSites, chooseGridCollisions } from "../src/column-grid.js";
import { findSupportSites } from "../src/boolean-supports.js";
import { voronoiBuild } from "../src/voronoi-engine.js";
const bounds = { min: [0, 0], max: [100, 100] };
const site = (id, x, y) => ({
  id,
  x,
  y,
  z: 12,
  kind: "seam",
  balloons: [2, 3],
});
test("grid selects real collisions within default five feet, leaving empty targets unpopulated", () => {
  const sites = [site(7, 32, 29), site(8, 38, 30), site(9, 61, 59)];
  const chosen = chooseGridCollisions(sites, bounds);
  assert.equal(chosen.length, 2);
  assert.deepEqual(chosen[0], {
    ...sites[0],
    grid: [1, 1],
    gridTarget: [30, 30],
    gridDistance: Math.sqrt(5),
  });
  assert.deepEqual(chosen[1].gridTarget, [60, 60]);
  assert.equal(chosen[0].x, 32);
  assert.equal(chosen[0].y, 29);
  assert.equal(sites[0].grid, undefined);
  assert.deepEqual(chooseGridCollisions([], bounds), []);
});
test("matching is deterministic, avoids duplicate collisions and targets, and uses a common grid across floors", () => {
  const sites = [site(0, 29, 30), site(1, 31, 30), site(2, 45, 30)];
  const a = chooseGridCollisions(sites, bounds, 30, 20);
  assert.equal(new Set(a.map((s) => s.id)).size, a.length);
  assert.equal(new Set(a.map((s) => s.grid.join(":"))).size, a.length);
  assert.deepEqual(a, chooseGridCollisions(sites, bounds, 30, 20));
  const b = chooseGridCollisions([site(10, 28, 33)], {
    min: [10, 10],
    max: [90, 90],
  });
  assert.deepEqual(b[0].gridTarget, [30, 30]);
  assert.equal(chooseGridCollisions([site(3, 36, 30)], bounds).length, 0);
  assert.equal(
    chooseGridCollisions([site(3, 36, 30)], bounds, 30, 7).length,
    1,
  );
  for (const value of [9, 51, NaN])
    assert.throws(() => chooseGridCollisions([], bounds, value), /10 TO 50/);
  for (const value of [0, 26, NaN])
    assert.throws(() => chooseGridCollisions([], bounds, 30, value), /1 TO 25/);
});
test("suggested sites preserve collision coordinates, ownership and Boolean exclusions on actual roofs", async () => {
  const m = await Module();
  m.setup();
  const source = voronoiBuild(m, {
    width: 80,
    height: 50,
    count: 40,
    seed: 42,
    index: 0,
    selected: 17,
    radiusMin: 15,
    radiusMax: 25,
    radiusSeed: 17,
    floor: 0,
    spacing: 2,
    smoothing: 4,
  });
  const collisions = findSupportSites(source, false),
    suggestions = columnGridSites(source, 30, 25);
  assert.ok(suggestions.length > 0);
  for (const s of suggestions) {
    const original = collisions.find((c) => c.id === s.id);
    assert.deepEqual(
      [s.x, s.y, s.z, s.balloons, s.kind],
      [original.x, original.y, original.z, original.balloons, original.kind],
    );
    assert.ok(s.gridDistance <= 25);
  }
  source.booleanFloor = 0;
  source.booleanCutters = [
    {
      enabled: true,
      floors: [0],
      targets: ["columns"],
      position: [40, 25, 10],
      size: [400, 400, 400],
      rotation: [0, 0, 0],
    },
  ];
  assert.deepEqual(columnGridSites(source), []);
});
