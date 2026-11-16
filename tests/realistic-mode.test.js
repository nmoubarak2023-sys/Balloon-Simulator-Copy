import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import * as T from "three";
import {
  buildRoomEnvelope,
  realisticBuilding,
  realisticMesh,
  realisticSection,
} from "../src/realistic-model.js";

test("realistic section leaves overlapping rooms open and fills the shell, slabs and columns", async () => {
  const m = await Module();
  m.setup();
  const owned = [];
  const own = (value) => (owned.push(value), value);
  try {
    const left = own(own(m.Manifold.sphere(5, 48)).translate([-2.4, 0, 0]));
    const right = own(own(m.Manifold.sphere(5, 48)).translate([2.4, 0, 0]));
    const joined = own(own(left.add(right)).trimByPlane([0, 0, 1], 0));
    const room = buildRoomEnvelope(m, realisticMesh(joined), 0.8, 0);
    owned.push(room.outside, room.inside);
    const column = own(
      own(m.Manifold.cube([1, 1, 3], true)).translate([0, 0, -2]),
    );
    const footprint = [
      [-8, -6],
      [8, -6],
      [8, 6],
      [-8, 6],
    ];
    const building = own(
      realisticBuilding(
        m,
        [
          {
            room,
            elevation: 0,
            perimeter: footprint,
            columns: [realisticMesh(column)],
          },
          { elevation: -3.5, perimeter: footprint, columns: [] },
          { elevation: 8, perimeter: footprint, columns: [] },
        ],
        0.5,
      ),
    );
    const localToWorld = new T.Matrix4().makeRotationX(Math.PI / 2);
    const cap = realisticSection(m, building, localToWorld.toArray());
    const worldToLocal = localToWorld.clone().invert();
    const vertices = Array.from({ length: cap.positions.length / 3 }, (_, i) =>
      new T.Vector3()
        .fromArray(cap.positions, i * 3)
        .applyMatrix4(worldToLocal),
    );
    const filled = (x, z) => {
      const point = new T.Vector3(x, z, 0.0001);
      for (let i = 0; i < cap.indices.length; i += 3) {
        const [a, b, c] = Array.from(
          cap.indices.slice(i, i + 3),
          (id) => vertices[id],
        );
        if (T.Triangle.containsPoint(point, a, b, c)) return true;
      }
      return false;
    };
    assert.equal(filled(0, 2), false, "overlap remains open");
    assert.equal(filled(2.4, 3), false, "interior stays hollow");
    assert.equal(filled(2.4, 5.4), true, "roof thickness gets poché");
    assert.equal(
      filled(2.4, 6.8),
      false,
      "air between the vault and upper slab stays clear",
    );
    assert.equal(filled(3, -0.25), true, "slab gets poché");
    assert.equal(filled(3, -3.75), true, "lower floor gets poché");
    assert.equal(filled(0, -2), true, "column gets poché");
    assert.equal(filled(3, -2), false, "the bay beside the column stays open");
  } finally {
    owned.reverse().forEach((object) => object.delete());
  }
});

test("poche fills enclosed section pockets but protects room voids", async () => {
  const m = await Module();
  m.setup();
  const outer = m.Manifold.cube([10, 10, 4]);
  const cavity = m.Manifold.cube([2, 2, 4]);
  const room = cavity.translate([2, 2, 0]);
  const gap = cavity.translate([6, 6, 0]);
  const shell = m.Manifold.difference([outer, room, gap]);
  try {
    const frame = new T.Matrix4().makeTranslation(0, 0, 2).toArray();
    const cap = realisticSection(m, shell, frame, room);
    let area = 0;
    const point = (index) =>
      new T.Vector3().fromArray(cap.positions, index * 3);
    for (let i = 0; i < cap.indices.length; i += 3)
      area += new T.Triangle(
        point(cap.indices[i]),
        point(cap.indices[i + 1]),
        point(cap.indices[i + 2]),
      ).getArea();
    assert.ok(Math.abs(area - 96) < 1e-5);
  } finally {
    for (const shape of [shell, gap, room, cavity, outer]) shape.delete();
  }
});
