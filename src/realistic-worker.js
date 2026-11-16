import Module from "manifold-3d";
import wasmURL from "manifold-3d/manifold.wasm?url";
import {
  buildRoomEnvelope,
  realisticBuilding,
  realisticMesh,
  realisticSection,
} from "./realistic-model.js";

const ready = Module({ locateFile: () => wasmURL }).then((m) => {
  m.setup();
  return m;
});
let building, roomVoids;
const rooms = new Map();
function release(room) {
  room.outside.delete();
  room.inside.delete();
}
self.onmessage = async ({ data }) => {
  try {
    const m = await ready;
    let mesh;
    if (data.kind === "build") {
      const retained = new Set();
      try {
        const floors = data.floors.map((floor) => {
          let room;
          if (floor.raw?.indices.length) {
            const key = [
              floor.index,
              floor.meshId,
              floor.floor,
              data.shellThickness,
            ].join(":");
            retained.add(key);
            room = rooms.get(key);
            if (!room) {
              try {
                room = buildRoomEnvelope(
                  m,
                  floor.raw,
                  data.shellThickness,
                  floor.floor,
                );
              } catch (error) {
                throw Error(floor.name + ": " + error.message);
              }
              rooms.set(key, room);
            }
          }
          return { ...floor, room };
        });
        const next = realisticBuilding(m, floors, data.slabThickness);
        try {
          mesh = realisticMesh(next);
        } catch (error) {
          next.delete();
          throw error;
        }
        building?.delete();
        building = next;
        roomVoids?.delete();
        const interiors = floors.flatMap((floor) =>
          floor.room ? [floor.room.inside] : [],
        );
        roomVoids = interiors.length ? m.Manifold.union(interiors) : undefined;
      } finally {
        for (const [key, room] of rooms) {
          if (retained.has(key)) continue;
          release(room);
          rooms.delete(key);
        }
      }
    } else {
      if (!building) throw Error("Build the model before cutting a section.");
      mesh = realisticSection(m, building, data.frame, roomVoids);
    }
    self.postMessage({ kind: data.kind, key: data.key, mesh }, [
      mesh.positions.buffer,
      mesh.indices.buffer,
    ]);
  } catch (error) {
    self.postMessage({ kind: data.kind, key: data.key, error: error.message });
  }
};
