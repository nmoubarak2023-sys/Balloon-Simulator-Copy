import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import { voronoiBuild } from "../src/voronoi-engine.js";
import {
  collisionSites,
  columnMesh,
  roofSampler,
  trumpetProfile,
} from "../src/columns.js";
import { meshQuality, signedVolume } from "../src/mesh-quality.js";
const m = await Module();
m.setup();
const params = {
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
};
const result = voronoiBuild(m, params);
test("collision sites use overlapping edited roof owners and remain inside the actual footprint", () => {
  const sites = collisionSites(result),
    sample = roofSampler(result.raw);
  assert.ok(sites.length > 0);
  assert.deepEqual(collisionSites(result), sites);
  for (const s of sites) {
    assert.ok(s.balloons.length >= 2);
    assert.ok(s.balloons.every((i) => result.ids.includes(i)));
    assert.ok(Math.abs(sample(s.x, s.y) - s.z) < 1e-6);
  }
  assert.ok(sites.some((s) => s.kind === "junction"));
});
test("flared supports are closed positive-volume shells and meet the actual roof", () => {
  const before = Array.from(result.raw.positions),
    sites = collisionSites(result);
  let built = 0;
  for (const site of sites) {
    let raw;
    try {
      raw = columnMesh(result, site, { radius: 0.5, flare: 3, blend: 0.55 });
    } catch {
      continue;
    }
    const q = meshQuality(raw);
    assert.equal(q.boundaryEdges, 0);
    assert.equal(q.nonManifoldEdges, 0);
    assert.equal(q.degenerateFaces, 0);
    assert.equal(q.inconsistentEdges, 0);
    assert.ok(signedVolume(raw) > 0);
    const solid = new m.Manifold(
      new m.Mesh({
        numProp: 3,
        vertProperties: new Float32Array(raw.positions),
        triVerts: raw.indices,
      }),
    );
    assert.equal(solid.status(), "NoError");
    solid.delete();
    const sample = roofSampler(result.raw);
    for (let i = (raw.rings - 1) * raw.sides; i < raw.rings * raw.sides; i++) {
      const [x, y, z] = raw.positions.slice(i * 3, i * 3 + 3);
      assert.ok(Math.abs(z - sample(x, y)) < 1e-6);
    }
    built++;
    if (built >= 4) break;
  }
  assert.ok(built >= 2);
  assert.deepEqual(Array.from(result.raw.positions), before);
});
test("no false collisions for a single balloon; reject invalid support settings", () => {
  const one = voronoiBuild(m, { ...params, selected: 1 });
  assert.equal(collisionSites(one).length, 0);
  const site = collisionSites(result)[0];
  assert.throws(() =>
    columnMesh(result, site, { radius: 2, flare: 1, blend: 0.5 }),
  );
  assert.throws(() =>
    columnMesh(result, site, { radius: 1, flare: 3, blend: 1 }),
  );
});
test("bottom radius is exact, full-height taper preserves the roof and legacy projects", () => {
  const site = collisionSites(result)[0],
    settings = { radius: 1, flare: 5, blend: 0.55 };
  const original = columnMesh(result, site, settings),
    wide = columnMesh(result, site, { ...settings, bottomRadius: 3 }),
    legacy = columnMesh(result, site, { ...settings, bottomRadius: 1 });
  assert.deepEqual(legacy.positions, original.positions);
  for (let i = 0; i < 64; i++) {
    const p = wide.positions.slice(i * 3, i * 3 + 3);
    assert.ok(Math.abs(Math.hypot(p[0] - site.x, p[1] - site.y) - 3) < 1e-9);
    assert.equal(p[2], params.floor);
  }
  assert.deepEqual(
    wide.positions.slice((wide.rings - 1) * 64 * 3, wide.rings * 64 * 3),
    original.positions.slice(
      (original.rings - 1) * 64 * 3,
      original.rings * 64 * 3,
    ),
  );
  const q = meshQuality(wide);
  assert.equal(q.boundaryEdges, 0);
  assert.equal(q.nonManifoldEdges, 0);
  assert.equal(q.degenerateFaces, 0);
  assert.ok(signedVolume(wide) > 0);
  assert.throws(() =>
    columnMesh(result, site, { ...settings, bottomRadius: 0 }),
  );
});
test("one continuous taper spans every ring without a shaft or separate bottom transition", () => {
  const site = collisionSites(result)[0];
  for (const bottomRadius of [0.1, 1, 3])
    for (const blend of [0.1, 0.55, 0.9]) {
      const raw = columnMesh(result, site, {
        radius: 1,
        bottomRadius,
        flare: 5,
        blend,
      });
      const radii = Array.from({ length: raw.rings }, (_, i) => {
        const [x, y] = raw.positions.slice(
          i * raw.sides * 3,
          i * raw.sides * 3 + 3,
        );
        return Math.hypot(x - site.x, y - site.y);
      });
      assert.ok(Math.abs(radii[0] - bottomRadius) < 1e-9);
      assert.ok(Math.abs(radii.at(-1) - 5) < 1e-9);
      for (let i = 1; i < radii.length; i++)
        assert.ok(radii[i] > radii[i - 1], "tapers at every height");
      const q = meshQuality(raw);
      assert.equal(q.boundaryEdges, 0);
      assert.equal(q.degenerateFaces, 0);
      assert.equal(q.nonManifoldEdges, 0);
      assert.ok(signedVolume(raw) > 0);
    }
});

test("trumpet is vertical at the base and tangent to the canopy, instead of a conical taper", () => {
  for (const slope of [-0.3, 0, 0.4])
    for (const blend of [0.1, 0.55, 0.9]) {
      const e = 1e-6,
        p0 = trumpetProfile(0, 1, 8, 25, slope, blend),
        pb = trumpetProfile(e, 1, 8, 25, slope, blend),
        pt = trumpetProfile(1 - e, 1, 8, 25, slope, blend),
        p1 = trumpetProfile(1, 1, 8, 25, slope, blend);
      assert.deepEqual(p0, [1, 0]);
      assert.deepEqual(p1, [8, 25]);
      assert.ok(
        Math.abs((pb[0] - p0[0]) / (pb[1] - p0[1])) < 1e-5,
        "vertical base tangent",
      );
      assert.ok(
        Math.abs((p1[1] - pt[1]) / (p1[0] - pt[0]) - slope) < 1e-4,
        "roof tangent",
      );
      const mid = trumpetProfile(0.5, 1, 8, 25, slope, blend);
      assert.ok(
        mid[1] / 25 > (mid[0] - 1) / 7 + 0.3,
        "upright stem and outward canopy sweep",
      );
    }
});
