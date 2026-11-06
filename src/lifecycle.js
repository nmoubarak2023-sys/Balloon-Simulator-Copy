import { validBalloonEdit } from "./balloon-edit.js";
import * as T from "three";
import { MeshBVH } from "three-mesh-bvh";

function center(raw) {
  const box = new T.Box3().setFromArray(raw.positions);
  return box.getCenter(new T.Vector3()).toArray();
}
function quantizationError(raw) {
  const box = new T.Box3().setFromArray(raw.positions),
    span = box.getSize(new T.Vector3()).length(),
    magnitude = Math.max(
      ...box.min.toArray().map(Math.abs),
      ...box.max.toArray().map(Math.abs),
    );
  return Math.max(1e-12, Math.min(magnitude * 2 ** -23, span * 2 ** -20));
}
function geo(raw) {
  const g = new T.BufferGeometry();
  g.setAttribute(
    "position",
    new T.BufferAttribute(new Float32Array(raw.positions), 3),
  );
  g.setIndex(new T.BufferAttribute(new Uint32Array(raw.indices), 1));
  return g;
}
function oneComponent(s) {
  const parts = s.decompose();
  const n = parts.length;
  parts.forEach((p) => p.delete());
  return n === 1;
}
function contactBridge(engine, a, b, maxGap) {
  const ra = engine.raw(a),
    rb = engine.raw(b),
    ga = geo(ra),
    gb = geo(rb),
    ta = new MeshBVH(ga),
    tb = new MeshBVH(gb),
    pa = {},
    pb = {};
  try {
    ga.boundsTree = ta;
    gb.boundsTree = tb;
    ta.closestPointToGeometry(gb, new T.Matrix4(), pa, pb);
    if (!pa.point || !pb.point || pa.distance > maxGap)
      throw Error(
        "Selected balloons are too far apart. Move them closer before merging.",
      );
    const radius = Math.cbrt(
        (Math.min(a.volume(), b.volume()) * 3) / (4 * Math.PI),
      ),
      reach = pa.distance + radius * 0.025,
      points = [];
    for (const [raw, tree] of [
      [ra, tb],
      [rb, ta],
    ])
      for (let k = 0; k < raw.positions.length; k += 3) {
        const p = new T.Vector3().fromArray(raw.positions, k),
          near = tree.closestPointToPoint(p, {}, 0, reach);
        if (near && near.distance <= reach)
          points.push(p.toArray(), near.point.toArray());
      }
    if (points.length >= 4) {
      // Include each nearby vertex AND its projection onto the opposite surface:
      // unequal tessellation can otherwise produce a patch on only one body.
      const axis = pb.point.clone().sub(pa.point).normalize(),
        magnitude = Math.max(
          ...pa.point.toArray().map(Math.abs),
          ...pb.point.toArray().map(Math.abs),
        );
      const padding = Math.min(
        radius * 0.001,
        Math.max(radius * 1e-6, magnitude * 2 ** -22),
      );
      const padded =
        axis.lengthSq() > 0
          ? points.flatMap((p) =>
              [-1, 1].map((sign) =>
                p.map((v, k) => v + sign * axis.getComponent(k) * padding),
              ),
            )
          : points;
      const hull = engine.m.Manifold.hull(padded);
      if (!hull.isEmpty() && hull.status() === "NoError") return hull;
      hull.delete();
    }
    // A round neck is the fallback for point contacts or a very small contact patch.
    const width = Math.max(radius * 0.06, pa.distance * 0.8),
      sa = engine.m.Manifold.sphere(width, 32).translate(pa.point.toArray()),
      sb = engine.m.Manifold.sphere(width, 32).translate(pb.point.toArray());
    const bridge = engine.m.Manifold.hull([sa, sb]);
    sa.delete();
    sb.delete();
    return bridge;
  } finally {
    ga.dispose();
    gb.dispose();
  }
}

