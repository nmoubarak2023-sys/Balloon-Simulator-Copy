import { roofSampler } from "./columns.js";
import { signedVolume } from "./mesh-quality.js";

// Join the transitions between roof owners into continuous ridge paths.
export function collisionRidges({ raw, spheres, params }) {
  if (spheres.length < 2) return [];
  const samplers = spheres.map(
    (sphere) => sphere.raw && roofSampler(sphere.raw),
  );
  const vertices = new Map(),
    links = new Map(),
    owners = new Map();
  const point = (i) => Array.from(raw.positions.slice(3 * i, 3 * i + 3));
  function owner(i, [x, y]) {
    if (owners.has(i)) return owners.get(i);
    let best = -Infinity,
      id = -1;
    spheres.forEach((sphere, j) => {
      const [cx, cy, cz] = sphere.center;
      const q = sphere.radius ** 2 - (x - cx) ** 2 - (y - cy) ** 2;
      const height = samplers[j]
        ? samplers[j](x, y)
        : q > 0
          ? cz + Math.sqrt(q)
          : null;
      if (height !== null && height > best) {
        best = height;
        id = j;
      }
    });
    owners.set(i, id);
    return id;
  }
  function connect(a, b, pair) {
    if (!links.has(pair)) links.set(pair, new Map());
    const graph = links.get(pair);
    for (const key of [a, b]) if (!graph.has(key)) graph.set(key, new Set());
    graph.get(a).add(b);
    graph.get(b).add(a);
  }
  for (let i = 0; i < raw.indices.length; i += 3) {
    const ids = Array.from(raw.indices.slice(i, i + 3));
    const pts = ids.map(point);
    const [a, b, c] = pts;
    if ((b[0] - a[0]) * (c[1] - a[1]) <= (b[1] - a[1]) * (c[0] - a[0]))
      continue;
    if (Math.max(a[2], b[2], c[2]) <= params.floor + 0.05) continue;
    const labels = ids.map((id, j) => owner(id, pts[j]));
    const cuts = [];
    for (let j = 0; j < 3; j++) {
      const k = (j + 1) % 3;
      if (labels[j] < 0 || labels[k] < 0 || labels[j] === labels[k]) continue;
      const key = [ids[j], ids[k]].sort((a, b) => a - b).join(":");
      if (!vertices.has(key))
        vertices.set(
          key,
          pts[j].map((v, axis) => (v + pts[k][axis]) / 2),
        );
      cuts.push({
        key,
        pair: [labels[j], labels[k]].sort((a, b) => a - b).join(":"),
      });
    }
    if (cuts.length === 2) connect(cuts[0].key, cuts[1].key, cuts[0].pair);
    if (cuts.length === 3) {
      const junction = "junction:" + i;
      vertices.set(
        junction,
        a.map((v, axis) => (v + b[axis] + c[axis]) / 3),
      );
      cuts.forEach(({ key, pair }) => connect(key, junction, pair));
    }
  }
  const sites = [];
  const minLength = Math.max(1, params.spacing ?? 1);
  for (const [pair, graph] of links) {
    const endpoints = new Set(
      [...graph].filter(([, edges]) => edges.size !== 2).map(([key]) => key),
    );
    function trace(first) {
      const points = [vertices.get(first)];
      let from = first;
      while (graph.get(from).size) {
        const next = graph.get(from).values().next().value;
        graph.get(from).delete(next);
        graph.get(next).delete(from);
        points.push(vertices.get(next));
        if (next === first || endpoints.has(next)) break;
        from = next;
      }
      const length = pathDistances(points).at(-1);
      if (length < minLength) return;
      const path = fitRidge(
        samplePath(points, Math.max(2, Math.ceil(length / 0.5))),
      );
      const [x, y, z] = path[Math.floor(path.length / 2)];
      sites.push({
        id: sites.length,
        x,
        y,
        z,
        kind: "ridge",
        fitted: true,
        pair,
        path,
        length,
      });
    }
    for (const key of endpoints) while (graph.get(key).size) trace(key);
    for (const [key, edges] of graph) while (edges.size) trace(key);
  }
  return sites;
}

