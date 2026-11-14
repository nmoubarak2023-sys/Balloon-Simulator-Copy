import * as T from "three";

const vector = (raw, id) => new T.Vector3().fromArray(raw.positions, id * 3);

function fitPlane(points, initialNormal) {
  const center = new T.Vector3();
  for (const point of points) center.add(point);
  center.divideScalar(points.length);
  const offsets = points.map((point) => point.clone().sub(center));
  const trace = offsets.reduce((sum, point) => sum + point.lengthSq(), 0);
  const normal = initialNormal.clone().normalize();
  const next = new T.Vector3();
  for (let pass = 0; pass < 24; pass++) {
    next.copy(normal).multiplyScalar(trace);
    for (const offset of offsets)
      next.addScaledVector(offset, -offset.dot(normal));
    if (next.lengthSq() === 0) break;
    normal.copy(next.normalize());
  }
  return new T.Plane().setFromNormalAndCoplanarPoint(normal, center);
}

// Every panel uses the same angular and elevation joint planes as its neighbors.
function cutFace(plane, joints, gap, depth) {
  const cuts = joints.map((joint) => {
    const alignment = joint.normal.dot(plane.normal);
    const shift = gap / 2 + depth * Math.max(0, alignment);
    return joint.clone().translate(joint.normal.clone().multiplyScalar(shift));
  });
  const vertices = cuts.map((cut, i) => {
    const previous = cuts[(i + cuts.length - 1) % cuts.length];
    const cross = new T.Vector3().crossVectors(previous.normal, cut.normal);
    const determinant = plane.normal.dot(cross);
    if (Math.abs(determinant) < 1e-9) return null;
    return cross
      .multiplyScalar(-plane.constant)
      .addScaledVector(
        new T.Vector3().crossVectors(cut.normal, plane.normal),
        -previous.constant,
      )
      .addScaledVector(
        new T.Vector3().crossVectors(plane.normal, previous.normal),
        -cut.constant,
      )
      .divideScalar(determinant);
  });
  if (
    vertices.some(
      (v) => !v || cuts.some((cut) => cut.distanceToPoint(v) < -1e-7),
    )
  )
    return null;
  const normal = new T.Vector3().crossVectors(
    vertices[1].clone().sub(vertices[0]),
    vertices[2].clone().sub(vertices[0]),
  );
  if (normal.lengthSq() < 1e-14) return null;
  if (normal.dot(plane.normal) < 0) vertices.reverse();
  return vertices;
}