export const lifecycleMethods = {
  initLifecycle(params) {
    this.positionErrorTolerance = 0;
    this.params = { ...params };
    this.meta = this.balloons.map((_, i) => ({
      id: `b${i}`,
      members: [i],
      frozen: false,
    }));
    this.popped = [];
    this.popEvents = [];
    this.popStrength = 0.25;
    this.lastPop = null;
  },
  session() {
    return {
      boundary: this.rawBoundary,
      balloons: this.balloons.map((s) => this.raw(s)),
      base: this.base.map((s) => this.raw(s)),
      centers: this.centers.map((c) => c.slice()),
      edits: this.edits.map((e) => e.slice()),
      meta: (this.meta || []).map((m) => ({
        ...m,
        members: m.members.slice(),
      })),
      popped: [...(this.popped || [])],
      popEvents: (this.popEvents || []).map((event) => ({ ...event })),
      popStrength: this.popStrength ?? 0.25,
      params: this.params,
      canAdjustPop: !!this.lastPop,
    };
  },
  fork() {
    // Internal actions must preserve native precision, not re-import display meshes.
    const next = new this.constructor(this.m);
    try {
      next.boundary = this.boundary.translate([0, 0, 0]);
      next.rawBoundary = this.rawBoundary;
      next.balloons = this.balloons.map((s) => s.translate([0, 0, 0]));
      next.base = this.base.map((s) => s.translate([0, 0, 0]));
      next.centers = this.centers.map((c) => c.slice());
      next.edits = this.edits.map((e) => e.slice());
      next.meta = this.meta.map((m) => ({ ...m, members: m.members.slice() }));
      next.popped = this.popped.slice();
      next.popEvents = this.popEvents.map((event) => ({ ...event }));
      next.popStrength = this.popStrength;
      next.params = { ...this.params };
      next.lastPop = this.lastPop;
      next.positionErrorTolerance = this.positionErrorTolerance || 0;
      return next;
    } catch (err) {
      next.clear();
      throw err;
    }
  },
  loadSession(state) {
    if (
      !state ||
      !Array.isArray(state.balloons) ||
      state.balloons.length > 40 ||
      state.meta?.length !== state.balloons.length ||
      state.base?.length !== state.balloons.length ||
      state.centers?.length !== state.balloons.length ||
      state.edits?.length !== state.balloons.length
    )
      throw Error("Invalid saved balloon state.");
    this.clear();
    this.rawBoundary = state.boundary;
    this.boundary = this.toSolid(state.boundary);
    this.assert(this.boundary, "Saved boundary");
    this.params = { ...state.params };
    this.meta = [];
    this.centers = [];
    this.edits = [];
    this.base = [];
    this.balloons = [];
    const members = new Set();
    for (let i = 0; i < state.balloons.length; i++) {
      const meta = state.meta[i],
        c = state.centers[i],
        edit = state.edits[i];
      if (
        !meta ||
        !Array.isArray(meta.members) ||
        !meta.members.length ||
        meta.members.some(
          (v) => !Number.isInteger(v) || v < 0 || v >= 40 || members.has(v),
        ) ||
        c?.length !== 3 ||
        c.some((v) => !Number.isFinite(v)) ||
        !validBalloonEdit(edit)
      )
        throw Error("Invalid saved balloon metadata.");
      meta.members.forEach((v) => members.add(v));
      const s = this.toSolid(state.balloons[i]),
        base = this.toSolid(state.base[i]);
      this.balloons.push(s);
      this.base.push(base);
      this.assert(s, "Saved balloon");
      this.assert(base, "Saved balloon baseline");
      this.meta.push({
        ...meta,
        frozen: !!meta.frozen,
        members: meta.members.slice(),
      });
      this.centers.push(c.slice());
      this.edits.push(edit.slice());
    }
    this.popped = [...(state.popped || [])];
    this.popEvents = (state.popEvents || []).map((event) => ({ ...event }));
    this.popStrength = state.popStrength ?? 0.25;
    this.lastPop = null;
    if (
      this.popped.some(
        (v) => !Number.isInteger(v) || v < 0 || v >= 40 || members.has(v),
      ) ||
      this.popEvents.length > 40 ||
      this.popEvents.some(
        (e) => !Number.isFinite(e.strength) || e.strength < 0 || e.strength > 1,
      )
    )
      throw Error("Invalid saved pop state.");
    // JSON/display coordinates are Float32. Permit only a bounded quantization skin.
    const positionError = quantizationError(state.boundary);
    this.positionErrorTolerance = positionError;
    for (let i = 0; i < this.balloons.length; i++)
      if (!this.safe(i, this.balloons[i], positionError))
        throw Error(
          `Saved balloon ${i + 1} has a boundary crossing or overlap larger than the mesh rounding tolerance.`,
        );
    return this.snapshot();
  },
  removeEntity(i) {
    for (const key of ["balloons", "base"]) {
      this[key][i].delete();
      this[key].splice(i, 1);
    }
    for (const key of ["centers", "edits", "meta"]) this[key].splice(i, 1);
  },
  replaceEntity(i, s) {
    this.assert(s, "Changed balloon");
    this.balloons[i].delete();
    this.base[i].delete();
    this.balloons[i] = s;
    this.base[i] = s.translate([0, 0, 0]);
    this.centers[i] = center(this.raw(s));
    this.edits[i] = [0, 0, 0, 1];
  },
  requireEditable(i) {
    if (!Number.isInteger(i) || !this.balloons[i])
      throw Error("Select a balloon first.");
    if (this.meta[i].frozen)
      throw Error(
        "This balloon is frozen. Unfreeze it before editing, popping, or merging.",
      );
  },
  freeze(i) {
    if (!this.meta[i]) throw Error("Select a balloon first.");
    this.meta[i].frozen = !this.meta[i].frozen;
    this.lastPop = null;
    return {
      ...this.snapshot(),
      message: this.meta[i].frozen
        ? "Balloon frozen. Its current geometry and position are locked."
        : "Balloon unfrozen.",
    };
  },
  pressureCut(source, strength) {
    const c = center(source),
      s = this.toSolid(source),
      a = s.translate(c.map((v) => -v)),
      b = a.scale(1 + strength * 0.25),
      cut = b.translate(c);
    s.delete();
    a.delete();
    b.delete();
    return cut;
  },
  applyPopEvent(event) {
    if (event.strength === 0) return 0;
    const cut = this.pressureCut(event.source, event.strength);
    let affected = 0;
    try {
      for (let i = 0; i < this.balloons.length; i++) {
        if (this.meta[i].frozen) continue;
        const rest = this.candidate(i, this.edits[i]),
          before = rest.volume(),
          s = rest.subtract(cut);
        rest.delete();
        if (s.isEmpty() || s.status() !== "NoError") {
          s.delete();
          throw Error(
            "Pop pressure would remove a neighboring balloon. Lower the pressure.",
          );
        }
        if (before - s.volume() > Math.max(1e-9, before * 1e-8)) {
          if (this.meta[i].members.length > 1 && !oneComponent(s)) {
            s.delete();
            throw Error(
              "Pop pressure would split a merged volume. Lower the pressure.",
            );
          }
          this.replaceEntity(i, s);
          affected++;
        } else s.delete();
      }
    } finally {
      cut.delete();
    }
    return affected;
  },
  pop(i, strength) {
    this.requireEditable(i);
    if (!Number.isFinite(strength) || strength < 0 || strength > 1)
      throw Error("Pop pressure must be between 0 and 100%.");
    const before = this.session(),
      id = this.meta[i].id,
      source = this.raw(this.balloons[i]),
      members = this.meta[i].members.slice();
    this.removeEntity(i);
    this.popped = [...new Set([...this.popped, ...members])];
    const event = { source, strength };
    const affected = this.applyPopEvent(event);
    this.refreshContacts();
    this.popEvents.push(event);
    this.popStrength = strength;
    this.lastPop = { before, id };
    return {
      ...this.snapshot(),
      message: `Pop! Balloon removed. ${affected} neighboring balloon${affected === 1 ? "" : "s"} deformed; frozen balloons unchanged.`,
    };
  },
  changePopPressure(strength) {
    if (!this.lastPop) throw Error("Set the pressure, then pop a balloon.");
    const { before, id } = this.lastPop;
    this.loadSession(before);
    const i = this.meta.findIndex((m) => m.id === id);
    return this.pop(i, strength);
  },
  mergedSolid(indices) {
    const bodies = indices.map((i) => this.balloons[i]),
      bridges = [];
    let result = this.m.Manifold.union(bodies);
    try {
      if (oneComponent(result)) {
        this.assert(result, "Merge");
        return result;
      }
      const parent = indices.map((_, i) => i),
        root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i]))),
        edges = [];
      for (let i = 0; i < bodies.length; i++)
        for (let j = i + 1; j < bodies.length; j++) {
          const radius = Math.cbrt(
              (Math.min(bodies[i].volume(), bodies[j].volume()) * 3) /
                (4 * Math.PI),
            ),
            limit = Math.max((this.params?.clearance || 0) * 3, radius * 0.3),
            gap = bodies[i].minGap(bodies[j], limit);
          if (gap < limit) edges.push({ i, j, gap, limit });
        }
      edges.sort((a, b) => a.gap - b.gap);
      let links = 0;
      for (const edge of edges) {
        if (root(edge.i) === root(edge.j)) continue;
        let bridge = contactBridge(
            this,
            bodies[edge.i],
            bodies[edge.j],
            edge.limit,
          ),
          next = bridge.intersect(this.boundary);
        bridge.delete();
        bridge = next;
        for (let k = 0; k < this.balloons.length; k++)
          if (!indices.includes(k)) {
            next = bridge.subtract(this.balloons[k]);
            bridge.delete();
            bridge = next;
          }
        bridges.push(bridge);
        parent[root(edge.i)] = root(edge.j);
        links++;
        if (links === bodies.length - 1) break;
      }
      if (links !== bodies.length - 1)
        throw Error(
          "Merge requires touching or nearby balloons. Move the selected balloons closer together.",
        );
      result.delete();
      result = this.m.Manifold.union([...bodies, ...bridges]);
      this.assert(result, "Merge");
      if (!oneComponent(result))
        throw Error(
          "A connected merge could not fit between the walls and other balloons. Move the balloons closer.",
        );
      return result;
    } catch (err) {
      result.delete();
      throw err;
    } finally {
      bridges.forEach((s) => s.delete());
    }
  },
  merge(indices) {
    indices = [...new Set(indices)].sort((a, b) => a - b);
    if (indices.length < 2)
      throw Error("Select at least two balloons to merge.");
    indices.forEach((i) => this.requireEditable(i));
    const merged = this.mergedSolid(indices),
      keep = indices[0],
      members = indices
        .flatMap((i) => this.meta[i].members)
        .sort((a, b) => a - b),
      id = this.meta[keep].id;
    this.replaceEntity(keep, merged);
    this.meta[keep] = { id, members, frozen: false };
    for (const i of indices.slice(1).reverse()) this.removeEntity(i);
    this.refreshContacts();
    this.lastPop = null;
    return {
      ...this.snapshot(),
      selectedIndex: keep,
      message: `Merged ${indices.length} balloons into one connected volume. Internal contact surfaces removed.`,
    };
  },
  adoptLifecycle(previous, sourceEngine) {
    if (!previous?.meta?.length && !previous?.popped?.length)
      return this.snapshot();
    this.popped = [...(previous.popped || [])];
    this.popEvents = (previous.popEvents || []).map((event) => ({ ...event }));
    this.popStrength = previous.popStrength ?? 0.25;
    const frozen = previous.meta
        .map((meta, i) => ({ meta, i }))
        .filter((x) => x.meta.frozen),
      frozenMembers = new Set(frozen.flatMap((x) => x.meta.members));
    if (frozen.length)
      this.positionErrorTolerance = Math.max(
        this.positionErrorTolerance || 0,
        sourceEngine?.positionErrorTolerance || 0,
      );
    for (let i = this.meta.length - 1; i >= 0; i--)
      if (
        this.popped.includes(this.meta[i].members[0]) ||
        frozenMembers.has(this.meta[i].members[0])
      )
        this.removeEntity(i);
    for (const event of this.popEvents) this.applyPopEvent(event);
    for (const group of previous.meta.filter(
      (m) => !m.frozen && m.members.length > 1,
    )) {
      const ids = this.meta
        .map((m, i) =>
          group.members.some((v) => m.members.includes(v)) ? i : -1,
        )
        .filter((i) => i >= 0);
      if (ids.length > 1) {
        const merged = this.merge(ids);
        this.meta[merged.selectedIndex].id = group.id;
      }
    }
    for (const { meta, i } of frozen) {
      this.balloons.push(
        sourceEngine
          ? sourceEngine.balloons[i].translate([0, 0, 0])
          : this.toSolid(previous.balloons[i]),
      );
      this.base.push(
        sourceEngine
          ? sourceEngine.base[i].translate([0, 0, 0])
          : this.toSolid(previous.base[i]),
      );
      this.centers.push(previous.centers[i].slice());
      this.edits.push(previous.edits[i].slice());
      this.meta.push({ ...meta, members: meta.members.slice() });
    }
    // Frozen objects are obstacles. Fresh unfrozen geometry is trimmed around them.
    const fixed = this.meta
      .map((m, i) => (m.frozen ? i : -1))
      .filter((i) => i >= 0);
    for (const i of fixed) {
      const outside = this.balloons[i].subtract(this.boundary),
        v = outside.volume();
      outside.delete();
      if (
        v >
        this.allowedVolumeError(
          this.balloons[i],
          quantizationError(this.rawBoundary),
        )
      )
        throw Error(
          "The changed boundary would exclude a frozen balloon. Unfreeze it first.",
        );
    }
    for (let i = 0; i < this.balloons.length; i++)
      if (!this.meta[i].frozen) {
        let s = this.balloons[i].translate([0, 0, 0]);
        for (const j of fixed) {
          const next = s.subtract(this.balloons[j]);
          s.delete();
          s = next;
        }
        if (s.isEmpty()) {
          s.delete();
          throw Error(
            "Frozen balloons leave no room for this field. Change the seed or unfreeze them.",
          );
        }
        if (this.meta[i].members.length > 1 && !oneComponent(s)) {
          s.delete();
          throw Error(
            "A frozen balloon disconnects this merged group. Unfreeze it or reset the operations.",
          );
        }
        this.replaceEntity(i, s);
      }
    this.lastPop = null;
    return this.snapshot();
  },
};
