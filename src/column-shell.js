import * as T from "three";
import { MeshBVH } from "three-mesh-bvh";
import { geometry } from "./view.js";
import { facadeMesh } from "./facade-wrap.js";

// Regularize the distance field before extracting either skin. Both surfaces
// follow the same field, so smoothing cannot push the cavity through the wall.
export function buildColumnShell(m, raw, thickness) {
  if (!Number.isFinite(thickness) || thickness <= 0)
    throw Error("Enter a valid shell thickness.");
  const origin = Array.from(raw.positions.slice(0, 3));
  const mesh = geometry(raw, origin);
  let outside, cavity;
  try {
    mesh.computeBoundingBox();
    const bounds = mesh.boundingBox;
    const size = bounds.getSize(new T.Vector3());
    const span = Math.max(size.x, size.y, size.z);
    const cell = span / 120;
    if (!(cell > 0)) throw Error("The enclosure has no volume.");
    const padded = bounds.clone().expandByScalar(cell * 4);
    const min = padded.min.toArray();
    const [nx, ny, nz] = padded
      .getSize(new T.Vector3())
      .toArray()
      .map((length) => Math.ceil(length / cell) + 1);
    const strides = [1, nx, nx * ny];
    let field = new Float32Array(nx * ny * nz);
    let scratch = new Float32Array(field.length);
    const bvh = new MeshBVH(mesh, { indirect: true });
    const point = new T.Vector3();
    const ray = new T.Ray(point, new T.Vector3(1, 0.371, 0.217).normalize());
    const nearest = {};
    for (let z = 0, i = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          point.set(min[0] + x * cell, min[1] + y * cell, min[2] + z * cell);
          const distance = bvh.closestPointToPoint(point, nearest).distance;
          field[i] =
            bounds.containsPoint(point) &&
            bvh.raycast(ray, T.DoubleSide).length % 2
              ? distance
              : -distance;
        }
      }
    }
    // Two local binomial passes soften narrow spikes and serrations without
    // flattening broad lobes or spreading across the whole enclosure.
    for (let pass = 0; pass < 2; pass++) {
      for (const stride of strides) {
        for (let z = 1; z < nz - 1; z++) {
          for (let y = 1; y < ny - 1; y++) {
            let i = z * strides[2] + y * nx + 1;
            for (let x = 1; x < nx - 1; x++, i++)
              scratch[i] =
                (field[i - stride] + 2 * field[i] + field[i + stride]) / 4;
          }
        }
        // Keep the padded border negative and unchanged between passes.
        for (let i = 0; i < field.length; i++) {
          const x = i % nx,
            y = Math.floor(i / nx) % ny,
            z = Math.floor(i / strides[2]);
          if (!x || !y || !z || x === nx - 1 || y === ny - 1 || z === nz - 1)
            scratch[i] = field[i];
        }
        [field, scratch] = [scratch, field];
      }
    }
    const sample = ([x, y, z]) => {
      const u = (x - min[0]) / cell,
        v = (y - min[1]) / cell,
        w = (z - min[2]) / cell;
      const a = Math.floor(u),
        b = Math.floor(v),
        c = Math.floor(w);
      if (a < 0 || b < 0 || c < 0 || a >= nx - 1 || b >= ny - 1 || c >= nz - 1)
        return -cell;
      const i = a + b * nx + c * strides[2];
      const lerp = (p, q, t) => p + (q - p) * t;
      const row = (j) => lerp(field[j], field[j + 1], u - a);
      const slice = (j) => lerp(row(j), row(j + nx), v - b);
      return Math.min(
        lerp(slice(i), slice(i + strides[2]), w - c),
        z - bounds.min.z,
      );
    };
    const box = { min, max: padded.max.toArray() };
    // Use the same extraction lattice for both wall surfaces.
    outside = m.Manifold.levelSet(sample, box, cell * 0.75, 0);
    cavity = m.Manifold.levelSet(sample, box, cell * 0.75, thickness);
    if (outside.isEmpty() || outside.status() !== "NoError")
      throw Error("Could not form a clean exterior from this enclosure.");
    if (cavity.isEmpty() || cavity.status() !== "NoError")
      throw Error("Could not form an interior cavity. Try a thinner shell.");
    const tolerance = Math.min(cell * 0.06, thickness * 0.03);
    const simplifiedOuter = outside.simplify(tolerance);
    const simplifiedInner = cavity.simplify(tolerance);
    outside.delete();
    cavity.delete();
    outside = simplifiedOuter;
    cavity = simplifiedInner;
    const outer = facadeMesh(outside),
      inner = facadeMesh(cavity);
    const positions = new Float64Array(
      outer.positions.length + inner.positions.length,
    );
    positions.set(outer.positions);
    positions.set(inner.positions, outer.positions.length);
    for (let i = 0; i < positions.length; i++) positions[i] += origin[i % 3];
    const indices = new Uint32Array(
      outer.indices.length + inner.indices.length,
    );
    indices.set(outer.indices);
    const offset = outer.positions.length / 3;
    for (let i = 0; i < inner.indices.length; i += 3) {
      const j = outer.indices.length + i;
      indices[j] = inner.indices[i] + offset;
      indices[j + 1] = inner.indices[i + 2] + offset;
      indices[j + 2] = inner.indices[i + 1] + offset;
    }
    return { positions, indices };
  } finally {
    outside?.delete();
    cavity?.delete();
    mesh.dispose();
  }
}
