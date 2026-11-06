import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import { voronoiBuild } from "../src/voronoi-engine.js";
const m = await Module();
m.setup();
const defaults = {
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
  spacing: 3,
  smoothing: 4,
};
test("individual transforms use stable seed IDs and rebuild the footprint and roof", () => {
  const a = voronoiBuild(m, defaults),
    b = voronoiBuild(m, { ...defaults, edits: { 0: [4, 2, 1, 1.2] } });
  assert.deepEqual(a.ids, b.ids);
  assert.deepEqual(a.cells, b.cells);
  assert.deepEqual(b.spheres[0].center, [
    a.spheres[0].center[0] + 4,
    a.spheres[0].center[1] + 2,
    1,
  ]);
  assert.equal(b.spheres[0].radius, a.spheres[0].radius * 1.2);
  assert.notEqual(a.volume, b.volume);
  assert(b.closed);
  assert.throws(() =>
    voronoiBuild(m, { ...defaults, edits: { 0: [0, 0, 0, 0] } }),
  );
});
test("curve pressure changes original balloon surfaces and enclosed roof; disabling it restores the baseline", () => {
  const a = voronoiBuild(m, defaults),
    settings = {
      ...defaults,
      curves: [
        [
          [0, 25, 0],
          [80, 25, 0],
        ],
      ],
      strength: 5,
      influence: 25,
    };
  const b = voronoiBuild(m, { ...settings, pressureEnabled: true }),
    c = voronoiBuild(m, { ...settings, pressureEnabled: false });
  assert(b.volume < a.volume);
  assert.deepEqual(a.ids, b.ids);
  assert.deepEqual(a.cells, b.cells);
  assert(b.spheres.every((s) => s.raw));
  assert(b.closed);
  assert.deepEqual(c.raw, a.raw);
});
test("uniform roof triangulation avoids the old fan slivers while retaining a closed solid", () => {
  const r = voronoiBuild(m, { ...defaults, spacing: 2 });
  assert(r.quality.maxAspect < 100);
  assert(r.quality.stretchedFaces < r.quality.triangles * 0.01);
  assert.equal(r.quality.duplicateFaces, 0);
  assert.equal(r.quality.inconsistentEdges, 0);
  assert.equal(r.quality.boundaryEdges, 0);
  assert.equal(r.quality.nonManifoldEdges, 0);
});
for (const width of [40, 80, 160])
  test(`Voronoi ${width}: closed roof, flat bottom, clipped footprint and matching nearest seeds`, () => {
    const r = voronoiBuild(m, { ...defaults, width, height: width * 0.625 });
    assert.equal(r.quality.boundaryEdges, 0);
    assert.equal(r.quality.nonManifoldEdges, 0);
    assert.equal(r.quality.degenerateFaces, 0);
    assert.equal(r.components, 1);
    assert(r.volume > 0);
    const expected = r.points
      .map((p, i) => ({
        i,
        d: Math.hypot(p[0] - r.points[0][0], p[1] - r.points[0][1]),
      }))
      .sort((a, b) => a.d - b.d || a.i - b.i)
      .slice(0, 17)
      .map((a) => a.i);
    assert.deepEqual(r.ids, expected);
    for (let i = 0; i < r.raw.positions.length; i += 3) {
      const [x, y, z] = r.raw.positions.slice(i, i + 3);
      assert(x >= -1e-6 && x <= width + 1e-6);
      assert(y >= -1e-6 && y <= width * 0.625 + 1e-6);
      assert(z >= 0);
    }
    assert(r.raw.positions.some((z, i) => i % 3 === 2 && z === 0));
  });
test("seeds are deterministic and changing radius seed preserves the original cells", () => {
  const a = voronoiBuild(m, defaults),
    b = voronoiBuild(m, { ...defaults, radiusSeed: 99 });
  assert.deepEqual(a.points, b.points);
  assert.deepEqual(a.cells, b.cells);
  assert.deepEqual(a.ids, b.ids);
  assert.notDeepEqual(a.spheres, b.spheres);
});
test("nonzero floor creates a closed enclosure and impossible sections are rejected", () => {
  const r = voronoiBuild(m, { ...defaults, floor: 5 });
  assert.equal(r.quality.boundaryEdges, 0);
  assert.equal(r.quality.nonManifoldEdges, 0);
  assert.throws(() => voronoiBuild(m, { ...defaults, floor: 30 }));
});
