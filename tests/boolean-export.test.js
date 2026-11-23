import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import rhino3dm from "rhino3dm";
import {
  booleanExportPieces,
  addRhinoBuildingPiece,
} from "../src/boolean-export.js";
import { booleanFloors, checkedRaw } from "../src/boolean-model.js";
import { addRhinoMesh, rhinoRaw } from "../src/rhino-io.js";
import { meshQuality } from "../src/mesh-quality.js";

test("separate Rhino export preserves cut, closed, named parts even with a joined assembly", async () => {
  const m = await Module();
  m.setup();
  const box = m.Manifold.cube([10, 10, 10]);
  const raw = checkedRaw(box);
  box.delete();
  const floors = booleanFloors(
    m,
    [
      {
        index: 0,
        name: "FLOOR 1",
        elevation: 0,
        raw,
        perimeter: [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        columns: [raw, raw],
        walls: [raw],
      },
    ],
    [],
    1,
  );
  const outputs = {
    floors,
    shells: [{ name: "ATRIUM SHELL", raw }],
    assembly: raw,
  };
  const separate = booleanExportPieces(outputs, true);
  assert.equal(separate.length, 6);
  assert.equal(booleanExportPieces(outputs).length, 1);
  assert.equal(booleanExportPieces(outputs)[0].raw, outputs.assembly);
  assert.equal(separate[0].raw, floors[0].pieces[0].raw);
  const r = await rhino3dm(),
    doc = new r.File3dm();
  try {
    for (const piece of separate) addRhinoBuildingPiece(r, doc, piece);
    const back = r.File3dm.fromByteArray(doc.toByteArray());
    try {
      assert.equal(back.objects().count, 6);
      for (let i = 0; i < 6; i++) {
        const obj = back.objects().get(i);
        assert.equal(obj.attributes().name, separate[i].name);
        if (separate[i].extrusion) {
          const g = obj.geometry();
          assert.ok(g instanceof r.Extrusion);
          assert.equal(g.isSolid, true);
          assert.ok(Math.abs(g.pathEnd[2] - 0) < 1e-8);
          assert.ok(Math.abs(g.pathStart[2] + 1) < 1e-8);
        } else
          assert.equal(meshQuality(rhinoRaw(obj.geometry())).boundaryEdges, 0);
      }
    } finally {
      back.delete();
    }
  } finally {
    doc.delete();
  }
  assert.deepEqual(booleanExportPieces(null, true), []);
  assert.equal(booleanExportPieces({ floors, shells: [] }).length, 5);
});
