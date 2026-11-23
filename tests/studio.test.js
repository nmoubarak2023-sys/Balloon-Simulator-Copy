import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import { studioLayout, lobbyZone, clearLobbyOverrides } from "../src/studio-layout.js";
import { voronoiBuild } from "../src/voronoi-engine.js";
import {
  collaborationZone,
  releaseCollaborationPoints,
} from "../src/collaboration-layout.js";
const loops = [
  [
    [0, 0],
    [100, 0],
    [100, 60],
    [0, 60],
  ],
];
const config = {
  spatialType: "studio",
  studioAngle: 30,
  studioBay: 20,
  studioElongation: 2,
  studioHeight: 10,
};
const points = studioLayout(loops, config);
const m = await Module();
m.setup();
const params = {
  ...config,
  width: 100,
  height: 60,
  count: points.length,
  index: 0,
  selected: points.length,
  seed: 42,
  radiusMin: 13,
  radiusMax: 13,
  radiusSeed: 17,
  floor: 0,
  spacing: 4,
  smoothing: 0,
  domain: { loops, elevation: 0 },
  unclippedBalloons: true,
  clipFloor: true,
  ceilingZ: 25,
};
test("lobby creates exactly one zone-spanning balloon with a height limit and editable transforms", () => {
  const cleaned=clearLobbyOverrides({frozen:{0:{},150:{}},popped:[0,150],edits:{0:[],150:[]}},0);
  assert.deepEqual(Object.keys(cleaned.frozen),['150']);assert.deepEqual(cleaned.popped,[150]);assert.deepEqual(Object.keys(cleaned.edits),['150']);
  const cfg = lobbyZone(loops, 10);
  const p = { ...params, ...cfg, directCells: true };
  const r = voronoiBuild(m, p);
  assert.equal(r.spheres.length, 1);
  assert.equal(r.cells.length, 1);
  for (const [x, y] of loops[0])
    assert.ok(
      ((x - cfg.lobbyX) / cfg.lobbyRX) ** 2 +
        ((y - cfg.lobbyY) / cfg.lobbyRY) ** 2 <
        1,
    );
  const balloon = r.spheres[0];
  assert.ok(balloon.radius * balloon.axisScale[2] <= 10.00001);
  assert.equal(r.quality.boundaryEdges, 0);
  for (const raw of [r.raw, r.spheres[0].raw, r.spheres[0].fullRaw].filter(Boolean))
    for (let i = 0; i < raw.positions.length; i += 3) {
      assert.ok(raw.positions[i] >= -0.0001 && raw.positions[i] <= 100.0001);
      assert.ok(raw.positions[i + 1] >= -0.0001 && raw.positions[i + 1] <= 60.0001);
    }
  const edited = voronoiBuild(m, {
    ...p,
    edits: { 0: [2, 0, 0, 1, 1, 1, 1.2] },
  });
  assert.equal(edited.spheres[0].center[0], balloon.center[0] + 2);
  assert.ok(edited.spheres[0].axisScale[2] > balloon.axisScale[2]);
});
test("lobby respects concave zone edges even with full balloons enabled", () => {
  const concave = [[[0, 0], [100, 0], [100, 30], [50, 30], [50, 60], [0, 60]]];
  const r = voronoiBuild(m, {
    ...params,
    ...lobbyZone(concave, 10),
    directCells: true,
    domain: { loops: concave, elevation: 0 },
  });
  for (let i = 0; i < r.raw.positions.length; i += 3)
    assert.ok(!(r.raw.positions[i] > 50.0001 && r.raw.positions[i + 1] > 30.0001), "no geometry spills into the adjoining zone");
  assert.equal(r.quality.boundaryEdges, 0);
  assert.equal(r.spheres[0].analyticSurface, false);
});

