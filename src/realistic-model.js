import * as T from "three";
import { MeshBVH } from "three-mesh-bvh";
import { facadeMesh } from "./facade-wrap.js";
import { subtractCutters, retainedShell } from "./boolean-model.js";

function nativeMesh(m, raw, origin) {
  return new m.Manifold(
    new m.Mesh({
      numProp: 3,
      vertProperties: Float32Array.from(
        raw.positions,
        (v, i) => v - origin[i % 3],
      ),
      triVerts: Uint32Array.from(raw.indices),
    }),
  );
}

// Offset the joined room volume. Its original surface is used for the cavity,
// so varying shell thickness does not shrink the rooms or close their seams.
export function buildRoomEnvelope(m, raw, thickness, floor) {
  const origin = Array.from(raw.positions.slice(0, 3));
  const room = nativeMesh(m, raw, origin);
  const mesh = new T.BufferGeometry();
  let expanded, trimmed;
  try {
    if (room.status() !== "NoError" || room.isEmpty())
      throw Error("The balloon enclosure must be closed.");
    mesh.setAttribute(
      "position",
      new T.BufferAttribute(
        Float32Array.from(raw.positions, (v, i) => v - origin[i % 3]),
        3,
      ),
    );
    mesh.setIndex(new T.BufferAttribute(Uint32Array.from(raw.indices), 1));
    mesh.computeBoundingBox();
    const bounds = mesh.boundingBox;
    const size = bounds.getSize(new T.Vector3());
    const cell = Math.max(
      Math.max(size.x, size.y, size.z) / 110,
      thickness / 3,
    );
    const box = bounds.clone().expandByScalar(thickness + 3 * cell);
    const bvh = new MeshBVH(mesh, { indirect: true });
    const point = new T.Vector3();
    const ray = new T.Ray(point, new T.Vector3(1, 0.371, 0.217).normalize());
    const closest = {};
    const band = thickness + 3 * cell;
    expanded = m.Manifold.levelSet(
      ([x, y, z]) => {
        point.set(x, y, z);
        if (bounds.distanceToPoint(point) > band) return -band;
        const nearest = bvh.closestPointToPoint(point, closest, 0, band);
        const inside =
          bounds.containsPoint(point) &&
          bvh.raycast(ray, T.DoubleSide).length % 2;
        const distance = nearest?.distance ?? band;
        return inside ? distance : -distance;
      },
      { min: box.min.toArray(), max: box.max.toArray() },
      cell,
      -thickness,
    );
    // A clipped floor uses the slab as its base. Preserve balloon edits that
    // intentionally extend below the floor.
    const base = floor - origin[2];
    const hasFlatBase = Math.abs(bounds.min.z - base) < 1e-4;
    trimmed = hasFlatBase ? expanded.trimByPlane([0, 0, 1], base) : null;
    const envelope = trimmed ?? expanded;
    if (envelope.status() !== "NoError" || envelope.isEmpty())
      throw Error(
        "Could not offset the balloon shell. Try a different thickness.",
      );
    return {
      outside: envelope.translate(origin),
      inside: room.translate(origin),
    };
  } finally {
    mesh.dispose();
    room.delete();
    trimmed?.delete();
    expanded?.delete();
  }
}

export function realisticBuilding(m, floors, slabThickness) {
  const owned = [];
  const own = (solid) => (owned.push(solid), solid);
  try {
    const rooms = floors.flatMap((floor) => (floor.room ? [floor.room] : []));
    const solids = [];
    if (rooms.length) {
      const inside = own(m.Manifold.union(rooms.map((room) => room.inside)));
      for (const floor of floors) {
        if (!floor.room) continue;
        const shell = own(floor.room.outside.subtract(inside));
        const cut = subtractCutters(
          m,
          shell,
          floor.booleanCutters ?? [],
          floor.index,
          "vaults",
        );
        solids.push(cut === shell ? shell : own(cut));
      }
    }
    for (const floor of floors) {
      if (floor.perimeter?.length >= 3) {
        const outline = own(new m.CrossSection([floor.perimeter], "EvenOdd"));
        if (!outline.isEmpty()) {
          const slab = own(
            own(outline.extrude(slabThickness)).translate([
              0,
              0,
              floor.elevation - slabThickness,
            ]),
          );
          const cut = subtractCutters(
            m,
            slab,
            floor.booleanCutters ?? [],
            floor.index,
            "slabs",
          );
          solids.push(cut === slab ? slab : own(cut));
        }
      }
      for (const [index, raw] of floor.columns.entries()) {
        const origin = Array.from(raw.positions.slice(0, 3));
        const column = own(nativeMesh(m, raw, origin));
        if (column.status() !== "NoError")
          throw Error(
            "A column mesh is not closed. Check it in Column POPulate.",
          );
        if (!column.isEmpty()) {
          const placed = own(column.translate(origin));
          const target =
            index >= floor.columns.length - (floor.wallCount ?? 0)
              ? "walls"
              : "columns";
          const cut = subtractCutters(
            m,
            placed,
            floor.booleanCutters ?? [],
            floor.index,
            target,
          );
          solids.push(cut === placed ? placed : own(cut));
        }
      }
    }
    for (const cutter of floors[0]?.booleanCutters ?? [])
      if (cutter.enabled && cutter.mode === "shell")
        solids.push(own(retainedShell(m, cutter)));
    const building = m.Manifold.union(solids);
    if (building.status() !== "NoError") {
      building.delete();
      throw Error("Could not join the building geometry.");
    }
    return building;
  } finally {
    for (const solid of owned) solid.delete();
  }
}

export function realisticSection(m, building, frame, rooms) {
  const toWorld = new T.Matrix4().fromArray(frame);
  const transformed = building.transform(toWorld.clone().invert().toArray());
  let crossSection, roomSlice, transformedRooms, pockets, fill, filled;
  try {
    // Slice just inside the retained side to handle coincident slab faces.
    const sliceZ = 0.0001;
    crossSection = transformed.slice(sliceZ);
    let loops = crossSection.toPolygons();
    if (rooms) {
      const holes = loops.filter(
        (loop) =>
          loop.reduce((area, [x, y], index) => {
            const [nx, ny] = loop[(index + 1) % loop.length];
            return area + x * ny - y * nx;
          }, 0) < 0,
      );
      if (holes.length) {
        transformedRooms = rooms.transform(toWorld.clone().invert().toArray());
        roomSlice = transformedRooms.slice(sliceZ);
        pockets = new m.CrossSection(
          holes.map((loop) => [...loop].reverse()),
          "NonZero",
        );
        fill = pockets.subtract(roomSlice);
        filled = crossSection.add(fill);
        loops = filled.toPolygons();
      }
    }
    const position = new T.Vector3();
    const positions = loops.flatMap((loop) =>
      loop.flatMap(([x, y]) =>
        position.set(x, y, sliceZ).applyMatrix4(toWorld).toArray(),
      ),
    );
    return {
      positions: new Float32Array(positions),
      indices: new Uint32Array(loops.length ? m.triangulate(loops).flat() : []),
    };
  } finally {
    for (const section of [filled, fill, pockets, roomSlice, transformedRooms])
      section?.delete();
    crossSection?.delete();
    transformed.delete();
  }
}

export { facadeMesh as realisticMesh };
