import { inLoops, loopBounds } from "./zones.js";
import { validateVoronoiLifecycle } from "./voronoi-lifecycle.js";
import { validBalloonEdit } from "./balloon-edit.js";
import cdt2d from "cdt2d";
import { random, closestPolyline } from "./engine.js";
import * as T from "three";
import { MeshBVH } from "three-mesh-bvh";
import { meshQuality, signedVolume } from "./mesh-quality.js";
export function voronoiBuild(m, p) {
  validateVoronoiLifecycle(p);
  const {
    width: w,
    height: h,
    count,
    seed,
    index,
    selected,
    radiusMin,
    radiusMax,
    radiusSeed,
    floor,
    spacing,
    smoothing,
  } = p;
  if (
    !Object.entries(p)
      .filter(
        ([k]) =>
          ![
            "curves",
            "edits",
            "pressureEnabled",
            "popped",
            "frozen",
            "popEvents",
            "domain",
          ].includes(k),
      )
      .every(([, v]) => Number.isFinite(v)) ||
    !Number.isInteger(selected) ||
    !Number.isInteger(smoothing) ||
    (p.domain
      ? !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0
      : ![40, 80, 160].includes(w) || h !== w * 0.625) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 150 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count ||
    selected < 1 ||
    selected > count ||
    radiusMin <= 0 ||
    radiusMax < radiusMin ||
    spacing < 0.5 ||
    spacing > 10 ||
    smoothing < 0 ||
    smoothing > 20
  )
    throw Error(
      "Check count, selected index, radii, floor height and spacing. The floor must intersect at least one sphere.",
    );
  if (p.edits && Object.values(p.edits).some((e) => !validBalloonEdit(e)))
    throw Error(
      "Balloon edits need finite X, Y, Z and scale between 0.1 and 3.",
    );
  if (
    p.curves &&
    (!Array.isArray(p.curves) ||
      p.curves.length > 5 ||
      p.curves.some(
        (c) =>
          !Array.isArray(c) ||
          c.length < 2 ||
          c.length > 2401 ||
          c.some(
            (v) =>
              !Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite),
          ),
      ))
  )
    throw Error("Invalid deformation curves.");
  if (
    p.pressureEnabled &&
    (!Number.isFinite(p.strength) ||
      p.strength < 0 ||
      !Number.isFinite(p.influence) ||
      p.influence <= 0)
  )
    throw Error(
      "Pressure strength must be nonnegative and influence must be positive.",
    );
  const domainLoops = p.domain?.loops;
  if (
    domainLoops &&
    (!Array.isArray(domainLoops) ||
      !domainLoops.length ||
      domainLoops.some(
        (loop) =>
          !Array.isArray(loop) ||
          loop.length < 3 ||
          loop.some(
            (v) =>
              !Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite),
          ),
      ))
  )
    throw Error("Invalid zone boundary.");
  const domainBounds = domainLoops
      ? loopBounds(domainLoops)
      : { min: [0, 0], max: [w, h] },
    [x0, y0] = domainBounds.min;
  const rng = random(seed),
    points = [];
  for (
    let attempts = 0;
    points.length < count && attempts < count * 20000;
    attempts++
  ) {
    const point = [x0 + rng() * w, y0 + rng() * h];
    if (!domainLoops || inLoops(point, domainLoops)) points.push(point);
  }
  if (points.length !== count)
    throw Error(
      "This zone is too narrow to populate reliably. Simplify its boundary or lower the point count.",
    );
  const cells = points.map((a, i) => {
    let poly = [
      [x0, y0],
      [x0 + w, y0],
      [x0 + w, y0 + h],
      [x0, y0 + h],
    ];
    points.forEach((b, j) => {
      if (i === j) return;
      const nx = b[0] - a[0],
        ny = b[1] - a[1],
        d = (b[0] ** 2 + b[1] ** 2 - a[0] ** 2 - a[1] ** 2) / 2,
        next = [];
      for (let k = 0; k < poly.length; k++) {
        const u = poly[k],
          v = poly[(k + 1) % poly.length],
          du = nx * u[0] + ny * u[1] - d,
          dv = nx * v[0] + ny * v[1] - d;
        if (du <= 1e-9) next.push(u);
        if (du < 0 !== dv < 0) {
          const t = du / (du - dv);
          next.push([u[0] + t * (v[0] - u[0]), u[1] + t * (v[1] - u[1])]);
        }
      }
      poly = next;
    });
    return poly;
  });
  let cellLoops = null;
  if (domainLoops) {
    const region = new m.CrossSection(domainLoops, "EvenOdd");
    try {
      cellLoops = cells.map((poly) => {
        if (poly.length < 3) return [];
        const cell = new m.CrossSection([poly], "EvenOdd");
        let cut;
        try {
          cut = cell.intersect(region);
          return cut.toPolygons();
        } finally {
          cut?.delete();
          cell.delete();
        }
      });
    } finally {
      region.delete();
    }
    cells.forEach((_, i) => {
      cells[i] = cellLoops[i].reduce(
        (big, loop) => (loop.length > big.length ? loop : big),
        [],
      );
    });
  }
  const selectedIds = points
    .map((a, i) => ({
      i,
      d: (a[0] - points[index][0]) ** 2 + (a[1] - points[index][1]) ** 2,
    }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, selected)
    .map((a) => a.i);
  const rr = random(radiusSeed),
    generated = selectedIds.map((id) => ({
      id,
      axisScale: [0, 1, 2].map((k) => p.edits?.[id]?.[4 + k] ?? 1),
      center: points[id]
        .map((v, k) => v + (p.edits?.[id]?.[k] || 0))
        .concat((p.domain?.elevation ?? 0) + (p.edits?.[id]?.[2] || 0)),
      radius:
        (radiusMin + rr() * (radiusMax - radiusMin)) *
        (p.edits?.[id]?.[3] ?? 1),
    }));
  const frozen = p.frozen ?? {},
    popped = new Set(p.popped ?? []);
  const spheres = generated
    .filter((s) => !popped.has(s.id))
    .map((s) =>
      frozen[s.id]
        ? { ...structuredClone(frozen[s.id]), id: s.id, frozen: true }
        : s,
    );
  for (const [id, s] of Object.entries(frozen))
    if (!popped.has(Number(id)) && !spheres.some((b) => b.id === Number(id)))
      spheres.push({ ...structuredClone(s), id: Number(id), frozen: true });
  const ids = spheres.map((s) => s.id);
  if (!spheres.length && p.domain)
    return {
      points,
      cells,
      cellLoops,
      ids,
      spheres,
      raw: { positions: new Float64Array(), indices: new Uint32Array() },
      loops: [],
      quality: meshQuality({
        positions: new Float64Array(),
        indices: new Uint32Array(),
      }),
      components: 0,
      volume: 0,
      closed: false,
      params: p,
    };
  if (!spheres.length)
    throw Error("At least one balloon must remain. Restore a popped balloon.");
  for (const s of spheres)
    if (
      !s.center.every(Number.isFinite) ||
      !Number.isFinite(s.radius) ||
      s.radius <= 0
    )
      throw Error("Invalid balloon transform.");
  const owned = [],
    disposables = [],
    own = (x) => (owned.push(x), x);
  try {
    const rectangle = own(
      domainLoops
        ? new m.CrossSection(domainLoops, "EvenOdd")
        : m.CrossSection.square([w, h]),
    );
    const prismHeight =
      Math.max(
        w,
        h,
        ...spheres.map((s) => s.radius * Math.max(...s.axisScale)),
        Math.abs(floor),
        1,
      ) * 20;
    const prism = domainLoops
      ? own(
          own(rectangle.extrude(prismHeight * 2)).translate([
            0,
            0,
            (p.domain.elevation ?? 0) - prismHeight,
          ]),
        )
      : null;
    const pressure = !!p.pressureEnabled && p.strength > 0 && p.curves?.length;
    const surfaces =
      domainLoops ||
      pressure ||
      (p.popEvents?.length && p.popPressure > 0) ||
      spheres.some((s) => s.frozen || s.axisScale.some((v) => v !== 1))
        ? spheres.map((s) => {
            const savedRaw = s.frozen ? s.raw : null;
            let solid = savedRaw
              ? own(
                  new m.Manifold(
                    new m.Mesh({
                      numProp: 3,
                      vertProperties: new Float32Array(savedRaw.positions),
                      triVerts: new Uint32Array(savedRaw.indices),
                    }),
                  ),
                )
              : own(m.Manifold.sphere(s.radius, 80).translate(s.center));
            if (solid.status() !== "NoError")
              throw Error("Frozen balloon mesh is invalid.");
            if (pressure && !s.frozen)
              solid = own(
                solid.warp((v) => {
                  const d = closestPolyline(v, p.curves),
                    u = Math.max(0, 1 - d / Math.max(0.01, p.influence)),
                    weight = u * u * u * (10 + u * (-15 + 6 * u)),
                    depth = Math.min(p.strength, s.radius * 0.75) * weight;
                  for (let k = 0; k < 3; k++)
                    v[k] =
                      s.center[k] +
                      (v[k] - s.center[k]) * (1 - depth / s.radius);
                }),
              );
            if (!s.frozen && p.popEvents?.length && p.popPressure > 0)
              solid = own(
                solid.warp((v) => {
                  const depth = p.popEvents.reduce((sum, e) => {
                    const distance = Math.max(
                      0,
                      Math.hypot(...v.map((x, k) => x - e.center[k])) -
                        e.radius,
                    );
                    const u = Math.max(
                      0,
                      1 - distance / Math.max(e.radius, s.radius),
                    );
                    return (
                      sum +
                      p.popPressure * s.radius * 0.12 * u * u * (3 - 2 * u)
                    );
                  }, 0);
                  const scale = 1 - Math.min(0.35, depth / s.radius);
                  for (let k = 0; k < 3; k++)
                    v[k] = s.center[k] + (v[k] - s.center[k]) * scale;
                }),
              );
            if (!savedRaw && s.axisScale.some((v) => v !== 1))
              solid = own(
                own(
                  own(solid.translate(s.center.map((v) => -v))).scale(
                    s.axisScale,
                  ),
                ).translate(s.center),
              );
            if (prism && !savedRaw) solid = own(solid.intersect(prism));
            if (solid.isEmpty())
              throw Error(
                `Balloon ${s.id + 1} is outside its zone. Move it back or reset it.`,
              );
            s.analyticSurface = s.frozen
              ? !!s.analyticSurface
              : !pressure && !(p.popEvents?.length && p.popPressure > 0);
            const mesh = solid.getMesh(),
              g = new T.BufferGeometry();
            g.setAttribute(
              "position",
              new T.BufferAttribute(new Float32Array(mesh.vertProperties), 3),
            );
            g.setIndex(
              new T.BufferAttribute(new Uint32Array(mesh.triVerts), 1),
            );
            const bvh = new MeshBVH(g);
            disposables.push(g);
            const raw = {
              positions: new Float32Array(mesh.vertProperties),
              indices: new Uint32Array(mesh.triVerts),
            };
            s.raw = savedRaw ? structuredClone(savedRaw) : raw;
            return {
              solid,
              bvh,
              top:
                raw.positions.reduce(
                  (max, v, i) => (i % 3 === 2 ? Math.max(max, v) : max),
                  -Infinity,
                ) + 1,
            };
          })
        : null;
    const circles = spheres
      .filter((s) => s.radius > Math.abs(floor - s.center[2]))
      .map((s) =>
        own(
          own(
            m.CrossSection.circle(
              Math.sqrt(s.radius ** 2 - (floor - s.center[2]) ** 2),
              Math.max(64, Math.ceil((2 * Math.PI * s.radius) / spacing)),
            ),
          ).translate(s.center.slice(0, 2)),
        ),
      );
    let footprint = own(
      own(
        m.CrossSection.union(
          surfaces ? surfaces.map((s) => own(s.solid.slice(floor))) : circles,
        ),
      ).intersect(rectangle),
    );
    if (domainLoops)
      footprint = own(
        footprint.simplify(Math.max(1e-5, Math.max(w, h) * 1e-7)),
      );
    const loops = footprint.toPolygons();
    if (!loops.length)
      throw Error("The floor plane does not intersect the balloons.");
    // Uniform interior samples and constrained Delaunay triangles avoid the
    // long fan diagonals inherited from triangulating the outline alone.
    const xy = [],
      constraints = [];
    for (const loop of loops) {
      const ids = [];
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i],
          b = loop[(i + 1) % loop.length],
          n = Math.max(
            1,
            Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing),
          );
        for (let j = 0; j < n; j++) {
          ids.push(xy.length);
          xy.push([
            a[0] + ((b[0] - a[0]) * j) / n,
            a[1] + ((b[1] - a[1]) * j) / n,
          ]);
        }
      }
      ids.forEach((id, i) => constraints.push([id, ids[(i + 1) % ids.length]]));
    }
    const inside = ([x, y]) => {
      let hit = false;
      for (const loop of loops)
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
          const a = loop[i],
            b = loop[j];
          if (
            a[1] > y !== b[1] > y &&
            x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
          )
            hit = !hit;
        }
      return hit;
    };
    const distance = (p, a, b) => {
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        t = Math.max(
          0,
          Math.min(
            1,
            ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy),
          ),
        );
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    };
    for (
      let row = 0, y = y0 + spacing * 0.5;
      y < y0 + h;
      y += (spacing * Math.sqrt(3)) / 2, row++
    )
      for (
        let x = x0 + spacing * (row % 2 ? 0.5 : 1);
        x < x0 + w;
        x += spacing
      ) {
        const p = [x, y];
        if (
          inside(p) &&
          !constraints.some(
            ([a, b]) => distance(p, xy[a], xy[b]) < spacing * 0.22,
          )
        )
          xy.push(p);
      }
    if (xy.length > 100000)
      throw Error("Mesh spacing is too fine; increase it.");
    const tris = cdt2d(xy, constraints, { exterior: false });
    const edges = new Map(),
      neighbors = xy.map(() => new Set());
    for (const t of tris)
      for (let k = 0; k < 3; k++) {
        const a = t[k],
          b = t[(k + 1) % 3],
          key = Math.min(a, b) + ":" + Math.max(a, b);
        if (edges.has(key)) edges.get(key).count++;
        else edges.set(key, { a, b, count: 1 });
        neighbors[a].add(b);
        neighbors[b].add(a);
      }
    const boundary = new Set();
    for (const e of edges.values())
      if (e.count === 1) {
        boundary.add(e.a);
        boundary.add(e.b);
      }
    let z = xy.map(([x, y]) =>
      Math.max(
        floor,
        ...spheres.map((s, i) => {
          if (surfaces && !s.analyticSurface) {
            const hit = surfaces[i].bvh.raycastFirst(
              new T.Ray(
                new T.Vector3(x, y, surfaces[i].top),
                new T.Vector3(0, 0, -1),
              ),
              T.DoubleSide,
            );
            return hit ? hit.point.z : -Infinity;
          }
          const [sx, sy, sz] = s.axisScale ?? [1, 1, 1];
          const q =
            1 -
            ((x - s.center[0]) / (s.radius * sx)) ** 2 -
            ((y - s.center[1]) / (s.radius * sy)) ** 2;
          return q >= 0
            ? s.center[2] + s.radius * sz * Math.sqrt(q)
            : -Infinity;
        }),
      ),
    );
    // On curved footprint edges the section and sphere meet at the floor.
    // Chord interpolation must not invent a rippled skirt between section points.
    for (const i of boundary) {
      const [x, y] = xy[i];
      if (
        domainLoops &&
        spheres.every((s) => s.analyticSurface) &&
        !domainLoops.some((loop) =>
          loop.some(
            (a, j) => distance([x, y], a, loop[(j + 1) % loop.length]) < 1e-4,
          ),
        )
      ) {
        const heights = spheres
          .filter((s) => {
            const [sx, sy, sz] = s.axisScale;
            const q = 1 - ((floor - s.center[2]) / (s.radius * sz)) ** 2;
            return (
              q >= 0 &&
              Math.abs(
                Math.hypot(
                  (x - s.center[0]) / (s.radius * sx),
                  (y - s.center[1]) / (s.radius * sy),
                ) - Math.sqrt(q),
              ) <
                spacing / (2 * s.radius * Math.max(sx, sy))
            );
          })
          .map((s) => s.center[2] + Math.abs(floor - s.center[2]));
        if (heights.length) z[i] = Math.max(floor, ...heights);
      } else if (
        domainLoops
          ? false
          : Math.min(
              Math.abs(x),
              Math.abs(x - w),
              Math.abs(y),
              Math.abs(y - h),
            ) > 1e-6
      )
        z[i] = surfaces
          ? Math.max(floor, z[i])
          : Math.max(
              floor,
              ...spheres
                .filter(
                  (s) =>
                    Math.abs(
                      Math.hypot(x - s.center[0], y - s.center[1]) -
                        Math.sqrt(
                          Math.max(
                            0,
                            s.radius ** 2 - (floor - s.center[2]) ** 2,
                          ),
                        ),
                    ) <
                    spacing * 0.5,
                )
                .map((s) => s.center[2] + Math.abs(floor - s.center[2])),
            );
    }
    // Keep footprint vertices fixed; relax only interior roof heights vertically.
    for (let i = 0; i < smoothing; i++)
      z = z.map((v, k) =>
        boundary.has(k)
          ? v
          : Math.max(
              floor + 1e-6,
              0.5 * v +
                (0.5 * [...neighbors[k]].reduce((s, j) => s + z[j], 0)) /
                  neighbors[k].size,
            ),
      );
    const pos = [],
      top = [],
      bottom = [];
    xy.forEach(([x, y], i) => {
      top[i] = pos.length / 3;
      pos.push(x, y, z[i]);
      if (boundary.has(i) && Math.abs(z[i] - floor) < 1e-7) bottom[i] = top[i];
      else {
        bottom[i] = pos.length / 3;
        pos.push(x, y, floor);
      }
    });
    const idx = [],
      add = (a, b, c) => {
        if (a !== b && b !== c && c !== a) idx.push(a, b, c);
      };
    for (const [a, b, c] of tris) {
      add(top[a], top[b], top[c]);
      add(bottom[c], bottom[b], bottom[a]);
    }
    for (const e of edges.values())
      if (e.count === 1) {
        add(top[e.a], bottom[e.a], bottom[e.b]);
        add(top[e.a], bottom[e.b], top[e.b]);
      }
    const raw = {
      positions: new Float64Array(pos),
      indices: new Uint32Array(idx),
    };
    if (signedVolume(raw) < 0)
      for (let i = 0; i < raw.indices.length; i += 3)
        [raw.indices[i + 1], raw.indices[i + 2]] = [
          raw.indices[i + 2],
          raw.indices[i + 1],
        ];
    const parent = xy.map((_, i) => i),
      root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    for (const [a, b, c] of tris) {
      parent[root(b)] = root(a);
      parent[root(c)] = root(a);
    }
    const components = new Set(xy.map((_, i) => root(i))).size,
      q = meshQuality(raw);
    return {
      raw,
      points,
      cells,
      ...(cellLoops ? { cellLoops } : {}),
      ids,
      spheres,
      loops,
      quality: q,
      components,
      volume: signedVolume(raw),
      params: p,
      closed:
        !q.boundaryEdges &&
        !q.nonManifoldEdges &&
        !q.degenerateFaces &&
        !q.duplicateFaces &&
        !q.invalidFaces &&
        !q.inconsistentEdges,
    };
  } finally {
    disposables.forEach((g) => g.dispose());
    owned.reverse().forEach((x) => x.delete());
  }
}
