import { meshQuality, prepareMesh } from "./mesh-quality.js";
import { repairBooleanSlivers } from "./boolean-slivers.js";
import { removeNumericalSheets } from "./precision-client.js";

export function affects(cutter, floor, target) {
  return (
    cutter.enabled &&
    cutter.floors.includes(floor) &&
    cutter.targets.includes(target)
  );
}

export function cutterSolid(m, cutter, offset = 0) {
  const axes = cutter.size.map((v) => v / 2);
  if (
    ![...axes, cutter.thickness].every((v) => Number.isFinite(v) && v > 0) ||
    ![...cutter.position, ...cutter.rotation].every(Number.isFinite)
  )
    throw Error(
      "Balloon dimensions and thickness must be positive and coordinates must be finite.",
    );
  if (
    offset < 0 &&
    -offset >= (Math.min(...axes) ** 2 / Math.max(...axes)) * 0.8
  )
    throw Error(
      "Shell thickness is too large for this balloon's curvature. Reduce thickness or use OUTWARD.",
    );
  const owned = [];
  const own = (value) => (owned.push(value), value);
  try {
    const sphere = own(m.Manifold.sphere(1, cutter.quality));
    const scaled = own(sphere.scale(axes));
    const shape = offset
      ? own(
          scaled.warp((p) => {
            const normal = p.map((v, i) => v / axes[i] ** 2);
            const length = Math.hypot(...normal);
            for (let i = 0; i < 3; i++) p[i] += (offset * normal[i]) / length;
          }),
        )
      : scaled;
    const rotated = own(shape.rotate(cutter.rotation));
    return rotated.translate(cutter.position);
  } finally {
    owned.forEach((solid) => solid.delete());
  }
}

export function subtractCutters(m, solid, cutters, floor, target) {
  let result = solid;
  try {
    for (const cutter of cutters) {
      if (!affects(cutter, floor, target)) continue;
      const tool = cutterSolid(m, cutter);
      try {
        const next = result.subtract(tool);
        if (next.status() !== "NoError") {
          next.delete();
          throw Error("Boolean subtraction failed.");
        }
        if (result !== solid) result.delete();
        result = next;
      } finally {
        tool.delete();
      }
    }
    return result;
  } catch (error) {
    if (result !== solid) result.delete();
    throw error;
  }
}

export function retainedShell(m, cutter) {
  const t = cutter.thickness;
  const outerOffset =
    cutter.offset === "inward" ? 0 : cutter.offset === "centered" ? t / 2 : t;
  const outer = cutterSolid(m, cutter, outerOffset);
  const inner = cutterSolid(m, cutter, outerOffset - t);
  try {
    return outer.subtract(inner);
  } finally {
    outer.delete();
    inner.delete();
  }
}

export function rawSolid(m, raw) {
  const origin = Array.from(raw.positions.slice(0, 3));
  const mesh = new m.Mesh({
    numProp: 3,
    vertProperties: Float32Array.from(
      raw.positions,
      (v, i) => v - origin[i % 3],
    ),
    triVerts: Uint32Array.from(raw.indices),
  });
  mesh.merge();
  const solid = new m.Manifold(mesh);
  if (solid.status() !== "NoError") {
    solid.delete();
    throw Error(
      "Input mesh is not closed. Repair it before applying a Boolean.",
    );
  }
  const placed = solid.translate(origin);
  solid.delete();
  return placed;
}

