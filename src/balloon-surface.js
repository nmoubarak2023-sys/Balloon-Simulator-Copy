// Six welded quad patches give the undeformed balloon a structured surface.
export function structuredSphere(radius, quality, center = [0, 0, 0]) {
  const n = Math.max(4, Math.round(quality / 4)),
    positions = [],
    indices = [],
    quads = [],
    ids = new Map();
  function vertex(c) {
    const key = c.join(":");
    if (ids.has(key)) return ids.get(key);
    const id = positions.length / 3,
      len = Math.hypot(...c);
    positions.push(...c.map((v, k) => center[k] + (radius * v) / len));
    ids.set(key, id);
    return id;
  }
  for (let axis = 0; axis < 3; axis++)
    for (const sign of [-1, 1]) {
      const u = (axis + 1) % 3,
        v = (axis + 2) % 3;
      const id = (i, j) => {
        const c = [0, 0, 0];
        c[axis] = sign * n;
        c[u] = -n + 2 * i;
        c[v] = -n + 2 * j;
        return vertex(c);
      };
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const face = [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)];
          if (sign < 0) face.reverse();
          const [a, b, c, d] = face;
          quads.push(...face);
          indices.push(a, b, c, a, c, d);
        }
    }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    quads: new Uint32Array(quads),
  };
}

// Smooth only the first ring beside a contact, leaving the contact itself and
// the unaffected curved surface fixed. Jacobi updates avoid directional bias.
export function smoothContactBand(raw, isContact, strength = 0.23, passes = 8) {
  const count = raw.positions.length / 3,
    neighbors = Array.from({ length: count }, () => new Set()),
    contact = new Uint8Array(count),
    eligible = new Uint8Array(count);
  for (let i = 0; i < raw.indices.length; i += 3) {
    const f = raw.indices.slice(i, i + 3);
    for (let k = 0; k < 3; k++) {
      neighbors[f[k]].add(f[(k + 1) % 3]);
      neighbors[f[k]].add(f[(k + 2) % 3]);
    }
  }
  for (let i = 0; i < count; i++)
    contact[i] = isContact(Array.from(raw.positions.slice(i * 3, i * 3 + 3)), i)
      ? 1
      : 0;
  for (let i = 0; i < count; i++)
    if (!contact[i] && [...neighbors[i]].some((j) => contact[j]))
      eligible[i] = 1;
  let positions = new Float64Array(raw.positions);
  for (let pass = 0; pass < passes; pass++) {
    const next = positions.slice();
    for (let i = 0; i < count; i++)
      if (eligible[i])
        for (let k = 0; k < 3; k++) {
          let average = 0;
          for (const j of neighbors[i]) average += positions[j * 3 + k];
          average /= neighbors[i].size;
          next[i * 3 + k] =
            positions[i * 3 + k] + (average - positions[i * 3 + k]) * strength;
        }
    positions = next;
  }
  return { positions, indices: raw.indices, contact, eligible };
}