export function planarPanels(raw, settings) {
  const { columns, rows } = raw;
  const origin = new T.Vector3(...raw.center, 0);
  const point = (r, c) => vector(raw, r * columns + (c % columns));
  const angularJoint = (c, sign) => {
    const angle = (c * Math.PI * 2) / columns;
    return new T.Plane().setFromNormalAndCoplanarPoint(
      new T.Vector3(-Math.sin(angle) * sign, Math.cos(angle) * sign, 0),
      origin,
    );
  };
  const horizontalJoint = (r, sign) =>
    new T.Plane(new T.Vector3(0, 0, sign), -point(r, 0).z * sign);
  const fields = settings.adaptive ? raw.panelFields : null;
  const scoreAt = (row, col, turn) => {
    const id = row * columns + (col % columns);
    const curvature = Math.min(
      1,
      turn / (settings.pinchAngle ?? settings.curvature),
    );
    return (
      0.28 * curvature +
      0.22 * fields.deformation[id] +
      0.34 * fields.foldProximity[id] +
      0.16 * fields.featureProximity[id]
    );
  };
  const result = { panels: [], omitted: 0, exceptions: 0, deviation: 0 };
  const quadFits = [];
  const add = (plane, joints, key, deviation, exception) => {
    const vertices = cutFace(
      plane,
      joints,
      settings.gap,
      settings.thickness + settings.returns,
    );
    if (!vertices) {
      result.omitted++;
      return;
    }
    result.panels.push({ id: "P_" + key, vertices, normal: plane.normal });
    result.deviation = Math.max(result.deviation, deviation);
    if (exception) result.exceptions++;
    return result.panels.at(-1);
  };
  function seamIndex(
    start,
    end,
    acrossStart,
    acrossEnd,
    pointAt,
    vertical = false,
  ) {
    const middle = Math.floor((start + end) / 2);
    if (!settings.adaptive || end - start < 4) return middle;
    let best = middle,
      bestScore = 0;
    const margin = Math.ceil((end - start) * 0.25);
    for (let seam = start + margin; seam <= end - margin; seam++) {
      let turn = 0,
        peak = 0;
      for (let across = acrossStart; across <= acrossEnd; across++) {
        const p = pointAt(seam, across);
        const angle = p
          .clone()
          .sub(pointAt(seam - 1, across))
          .angleTo(pointAt(seam + 1, across).sub(p));
        const weight = fields
          ? scoreAt(vertical ? seam : across, vertical ? across : seam, angle)
          : angle;
        turn += weight;
        peak = Math.max(peak, weight);
      }
      const score =
        0.5 * peak +
        (0.5 * turn) / (acrossEnd - acrossStart + 1) -
        (0.3 * Math.abs(seam - middle)) / (end - start);
      if (score > bestScore) {
        best = seam;
        bestScore = score;
      }
    }
    return best;
  }
  function tile(r0, r1, c0, c1) {
    const a = point(r0, c0),
      b = point(r0, c1),
      c = point(r1, c1),
      d = point(r1, c0);
    const samples = [];
    let curvature = 0;
    const initial = new T.Vector3()
      .crossVectors(b.clone().sub(a), d.clone().sub(a))
      .normalize();
    const facet = new T.Vector3();
    let pinchWidth = 0;
    let pinchHeight = 0;
    let totalScore = 0;
    let peakScore = 0;
    for (let r = r0; r <= r1; r++) {
      for (let col = c0; col <= c1; col++) {
        const p = point(r, col);
        samples.push(p);
        const turnWidth =
          settings.adaptive && col > c0 && col < c1
            ? p
                .clone()
                .sub(point(r, col - 1))
                .angleTo(point(r, col + 1).sub(p))
            : 0;
        const turnHeight =
          settings.adaptive && r > r0 && r < r1
            ? p
                .clone()
                .sub(point(r - 1, col))
                .angleTo(point(r + 1, col).sub(p))
            : 0;
        pinchWidth = Math.max(pinchWidth, turnWidth);
        pinchHeight = Math.max(pinchHeight, turnHeight);
        if (fields) {
          const score = scoreAt(r, col, Math.max(turnWidth, turnHeight));
          totalScore += score;
          peakScore = Math.max(peakScore, score);
        }
        if (r < r1 && col < c1) {
          facet
            .crossVectors(point(r, col + 1).sub(p), point(r + 1, col).sub(p))
            .normalize();
          curvature = Math.max(curvature, facet.angleTo(initial));
        }
      }
    }
    const plane = fitPlane(samples, initial);
    const deviation = Math.max(
      ...samples.map((p) => Math.abs(plane.distanceToPoint(p))),
    );
    const width = Math.max(a.distanceTo(b), c.distanceTo(d));
    const height = Math.max(a.distanceTo(d), b.distanceTo(c));
    const u = c1 - c0,
      v = r1 - r0;
    const pinchThreshold = settings.pinchAngle ?? settings.curvature * 0.35;
    const refinementThreshold = pinchThreshold * (settings.balanced ? 1.6 : 1);
    const pinchedWidth = pinchWidth > refinementThreshold;
    const pinchedHeight = pinchHeight > refinementThreshold;
    // Broad folds can use a coarser planar approximation. Keep the original
    // fit target in tight folds and in the panel diagnostics.
    const fitAllowance =
      pinchedWidth || pinchedHeight ? 1 : (settings.calmFit ?? 1);
    const detail =
      deviation >
      settings.deviation * fitAllowance * (settings.balanced ? 1.8 : 1);
    const refineWidth =
      (settings.refineFit && detail) ||
      (settings.adaptive && (pinchedWidth || (detail && !pinchedHeight)));
    const refineHeight =
      (settings.refineFit && detail) ||
      (settings.adaptive && (pinchedHeight || (detail && !pinchedWidth)));
    const densityFactor = Math.max(1, settings.density / 0.6);
    const subdivision = fields
      ? 0.55 * peakScore + (0.45 * totalScore) / samples.length
      : 0;
    const blend = settings.balanced
      ? 0.45 * T.MathUtils.smoothstep(totalScore / samples.length, 0.15, 0.55)
      : T.MathUtils.smoothstep(subdivision, 0.12, 0.62);
    const widthLimit = T.MathUtils.lerp(
      settings.maxWidth / densityFactor,
      Math.min(settings.maxWidth / densityFactor, 2 * settings.minWidth),
      blend,
    );
    const heightLimit = T.MathUtils.lerp(
      settings.maxHeight / densityFactor,
      Math.min(settings.maxHeight / densityFactor, 2 * settings.minHeight),
      blend,
    );
    const splitWidth =
      u > 1 &&
      (width > widthLimit ||
        (refineWidth && width >= 2 * settings.minWidth) ||
        u > settings.span);
    const splitHeight =
      v > 1 &&
      (height > heightLimit ||
        (refineHeight && height >= 2 * settings.minHeight) ||
        v > settings.span);
    if (
      splitWidth &&
      (!splitHeight ||
        width / widthLimit + pinchWidth / pinchThreshold >=
          height / heightLimit + pinchHeight / pinchThreshold)
    ) {
      const mid = seamIndex(c0, c1, r0, r1, (col, row) => point(row, col));
      tile(r0, r1, c0, mid);
      tile(r0, r1, mid, c1);
      return;
    }
    if (splitHeight) {
      const mid = seamIndex(r0, r1, c0, c1, point, true);
      tile(r0, mid, c0, c1);
      tile(mid, r1, c0, c1);
      return;
    }
    const joints = [
      angularJoint(c0, 1),
      horizontalJoint(r0, 1),
      angularJoint(c1, -1),
      horizontalJoint(r1, -1),
    ];
    const key = [r0, r1, c0, c1].join("_");
    const sizeException =
      width < settings.minWidth ||
      width > settings.maxWidth ||
      height < settings.minHeight ||
      height > settings.maxHeight;
    const triangles =
      settings.mode === "tri" ||
      (settings.mode === "hybrid" &&
        detail &&
        deviation > settings.deviation &&
        curvature > settings.curvature);
    if (!triangles) {
      const panel = add(
        plane,
        joints,
        key,
        deviation,
        sizeException ||
          deviation > settings.deviation ||
          curvature > settings.curvature,
      );
      if (panel && raw.creaseRows)
        quadFits.push({
          panel,
          plane,
          joints,
          samples,
          deviation,
          sizeException,
          r0,
          r1,
          c0,
          c1,
        });
      return;
    }
    // Both triangles meet at one diagonal joint plane, including at the reveal.
    const makePair = (p, q, side, pair) => {
      const diagonal = new T.Plane().setFromCoplanarPoints(
        p,
        q,
        p.clone().add(initial),
      );
      if (diagonal.distanceToPoint(side) < 0) diagonal.negate();
      return pair.map(([corners, sides], index) => {
        const seams = [index ? diagonal.clone().negate() : diagonal, ...sides];
        const plane = new T.Plane().setFromCoplanarPoints(...corners);
        const error = samples.reduce(
          (max, point) =>
            seams.every((seam) => seam.distanceToPoint(point) >= -1e-7)
              ? Math.max(max, Math.abs(plane.distanceToPoint(point)))
              : max,
          0,
        );
        const fits = !!cutFace(
          plane,
          seams,
          settings.gap,
          settings.thickness + settings.returns,
        );
        return { plane, seams, error, fits };
      });
    };
    const pairs = [
      makePair(a, c, b, [
        [
          [a, b, c],
          [joints[1], joints[2]],
        ],
        [
          [a, c, d],
          [joints[3], joints[0]],
        ],
      ]),
      makePair(b, d, a, [
        [
          [a, b, d],
          [joints[0], joints[1]],
        ],
        [
          [b, c, d],
          [joints[2], joints[3]],
        ],
      ]),
    ];
    const score = (pair) =>
      pair.filter((panel) => !panel.fits).length * 1e9 +
      Math.max(...pair.map((panel) => panel.error));
    const chosen = score(pairs[0]) <= score(pairs[1]) ? pairs[0] : pairs[1];
    chosen.forEach(({ plane, seams, error }, index) => {
      add(
        plane,
        seams,
        key + (index ? "B" : "A"),
        error,
        sizeException || error > settings.deviation,
      );
    });
  }
  const creaseRows = new Set(raw.creaseRows ?? []);
  const bands = [0, ...creaseRows, rows - 1];
  for (let i = 1; i < bands.length; i++)
    for (let c = 0; c < columns; c += Math.ceil(columns / 4))
      tile(
        bands[i - 1],
        bands[i],
        c,
        Math.min(columns, c + Math.ceil(columns / 4)),
      );

  // Ease adjacent quad normals within each continuous band. Recut the
  // planar faces against the original joints, and limit the fit tradeoff.
  const overlaps = (a0, a1, b0, b1) => Math.min(a1, b1) > Math.max(a0, b0);
  for (const fit of quadFits) {
    const target = fit.plane.normal.clone();
    let count = 0;
    for (const other of quadFits) {
      const side =
        (fit.c0 === other.c1 % columns || fit.c1 % columns === other.c0) &&
        overlaps(fit.r0, fit.r1, other.r0, other.r1);
      const above = fit.r1 === other.r0 && !creaseRows.has(fit.r1);
      const below = fit.r0 === other.r1 && !creaseRows.has(fit.r0);
      const stacked =
        (above || below) && overlaps(fit.c0, fit.c1, other.c0, other.c1);
      if (
        fit === other ||
        !(side || stacked) ||
        fit.plane.normal.dot(other.plane.normal) < 0.5
      )
        continue;
      target.add(other.plane.normal);
      count++;
    }
    if (!count) continue;
    const normal = fit.plane.normal
      .clone()
      .lerp(target.normalize(), 0.2)
      .normalize();
    const center = fit.samples
      .reduce((sum, p) => sum.add(p), new T.Vector3())
      .divideScalar(fit.samples.length);
    const plane = new T.Plane().setFromNormalAndCoplanarPoint(normal, center);
    const error = fit.samples.reduce(
      (max, p) => Math.max(max, Math.abs(plane.distanceToPoint(p))),
      0,
    );
    const ceiling = Math.max(settings.deviation, fit.deviation);
    if (error > ceiling + 1e-8) continue;
    const vertices = cutFace(
      plane,
      fit.joints,
      settings.gap,
      settings.thickness + settings.returns,
    );
    if (!vertices) continue;
    fit.panel.vertices = vertices;
    fit.panel.normal = normal;
    result.deviation = Math.max(result.deviation, error);
    if (
      !fit.sizeException &&
      fit.deviation > settings.deviation &&
      error <= settings.deviation
    )
      result.exceptions--;
  }
  return result;
}

export function panelParts(panel, thickness, returns) {
  const front = panel.vertices;
  const back = front.map((point) =>
    point.clone().addScaledVector(panel.normal, -thickness),
  );
  const lip = back.map((point) =>
    point.clone().addScaledVector(panel.normal, -returns),
  );
  const faces = [front, [...back].reverse()];
  const flanges = [];
  for (let i = 0; i < front.length; i++) {
    const j = (i + 1) % front.length;
    faces.push([front[j], front[i], back[i], back[j]]);
    if (returns > 0) flanges.push([back[j], back[i], lip[i], lip[j]]);
  }
  return {
    faces,
    flanges,
    rail: lip.map((point) =>
      point.clone().addScaledVector(panel.normal, -0.15),
    ),
  };
}
