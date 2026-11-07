export function readBoundaryCurves(r, bytes) {
  const doc = r.File3dm.fromByteArray(bytes);
  if (!doc) throw Error("Could not read the Rhino .3dm file.");
  try {
    const unit = doc.settings().modelUnitSystem;
    const values = {
      Feet: 1,
      Inches: 1 / 12,
      Yards: 3,
      Miles: 5280,
      Millimeters: 1 / 304.8,
      Centimeters: 1 / 30.48,
      Decimeters: 1 / 3.048,
      Meters: 1 / 0.3048,
      Kilometers: 1000 / 0.3048,
    };
    const unitName = Object.keys(values).find(
      (name) =>
        (r.UnitSystem[name]?.value ?? r.UnitSystem[name]) ===
        (unit?.value ?? unit),
    );
    if (!unitName)
      throw Error(
        "Set model units to feet, inches, yards, miles, millimeters, centimeters, decimeters, meters or kilometers in Rhino.",
      );
    let curveTolerance = 0;
    const scale = values[unitName],
      objects = doc.objects(),
      curves = [],
      all = [];
    for (let i = 0; i < objects.count; i++) {
      const object = objects.get(i),
        g = object.geometry();
      try {
        if (!(g instanceof r.Curve)) continue;
        let points = [];
        const poly = g.tryGetPolyline();
        if (poly?.[0] && poly[1]) {
          const line = poly[1];
          try {
            points = Array.from({ length: line.count }, (_, j) =>
              line.get(j).map((v) => v * scale),
            );
          } finally {
            line.delete();
          }
        } else {
          const [a, b] = g.domain,
            at = (t) => g.pointAt(t).map((v) => v * scale),
            seed = Array.from({ length: 17 }, (_, j) =>
              at(a + ((b - a) * j) / 16),
            );
          const span = Math.max(
            ...[0, 1].map(
              (k) =>
                Math.max(...seed.map((p) => p[k])) -
                Math.min(...seed.map((p) => p[k])),
            ),
          );
          const error = Math.max(0.005, span * 0.0003);
          curveTolerance = Math.max(curveTolerance, error);
          const distance = (p, u, v) => {
            const d = v.map((x, k) => x - u[k]),
              length = d.reduce((s, x) => s + x * x, 0),
              t = length
                ? Math.max(
                    0,
                    Math.min(
                      1,
                      p.reduce((s, x, k) => s + (x - u[k]) * d[k], 0) / length,
                    ),
                  )
                : 0;
            return Math.hypot(...p.map((x, k) => x - u[k] - t * d[k]));
          };
          function sample(t0, t1, p0, p1, depth = 0) {
            const dt = t1 - t0,
              mid = at(t0 + dt * 0.5),
              q1 = at(t0 + dt * 0.25),
              q3 = at(t0 + dt * 0.75);
            if (
              depth < 9 &&
              Math.max(
                distance(mid, p0, p1),
                distance(q1, p0, p1),
                distance(q3, p0, p1),
              ) > error
            ) {
              sample(t0, t0 + dt * 0.5, p0, mid, depth + 1);
              sample(t0 + dt * 0.5, t1, mid, p1, depth + 1);
            } else points.push(p0);
          }
          for (let j = 0; j < 16; j++)
            sample(
              a + ((b - a) * j) / 16,
              a + ((b - a) * (j + 1)) / 16,
              seed[j],
              seed[j + 1],
            );
          points.push(seed.at(-1));
        }
        if (points.length > 4096)
          throw Error(
            "A boundary curve is too detailed. Simplify it in Rhino.",
          );
        const closed = !!g.isClosed;
        if (
          closed &&
          points.length > 2 &&
          Math.hypot(...points[0].map((v, k) => v - points.at(-1)[k])) < 1e-5
        )
          points.pop();
        if (all.length + points.length > 6000)
          throw Error(
            "Boundary curves contain too many segments. Simplify them in Rhino.",
          );
        all.push(...points);
        curves.push({ closed, points });
      } finally {
        g.delete();
        object.delete();
      }
    }
    if (!curves.length)
      throw Error(
        "No curve objects found. Export the perimeter and divider curves as a .3dm file.",
      );
    const elevation = all[0][2],
      span = Math.max(
        1,
        ...all.map(
          (p) => Math.abs(p[0] - all[0][0]) + Math.abs(p[1] - all[0][1]),
        ),
      );
    if (
      all.some((p) => Math.abs(p[2] - elevation) > Math.max(0.001, span * 1e-6))
    )
      throw Error(
        "Floor curves must lie on one horizontal plane. Use SetPt Z in Rhino to align them.",
      );
    // Connect true Rhino endpoints to the sampled curve within the chord error.
    // This avoids gaps when a divider meets a NURBS edge between sample points.
    if (curveTolerance > 0)
      for (const curve of curves)
        if (!curve.closed)
          for (const index of [0, curve.points.length - 1]) {
            const p = curve.points[index];
            let best = null,
              distance = curveTolerance * 1.2;
            for (const other of curves)
              if (other !== curve)
                for (
                  let j = 0;
                  j < other.points.length - (other.closed ? 0 : 1);
                  j++
                ) {
                  const a = other.points[j],
                    b = other.points[(j + 1) % other.points.length],
                    dx = b[0] - a[0],
                    dy = b[1] - a[1],
                    den = dx * dx + dy * dy;
                  if (!den) continue;
                  const t = Math.max(
                      0,
                      Math.min(
                        1,
                        ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / den,
                      ),
                    ),
                    q = [a[0] + t * dx, a[1] + t * dy, elevation],
                    d = Math.hypot(p[0] - q[0], p[1] - q[1]);
                  if (d < distance) {
                    distance = d;
                    best = q;
                  }
                }
            if (best) curve.points[index] = best;
          }
    return {
      curves: curves.map((c) => ({
        ...c,
        points: c.points.map((p) => p.slice(0, 2)),
      })),
      elevation,
      unitName,
    };
  } finally {
    doc.delete();
  }
}
