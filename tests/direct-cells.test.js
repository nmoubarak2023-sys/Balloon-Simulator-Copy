import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import { voronoiBuild } from "../src/voronoi-engine.js";
import {
  zonedVoronoiBuild,
  defaultZoneSettings,
  ZONE_STRIDE,
} from "../src/zoned-voronoi.js";
import { partitionCurves } from "../src/zones.js";
import { signedVolume } from "../src/mesh-quality.js";
const m = await Module();
m.setup();
const loops = [
  [
    [0, 0],
    [40, 0],
    [40, 25],
    [0, 25],
  ],
];
const params = {
  directCells: true,
  width: 40,
  height: 25,
  count: 6,
  seed: 42,
  radiusMin: 7,
  radiusMax: 12,
  radiusSeed: 17,
  floor: 0,
  spacing: 3,
  smoothing: 0,
  domain: { loops, elevation: 0 },
  clipFloor: true,
  unclippedBalloons: true,
};
for (const count of [1, 6, 11])
  test(`${count} requested cells produce exactly ${count} centers, territories and balloons`, () => {
    const r = voronoiBuild(m, { ...params, count });
    assert.equal(r.points.length, count);
    assert.equal(r.cells.length, count);
    assert.equal(r.spheres.length, count);
    assert.deepEqual(
      r.ids,
      Array.from({ length: count }, (_, i) => i),
    );
    const area = r.cells.reduce(
      (sum, poly) =>
        sum +
        Math.abs(
          poly.reduce((a, p, i) => {
            const q = poly[(i + 1) % poly.length];
            return a + p[0] * q[1] - p[1] * q[0];
          }, 0),
        ) /
          2,
      0,
    );
    assert.ok(
      Math.abs(area - 1000) < 1e-4,
      "all requested cells partition the whole zone",
    );
    assert.equal(r.quality.boundaryEdges, 0);
  });
test("direct cell mode ignores old anchor and nearest-group settings; older recipes can still replay", () => {
  const a = voronoiBuild(m, { ...params, index: 0, selected: 1 }),
    b = voronoiBuild(m, { ...params, index: 4, selected: 2 });
  assert.deepEqual(a.points, b.points);
  assert.deepEqual(a.raw, b.raw);
  assert.deepEqual(a.ids, b.ids);
  const legacy = voronoiBuild(m, {
    ...params,
    directCells: false,
    index: 0,
    selected: 2,
  });
  assert.equal(legacy.spheres.length, 2);
  assert.deepEqual(
    voronoiBuild(m, JSON.parse(JSON.stringify(params))).raw,
    a.raw,
  );
});
test("cell count changes preserve existing seed IDs and radii; pop, freeze and individual edits remain explicit", () => {
  const a = voronoiBuild(m, params),
    more = voronoiBuild(m, { ...params, count: 9 });
  for (const s of a.spheres) {
    const b = more.spheres.find((b) => b.id === s.id);
    assert.equal(s.radius, b.radius);
    assert.deepEqual(s.center, b.center);
  }
  const frozen = structuredClone(a.spheres[1]);
  const edited = voronoiBuild(m, {
    ...params,
    popped: [2],
    frozen: { 1: frozen },
    edits: { 1: [5, 0, 0, 2, 1, 1, 1], 3: [2, 0, 0, 1, 1, 1, 1.2] },
  });
  assert.equal(edited.spheres.length, 5);
  assert.ok(!edited.ids.includes(2));
  const preserved = edited.spheres.find((s) => s.id === 1);
  assert.deepEqual(preserved.center, frozen.center);
  assert.deepEqual(preserved.axisScale, frozen.axisScale);
  // The geometry kernel may reorder triangles while clipping an already
  // floor-clipped frozen solid; its shape and volume must remain unchanged.
  assert.ok(
    Math.abs(signedVolume(preserved.raw) - signedVolume(frozen.raw)) < 1e-4,
  );
  assert.equal(
    edited.spheres.find((s) => s.id === 3).center[0],
    a.spheres.find((s) => s.id === 3).center[0] + 2,
  );
});
test("each populated zone gets its requested cell count without generating a candidate pool in empty zones", () => {
  const boundary = partitionCurves([
    { closed: true, points: loops[0] },
    {
      points: [
        [20, 0],
        [20, 25],
      ],
    },
  ]);
  const configs = defaultZoneSettings(boundary).map((c, i) => ({
    ...c,
    count: i ? 5 : 3,
    selected: 1,
    index: 0,
  }));
  const p = { ...params, boundary, zoneSettings: configs, populatedZones: [0] };
  delete p.domain;
  const a = zonedVoronoiBuild(m, p);
  assert.equal(a.points.filter(Boolean).length, 3);
  assert.equal(a.spheres.length, 3);
  assert.equal(a.zones[1].balloons, 0);
  const b = zonedVoronoiBuild(m, { ...p, populatedZones: [0, 1] });
  assert.equal(b.points.filter(Boolean).length, 8);
  assert.deepEqual(
    b.zones.map((z) => z.balloons),
    [3, 5],
  );
  assert.deepEqual(
    b.spheres.filter((s) => s.zone === 0).map((s) => s.id),
    [0, 1, 2],
  );
  assert.deepEqual(
    b.spheres.filter((s) => s.zone === 1).map((s) => s.id),
    Array.from({ length: 5 }, (_, i) => ZONE_STRIDE + i),
  );
});
