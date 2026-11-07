import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import { voronoiBuild } from "../src/voronoi-engine.js";
const m = await Module();
m.setup();
const p = {
  width: 80,
  height: 50,
  count: 40,
  seed: 42,
  index: 0,
  selected: 8,
  radiusMin: 15,
  radiusMax: 25,
  radiusSeed: 17,
  floor: 0,
  spacing: 2,
  smoothing: 4,
};
const base = voronoiBuild(m, p);
test("popping removes only that balloon without shifting seeded radii, and restore recovers the enclosure", () => {
  const id = base.ids[0],
    pop = voronoiBuild(m, { ...p, popped: [id] });
  assert.ok(!pop.ids.includes(id));
  assert.equal(pop.spheres.length, base.spheres.length - 1);
  for (const s of pop.spheres) {
    const old = base.spheres.find((b) => b.id === s.id);
    assert.equal(s.radius, old.radius);
    assert.deepEqual(s.center, old.center);
  }
  assert.equal(pop.closed, true);
  const restored = voronoiBuild(m, { ...p, popped: [] });
  assert.deepEqual(restored.raw, base.raw);
  assert.throws(
    () => voronoiBuild(m, { ...p, popped: base.ids }),
    /at least one/i,
  );
});
test("frozen snapshots preserve their exact native mesh through pressure, edits, seeds and cluster changes", () => {
  const pressure = {
    pressureEnabled: true,
    strength: 2,
    influence: 25,
    curves: [
      [
        [0, 0, 0],
        [80, 50, 0],
      ],
    ],
  };
  const first = voronoiBuild(m, { ...p, ...pressure }),
    s = first.spheres[0],
    frozen = {
      [s.id]: {
        center: s.center,
        radius: s.radius,
        axisScale: s.axisScale,
        raw: s.raw,
      },
    };
  const frozenCopy = structuredClone(frozen);
  const next = voronoiBuild(m, {
    ...p,
    ...pressure,
    seed: 812,
    index: 20,
    selected: 3,
    radiusSeed: 222,
    strength: 8,
    edits: { [s.id]: [20, 10, 0, 2] },
    frozen,
  });
  assert.ok(next.ids.includes(s.id));
  assert.deepEqual(next.spheres.find((b) => b.id === s.id).raw, s.raw);
  assert.deepEqual(frozen, frozenCopy);
  assert.equal(next.closed, true);
  const json = JSON.parse(
    JSON.stringify({ ...p, ...pressure, frozen }, (_, v) =>
      ArrayBuffer.isView(v) ? Array.from(v) : v,
    ),
  );
  const loaded = voronoiBuild(m, json);
  assert.deepEqual(
    Array.from(loaded.spheres.find((b) => b.id === s.id).raw.positions),
    Array.from(s.raw.positions),
  );
});
test("pop pressure deforms neighbors but does not change a frozen balloon", () => {
  const native = voronoiBuild(m, {
      ...p,
      pressureEnabled: true,
      strength: 0.1,
      influence: 25,
      curves: [
        [
          [0, 0, 0],
          [80, 50, 0],
        ],
      ],
    }),
    s = native.spheres[1],
    popped = native.spheres[0];
  const frozen = {
      [s.id]: {
        center: s.center,
        radius: s.radius,
        axisScale: s.axisScale,
        raw: s.raw,
      },
    },
    event = { center: popped.center, radius: popped.radius };
  const next = voronoiBuild(m, {
    ...p,
    popped: [popped.id],
    popEvents: [event],
    popPressure: 1,
    frozen,
  });
  assert.deepEqual(next.spheres.find((b) => b.id === s.id).raw, s.raw);
  assert.equal(next.closed, true);
  assert.ok(!next.ids.includes(popped.id));
  const unpressured = voronoiBuild(m, {
    ...p,
    popped: [popped.id],
    popPressure: 0,
    frozen,
  });
  const other = next.spheres.find((b) => b.id !== s.id);
  assert.notDeepEqual(
    other.raw,
    unpressured.spheres.find((b) => b.id === other.id).raw,
  );
});
test("reject malformed lifecycle state rather than silently accepting corrupt projects", () => {
  assert.throws(() => voronoiBuild(m, { ...p, popped: [-1] }));
  assert.throws(() => voronoiBuild(m, { ...p, frozen: { 0: {} } }));
  assert.throws(() => voronoiBuild(m, { ...p, popPressure: 2 }));
});