export function checkedRaw(solid, tolerance = 0.00001) {
  if (solid.status() !== "NoError")
    throw Error("Boolean result failed solid validation.");
  // Remove sub-millimetre intersection slivers through the solid kernel,
  // preserving its closed topology before converting to rendering vertices.
  const cleaned = solid.simplify(tolerance);
  const bounds = cleaned.boundingBox();
  const origin = bounds.min.map((v, i) => (v + bounds.max[i]) / 2);
  const centered = cleaned.isEmpty()
    ? null
    : cleaned.translate(origin.map((v) => -v));
  // MeshGL stores coordinates as Float32. Preserve the kernel's double
  // coordinates in three residual property channels before conversion, so
  // close intersection vertices do not collapse to zero-area triangles.
  const precise = (centered ?? cleaned).setProperties(3, (props, position) => {
    for (let k = 0; k < 3; k++)
      props[k] = position[k] - Math.fround(position[k]);
  });
  let raw;
  try {
    const mesh = precise.getMesh();
    const positions = new Float64Array(
      (mesh.vertProperties.length / mesh.numProp) * 3,
    );
    for (let i = 0; i < positions.length / 3; i++)
      for (let k = 0; k < 3; k++)
        positions[i * 3 + k] =
          mesh.vertProperties[i * mesh.numProp + k] +
          mesh.vertProperties[i * mesh.numProp + 3 + k] +
          (centered ? origin[k] : 0);
    raw = {
      positions,
      indices: Uint32Array.from(mesh.triVerts),
    };
  } finally {
    precise.delete();
    centered?.delete();
    cleaned.delete();
  }
  // Float32 kernel output can leave microscopic slivers after intersections.
  // Retry conditioning from the original mesh within a bounded sub-millimetre
  // tolerance; never accept a repair that opens the solid.
  const initialQuality = meshQuality(raw);
  if (
    raw.indices.length > 600000 &&
    (initialQuality.duplicateFaces || initialQuality.degenerateFaces)
  )
    raw = removeNumericalSheets(raw, 0.001).raw;
  if (meshQuality(raw).degenerateFaces) {
    const original = raw;
    for (const tolerance of [0.00001, 0.00005, 0.0001, 0.0005, 0.001]) {
      const candidate =
        raw.indices.length > 600000
          ? repairBooleanSlivers(raw, tolerance)
          : prepareMesh(original, tolerance, {
              precision: "double",
              regularizeTiny: true,
              flip: false,
            });
      const audit = meshQuality(candidate);
      if (
        !audit.boundaryEdges &&
        !audit.nonManifoldEdges &&
        !audit.inconsistentEdges &&
        audit.finite
      )
        raw = candidate;
      if (
        !audit.boundaryEdges &&
        !audit.nonManifoldEdges &&
        !audit.degenerateFaces &&
        !audit.inconsistentEdges &&
        audit.finite
      ) {
        raw = candidate;
        break;
      }
    }
  }
  const quality = meshQuality(raw);
  if (
    quality.boundaryEdges ||
    quality.nonManifoldEdges ||
    quality.degenerateFaces ||
    quality.duplicateFaces ||
    quality.invalidFaces ||
    quality.inconsistentEdges ||
    !quality.finite
  )
    throw Error(
      "Boolean result has invalid edges or faces. Try a higher mesh quality.",
    );
  return raw;
}

export function booleanFloors(m, floors, cutters, slabThickness) {
  return floors.map((floor) => {
    const pieces = [];
    let raw = floor.raw;
    if (raw?.indices.length) {
      const original = rawSolid(m, raw);
      const cut = subtractCutters(m, original, cutters, floor.index, "vaults");
      try {
        raw = checkedRaw(cut);
        pieces.push({ name: floor.name + " VAULTS", raw });
      } finally {
        if (cut !== original) cut.delete();
        original.delete();
      }
    }
    if (floor.perimeter?.length >= 3) {
      const section = new m.CrossSection([floor.perimeter], "EvenOdd");
      const base = section.extrude(slabThickness);
      const slab = base.translate([0, 0, floor.elevation - slabThickness]);
      const cut = subtractCutters(m, slab, cutters, floor.index, "slabs");
      try {
        pieces.push({ name: floor.name + " SLAB", raw: checkedRaw(cut) });
      } finally {
        if (cut !== slab) cut.delete();
        slab.delete();
        base.delete();
        section.delete();
      }
    }
    for (const target of ["columns", "walls"])
      for (const [index, input] of (floor[target] ?? []).entries()) {
        const original = rawSolid(m, input);
        const cut = subtractCutters(m, original, cutters, floor.index, target);
        try {
          pieces.push({
            name: floor.name + " " + target.toUpperCase() + " " + (index + 1),
            raw: checkedRaw(cut),
          });
        } finally {
          if (cut !== original) cut.delete();
          original.delete();
        }
      }
    return { index: floor.index, raw, pieces };
  });
}

export function joinBooleanPieces(m, pieces, progress = () => {}) {
  const solids = [];
  let joined;
  try {
    for (const piece of pieces)
      if (piece.raw.indices.length) solids.push(rawSolid(m, piece.raw));
    if (!solids.length)
      return { positions: new Float64Array(), indices: new Uint32Array() };
    progress("JOINING BUILDING SOLIDS…");
    joined = m.Manifold.union(solids);
    progress("VALIDATING JOINED MESH…");
    return checkedRaw(joined);
  } finally {
    joined?.delete();
    solids.forEach((solid) => solid.delete());
  }
}
