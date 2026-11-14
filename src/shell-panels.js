import * as T from "three";

export function shellPanels(raw, settings) {
  const { rows, columns, positions } = raw;
  const point = (r, c) =>
    new T.Vector3().fromArray(positions, 3 * (r * columns + (c % columns)));
  const width = Array.from({ length: columns }, (_, c) => {
    let max = 0;
    for (let r = 0; r < rows; r++)
      max = Math.max(max, point(r, c).distanceTo(point(r, c + 1)));
    return max;
  });
  const height = Array.from({ length: rows - 1 }, (_, r) => {
    let max = 0;
    for (let c = 0; c < columns; c++)
      max = Math.max(max, point(r, c).distanceTo(point(r + 1, c)));
    return max;
  });
  // A few wide bays, with joints biased to major changes of direction.
  // Only the explicit size limits can force additional seams.
  const turn = (before, at, after) =>
    at.clone().sub(before).angleTo(after.clone().sub(at));
  const planTransition = (c) => {
    let score = 0;
    for (let r = 0; r < rows; r += 4)
      score += turn(point(r, c + columns - 2), point(r, c), point(r, c + 2));
    return score / Math.ceil(rows / 4);
  };
  const heightTransition = (r) => {
    let score = 0;
    for (let c = 0; c < columns; c += 4)
      score += turn(
        point(Math.max(0, r - 2), c),
        point(r, c),
        point(Math.min(rows - 1, r + 2), c),
      );
    return score / Math.ceil(columns / 4);
  };
  let origin = 0;
  for (let c = 1; c < columns; c++)
    if (planTransition(c) > planTransition(origin)) origin = c;
  const split = (lengths, limit, minimumCount, score) => {
    const cumulative = [0];
    lengths.forEach((length) => cumulative.push(cumulative.at(-1) + length));
    const total = cumulative.at(-1);
    const n = Math.min(
      lengths.length,
      Math.max(minimumCount, Math.ceil(total / limit)),
    );
    const cuts = [0];
    for (let i = 1; i < n; i++) {
      const goal = (total * i) / n;
      let best = Infinity,
        cut = cuts.at(-1) + 1;
      for (let j = cut; j <= lengths.length - n + i; j++) {
        const error = Math.abs(cumulative[j] - goal) / (total / n);
        const rank = error - Math.min(0.15, score(j) * 0.35);
        if (rank < best) {
          best = rank;
          cut = j;
        }
      }
      cuts.push(cut);
    }
    cuts.push(lengths.length);
    // Discrete sampling and seam shifts can put a bay over its size limit.
    // Move its joint to the limit rather than adding a fine subdivision grid.
    const limited = [0];
    for (const end of cuts.slice(1)) {
      let start = limited.at(-1);
      while (cumulative[end] - cumulative[start] > limit && end > start + 1) {
        let j = start + 1;
        while (j + 1 < end && cumulative[j + 1] - cumulative[start] <= limit)
          j++;
        limited.push(j);
        start = j;
      }
      limited.push(end);
    }
    return limited;
  };
  const cols = split(
    width.map((_, c) => width[(origin + c) % columns]),
    settings.maxWidth,
    4,
    (c) => planTransition(origin + c),
  ).map((c) => c + origin);
  const levels = split(height, settings.maxHeight, 1, heightTransition);
  const sample = (r, c) => {
    const a = Math.floor(r),
      b = Math.floor(c);
    const x = point(a, b).lerp(point(a, b + 1), c - b);
    return r === a
      ? x
      : x.lerp(point(a + 1, b).lerp(point(a + 1, b + 1), c - b), r - a);
  };
  const panels = [];
  for (let j = 1; j < levels.length; j++)
    for (let i = 1; i < cols.length; i++) {
      const r0 = levels[j - 1],
        r1 = levels[j],
        c0 = cols[i - 1],
        c1 = cols[i];
      const inset = (length, span) =>
        Math.min(0.45, settings.gap / (2 * Math.max(length, 1e-6))) *
        Math.min(1, span);
      const grid = [];
      for (let r = r0; r <= r1; r++) {
        const line = [];
        for (let c = c0; c <= c1; c++) {
          const base = point(r, c);
          const dc =
            c === c0
              ? inset(base.distanceTo(point(r, c + 1)), c1 - c0)
              : c === c1
                ? -inset(base.distanceTo(point(r, c - 1)), c1 - c0)
                : 0;
          const dr =
            r === r0 && r0 > 0
              ? inset(base.distanceTo(point(r + 1, c)), r1 - r0)
              : r === r1 && r1 < rows - 1
                ? -inset(base.distanceTo(point(r - 1, c)), r1 - r0)
                : 0;
          line.push(sample(r + dr, c + dc));
        }
        grid.push(line);
      }
      const id = "P_" + j + "_" + i;
      if (settings.shape === "triangular") {
        for (const panel of triangularBays(grid, id, settings.gap))
          panels.push(panel);
        continue;
      }
      const surface = [];
      for (let r = 1; r < grid.length; r++)
        for (let c = 1; c < grid[r].length; c++)
          surface.push([
            grid[r - 1][c - 1],
            grid[r - 1][c],
            grid[r][c],
            grid[r][c - 1],
          ]);
      const vertices = [
        ...grid[0],
        ...grid.slice(1, -1).map((line) => line.at(-1)),
        ...grid.at(-1).slice().reverse(),
        ...grid
          .slice(1, -1)
          .reverse()
          .map((line) => line[0]),
      ];
      panels.push(curvedPanel(id, surface, vertices));
    }
  return { panels };
}