export function wallMesh(source, site, { bottomRadius, flare, blend }) {
  if (
    !site.path?.length ||
    ![bottomRadius, flare, blend].every(Number.isFinite) ||
    bottomRadius <= 0 ||
    flare <= 0 ||
    blend <= 0 ||
    blend >= 1
  )
    throw Error("Choose a ridge and positive wall dimensions.");
  bottomRadius /= 2;
  flare /= 2;
  const floor = source.params.floor;
  const roof = roofSampler(source.raw);
  const sourcePath = site.path;
  // Keep the wall aligned with the same fitted path used for picking.
  const length = pathDistances(sourcePath).at(-1);
  if (!(length > 0)) throw Error("This ridge is too short.");
  let stations = Math.min(260, Math.max(2, Math.ceil(length / 0.45)));
  const path = samplePath(
    site.fitted ? sourcePath : fitRidge(samplePath(sourcePath, stations)),
    stations,
  );
  // Where the collision reaches the footprint edge, stop at the last usable
  // roof station instead of rejecting the whole wall.
  let start = 0;
  let bestStart = 0;
  let bestLength = 0;
  for (let i = 0; i < path.length; i++) {
    if ((roof(...path[i]) ?? floor) <= floor + 0.15) {
      start = i + 1;
    } else if (i - start + 1 > bestLength) {
      bestStart = start;
      bestLength = i - start + 1;
    }
  }
  if (bestLength < 2)
    throw Error("This ridge has too little clearance above the floor.");
  path.splice(bestStart + bestLength);
  path.splice(0, bestStart);
  if (
    path.length > 2 &&
    Math.hypot(path[0][0] - path.at(-1)[0], path[0][1] - path.at(-1)[1]) < 1e-8
  )
    path.pop();
  stations = path.length - 1;
  const positions = [],
    indices = [];
  const rows = 12;
  const ringSize = 2 * (rows + 1) + 1;
  const sections = path.map(([x, y], i) => {
    const before = path[Math.max(0, i - 1)],
      after = path[Math.min(stations, i + 1)];
    const dx = after[0] - before[0],
      dy = after[1] - before[1];
    const span = Math.hypot(dx, dy);
    if (span < 1e-8) throw Error("Could not resolve the ridge direction.");
    const nx = -dy / span,
      ny = dx / span;
    const at = (offset) => [x + nx * offset, y + ny * offset];
    const center = roof(x, y);
    if (center === null || center <= floor + 0.05)
      throw Error("This ridge is too close to the floor edge.");
    let width = flare;
    for (let pass = 0; pass < 20; pass++) {
      if (
        [-1, -0.5, 0.5, 1].every(
          (side) => (roof(...at(side * width)) ?? floor) > floor + 0.05,
        )
      )
        break;
      width *= 0.75;
    }
    return {
      at,
      profile: [
        width,
        roof(...at(width)) ?? center,
        center,
        roof(...at(-width)) ?? center,
      ],
    };
  });
  const profiles = smoothStations(
    sections.map(({ profile }) => profile),
    Math.min(14, Math.max(4, Math.round(stations / 5))),
  );
  for (const [i, { at }] of sections.entries()) {
    const [width, left, center, right] = profiles[i];
    function side(sign, row) {
      const t = row / rows;
      const u = Math.max(0, (t - (1 - blend)) / blend);
      const eased = u * u * (3 - 2 * u);
      const xy = at(sign * (bottomRadius + (width - bottomRadius) * eased));
      const top = sign === 1 ? left : right;
      positions.push(...xy, floor + (top - floor) * t);
    }
    for (let row = 0; row <= rows; row++) side(1, row);
    positions.push(...at(0), center);
    for (let row = rows; row >= 0; row--) side(-1, row);
  }
  for (let i = 0; i < stations; i++)
    for (let j = 0; j < ringSize; j++) {
      const a = i * ringSize + j,
        b = i * ringSize + ((j + 1) % ringSize);
      indices.push(a, b, b + ringSize, a, b + ringSize, a + ringSize);
    }
  for (const i of [0, stations]) {
    const base = i * ringSize;
    const [x, y] = path[i];
    const hub = positions.length / 3;
    positions.push(x, y, (floor + roof(x, y)) / 2);
    for (let j = 0; j < ringSize; j++) {
      const a = base + j,
        b = base + ((j + 1) % ringSize);
      indices.push(hub, ...(i === 0 ? [b, a] : [a, b]));
    }
  }
  const raw = {
    positions: new Float64Array(positions),
    indices: new Uint32Array(indices),
  };
  if (signedVolume(raw) < 0)
    for (let i = 0; i < indices.length; i += 3)
      [raw.indices[i + 1], raw.indices[i + 2]] = [
        raw.indices[i + 2],
        raw.indices[i + 1],
      ];
  return raw;
}

function pathDistances(sourcePath) {
  const distances = [0];
  for (let i = 1; i < sourcePath.length; i++) {
    const [x, y] = sourcePath[i],
      [px, py] = sourcePath[i - 1];
    distances.push(distances[i - 1] + Math.hypot(x - px, y - py));
  }
  return distances;
}

function samplePath(sourcePath, stations) {
  const distances = pathDistances(sourcePath);
  const length = distances.at(-1);
  let segment = 1;
  return Array.from({ length: stations + 1 }, (_, i) => {
    const distance = (length * i) / stations;
    while (segment < distances.length - 1 && distances[segment] <= distance)
      segment++;
    const t =
      (distance - distances[segment - 1]) /
      (distances[segment] - distances[segment - 1] || 1);
    return sourcePath[0].map(
      (_, axis) =>
        sourcePath[segment - 1][axis] * (1 - t) + sourcePath[segment][axis] * t,
    );
  });
}

function smoothStations(values, radius) {
  return values.map((point, i) => {
    const window = Math.min(radius, i, values.length - 1 - i);
    return point.map((_, axis) => {
      let sum = 0;
      for (let step = -window; step <= window; step++) {
        sum += values[i + step][axis] * (window + 1 - Math.abs(step));
      }
      return sum / (window + 1) ** 2;
    });
  });
}

function fitRidge(points) {
  const first = points[0],
    last = points.at(-1);
  const chord = Math.hypot(last[0] - first[0], last[1] - first[1]);
  if (chord < 1e-6) return smoothStations(points, 12);

  // Fit one quadratic through both endpoints. There are no intermediate
  // control points to reproduce the zigzags in the collision mesh.
  const shift = first.map(() => 0);
  let denominator = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const t = i / (points.length - 1);
    const weight = 2 * t * (1 - t);
    denominator += weight * weight;
    for (let axis = 0; axis < shift.length; axis++) {
      shift[axis] +=
        weight * (points[i][axis] - first[axis] * (1 - t) - last[axis] * t);
    }
  }
  return points.map((_, i) => {
    const t = i / (points.length - 1);
    return first.map(
      (value, axis) =>
        value * (1 - t) +
        last[axis] * t +
        (2 * t * (1 - t) * shift[axis]) / (denominator || 1),
    );
  });
}