test("collaboration opt-in leaves custom geometry exactly unchanged", () => {
  const legacy = { ...params };
  for (const key of [
    "spatialType",
    "studioAngle",
    "studioBay",
    "studioElongation",
    "studioHeight",
  ])
    delete legacy[key];
  const a = voronoiBuild(m, legacy),
    b = voronoiBuild(m, { ...legacy, spatialType: "custom" });
  assert.deepEqual(a.raw, b.raw);
  assert.deepEqual(a.points, b.points);
  assert.deepEqual(a.spheres, b.spheres);
});
test("native point controls return to custom while radii and other controls retain collaboration", () => {
  for (const key of ["count", "seed"]) {
    const cfg = { ...config };
    assert.equal(releaseCollaborationPoints(cfg, key), true);
    assert.equal(cfg.spatialType, "custom");
  }
  for (const key of [
    "radiusMin",
    "radiusMax",
    "radiusSeed",
    "floor",
    "spacing",
  ]) {
    const cfg = { ...config };
    assert.equal(releaseCollaborationPoints(cfg, key), false);
    assert.equal(cfg.spatialType, "studio");
  }
});
test("collaboration settings persist per zone without altering neighboring settings", () => {
  const zones = [
      { count: 8, seed: 42 },
      { count: 6, seed: 43 },
    ],
    prior = structuredClone(zones[1]);
  Object.assign(zones[0], collaborationZone(loops, config));
  assert.equal(zones[0].count, points.length);
  assert.deepEqual(zones[1], prior);
  assert.deepEqual(JSON.parse(JSON.stringify(zones)), zones);
  assert.throws(
    () => collaborationZone(loops, { ...config, studioHeight: 0 }),
    /HEIGHT/,
  );
});
test("studio rows are deterministic, within the zone, and respect holes", () => {
  assert.deepEqual(studioLayout(loops, config), points);
  assert.ok(points.length > 1);
  const withHole = [
    loops[0],
    [
      [40, 20],
      [60, 20],
      [60, 40],
      [40, 40],
    ],
  ];
  assert.ok(
    studioLayout(withHole, config).every(
      ([x, y]) => !(x > 40 && x < 60 && y > 20 && y < 40),
    ),
  );
});
test("studio vaults remain individual balloons with height limits, pop, freeze and transforms", () => {
  const a = voronoiBuild(m, params);
  assert.deepEqual(a.points, points);
  assert.ok(a.spheres.every((s) => s.axisScale[0] === 2));
  assert.ok(a.spheres.every((s) => s.radius * s.axisScale[2] <= 10.00001));
  const id = a.ids[0],
    frozen = { [id]: structuredClone(a.spheres[0]) };
  const changed = voronoiBuild(m, {
    ...params,
    frozen,
    studioAngle: 60,
    edits: { [id]: [5, 0, 0, 2, 1, 1, 1] },
  });
  assert.deepEqual(
    changed.spheres.find((s) => s.id === id).center,
    a.spheres[0].center,
  );
  const popped = voronoiBuild(m, { ...params, popped: [id] });
  assert.ok(!popped.ids.includes(id));
  const edited = voronoiBuild(m, {
    ...params,
    edits: { [id]: [2, 0, 0, 1, 1, 1, 1.2] },
  });
  assert.equal(
    edited.spheres.find((s) => s.id === id).center[0],
    a.spheres[0].center[0] + 2,
  );
  assert.ok(
    edited.spheres.find((s) => s.id === id).axisScale[2] >
      a.spheres[0].axisScale[2],
  );
});

test("studio geometry remains usable by Boolean, column, wall and Rhino workflows", async () => {
  const { booleanFloors, checkedRaw, rawSolid } =
    await import("../src/boolean-model.js");
  const { collisionSites, columnMesh } = await import("../src/columns.js");
  const { collisionRidges, wallMesh } = await import("../src/walls.js");
  const { meshQuality } = await import("../src/mesh-quality.js");
  const { addRhinoMesh, rhinoRaw } = await import("../src/rhino-io.js");
  const { default: rhino3dm } = await import("rhino3dm");
  const result = voronoiBuild(m, params);
  for (const wall of [false, true]) {
    let made = false;
    for (const site of (wall ? collisionRidges : collisionSites)(result)) {
      try {
        const raw = (wall ? wallMesh : columnMesh)(result, site, {
          radius: 0.5,
          bottomRadius: 0.5,
          flare: 2,
          blend: 0.55,
        });
        assert.equal(meshQuality(raw).boundaryEdges, 0);
        made = true;
        break;
      } catch (e) {
        if (e.code === "ERR_ASSERTION") throw e;
      }
    }
    assert.ok(made, wall ? "wall placement" : "column placement");
  }
  const cutter = {
    enabled: true,
    mode: "void",
    floors: [0],
    targets: ["vaults"],
    position: [50, 30, 5],
    size: [12, 12, 30],
    rotation: [0, 0, 0],
    quality: 48,
    thickness: 1,
    offset: "outward",
  };
  const cut = booleanFloors(
    m,
    [{ index: 0, name: "STUDIO", raw: result.raw }],
    [cutter],
    1,
  )[0].raw;
  assert.equal(meshQuality(cut).boundaryEdges, 0);
  const r = await rhino3dm(),
    doc = new r.File3dm();
  try {
    addRhinoMesh(r, doc, cut, "STUDIO TEST");
    const back = r.File3dm.fromByteArray(doc.toByteArray());
    try {
      assert.equal(back.objects().count, 1);
      assert.equal(
        meshQuality(rhinoRaw(back.objects().get(0).geometry())).boundaryEdges,
        0,
      );
    } finally {
      back.delete();
    }
  } finally {
    doc.delete();
  }
});