function curvedPanel(id, surface, vertices) {
  const normals = new Map(surface.flat().map((p) => [p, new T.Vector3()]));
  for (const face of surface) {
    const n = face[1]
      .clone()
      .sub(face[0])
      .cross(face.at(-1).clone().sub(face[0]));
    face.forEach((p) => normals.get(p).add(n));
  }
  const normal = new T.Vector3();
  normals.forEach((n) => normal.add(n.normalize()));
  return { id, surface, vertices, normals, normal: normal.normalize() };
}

// Divide each large bay along a single diagonal in shell coordinates.
// The internal mesh follows the parent bay; only the perimeter is a seam.
function triangularBays(grid, id, gap) {
  const rows = grid.length - 1;
  const cols = grid[0].length - 1;
  const n = Math.max(rows, cols);
  const sample = (u, v) => {
    const c = u * cols,
      r = v * rows;
    const i = Math.min(Math.floor(c), cols - 1);
    const j = Math.min(Math.floor(r), rows - 1);
    return grid[j][i]
      .clone()
      .lerp(grid[j][i + 1], c - i)
      .lerp(grid[j + 1][i].clone().lerp(grid[j + 1][i + 1], c - i), r - j);
  };
  const middle = sample(0.5, 0.5);
  return [true, false].map((upper) => {
    const corner = upper ? [1, 0] : [0, 1];
    const inset = Math.min(
      0.1,
      gap / (2 * Math.max(middle.distanceTo(sample(...corner)), 1e-6)),
    );
    const points = Array.from({ length: n + 1 }, (_, r) =>
      Array.from({ length: n + 1 }, (_, c) => {
        if (upper ? c < r : c > r) return null;
        return sample(
          T.MathUtils.lerp(c / n, corner[0], inset),
          T.MathUtils.lerp(r / n, corner[1], inset),
        );
      }),
    );
    const surface = [];
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        const a = points[r][c],
          b = points[r][c + 1];
        const d = points[r + 1][c],
          e = points[r + 1][c + 1];
        if (a && b && e) surface.push([a, b, e]);
        if (a && e && d) surface.push([a, e, d]);
      }
    const diagonal = points.map((row, i) => row[i]);
    const vertices = upper
      ? [
          ...points[0],
          ...points.slice(1).map((row) => row[n]),
          ...diagonal.slice(1, -1).reverse(),
        ]
      : [
          ...diagonal,
          ...points[n].slice(0, -1).reverse(),
          ...points
            .slice(1, -1)
            .reverse()
            .map((row) => row[0]),
        ];
    return curvedPanel(id + (upper ? "_A" : "_B"), surface, vertices);
  });
}

export function shellPanelParts(panel, thickness, returns) {
  const back = new Map();
  panel.normals.forEach((normal, p) =>
    back.set(p, p.clone().addScaledVector(normal, -thickness)),
  );
  const boundary = panel.vertices.map((p) => back.get(p));
  const lip = boundary.map((p, i) =>
    p.clone().addScaledVector(panel.normals.get(panel.vertices[i]), -returns),
  );
  const faces = [
    ...panel.surface,
    ...panel.surface.map((quad) => quad.map((p) => back.get(p)).reverse()),
  ];
  const flanges = [];
  boundary.forEach((p, i) => {
    const j = (i + 1) % boundary.length;
    faces.push([panel.vertices[j], panel.vertices[i], p, boundary[j]]);
    if (returns > 0) flanges.push([boundary[j], p, lip[i], lip[j]]);
  });
  return {
    faces,
    flanges,
    rail: lip.map((p, i) =>
      p.clone().addScaledVector(panel.normals.get(panel.vertices[i]), -0.15),
    ),
  };
}
