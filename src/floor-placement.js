// Move an older single-floor save to the destination elevation without changing its shape.
export function placeSavedFloor(data, elevation) {
  const copy = structuredClone(data);
  const params = copy.result?.params ?? copy.params;
  const delta = elevation - (params.floor ?? 0);
  if (!Number.isFinite(delta)) throw Error("Invalid floor elevation.");
  const shifted = new WeakSet();
  function point(p) {
    if (
      Array.isArray(p) &&
      p.length === 3 &&
      p.every(Number.isFinite) &&
      !shifted.has(p)
    ) {
      shifted.add(p);
      p[2] += delta;
    }
  }
  function raw(mesh) {
    if (!mesh?.positions || shifted.has(mesh.positions)) return;
    shifted.add(mesh.positions);
    for (let i = 2; i < mesh.positions.length; i += 3)
      mesh.positions[i] += delta;
  }
  function curves(list) {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (
        Array.isArray(item) &&
        item.length === 3 &&
        item.every(Number.isFinite)
      )
        point(item);
      else curves(item);
    }
  }
  function state(s) {
    if (!s) return;
    curves(s.curves);
    for (const f of Object.values(s.frozen ?? {})) {
      point(f.center);
      raw(f.raw);
    }
    for (const event of s.popEvents ?? []) point(event.center);
  }
  params.floor += delta;
  if (params.boundary)
    params.boundary.elevation = (params.boundary.elevation ?? 0) + delta;
  if (params.domain)
    params.domain.elevation = (params.domain.elevation ?? 0) + delta;
  state(params);
  state(copy.editing);
  const result = copy.result;
  if (result) {
    raw(result.raw);
    for (const z of result.zones ?? []) raw(z.raw);
    for (const sphere of result.spheres ?? []) {
      point(sphere.center);
      raw(sphere.raw);
    }
  }
  return copy;
}
