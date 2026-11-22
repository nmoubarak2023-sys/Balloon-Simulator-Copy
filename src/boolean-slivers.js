// Collapse only short edges incident to degenerate triangles. The link and
// orientation checks preserve closed topology; untouched faces stay untouched.
export function repairBooleanSlivers(raw, tolerance) {
  const p = raw.positions,
    idx = raw.indices;
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    const k = i % 3;
    min[k] = Math.min(min[k], p[i]);
    max[k] = Math.max(max[k], p[i]);
  }
  const areaFloor = Math.max(
    Number.MIN_VALUE,
    max.reduce((s, v, k) => s + (v - min[k]) ** 2, 0) * 1e-14,
  );
  function normal(a, b, c) {
    const x = p[b * 3] - p[a * 3],
      y = p[b * 3 + 1] - p[a * 3 + 1],
      z = p[b * 3 + 2] - p[a * 3 + 2],
      u = p[c * 3] - p[a * 3],
      v = p[c * 3 + 1] - p[a * 3 + 1],
      w = p[c * 3 + 2] - p[a * 3 + 2];
    return [y * w - z * v, z * u - x * w, x * v - y * u];
  }
  const bad = [],
    stars = new Map();
  for (let i = 0; i < idx.length; i += 3) {
    const t = [idx[i], idx[i + 1], idx[i + 2]];
    if (Math.hypot(...normal(...t)) <= areaFloor) {
      t.offset = i;
      bad.push(t);
      for (const v of t) stars.set(v, []);
    }
  }
  if (!bad.length) return raw;
  for (let i = 0; i < idx.length; i += 3)
    for (let k = 0; k < 3; k++) stars.get(idx[i + k])?.push(i);
  const remap = new Map(),
    locked = new Set();
  for (const t of bad) {
    const edges = t
      .map((a, k) => {
        const b = t[(k + 1) % 3];
        return {
          a,
          b,
          d: Math.hypot(
            p[a * 3] - p[b * 3],
            p[a * 3 + 1] - p[b * 3 + 1],
            p[a * 3 + 2] - p[b * 3 + 2],
          ),
        };
      })
      .sort((a, b) => a.d - b.d);
    for (const { a, b, d } of edges) {
      if (a === b || d > tolerance || locked.has(a) || locked.has(b)) continue;
      const aStars = stars.get(a),
        bStars = stars.get(b);
      if (!aStars || !bStars) continue;
      const neighbors = (v) =>
        new Set(
          stars
            .get(v)
            .flatMap((i) => [idx[i], idx[i + 1], idx[i + 2]])
            .filter((n) => n !== v),
        );
      const an = neighbors(a),
        bn = neighbors(b),
        common = [...an].filter((v) => bn.has(v));
      const shared = aStars.filter((i) =>
        [idx[i], idx[i + 1], idx[i + 2]].includes(b),
      );
      if (common.length !== 2 || shared.length !== 2) continue;
      const affected = [...new Set([...aStars, ...bStars])];
      let safe = true;
      for (const i of affected) {
        const before = [idx[i], idx[i + 1], idx[i + 2]];
        if (before.includes(a) && before.includes(b)) continue;
        if (before.some((v) => locked.has(v))) {
          safe = false;
          break;
        }
        const after = before.map((v) => (v === b ? a : v)),
          old = normal(...before),
          next = normal(...after);
        if (
          Math.hypot(...old) > 0 &&
          (Math.hypot(...next) === 0 ||
            old.reduce((s, v, k) => s + v * next[k], 0) <= 0)
        ) {
          safe = false;
          break;
        }
      }
      if (!safe) continue;
      remap.set(b, a);
      for (const i of affected)
        for (let k = 0; k < 3; k++) locked.add(idx[i + k]);
      break;
    }
  }
  const flips = new Map();
  for (const t of bad) {
    if (t.some((v) => locked.has(v))) continue;
    for (let k = 0; k < 3; k++) {
      const a = t[k],
        b = t[(k + 1) % 3],
        c = t[(k + 2) % 3];
      const shared = stars
        .get(a)
        .filter((i) => [idx[i], idx[i + 1], idx[i + 2]].includes(b));
      if (shared.length !== 2) continue;
      const j = shared.find((i) => i !== t.offset),
        other = [idx[j], idx[j + 1], idx[j + 2]],
        d = other.find((v) => v !== a && v !== b);
      if (
        d === undefined ||
        locked.has(d) ||
        stars.get(c).some((i) => [idx[i], idx[i + 1], idx[i + 2]].includes(d))
      )
        continue;
      const reference = normal(...other),
        length = Math.hypot(...reference);
      if (!length) continue;
      const distance =
        Math.abs(
          reference.reduce(
            (sum, v, axis) => sum + v * (p[c * 3 + axis] - p[a * 3 + axis]),
            0,
          ),
        ) / length;
      if (distance > tolerance) continue;
      const one = [c, d, b],
        two = [d, c, a],
        n1 = normal(...one),
        n2 = normal(...two);
      if (
        Math.hypot(...n1) <= areaFloor ||
        Math.hypot(...n2) <= areaFloor ||
        n1.reduce((v, x, i) => v + x * reference[i], 0) <= 0 ||
        n2.reduce((v, x, i) => v + x * reference[i], 0) <= 0
      )
        continue;
      flips.set(t.offset, one);
      flips.set(j, two);
      for (const v of [a, b, c, d]) locked.add(v);
      break;
    }
  }
  if (!remap.size && !flips.size) return raw;
  const out = new Uint32Array(idx.length);
  let n = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const face = flips.get(i) ?? [idx[i], idx[i + 1], idx[i + 2]],
      a = remap.get(face[0]) ?? face[0],
      b = remap.get(face[1]) ?? face[1],
      c = remap.get(face[2]) ?? face[2];
    if (a === b || b === c || c === a) continue;
    out[n++] = a;
    out[n++] = b;
    out[n++] = c;
  }
  return { positions: p, indices: out.slice(0, n) };
}
