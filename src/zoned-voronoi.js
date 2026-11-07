import { voronoiBuild } from "./voronoi-engine.js";
import { loopBounds } from "./zones.js";
import { meshQuality, signedVolume, prepareMesh } from "./mesh-quality.js";
export const ZONE_STRIDE = 150;
export function defaultZoneSettings(boundary, floorIndex = 0) {
  const area = boundary.zones.reduce((s, z) => s + z.area, 0);
  return boundary.zones.map((z, i) => {
    const count = Math.max(4, Math.round((40 * z.area) / area)),
      r = Math.sqrt(z.area / (count * Math.PI));
    return {
      count,
      seed: 42 + i + floorIndex * 101,
      index: 0,
      selected: count,
      radiusMin: Math.max(1, Math.round(r * 1.4 * 2) / 2),
      radiusMax: Math.max(1.5, Math.round(r * 2.2 * 2) / 2),
      radiusSeed: 17 + i + floorIndex * 101,
    };
  });
}
export function zonedVoronoiBuild(m, p) {
  if (!p.boundary) return voronoiBuild(m, p);
  const boundary = p.boundary,
    configs = p.zoneSettings;
  if (
    !Array.isArray(boundary.zones) ||
    boundary.zones.length < 1 ||
    boundary.zones.length > 20 ||
    !Array.isArray(configs) ||
    configs.length !== boundary.zones.length
  )
    throw Error("Invalid imported zones or zone settings.");
  const enabled = new Set(p.populatedZones ?? configs.map((_, i) => i));
  if (
    [...enabled].some(
      (i) => !Number.isInteger(i) || i < 0 || i >= configs.length,
    )
  )
    throw Error("Invalid populated zones.");
  if (
    configs.reduce(
      (s, c, i) =>
        s + (enabled.has(i) ? (p.unclippedBalloons ? c.count : c.selected) : 0),
      0,
    ) > 200
  )
    throw Error("Use at most 200 selected balloons across all zones.");
  const results = [];
  for (let i = 0; i < boundary.zones.length; i++) {
    const z = boundary.zones[i],
      cfg = configs[i],
      offset = i * ZONE_STRIDE,
      bounds = loopBounds(z.loops);
    const remap = (object) =>
      Object.fromEntries(
        Object.entries(object ?? {})
          .filter(
            ([id]) => Number(id) >= offset && Number(id) < offset + ZONE_STRIDE,
          )
          .map(([id, value]) => [Number(id) - offset, value]),
      );
    try {
      results.push(
        voronoiBuild(m, {
          ...cfg,
          selected: p.unclippedBalloons ? cfg.count : cfg.selected,
          unclippedBalloons: !!p.unclippedBalloons,
          clipFloor: !!p.clipFloor,
          width: bounds.width,
          height: bounds.height,
          floor: p.floor,
          spacing: p.spacing,
          smoothing: p.smoothing,
          domain: { loops: z.loops, elevation: boundary.elevation ?? 0 },
          curves: p.curves,
          edits: remap(p.edits),
          pressureEnabled: !!p.pressureEnabled,
          strength: p.strength ?? 0,
          influence: p.influence ?? 10,
          frozen: enabled.has(i) ? remap(p.frozen) : {},
          popped: !enabled.has(i)
            ? Array.from({ length: cfg.count }, (_, j) => j)
            : (p.popped ?? [])
                .filter((id) => id >= offset && id < offset + ZONE_STRIDE)
                .map((id) => id - offset),
          popEvents: (p.popEvents ?? []).filter(
            (e) => e.zone === undefined || e.zone === i,
          ),
          popPressure: p.popPressure ?? 0.25,
        }),
      );
    } catch (e) {
      throw Error(`${z.name}: ${e.message}`);
    }
  }
  const points = Array(boundary.zones.length * ZONE_STRIDE).fill(null),
    cells = Array.from({ length: points.length }, () => []),
    cellLoops = Array.from({ length: points.length }, () => []),
    ids = [],
    spheres = [],
    zoneResults = [];
  const solids = [];
  let union;
  try {
    results.forEach((r, zone) => {
      r.raw = prepareMesh(r.raw, 1e-5, {
        precision: "double",
        regularizeTiny: true,
      });
      if (r.raw.indices.length) {
        const solid = new m.Manifold(
          new m.Mesh({
            numProp: 3,
            vertProperties: new Float32Array(r.raw.positions),
            triVerts: r.raw.indices,
          }),
        );
        if (solid.status() !== "NoError") {
          solid.delete();
          throw Error(
            "A zone enclosure could not be joined. Increase mesh spacing.",
          );
        }
        solids.push(solid);
        const native = solid.getMesh();
        r.raw = prepareMesh(
          { positions: native.vertProperties, indices: native.triVerts },
          1e-5,
          { precision: "double", regularizeTiny: true },
        );
        const pieces = solid.decompose();
        r.components = pieces.length;
        pieces.forEach((s) => s.delete());
        r.volume = solid.volume();
      }
      r.quality = meshQuality(r.raw);
      r.closed =
        !!r.raw.indices.length &&
        !r.quality.boundaryEdges &&
        !r.quality.nonManifoldEdges &&
        !r.quality.degenerateFaces;
      const offset = zone * ZONE_STRIDE;
      r.points.forEach((v, i) => (points[offset + i] = v));
      r.cells.forEach((v, i) => (cells[offset + i] = v));
      r.cellLoops?.forEach((v, i) => (cellLoops[offset + i] = v));
      ids.push(...r.ids.map((id) => offset + id));
      spheres.push(
        ...r.spheres.map((s) => ({ ...s, id: offset + s.id, zone })),
      );
      zoneResults.push({
        id: zone,
        name: boundary.zones[zone].name,
        raw: r.raw,
        loops: r.loops,
        closed: r.closed,
        components: r.components,
        balloons: r.spheres.length,
        volume: r.volume,
      });
    });
    if (!solids.length) {
      const raw = { positions: new Float64Array(), indices: new Uint32Array() };
      return {
        raw,
        points,
        cells,
        cellLoops,
        ids,
        spheres,
        loops: [],
        zones: zoneResults,
        quality: meshQuality(raw),
        components: 0,
        volume: 0,
        params: p,
        closed: false,
      };
    }
    union = m.Manifold.union(solids);
    if (union.status() !== "NoError")
      throw Error("Could not join the zone enclosures.");
    const mesh = union.getMesh(),
      positions = new Float64Array(mesh.numVert * 3);
    for (let i = 0; i < mesh.numVert; i++)
      for (let k = 0; k < 3; k++)
        positions[i * 3 + k] = mesh.vertProperties[i * mesh.numProp + k];
    const raw = prepareMesh(
        { positions, indices: new Uint32Array(mesh.triVerts) },
        1e-5,
        { precision: "double", regularizeTiny: true },
      ),
      quality = meshQuality(raw),
      pieces = union.decompose(),
      components = pieces.length;
    pieces.forEach((s) => s.delete());
    const slice = union.slice(p.floor),
      loops = slice.toPolygons();
    slice.delete();
    return {
      raw,
      points,
      cells,
      cellLoops,
      ids,
      spheres,
      loops,
      zones: zoneResults,
      quality,
      components,
      volume: signedVolume(raw),
      params: p,
      closed:
        !quality.boundaryEdges &&
        !quality.nonManifoldEdges &&
        !quality.degenerateFaces &&
        !quality.invalidFaces &&
        !quality.inconsistentEdges,
    };
  } finally {
    union?.delete();
    solids.forEach((s) => s.delete());
  }
}
