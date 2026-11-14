import * as T from "three";
import { MeshBVH } from "three-mesh-bvh";

function signedOutline(loop, x, y) {
  let inside = false;
  let distance = Infinity;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [ax, ay] = loop[j],
      [bx, by] = loop[i];
    const dx = bx - ax,
      dy = by - ay;
    const length = dx * dx + dy * dy;
    if (!length) continue;
    const t = T.MathUtils.clamp(((x - ax) * dx + (y - ay) * dy) / length, 0, 1);
    distance = Math.min(
      distance,
      (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2,
    );
    if (ay > y !== by > y && x < ax + ((y - ay) * dx) / dy) inside = !inside;
  }
  return Math.sqrt(distance) * (inside ? 1 : -1);
}

export function offsetWrap(m, input, offset, resolution) {
  const floors = [...input].sort((a, b) => a.z - b.z);
  const bounds = new T.Box3();
  const bottom = floors[0].z;
  const top = floors.at(-1).z + (floors.length === 1 ? 1 : 0);
  for (const { loop, z } of floors)
    for (const [x, y] of loop) bounds.expandByPoint(new T.Vector3(x, y, z));
  bounds.max.z = top;
  const obstacles = floors.flatMap(({ raw }) => {
    if (!raw?.indices.length) return [];
    const mesh = new T.BufferGeometry();
    mesh.setAttribute(
      "position",
      new T.BufferAttribute(Float32Array.from(raw.positions), 3),
    );
    mesh.setIndex(new T.BufferAttribute(Uint32Array.from(raw.indices), 1));
    mesh.computeBoundingBox();
    bounds.union(mesh.boundingBox);
    return [
      { bvh: new MeshBVH(mesh, { indirect: true }), bounds: mesh.boundingBox },
    ];
  });
  const span = Math.max(...bounds.getSize(new T.Vector3()).toArray());
  const cell = (span + 2 * offset) / resolution;
  const margin = offset + 3 * cell;
  bounds.expandByScalar(margin);
  const point = new T.Vector3();
  const ray = new T.Ray(point, new T.Vector3(1, 0.371, 0.217).normalize());
  const hit = {};
  const field = ([x, y, z]) => {
    const upper = floors.findIndex((f) => f.z >= z);
    const b = upper < 0 ? floors.length - 1 : upper;
    const a = upper < 0 ? b : Math.max(0, b - 1);
    const lowerDistance = signedOutline(floors[a].loop, x, y);
    const plan =
      a === b
        ? lowerDistance
        : T.MathUtils.lerp(
            lowerDistance,
            signedOutline(floors[b].loop, x, y),
            (z - floors[a].z) / (floors[b].z - floors[a].z),
          );
    const vertical = Math.min(z - bottom, top - z);
    let value =
      plan < 0 && vertical < 0
        ? -Math.hypot(plan, vertical)
        : Math.min(plan, vertical);
    point.set(x, y, z);
    for (const obstacle of obstacles) {
      if (obstacle.bounds.distanceToPoint(point) > offset + 2 * cell) continue;
      const nearest = obstacle.bvh.closestPointToPoint(
        point,
        hit,
        0,
        offset + 3 * cell,
      );
      if (!nearest) {
        if (
          obstacle.bounds.containsPoint(point) &&
          obstacle.bvh.raycast(ray, T.DoubleSide).length % 2
        )
          value = Math.max(value, cell);
        continue;
      }
      const inside =
        obstacle.bounds.containsPoint(point) &&
        obstacle.bvh.raycast(ray, T.DoubleSide).length % 2;
      value = Math.max(value, nearest.distance * (inside ? 1 : -1));
    }
    return value;
  };
  const solid = m.Manifold.levelSet(
    field,
    { min: bounds.min.toArray(), max: bounds.max.toArray() },
    cell,
    -offset,
  );
  if (solid.isEmpty()) {
    solid.delete();
    throw Error("The wrap is empty. Increase wrap resolution or offset.");
  }
  return { solid, cell };
}

export function facadeMesh(solid) {
  const mesh = solid.getMesh();
  const positions = new Float32Array(mesh.numVert * 3);
  for (let i = 0; i < mesh.numVert; i++)
    positions.set(
      mesh.vertProperties.subarray(i * mesh.numProp, i * mesh.numProp + 3),
      3 * i,
    );
  return { positions, indices: mesh.triVerts.slice() };
}

