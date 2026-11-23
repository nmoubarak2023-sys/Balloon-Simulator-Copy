import { addRhinoMesh } from "./rhino-io.js";

export function addRhinoBuildingPiece(r, doc, piece) {
  if (!piece.extrusion) return addRhinoMesh(r, doc, piece.raw, piece.name);
  const { perimeter, base, height } = piece.extrusion;
  const points = perimeter.map((p) => [p[0], p[1], base]);
  const area = points.reduce((s, a, i) => {
    const b = points[(i + 1) % points.length];
    return s + a[0] * b[1] - b[0] * a[1];
  }, 0);
  if (area < 0) points.reverse();
  if (points[0].some((v, k) => v !== points.at(-1)[k]))
    points.push([...points[0]]);
  const curve = new r.PolylineCurve(points);
  let extrusion, attr;
  try {
    extrusion = r.Extrusion.create(curve, height, true);
    if (!extrusion?.isSolid)
      throw Error("COULD NOT CREATE CLOSED FLOOR EXTRUSION.");
    attr = new r.ObjectAttributes();
    attr.name = piece.name;
    doc.objects().addExtrusion(extrusion, attr);
  } finally {
    attr?.delete();
    extrusion?.delete();
    curve.delete();
  }
}

// Use the final cut pieces, never the original uncut inputs or cutter previews.
export function booleanExportPieces(outputs, separate = false) {
  if (!outputs) return [];
  if (!separate && outputs.assembly)
    return [{ name: "BOOLEAN BUILDING · JOINED", raw: outputs.assembly }];
  return [
    ...outputs.floors.flatMap((floor) => floor.pieces),
    ...outputs.shells,
  ].filter((piece) => piece.raw?.indices.length);
}
