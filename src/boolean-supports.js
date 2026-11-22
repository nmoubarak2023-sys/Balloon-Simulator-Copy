import * as T from "three";
import { collisionSites } from "./columns.js";
import { collisionRidges } from "./walls.js";

export function findSupportSites(source, walls = false) {
  const original = source.collisionRaw
    ? { ...source, raw: source.collisionRaw }
    : source;
  const sites = supportSites(
    (walls ? collisionRidges : collisionSites)(original),
    source,
    walls,
  );
  // Floor-edge contacts cannot support the default one-foot-radius column.
  // Prefer real, elevated collisions instead of defaulting to a floor sliver.
  return walls
    ? sites
    : sites
        .filter((site) => site.z - source.params.floor >= 0.5)
        .sort((a, b) => b.z - a.z);
}

export function segmentHitsVoid(a, b, cutter) {
  const inverse = new T.Quaternion()
    .setFromEuler(
      new T.Euler(...cutter.rotation.map(T.MathUtils.degToRad), "ZYX"),
    )
    .invert();
  const local = (point) =>
    new T.Vector3(...point)
      .sub(new T.Vector3(...cutter.position))
      .applyQuaternion(inverse)
      .divide(new T.Vector3(...cutter.size.map((v) => v / 2)));
  const start = local(a),
    direction = local(b).sub(start);
  const t = T.MathUtils.clamp(
    -start.dot(direction) / (direction.lengthSq() || 1),
    0,
    1,
  );
  return start.addScaledVector(direction, t).lengthSq() < 1 - 1e-8;
}

export function supportSites(sites, source, walls) {
  const cutters = (source.booleanCutters ?? []).filter(
    (c) =>
      c.enabled &&
      c.floors.includes(source.booleanFloor) &&
      c.targets.includes(walls ? "walls" : "columns"),
  );
  if (!cutters.length) return sites;
  const safe = ([x, y, z]) =>
    !cutters.some((c) =>
      segmentHitsVoid([x, y, source.params.floor], [x, y, z], c),
    );
  if (!walls) return sites.filter((s) => safe([s.x, s.y, s.z]));
  const split = [];
  for (const site of sites) {
    let path = [];
    function finish() {
      if (path.length >= 2) {
        const [x, y, z] = path[Math.floor(path.length / 2)];
        split.push({ ...site, id: split.length, x, y, z, path });
      }
      path = [];
    }
    for (const point of site.path) {
      if (safe(point)) path.push(point);
      else finish();
    }
    finish();
  }
  return split;
}

export function checkSupport(raw, source, walls) {
  const cutters = (source.booleanCutters ?? []).filter(
    (c) =>
      c.enabled &&
      c.floors.includes(source.booleanFloor) &&
      c.targets.includes(walls ? "walls" : "columns"),
  );
  for (const cutter of cutters)
    for (let i = 0; i < raw.indices.length; i += 3) {
      const points = Array.from(raw.indices.slice(i, i + 3), (id) =>
        Array.from(raw.positions.slice(id * 3, id * 3 + 3)),
      );
      if (
        points.some((a, j) => segmentHitsVoid(a, points[(j + 1) % 3], cutter))
      )
        throw Error(
          "This support intersects a Boolean void. Choose another ridge or reduce its dimensions.",
        );
    }
  return raw;
}
