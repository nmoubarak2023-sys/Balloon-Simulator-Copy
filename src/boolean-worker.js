import { subtractCutters } from "./boolean-model.js";
import { buildRoomEnvelope } from "./realistic-model.js";
import Module from "manifold-3d";
import wasmURL from "manifold-3d/manifold.wasm?url";
import { booleanFloors, retainedShell, checkedRaw } from "./boolean-model.js";
import { rawSolid } from "./boolean-model.js";
const ready = Module({ locateFile: () => wasmURL }).then((m) => {
  m.setup();
  return m;
});
self.onmessage = async ({ data }) => {
  const nativePieces = [];
  const rooms = new Map();
  let roomInteriors;
  const floorGroups = new Map(),
    shellIndices = [],
    joinedFloors = [];
  const addFloorSolid = (index, solid) => {
    if (!floorGroups.has(index)) floorGroups.set(index, []);
    floorGroups.get(index).push(nativePieces.length);
    nativePieces.push(solid);
  };
  let joined;
  try {
    const m = await ready;
    self.postMessage({ progress: "CUTTING FLOOR PLATES AND ENCLOSURES…" });
    const floors = booleanFloors(
      m,
      data.floors,
      data.cutters,
      data.slabThickness,
    );
    for (const floor of data.floors) {
      if (!floor.raw?.indices.length) continue;
      self.postMessage({
        progress: "BUILDING HOLLOW ENVELOPE · " + floor.name.toUpperCase(),
      });
      rooms.set(
        floor.index,
        buildRoomEnvelope(m, floor.raw, data.vaultThickness, floor.elevation),
      );
    }
    if (rooms.size)
      roomInteriors = m.Manifold.union(
        [...rooms.values()].map((room) => room.inside),
      );
    for (const floor of data.floors) {
      if (!floor.raw?.indices.length) continue;
      self.postMessage({
        progress: "THICKENING AND CUTTING " + floor.name.toUpperCase() + "…",
      });
      const room = rooms.get(floor.index);
      let shell, cut;
      try {
        // Overlapping floors share habitable voids. Hollow against all rooms,
        // otherwise a neighbouring vault's outer envelope fills this room.
        shell = room.outside.subtract(roomInteriors);
        cut = subtractCutters(m, shell, data.cutters, floor.index, "vaults");
        const piece = floors
          .find((item) => item.index === floor.index)
          .pieces.find((item) => item.name === floor.name + " VAULTS");
        piece.raw = checkedRaw(cut);
        if (data.joinResult)
          addFloorSolid(floor.index, cut.translate([0, 0, 0]));
      } finally {
        if (cut && cut !== shell) cut.delete();
        shell?.delete();
      }
    }
    const shells = [];
    for (const cutter of data.cutters.filter(
      (c) => c.enabled && c.mode === "shell",
    )) {
      const solid = retainedShell(m, cutter);
      try {
        shells.push({ name: cutter.name + " SHELL", raw: checkedRaw(solid) });
        if (data.joinResult) {
          shellIndices.push(nativePieces.length);
          nativePieces.push(solid.translate([0, 0, 0]));
        }
      } finally {
        solid.delete();
      }
    }
    // Display the validated cuts before the optional whole-building union.
    self.postMessage({ preview: { floors, shells } });
    self.postMessage({
      progress: "JOINING AND VALIDATING CLOSED BUILDING MESHES…",
    });
    let assembly;
    if (data.joinResult) {
      // Keep the original double-precision solids for the curved shells.
      // Reimporting their Float32 display meshes creates microscopic overlaps
      // and slivers at the very interfaces that the final union must resolve.
      for (const floor of floors)
        for (const piece of floor.pieces)
          if (!piece.name.endsWith(" VAULTS") && piece.raw.indices.length)
            addFloorSolid(floor.index, rawSolid(m, piece.raw));
      // Imported supports contain dense, nearly coplanar canopy grids. A
      // bounded 0.001 ft (0.305 mm) kernel simplification avoids millions of
      // redundant intersections without opening or smoothing the solids.
      for (let i = 0; i < nativePieces.length; i++) {
        const simplified = nativePieces[i].simplify(0.001);
        nativePieces[i].delete();
        nativePieces[i] = simplified;
      }
      // Resolve the dense support/canopy interfaces locally before adding
      // shells that span several floors to the final building union.
      for (const [index, indices] of floorGroups) {
        self.postMessage({
          progress: "JOINING FLOOR " + (index + 1) + " SUPPORTS AND VAULTS…",
        });
        const combined = m.Manifold.union(indices.map((i) => nativePieces[i]));
        try {
          joinedFloors.push(combined.simplify(0.001));
        } finally {
          combined.delete();
        }
      }
      joined = m.Manifold.union([
        ...joinedFloors,
        ...shellIndices.map((i) => nativePieces[i]),
      ]);
      self.postMessage({ progress: "VALIDATING JOINED MESH…" });
      assembly = checkedRaw(joined, 0.001);
    }
    self.postMessage({ floors, shells, assembly });
  } catch (error) {
    self.postMessage({ error: error.message });
  } finally {
    joined?.delete();
    joinedFloors.forEach((solid) => solid.delete());
    nativePieces.forEach((solid) => solid.delete());
    roomInteriors?.delete();
    rooms.forEach((room) => {
      room.outside.delete();
      room.inside.delete();
    });
  }
};
