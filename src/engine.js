import { validBalloonEdit, expandedEdit, editScale } from "./balloon-edit.js";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { lifecycleMethods } from "./lifecycle.js";
import { buildCavities } from "./boolean-pipeline.js";
import { rebuildVolume } from "./volume-remesh.js";
import { structuredSphere, smoothContactBand } from "./balloon-surface.js";

export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export function bounds(raw) {
  let min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < raw.positions.length; i++) {
    const k = i % 3;
    min[k] = Math.min(min[k], raw.positions[i]);
    max[k] = Math.max(max[k], raw.positions[i]);
  }
  return {
    min,
    max,
    center: min.map((v, k) => (v + max[k]) / 2),
    span: min.map((v, k) => max[k] - v),
  };
}
export function canonical(raw) {
  const p = Array.from(raw.positions),
    ids = raw.indices
      ? Array.from(raw.indices)
      : p
          .map((_, i) => i)
          .filter((i) => i % 3 === 0)
          .map((i) => i / 3);
  if (
    p.length % 3 ||
    ids.length % 3 ||
    p.length < 12 ||
    p.some((v) => !Number.isFinite(v))
  )
    throw Error("Invalid mesh coordinates.");
  const b = bounds(raw),
    eps = Math.max(...b.span) * 1e-8;
  if (!(eps > 0)) throw Error("Container has no volume.");
  const map = new Map(),
    verts = [],
    remap = [];
  for (let i = 0; i < p.length; i += 3) {
    const key = p
      .slice(i, i + 3)
      .map((v) => Math.round(v / eps))
      .join(",");
    let j = map.get(key);
    if (j === undefined) {
      j = verts.length / 3;
      map.set(key, j);
      verts.push(...p.slice(i, i + 3));
    }
    remap.push(j);
  }
  const idx = [];
  for (let i = 0; i < ids.length; i += 3) {
    if (
      ids
        .slice(i, i + 3)
        .some((v) => !Number.isInteger(v) || v < 0 || v >= remap.length)
    )
      throw Error("Mesh face references an invalid vertex.");
    const t = ids.slice(i, i + 3).map((v) => remap[v]);
    if (new Set(t).size < 3)
      throw Error("Degenerate faces found. Repair the mesh in Rhino.");
    idx.push(...t);
  }
  let vol = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3,
      b = idx[i + 1] * 3,
      c = idx[i + 2] * 3;
    vol +=
      verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1]) +
      verts[a + 1] * (verts[b + 2] * verts[c] - verts[b] * verts[c + 2]) +
      verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c]);
  }
  if (vol < 0)
    for (let i = 0; i < idx.length; i += 3)
      [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  const result = {
      positions: new Float32Array(verts),
      indices: new Uint32Array(idx),
    },
    check = topology(result);
  if (!check.closed || !check.manifold || !check.valid)
    throw Error(
      "Container must be closed, consistently oriented, and manifold. Repair naked edges or degenerate faces in Rhino.",
    );
  return result;
}
export function topology(raw) {
  const edges = new Map();
  let valid =
    raw.positions.length >= 12 &&
    raw.positions.length % 3 === 0 &&
    raw.indices.length >= 12 &&
    raw.indices.length % 3 === 0;
  const p = raw.positions;
  for (let i = 0; i < raw.indices.length; i += 3) {
    const t = Array.from(raw.indices.slice(i, i + 3));
    if (
      t.some((v) => !Number.isInteger(v) || v < 0 || v * 3 + 2 >= p.length) ||
      new Set(t).size < 3
    ) {
      valid = false;
      continue;
    }
    const a = t[0] * 3,
      b = t[1] * 3,
      c = t[2] * 3,
      ab = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]],
      ac = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    if (
      Math.hypot(
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ) < 1e-15
    )
      valid = false;
    for (let k = 0; k < 3; k++) {
      const a = t[k],
        b = t[(k + 1) % 3],
        key = Math.min(a, b) + ":" + Math.max(a, b);
      let e = edges.get(key) || [0, 0];
      e[0]++;
      e[1] += a < b ? 1 : -1;
      edges.set(key, e);
    }
  }
  return {
    valid: valid && Array.from(p).every(Number.isFinite),
    closed: edges.size > 0 && [...edges.values()].every((e) => e[0] === 2),
    manifold:
      edges.size > 0 &&
      [...edges.values()].every((e) => e[0] === 2 && e[1] === 0),
  };
}
export function spatial(raw) {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(raw.positions), 3),
  );
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(raw.indices), 1));
  const tree = new MeshBVH(g),
    direction = new THREE.Vector3(1, 0.371390676, 0.69474659).normalize();
  const ray = new THREE.Ray(new THREE.Vector3(), direction);
  return {
    inside(p) {
      ray.origin.set(...p);
      const hits = tree
        .raycast(ray, THREE.DoubleSide)
        .map((h) => h.distance)
        .filter((t) => t > 1e-8)
        .sort((a, b) => a - b);
      let n = 0,
        last = -Infinity;
      for (const t of hits)
        if (t - last > 1e-6) {
          n++;
          last = t;
        }
      return n % 2 === 1;
    },
    near(p, tolerance) {
      return !!tree.closestPointToPoint(
        new THREE.Vector3(...p),
        {},
        0,
        tolerance,
      );
    },
    dispose() {
      g.dispose();
    },
  };
}
export function populate(raw, count, seed) {
  const b = bounds(raw),
    rng = random(seed),
    s = spatial(raw),
    out = [];
  let attempts = 0;
  while (out.length < count && attempts++ < Math.max(10000, count * 3000)) {
    const p = b.min.map((v, k) => v + rng() * b.span[k]);
    if (s.inside(p)) out.push(p);
  }
  s.dispose();
  if (out.length !== count)
    throw Error(
      `Only ${out.length}/${count} interior points found. Try a different seed or a simpler boundary.`,
    );
  return out;
}
export function closestPolyline(p, curve) {
  // Separate polylines must never be joined by an artificial pressure segment.
  if (Array.isArray(curve?.[0]?.[0]))
    return Math.min(...curve.map((c) => closestPolyline(p, c)));
  let best = Infinity;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i],
      b = curve[i + 1],
      v = b.map((x, k) => x - a[k]),
      w = p.map((x, k) => x - a[k]);
    const t = Math.max(0, Math.min(1, dot(w, v) / Math.max(1e-20, dot(v, v))));
    best = Math.min(
      best,
      dist(
        p,
        a.map((x, k) => x + v[k] * t),
      ),
    );
  }
  return best;
}