function hasLongEdges({ positions, indices }, limit) {
  const limitSquared = limit ** 2;
  for (let i = 0; i < indices.length; i += 3) {
    for (let edge = 0; edge < 3; edge++) {
      const a = indices[i + edge] * 3;
      const b = indices[i + ((edge + 1) % 3)] * 3;
      const lengthSquared =
        (positions[a] - positions[b]) ** 2 +
        (positions[a + 1] - positions[b + 1]) ** 2 +
        (positions[a + 2] - positions[b + 2]) ** 2;
      if (lengthSquared > limitSquared) return true;
    }
  }
  return false;
}

function areaSpread({ positions, indices }) {
  const areas = [];
  const a = new T.Vector3(),
    b = new T.Vector3(),
    c = new T.Vector3();
  for (let i = 0; i < indices.length; i += 3) {
    a.fromArray(positions, indices[i] * 3);
    b.fromArray(positions, indices[i + 1] * 3).sub(a);
    c.fromArray(positions, indices[i + 2] * 3).sub(a);
    areas.push(b.cross(c).length());
  }
  areas.sort((a, b) => a - b);
  return (
    areas[Math.floor(areas.length * 0.9)] /
    Math.max(1e-12, areas[Math.floor(areas.length * 0.5)])
  );
}

export function lowPolyWrap(m, { solid, cell }, target) {
  const source = facadeMesh(solid);
  if (source.indices.length / 3 <= target) return source;

  const geometry = new T.BufferGeometry();
  geometry.setAttribute("position", new T.BufferAttribute(source.positions, 3));
  geometry.setIndex(new T.BufferAttribute(source.indices, 1));
  geometry.computeBoundingBox();
  const bvh = new MeshBVH(geometry, { indirect: true });
  const bounds = geometry.boundingBox;
  const span = Math.max(...bounds.getSize(new T.Vector3()).toArray());
  const point = new T.Vector3();
  const ray = new T.Ray(point, new T.Vector3(1, 0.371, 0.217).normalize());
  const hit = {};
  const field = ([x, y, z]) => {
    point.set(x, y, z);
    const nearest = bvh.closestPointToPoint(point, hit);
    const inside =
      bounds.containsPoint(point) && bvh.raycast(ray, T.DoubleSide).length % 2;
    return nearest.distance * (inside ? 1 : -1);
  };

  // Resample first, then adapt the triangles to the shape of the wrap.
  let fine = cell;
  let coarse = Math.max(cell, span / 3);
  let best;
  let bestScore = Infinity;
  const size = bounds.getSize(new T.Vector3());
  const boxArea = 2 * (size.x * size.y + size.y * size.z + size.z * size.x);
  const edgeLimit = Math.min(span * 0.85, 8 * Math.sqrt(boxArea / target));
  const consider = (mesh) => {
    const count = mesh.indices.length / 3;
    if (!count || hasLongEdges(mesh, edgeLimit)) return;
    const error = Math.abs(Math.log(count / target));
    const score = error - 0.65 * Math.log(Math.min(10, areaSpread(mesh)));
    if (score < bestScore) {
      best = mesh;
      bestScore = score;
    }
  };
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const step = attempt === 0 ? coarse : (fine + coarse) / 2;
      const padded = bounds.clone().expandByScalar(step * 2);
      const candidate = m.Manifold.levelSet(
        field,
        { min: padded.min.toArray(), max: padded.max.toArray() },
        step,
      );
      try {
        if (!candidate.numTri()) {
          coarse = step;
          continue;
        }
        const seedCount = candidate.numTri();
        consider(facadeMesh(candidate));
        // Try several error budgets on a denser seed so small bends have
        // vertices to retain when broader stretches are simplified.
        for (const fraction of [0.06, 0.14, 0.28, 0.5]) {
          const simplified = candidate.simplify(step * fraction);
          try {
            if (simplified.numTri()) consider(facadeMesh(simplified));
          } finally {
            simplified.delete();
          }
        }
        if (seedCount > target * 4) fine = step;
        else coarse = step;
      } finally {
        candidate.delete();
      }
    }
  } finally {
    geometry.dispose();
  }
  return best ?? source;
}
