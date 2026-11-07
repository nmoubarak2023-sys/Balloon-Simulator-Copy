import test from "node:test";
import assert from "node:assert/strict";
import M from "manifold-3d";
import rhino3dm from "rhino3dm";
import { partitionCurves, demoBoundary, inLoops } from "../src/zones.js";
import { readBoundaryCurves } from "../src/rhino-zones.js";
import {
  zonedVoronoiBuild,
  defaultZoneSettings,
} from "../src/zoned-voronoi.js";
const m = await M();
m.setup();
const r = await rhino3dm();
const outer = {
  closed: true,
  points: [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ],
};
test("open crossing and T-junction dividers become separate zones with no missing or duplicate area", () => {
  const b = partitionCurves([
    outer,
    {
      points: [
        [0, 5],
        [10, 5],
      ],
    },
    {
      points: [
        [5, 0],
        [5, 5],
      ],
    },
  ]);
  assert.equal(b.zones.length, 3);
  assert.equal(
    b.zones.reduce((s, z) => s + z.area, 0),
    100,
  );
  const crossing = partitionCurves([
    outer,
    {
      points: [
        [0, 5],
        [10, 5],
      ],
    },
    {
      points: [
        [5, 0],
        [5, 10],
      ],
    },
  ]);
  assert.equal(crossing.zones.length, 4);
});
test("closed inner zones produce a remainder zone with a hole, rather than overlapping populations", () => {
  const b = partitionCurves([
    outer,
    {
      closed: true,
      points: [
        [3, 3],
        [7, 3],
        [7, 7],
        [3, 7],
      ],
    },
  ]);
  assert.equal(b.zones.length, 2);
  assert.deepEqual(
    b.zones.map((z) => z.area).sort((a, b) => a - b),
    [16, 84],
  );
  assert.ok(b.zones.some((z) => z.loops.length === 2));
  for (const p of [
    [1, 1],
    [5, 5],
    [9, 9],
  ])
    assert.equal(b.zones.filter((z) => inLoops(p, z.loops)).length, 1);
});
test("perimeter discovery is independent of curve order and rejects open outlines", () => {
  const lines = [
    {
      points: [
        [0, 5],
        [10, 5],
      ],
    },
    outer,
  ];
  assert.equal(partitionCurves(lines).zones.length, 2);
  assert.throws(
    () =>
      partitionCurves([
        {
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
          ],
        },
      ]),
    /closed/,
  );
});
test("Rhino polyline import preserves coordinates, converts millimeters to feet, and recognizes zones", () => {
  const doc = new r.File3dm();
  doc.settings().modelUnitSystem = r.UnitSystem.Millimeters;
  for (const c of [
    outer,
    {
      points: [
        [0, 5],
        [10, 5],
      ],
    },
  ]) {
    const p = c.closed ? [...c.points, c.points[0]] : c.points;
    const curve = new r.PolylineCurve(
      p.map(([x, y]) => [x * 304.8, y * 304.8, 5 * 304.8]),
    );
    doc.objects().addCurve(curve, null);
    curve.delete();
  }
  const parsed = readBoundaryCurves(r, doc.toByteArray()),
    b = partitionCurves(parsed.curves, { elevation: parsed.elevation });
  doc.delete();
  assert.equal(parsed.unitName, "Millimeters");
  assert.ok(Math.abs(parsed.elevation - 5) < 1e-9);
  assert.equal(b.zones.length, 2);
  assert.ok(Math.abs(b.bounds.width - 10) < 1e-9);
});
test("each zone populates independently and clips its balloon meshes to its boundary", () => {
  const boundary = demoBoundary(),
    zoneSettings = defaultZoneSettings(boundary),
    p = {
      boundary,
      zoneSettings,
      width: boundary.bounds.width,
      height: boundary.bounds.height,
      origin: boundary.bounds.min,
      floor: 0,
      spacing: 2,
      smoothing: 4,
    };
  const first = zonedVoronoiBuild(m, p);
  assert.equal(first.closed, true);
  assert.equal(first.zones.length, 3);
  assert.equal(first.quality.boundaryEdges, 0);
  assert.equal(first.quality.nonManifoldEdges, 0);
  assert.equal(first.quality.degenerateFaces, 0);
  for (const s of first.spheres) {
    assert.ok(inLoops(s.center.slice(0, 2), boundary.zones[s.zone].loops));
    assert.ok(s.raw);
  }
  const changed = structuredClone(p);
  changed.zoneSettings[0].radiusSeed += 1;
  const next = zonedVoronoiBuild(m, changed);
  assert.notDeepEqual(next.zones[0].raw, first.zones[0].raw);
  assert.deepEqual(next.zones[1].raw, first.zones[1].raw);
  assert.deepEqual(next.zones[2].raw, first.zones[2].raw);
  const saved = JSON.parse(JSON.stringify(p));
  assert.deepEqual(zonedVoronoiBuild(m, saved).raw, first.raw);
  const pop = first.spheres.find((s) => s.zone === 0),
    popParams = {
      ...p,
      popped: [pop.id],
      popEvents: [{ center: pop.center, radius: pop.radius, zone: 0 }],
      popPressure: 0.25,
    };
  const popped = zonedVoronoiBuild(m, popParams);
  assert.ok(!popped.ids.includes(pop.id));
  assert.deepEqual(popped.zones[1].raw, first.zones[1].raw);
});
test("curved NURBS perimeters and elevated plans retain their shape and coordinates", () => {
  const doc = new r.File3dm();
  doc.settings().modelUnitSystem = r.UnitSystem.Feet;
  const circle = new r.Circle(10),
    curve = circle.toNurbsCurve();
  doc.objects().addCurve(curve, null);
  const imported = readBoundaryCurves(r, doc.toByteArray()),
    b = partitionCurves(imported.curves, { elevation: 5 });
  curve.delete();
  circle.delete();
  doc.delete();
  assert.ok(imported.curves[0].points.length > 32);
  assert.ok(Math.abs(b.zones[0].area - Math.PI * 100) < 0.5);
  assert.equal(b.bounds.min[0], -10);
  const configs = defaultZoneSettings(b),
    out = zonedVoronoiBuild(m, {
      boundary: b,
      zoneSettings: configs,
      floor: 5,
      spacing: 1,
      smoothing: 4,
    });
  assert.equal(out.closed, true);
  assert.ok(out.spheres.every((s) => s.center[2] === 5));
  for (let i = 2; i < out.raw.positions.length; i += 3)
    assert.ok(out.raw.positions[i] >= 5 - 1e-4);
});
test("freeze, pressure and empty zones work with zoned balloon IDs", () => {
  const boundary = demoBoundary(),
    zoneSettings = defaultZoneSettings(boundary),
    p = { boundary, zoneSettings, floor: 0, spacing: 2, smoothing: 4 },
    first = zonedVoronoiBuild(m, p),
    s = first.spheres.find((s) => s.zone === 1);
  const frozen = {
    [s.id]: {
      center: s.center,
      radius: s.radius,
      axisScale: s.axisScale,
      raw: s.raw,
      analyticSurface: s.analyticSurface,
    },
  };
  const pressured = zonedVoronoiBuild(m, {
    ...p,
    pressureEnabled: true,
    strength: 1,
    influence: 20,
    curves: [
      [
        [0, 0, 0],
        [80, 50, 0],
      ],
    ],
    frozen,
  });
  assert.equal(pressured.closed, true);
  assert.deepEqual(pressured.spheres.find((b) => b.id === s.id).raw, s.raw);
  const emptied = zonedVoronoiBuild(m, {
    ...p,
    popped: first.spheres.filter((s) => s.zone === 0).map((s) => s.id),
  });
  assert.equal(emptied.zones[0].balloons, 0);
  assert.ok(emptied.spheres.length > 0);
  assert.equal(emptied.closed, true);
});
test("only explicitly populated zones generate balloons; empty imports remain empty", () => {
  const boundary = demoBoundary(),
    zoneSettings = defaultZoneSettings(boundary);
  const p = {
    boundary,
    zoneSettings,
    floor: 0,
    spacing: 2,
    smoothing: 4,
    populatedZones: [],
  };
  const empty = zonedVoronoiBuild(m, p);
  assert.equal(empty.spheres.length, 0);
  assert.equal(empty.raw.indices.length, 0);
  const first = zonedVoronoiBuild(m, { ...p, populatedZones: [1] });
  assert.ok(first.spheres.length > 0);
  assert.ok(first.spheres.every((s) => s.zone === 1));
  assert.equal(first.zones[0].raw.indices.length, 0);
  const both = zonedVoronoiBuild(m, { ...p, populatedZones: [1, 0] });
  assert.deepEqual(
    both.spheres.filter((s) => s.zone === 1),
    first.spheres,
  );
  assert.ok(both.spheres.some((s) => s.zone === 0));
});