export class BalloonEngine {
  constructor(module) {
    this.m = module;
    this.boundary = null;
    this.base = [];
    this.balloons = [];
    this.edits = [];
    this.centers = [];
  }
  clear() {
    for (const s of new Set([this.boundary, ...this.base, ...this.balloons]))
      if (s) s.delete();
    this.boundary = null;
    this.base = [];
    this.balloons = [];
  }
  toSolid(raw) {
    return new this.m.Manifold(
      new this.m.Mesh({
        numProp: 3,
        vertProperties: new Float32Array(raw.positions),
        triVerts: new Uint32Array(raw.indices),
      }),
    );
  }
  raw(s) {
    const mesh = s.getMesh(),
      p = new Float32Array(mesh.numVert * 3);
    for (let i = 0; i < mesh.numVert; i++)
      for (let k = 0; k < 3; k++)
        p[i * 3 + k] = mesh.vertProperties[i * mesh.numProp + k];
    return { positions: p, indices: new Uint32Array(mesh.triVerts) };
  }
  assert(s, label) {
    if (s.status() !== "NoError" || s.isEmpty())
      throw Error(`${label}: invalid or empty solid (${s.status()}).`);
  }
  generate(raw, p, curve, progress = () => {}) {
    this.clear();
    raw = canonical(raw);
    if (raw.indices.length / 3 > 300000)
      throw Error(
        "Container exceeds 300,000 triangles. Reduce its mesh density in Rhino.",
      );
    this.boundary = this.toSolid(raw);
    this.assert(this.boundary, "Container");
    this.rawBoundary = raw;
    const centers = populate(raw, p.count, p.pointSeed),
      rng = random(p.radiusSeed),
      radii = centers.map(
        () => p.radiusMin + rng() * (p.radiusMax - p.radiusMin),
      ),
      space = spatial(raw);
    // Moderate separation before contact partitioning; centers remain verified interior points.
    for (let pass = 0; pass < 20; pass++)
      for (let i = 0; i < centers.length; i++)
        for (let j = i + 1; j < centers.length; j++) {
          const a = centers[i],
            b = centers[j],
            d = dist(a, b),
            depth = radii[i] + radii[j] - d;
          if (depth > Math.min(radii[i], radii[j]) * 0.35) {
            const v = b.map((x, k) => (x - a[k]) / Math.max(d, 1e-9)),
              step = Math.min(
                depth * 0.12,
                Math.min(radii[i], radii[j]) * 0.06,
              );
            for (const [id, sign] of [
              [i, -1],
              [j, 1],
            ]) {
              const next = centers[id].map((x, k) => x + v[k] * step * sign);
              if (space.inside(next)) centers[id] = next;
            }
          }
        }
    const made = [];
    try {
      for (let i = 0; i < centers.length; i++) {
        progress(
          i / centers.length,
          `Forming balloon ${i + 1} / ${centers.length}`,
        );
        const c = centers[i],
          r = radii[i];
        const contactPlanes = [];
        let s = this.toSolid(structuredSphere(r, p.quality, c));
        const replace = (next) => {
          s.delete();
          s = next;
        };
        if (p.pressureEnabled && curve.length && p.strength > 0) {
          replace(
            s.warp((v) => {
              const delta = v.map((x, k) => x - c[k]),
                len = Math.hypot(...delta),
                d = closestPolyline(v, curve),
                u = Math.max(0, 1 - d / p.influence),
                w = u * u * u * (10 + u * (-15 + 6 * u)),
                depth = Math.min(p.strength, 0.75 * len) * w;
              for (let k = 0; k < 3; k++)
                v[k] = c[k] + delta[k] * (1 - depth / len);
            }),
          );
        }
        // Common weighted contact planes define disjoint cells. Apply AFTER pressure.
        for (let j = 0; j < centers.length; j++)
          if (i !== j) {
            const d = dist(c, centers[j]);
            if (d < r + radii[j] + p.clearance) {
              const n = centers[j].map(
                  (x, k) => (x - c[k]) / Math.max(d, 1e-12),
                ),
                h = (d * r) / (r + radii[j]) - p.clearance * 0.5;
              contactPlanes.push({ normal: n, offset: dot(n, c) + h });
              replace(
                s.trimByPlane(
                  n.map((v) => -v),
                  -dot(n, c) - h,
                ),
              );
            }
          }
        replace(s.intersect(this.boundary));
        replace(this.softenContacts(s, contactPlanes, space));
        this.assert(
          s,
          `Balloon ${i + 1} collapsed; reduce count, radii, or gap`,
        );
        made.push(s);
      }
    } catch (e) {
      for (const s of made) s.delete();
      throw e;
    } finally {
      space.dispose();
    }
    this.base = made;
    this.balloons = made.map((s) => s.translate([0, 0, 0]));
    this.centers = centers;
    this.edits = made.map(() => [0, 0, 0, 1]);
    this.initLifecycle(p);
    return this.snapshot();
  }
  softenContacts(solid, planes = [], surface = null, minimumVolume = 0) {
    const raw = this.raw(solid),
      b = bounds(raw),
      tolerance = Math.max(...b.span) * 1e-6;
    const contact = (p) =>
      planes.some(
        ({ normal, offset }) => Math.abs(dot(normal, p) - offset) <= tolerance,
      ) || !!surface?.near(p, tolerance);
    for (const strength of [0.23, 0.115, 0.0575]) {
      const smooth = smoothContactBand(raw, contact, strength, 8);
      if (!smooth.eligible.some(Boolean)) return solid.translate([0, 0, 0]);
      const candidate = this.toSolid(smooth);
      let outside;
      let accepted = false;
      try {
        if (candidate.status() !== "NoError" || candidate.isEmpty()) continue;
        const parts = candidate.decompose(),
          connected = parts.length === 1;
        parts.forEach((p) => p.delete());
        if (
          !connected ||
          candidate.volume() < Math.max(solid.volume() * 0.85, minimumVolume)
        )
          continue;
        outside = candidate.subtract(solid);
        if (outside.volume() > this.allowedVolumeError(solid)) continue;
        accepted = true;
        return candidate;
      } finally {
        if (!accepted) candidate.delete();
        outside?.delete();
      }
    }
    // A tiny or pinched remainder takes precedence over softening. Never erode
    // a balloon below the collision solver's minimum viable volume.
    return solid.translate([0, 0, 0]);
  }
  candidate(i, edit) {
    const c = this.centers[i];
    return this.base[i]
      .translate(c.map((x) => -x))
      .scale(editScale(edit))
      .translate(c.map((x, k) => x + edit[k]));
  }
  allowedVolumeError(s, positionError = 0) {
    const volumeOfBalloon = s.volume();
    return Math.max(
      1e-9,
      volumeOfBalloon * 1e-9,
      positionError > 0
        ? Math.min(s.surfaceArea() * positionError, volumeOfBalloon * 1e-6)
        : 0,
    );
  }
  safe(i, s, positionError = 0) {
    const threshold = this.allowedVolumeError(s, positionError);
    let cut = s.subtract(this.boundary),
      outside = cut.volume();
    cut.delete();
    if (outside > threshold) return false;
    for (let j = 0; j < this.balloons.length; j++)
      if (j !== i) {
        cut = s.intersect(this.balloons[j]);
        const volume = cut.volume();
        cut.delete();
        if (volume > threshold) return false;
      }
    return s.status() === "NoError" && !s.isEmpty();
  }
  pressureSafe(i, s, boundaryRoundingError = 0) {
    if (s.status() !== "NoError" || s.isEmpty()) return false;
    let part = s.subtract(this.boundary);
    const outside = part.volume();
    part.delete();
    if (outside > this.allowedVolumeError(s, boundaryRoundingError))
      return false;
    for (let j = 0; j < this.balloons.length; j++)
      if (j !== i) {
        const rest = this.meta[j].frozen
          ? this.balloons[j].translate([0, 0, 0])
          : this.candidate(j, this.edits[j]);
        try {
          part = s.intersect(rest);
          const overlap = part.volume();
          part.delete();
          if (overlap <= this.allowedVolumeError(rest)) continue;
          if (this.meta[j].frozen) return false;
          part = rest.subtract(s);
          const ok =
            part.status() === "NoError" &&
            !part.isEmpty() &&
            part.volume() >= rest.volume() * 0.02;
          let connected = false;
          if (ok) {
            const pieces = part.decompose();
            connected = pieces.length === 1;
            pieces.forEach((piece) => piece.delete());
          }
          part.delete();
          if (!ok || !connected) return false;
        } finally {
          rest.delete();
        }
      }
    return true;
  }
  edit(i, requested) {
    this.requireEditable(i);
    this.lastPop = null;
    if (!this.base[i] || !validBalloonEdit(requested))
      throw Error("Invalid individual balloon edit.");
    const directional = requested.length === 7 || this.edits[i].length === 7;
    if (directional) requested = expandedEdit(requested);
    let boundaryRoundingError = 0;
    if (this.positionErrorTolerance) {
      const outside = this.balloons[i].subtract(this.boundary),
        leak = outside.volume();
      outside.delete();
      if (leak > this.allowedVolumeError(this.balloons[i]))
        boundaryRoundingError = this.positionErrorTolerance;
    }
    let accepted = directional
        ? expandedEdit(this.edits[i])
        : this.edits[i].slice(),
      clamped = false;
    for (const axis of directional
      ? [3, 0, 1, 2, 0, 1, 2, 4, 5, 6]
      : [3, 0, 1, 2, 0, 1, 2]) {
      let goal = accepted.slice();
      goal[axis] = requested[axis];
      let test = this.candidate(i, goal);
      if (this.pressureSafe(i, test, boundaryRoundingError)) {
        accepted = goal;
        test.delete();
        continue;
      }
      test.delete();
      clamped = true;
      let lo = 0,
        hi = 1;
      for (let step = 0; step < 18; step++) {
        const t = (lo + hi) / 2,
          trial = accepted.slice();
        trial[axis] += t * (requested[axis] - accepted[axis]);
        test = this.candidate(i, trial);
        const ok = this.pressureSafe(i, test, boundaryRoundingError);
        test.delete();
        if (ok) lo = t;
        else hi = t;
      }
      accepted[axis] += lo * (requested[axis] - accepted[axis]);
    }
    const candidate = this.candidate(i, accepted);
    if (!this.pressureSafe(i, candidate, boundaryRoundingError)) {
      candidate.delete();
      throw Error("Edit could not be verified; previous balloon preserved.");
    }
    this.balloons[i].delete();
    this.balloons[i] = candidate;
    this.edits[i] = accepted;
    this.meta[i].contactPriority =
      1 + Math.max(0, ...this.meta.map((m) => m.contactPriority || 0));
    const deformedNeighbors = this.refreshContacts();
    return { ...this.snapshot(), clamped, deformedNeighbors };
  }
  refreshContacts() {
    // Rebuild temporary contact dents from the edited rest shapes, never from
    // yesterday's dented display meshes. Frozen shapes remain exact obstacles.
    const order = this.balloons
      .map((_, i) => i)
      .sort(
        (a, b) =>
          Number(this.meta[b].frozen) - Number(this.meta[a].frozen) ||
          (this.meta[b].contactPriority || 0) -
            (this.meta[a].contactPriority || 0) ||
          a - b,
      );
    const next = new Map();
    let deformed = 0;
    try {
      for (const i of order) {
        let solid = this.meta[i].frozen
          ? this.balloons[i].translate([0, 0, 0])
          : this.candidate(i, this.edits[i]);
        next.set(i, solid);
        if (this.meta[i].frozen) continue;
        const volume = solid.volume();
        for (const [j, obstacle] of next) {
          if (j === i) continue;
          const contact = solid.intersect(obstacle);
          const overlap = contact.volume();
          contact.delete();
          if (overlap <= this.allowedVolumeError(solid)) continue;
          const cut = solid.subtract(obstacle),
            surface = spatial(this.raw(obstacle));
          let softened;
          try {
            softened = this.softenContacts(cut, [], surface, volume * 0.02);
          } finally {
            surface.dispose();
            cut.delete();
          }
          solid.delete();
          solid = softened;
          next.set(i, solid);
        }
        this.assert(solid, "Contact deformation");
        const parts = solid.decompose();
        const connected = parts.length === 1;
        parts.forEach((p) => p.delete());
        if (!connected || solid.volume() < volume * 0.02)
          throw Error(
            "This movement leaves too little connected space for a neighboring balloon.",
          );
        if (volume - solid.volume() > this.allowedVolumeError(solid))
          deformed++;
      }
      for (const [i, solid] of next) {
        this.balloons[i].delete();
        this.balloons[i] = solid;
      }
      next.clear();
      return deformed;
    } finally {
      for (const solid of next.values()) solid.delete();
    }
  }
  restore(raw, params, curve, edits) {
    this.generate(raw, params, curve);
    if (edits.length !== this.base.length)
      throw Error("Saved edit count does not match balloon count.");
    const old = this.balloons;
    this.balloons = edits.map((e, i) => {
      if (!validBalloonEdit(e)) throw Error("Invalid saved edit.");
      return this.candidate(i, e);
    });
    try {
      for (let i = 0; i < this.balloons.length; i++)
        if (!this.safe(i, this.balloons[i]))
          throw Error("Saved edits fail containment or collision checks.");
    } catch (err) {
      this.balloons.forEach((s) => s.delete());
      this.balloons = old;
      throw err;
    }
    old.forEach((s) => s.delete());
    this.edits = edits.map((e) => e.slice());
    return this.snapshot();
  }
  snapshot() {
    return this.session();
  }
  output(
    mode,
    tolerance,
    quality = "final",
    progress = () => {},
    resolution = 160,
  ) {
    if (!this.boundary)
      throw Error("Generate a field before building an output.");
    if (mode === "shell")
      return {
        mode,
        shells: [this.rawBoundary, ...this.balloons.map((s) => this.raw(s))],
        message: `Shell assembly: ${this.balloons.length + 1} separate shells. Ready to export: choose EXPORT .3DM, .OBJ or .STL below. No material removed.`,
      };
    const diagnostics =
      quality === "rebuild"
        ? rebuildVolume(this, resolution, progress)
        : buildCavities(this, tolerance, quality, progress);
    const raw = diagnostics.raw,
      checks = topology(raw),
      incomplete =
        !checks.valid ||
        !checks.closed ||
        !checks.manifold ||
        (diagnostics.intersectionAudit?.properCrossings || 0) > 0;
    return {
      mode,
      shells: [raw],
      checks,
      quality,
      resolution: diagnostics.resolution,
      qualityWarning:
        diagnostics.after.stretchedFaces > 0 ||
        diagnostics.after.degenerateFaces > 0 ||
        !!diagnostics.approximation,
      diagnostics: { ...diagnostics, raw: undefined },
      incomplete,
      message: `${diagnostics.approximation ? "Volume rebuild / approximate" : incomplete ? "Boolean available for export with warnings" : "Boolean topology verified"} · Closed: ${checks.closed ? "yes" : "no"} · Manifold: ${checks.manifold ? "yes" : "no"} · Degenerate: ${diagnostics.after.degenerateFaces} · Stretched: ${diagnostics.after.stretchedFaces} · Max aspect: ${Number.isFinite(diagnostics.after.maxAspect) ? diagnostics.after.maxAspect.toFixed(1) : "unbounded"} · Suspected crossings: ${diagnostics.intersectionAudit?.properCrossings ?? "not checked"}${diagnostics.intersectionAudit?.truncated ? " (partial audit)" : ""}${diagnostics.approximation ? ` · Cell size: ${diagnostics.cellSize.toPrecision(3)}. ${diagnostics.featureWarning}` : diagnostics.after.stretchedFaces ? ". Thin-feature triangles remain; surface quality is not certified." : ""}${incomplete ? " Export is allowed with warnings; separate input shells are preserved." : ""}`,
    };
  }
}
Object.assign(BalloonEngine.prototype, lifecycleMethods);
