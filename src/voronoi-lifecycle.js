export function validateVoronoiLifecycle(p) {
  const ids = p.popped ?? [],
    frozen = p.frozen ?? {},
    events = p.popEvents ?? [];
  const validId = (id) =>
    Number.isInteger(Number(id)) && Number(id) >= 0 && Number(id) < 3000;
  if (
    !Array.isArray(ids) ||
    ids.some((id) => !Number.isInteger(id) || !validId(id)) ||
    new Set(ids).size !== ids.length
  )
    throw Error("Invalid popped balloon state.");
  if (
    !frozen ||
    typeof frozen !== "object" ||
    Array.isArray(frozen) ||
    Object.entries(frozen).some(
      ([id, s]) =>
        !validId(id) ||
        !s ||
        !Array.isArray(s.center) ||
        s.center.length !== 3 ||
        !s.center.every(Number.isFinite) ||
        !Number.isFinite(s.radius) ||
        s.radius <= 0 ||
        !Array.isArray(s.axisScale) ||
        s.axisScale.length !== 3 ||
        s.axisScale.some((v) => !Number.isFinite(v) || v <= 0),
    )
  )
    throw Error("Invalid frozen balloon state.");
  for (const s of Object.values(frozen))
    if (s.raw) {
      const { positions: a, indices: b } = s.raw;
      if (
        !a ||
        !b ||
        a.length < 12 ||
        a.length > 900000 ||
        a.length % 3 ||
        b.length < 12 ||
        b.length % 3 ||
        b.length > 900000 ||
        Array.from(a).some((v) => !Number.isFinite(v)) ||
        Array.from(b).some(
          (i) => !Number.isInteger(i) || i < 0 || i >= a.length / 3,
        )
      )
        throw Error("Invalid frozen balloon mesh.");
    }
  if (
    !Array.isArray(events) ||
    events.length > 3000 ||
    events.some(
      (e) =>
        !Array.isArray(e.center) ||
        e.center.length !== 3 ||
        !e.center.every(Number.isFinite) ||
        !Number.isFinite(e.radius) ||
        e.radius <= 0,
    )
  )
    throw Error("Invalid pop pressure state.");
  if (
    p.popPressure !== undefined &&
    (!Number.isFinite(p.popPressure) || p.popPressure < 0 || p.popPressure > 1)
  )
    throw Error("Pop pressure must be between 0 and 1.");
}
