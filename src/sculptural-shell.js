import * as T from "three";

// Periodic in plan, open at the top and bottom. Widths are fractions of the
// entire envelope, so raising mesh resolution cannot add new articulation.
function smooth(field, rows, cols, sweep) {
  const pass = (input, count, sigma, vertical) => {
    const output = new Float64Array(input.length);
    const reach = Math.ceil(3 * sigma);
    const weights = Array.from({ length: reach + 1 }, (_, i) =>
      Math.exp(-0.5 * (i / sigma) ** 2),
    );
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        let sum = 0,
          weight = 0;
        for (let d = -reach; d <= reach; d++) {
          const j = (vertical ? r : c) + d;
          if (vertical && (j < 0 || j >= count)) continue;
          const w = weights[Math.abs(d)];
          sum +=
            w *
            input[vertical ? j * cols + c : r * cols + ((j + count) % count)];
          weight += w;
        }
        output[r * cols + c] = sum / weight;
      }
    return output;
  };
  return pass(
    pass(field, cols, cols * (0.038 + 0.032 * sweep), false),
    rows,
    rows * (0.095 + 0.1 * sweep),
    true,
  );
}

export function sculpturalShell(
  inputFloors,
  settings,
  obstacles,
  perimeterRadius,
) {
  const floors = [...inputFloors].sort((a, b) => a.z - b.z);
  const bounds = new T.Box3();
  for (const floor of floors)
    for (const [x, y] of floor.loop)
      bounds.expandByPoint(new T.Vector3(x, y, floor.z));
  const center = bounds.getCenter(new T.Vector3());
  for (const mesh of obstacles) bounds.union(mesh.boundingBox);
  const reach = bounds.getSize(new T.Vector3()).length() * 2 + 1;
  const bottom = bounds.min.z;
  const top = Math.max(
    bounds.max.z,
    floors.at(-1).z + (floors.length === 1 ? 20 : 0.01),
  );
  const columns = settings.resolution;
  const rows = Math.ceil(columns / 2) + 1;
  const zAt = (r) => T.MathUtils.lerp(bottom, top, r / (rows - 1));
  const angles = Array.from({ length: columns }, (_, c) => {
    const a = (c * 2 * Math.PI) / columns;
    return [Math.cos(a), Math.sin(a)];
  });
  const plates = floors.map(({ loop }) =>
    angles.map(([x, y]) => perimeterRadius(loop, center, x, y)),
  );
  const clearance = new Float64Array(rows * columns);
  const ray = new T.Ray();
  for (let r = 0; r < rows; r++) {
    const z = zAt(r);
    const upper = floors.findIndex((f) => f.z >= z);
    const b = upper < 0 ? floors.length - 1 : upper;
    const a = upper < 0 ? b : Math.max(0, b - 1);
    const t = a === b ? 0 : (z - floors[a].z) / (floors[b].z - floors[a].z);
    const adjacent = floors.flatMap((f, i) =>
      Math.abs(f.z - z) <= zAt(1) - bottom ? [i] : [],
    );
    angles.forEach(([x, y], c) => {
      let radius = T.MathUtils.lerp(plates[a][c], plates[b][c], t);
      for (const i of adjacent) radius = Math.max(radius, plates[i][c]);
      ray.origin.set(center.x + reach * x, center.y + reach * y, z);
      ray.direction.set(-x, -y, 0);
      for (const mesh of obstacles) {
        if (z < mesh.boundingBox.min.z || z > mesh.boundingBox.max.z) continue;
        const hit = mesh.boundsTree.raycastFirst(ray, T.DoubleSide);
        if (hit) radius = Math.max(radius, reach - hit.distance);
      }
      clearance[r * columns + c] = Math.max(0.05, radius) + settings.offset;
    });
  }
  // A fixed control cage abstracts the massing before display tessellation.
  // Closing fills narrow recesses while retaining openings wider than a bay.
  const cageColumns = 16;
  const cageRows = 6;
  const sweep = settings.sweep / 100;
  const morph = (input, combine, neutral) =>
    input.map((_, index) => {
      const r = Math.floor(index / cageColumns),
        c = index % cageColumns;
      let value = neutral;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const row = T.MathUtils.clamp(r + dr, 0, cageRows - 1);
          const col = (c + dc + cageColumns) % cageColumns;
          value = combine(value, input[row * cageColumns + col]);
        }
      return value;
    });
  const cage = new Float64Array(cageColumns * cageRows);
  clearance.forEach((value, i) => {
    const r = Math.round(
      (Math.floor(i / columns) * (cageRows - 1)) / (rows - 1),
    );
    const c = Math.round(((i % columns) * cageColumns) / columns) % cageColumns;
    const j = r * cageColumns + c;
    cage[j] = Math.max(cage[j], value);
  });
  const closed = morph(morph(cage, Math.max, -Infinity), Math.min, Infinity);
  const controls = smooth(closed, cageRows, cageColumns, sweep);
  const knot = (r, c) =>
    controls[
      T.MathUtils.clamp(r, 0, cageRows - 1) * cageColumns +
        ((c + cageColumns) % cageColumns)
    ];
  const cubic = (a, b, c, d, t) =>
    b +
    0.5 *
      t *
      (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
  const sample = (r, c) => {
    const ri = Math.floor(r),
      ci = Math.floor(c);
    const values = [-1, 0, 1, 2].map((dr) =>
      cubic(
        knot(ri + dr, ci - 1),
        knot(ri + dr, ci),
        knot(ri + dr, ci + 1),
        knot(ri + dr, ci + 2),
        c - ci,
      ),
    );
    return cubic(...values, r - ri);
  };

  // Place one ridge/valley pair at the strongest interior massing transition.
  let fold = { row: 2, col: 0, change: 0 };
  for (let r = 1; r < cageRows - 1; r++)
    for (let c = 0; c < cageColumns; c++) {
      const change = knot(r, c) - (knot(r - 1, c) + knot(r + 1, c)) / 2;
      if (Math.abs(change) > Math.abs(fold.change))
        fold = { row: r, col: c, change };
    }
  const ridgeRow = Math.round((fold.row * (rows - 1)) / (cageRows - 1));
  const valleyRow = Math.min(
    rows - 2,
    ridgeRow + Math.round((rows - 1) * 0.16),
  );
  const amplitude =
    Math.abs(fold.change) > 0.03 * Math.max(...controls)
      ? Math.min(Math.abs(fold.change), 0.07 * Math.max(...controls))
      : 0;
  const creaseRows = amplitude ? [ridgeRow, valleyRow] : [];
  const radius = clearance.map((_, i) => {
    const r = Math.floor(i / columns);
    const c = ((i % columns) * cageColumns) / columns;
    const arc =
      Math.max(0, Math.cos(((c - fold.col) * 2 * Math.PI) / cageColumns)) ** 2;
    const lobe = (row) =>
      Math.max(0, 1 - Math.abs(r - row) / ((rows - 1) * 0.24)) ** 2;
    return (
      sample((r * (cageRows - 1)) / (rows - 1), c) +
      amplitude * arc * (lobe(ridgeRow) - 0.55 * lobe(valleyRow))
    );
  });
  const positions = new Float64Array(radius.length * 3);
  const indices = [];
  let reserve = 0;
  radius.forEach((value, i) => {
    reserve = Math.max(reserve, clearance[i] - value);
  });
  for (let r = 0; r < rows; r++) {
    const arch = Math.sin((Math.PI * r) / (rows - 1)) ** 2;
    angles.forEach(([x, y], c) => {
      const i = r * columns + c;
      const d =
        radius[i] + reserve + (arch * radius[i] * settings.fullness) / 500;
      positions.set([center.x + d * x, center.y + d * y, zAt(r)], i * 3);
      if (r < rows - 1) {
        const j = r * columns + ((c + 1) % columns);
        indices.push(i, j, i + columns, j, j + columns, i + columns);
      }
    });
  }
  return {
    positions,
    indices: Uint32Array.from(indices),
    columns,
    rows,
    creaseRows,
    center: [center.x, center.y],
  };
}
