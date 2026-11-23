import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import {
  sharedBoundaries,
  boundaryRules,
  applyBoundaryRules,
} from "../src/zone-boundaries.js";
import { roofSampler } from "../src/columns.js";
import {
  zonedVoronoiBuild,
  defaultZoneSettings,
} from "../src/zoned-voronoi.js";
import { partitionCurves } from "../src/zones.js";
import { meshQuality } from "../src/mesh-quality.js";
import rhino3dm from "rhino3dm";
import { addRhinoMesh, rhinoRaw } from "../src/rhino-io.js";
const m = await Module();
m.setup();
const left = [
    [0, 0],
    [20, 0],
    [20, 20],
    [0, 20],
  ],
  right = [
    [20, 0],
    [40, 0],
    [40, 20],
    [20, 20],
  ];
const boundary = {
  bounds: { width: 40, height: 20 },
  zones: [{ loops: [left] }, { loops: [right] }],
};
test("open defaults are identical and a shared treatment rebuilds only its adjacent zones", () => {
  const b = partitionCurves([
    {
      closed: true,
      points: [
        [0, 0],
        [60, 0],
        [60, 20],
        [0, 20],
      ],
    },
    {
      points: [
        [20, 0],
        [20, 20],
      ],
    },
    {
      points: [
        [40, 0],
        [40, 20],
      ],
    },
  ]);
  const cfg = defaultZoneSettings(b).map((c) => ({
    ...c,
    count: 2,
    selected: 2,
    radiusMin: 18,
    radiusMax: 18,
  }));
  const p = {
    directCells: true,
    boundary: b,
    zoneSettings: cfg,
    populatedZones: [0, 1, 2],
    width: 60,
    height: 20,
    floor: 0,
    spacing: 3,
    smoothing: 0,
    unclippedBalloons: true,
    clipFloor: true,
    clipFloorEdge: true,
  };
  const a = zonedVoronoiBuild(m, p),
    edge = sharedBoundaries(b)[0];
  const open = zonedVoronoiBuild(m, {
    ...p,
    boundary: { ...b, edgeTreatments: { [edge.id]: { mode: "open" } } },
  });
  assert.deepEqual(a.raw, open.raw, "no changes to existing OPEN geometry");
  for (const mode of ["soft"]) {
    const changed = zonedVoronoiBuild(
      m,
      {
        ...p,
        boundary: {
          ...b,
          edgeTreatments: { [edge.id]: { mode, width: 8, height: 7 } },
        },
      },
      { previous: a, editingZone: edge.zones[0] },
    );
    assert.ok(edge.zones.every((i) => changed.zones[i].rebuilt));
    const other = [0, 1, 2].find((i) => !edge.zones.includes(i));
    assert.equal(changed.zones[other].rebuilt, false);
    assert.deepEqual(changed.zones[other].raw, a.zones[other].raw);
    for (const i of edge.zones) {
      assert.equal(meshQuality(changed.zones[i].raw).boundaryEdges, 0);
      assert.equal(meshQuality(changed.zones[i].raw).nonManifoldEdges, 0);
    }
    assert.equal(changed.spheres.length, a.spheres.length);
  }
});
test("shared boundary detection excludes the exterior and handles subdivided edges", () => {
  const edges = sharedBoundaries(boundary);
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0].zones, [0, 1]);
  const b = {
    ...boundary,
    zones: [
      boundary.zones[0],
      {
        loops: [
          [
            [20, 0],
            [40, 0],
            [40, 20],
            [20, 20],
            [20, 10],
          ],
        ],
      },
    ],
  };
  assert.equal(sharedBoundaries(b)[0].segments.length, 2);
  assert.deepEqual(boundaryRules(boundary, undefined, 0), []);
});
test("retired defined settings safely use OPEN behavior", () => {
  assert.deepEqual(
    boundaryRules(boundary, { "0:1": { mode: "defined" } }, 0),
    [],
  );
});
for (const mode of ["open", "soft"])
  test(
    mode + " uses closed geometry and the soft valley keeps a rounded crown",
    () => {
      const owned = [],
        own = (s) => (owned.push(s), s);
      try {
        const source = own(
          own(m.Manifold.sphere(18, 64)).translate([10, 10, 0]),
        );
        const outer = own(
          new m.CrossSection(
            [
              [
                [0, 0],
                [40, 0],
                [40, 20],
                [0, 20],
              ],
            ],
            "EvenOdd",
          ),
        );
        const initial = own(source.intersect(own(outer.extrude(40))));
        const rules = boundaryRules(
          boundary,
          { "0:1": { mode, width: 8, height: 7 } },
          0,
        );
        const solid = applyBoundaryRules(m, initial, rules, 0, own);
        assert.equal(solid.status(), "NoError");
        assert.ok(solid.volume() > 0);
        if (mode === "open") {
          assert.equal(solid, initial);
          assert.ok(solid.boundingBox().max[0] > 20);
        } else {
          assert.ok(
            solid.boundingBox().max[0] > 20,
            "SOFT preserves overlap across the shared edge",
          );
          const mesh = solid.getMesh(),
            roof = roofSampler({
              positions: mesh.vertProperties,
              indices: mesh.triVerts,
            });
          if (mode === "soft") {
            assert.ok(roof(19.99, 10) < 7.1);
            assert.ok(
              roof(20.01, 10) > 6.8,
              "roof continues across the boundary at valley height",
            );
            assert.ok(roof(10, 10) > 15);
          } else assert.ok(roof(19.99, 10) > 12);
        }
      } finally {
        owned.reverse().forEach((s) => s.delete());
      }
    },
  );

test("soft boundary geometry remains capped after Rhino export and saved settings reproduce it", async () => {
  const b = partitionCurves([
    {
      closed: true,
      points: [
        [0, 0],
        [40, 0],
        [40, 20],
        [0, 20],
      ],
    },
    {
      points: [
        [20, 0],
        [20, 20],
      ],
    },
  ]);
  const edge = sharedBoundaries(b)[0];
  b.edgeTreatments = { [edge.id]: { mode: "soft", width: 8, height: 7 } };
  const p = {
    directCells: true,
    boundary: b,
    zoneSettings: defaultZoneSettings(b).map((c) => ({
      ...c,
      count: 1,
      selected: 1,
      radiusMin: 18,
      radiusMax: 18,
    })),
    populatedZones: [0, 1],
    floor: 0,
    spacing: 3,
    smoothing: 0,
    unclippedBalloons: true,
    clipFloor: true,
    clipFloorEdge: true,
  };
  const a = zonedVoronoiBuild(m, p),
    back = zonedVoronoiBuild(m, JSON.parse(JSON.stringify(p)));
  assert.deepEqual(a.raw, back.raw);
  const r = await rhino3dm(),
    doc = new r.File3dm();
  try {
    addRhinoMesh(r, doc, a.raw, "BOUNDARY TEST");
    const loaded = r.File3dm.fromByteArray(doc.toByteArray());
    try {
      assert.equal(
        meshQuality(rhinoRaw(loaded.objects().get(0).geometry())).boundaryEdges,
        0,
      );
    } finally {
      loaded.delete();
    }
  } finally {
    doc.delete();
  }
  const pop = zonedVoronoiBuild(m, { ...p, popped: [0] });
  assert.ok(!pop.ids.includes(0));
  const frozen = a.spheres.find((s) => s.id === 0);
  const keep = zonedVoronoiBuild(m, {
    ...p,
    frozen: { 0: frozen },
    edits: { 0: [5, 0, 0, 2, 1, 1, 1] },
  });
  assert.deepEqual(keep.spheres.find((s) => s.id === 0).center, frozen.center);
});
