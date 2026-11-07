import test from "node:test";
import assert from "node:assert/strict";
import { populateAllZones } from "../src/zone-population.js";
import M from "manifold-3d";
import {
  zonedVoronoiBuild,
  defaultZoneSettings,
} from "../src/zoned-voronoi.js";
import { demoBoundary } from "../src/zones.js";
test("populate-all enables every zone without altering per-zone settings or lifecycle edits", () => {
  const p = {
    boundary: { zones: [{}, {}, {}] },
    zoneSettings: [{ seed: 1 }, { seed: 2 }, { seed: 3 }],
    populatedZones: [1],
    edits: { 150: [1, 2, 3, 1] },
    popped: [151],
    frozen: { 152: { center: [1, 2, 3] } },
    curves: [[[1, 2, 3]]],
  };
  const all = populateAllZones(p);
  assert.deepEqual(all.populatedZones, [0, 1, 2]);
  for (const k of ["zoneSettings", "edits", "popped", "frozen", "curves"])
    assert.deepEqual(all[k], p[k]);
  assert.deepEqual(p.populatedZones, [1]);
  assert.throws(() => populateAllZones({}), /Import/);
});
test("populating remaining zones preserves the existing edited balloon arrangement", async () => {
  const m = await M();
  m.setup();
  const boundary = demoBoundary();
  const p = {
    boundary,
    zoneSettings: defaultZoneSettings(boundary),
    populatedZones: [1],
    floor: 0,
    spacing: 2,
    smoothing: 4,
    edits: { 150: [0.5, 0, 0, 1] },
    popped: [151],
  };
  const before = zonedVoronoiBuild(m, p),
    after = zonedVoronoiBuild(m, populateAllZones(p));
  assert.deepEqual(
    after.spheres.filter((s) => s.zone === 1),
    before.spheres,
  );
  assert.ok(after.zones.every((z) => z.balloons > 0));
  assert.ok(!after.spheres.some((s) => s.id === 151));
});
