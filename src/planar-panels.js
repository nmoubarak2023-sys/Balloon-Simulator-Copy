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
  const result = { panels: [], omitted: 0, exceptions: 0, deviation: 0 };
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
  };
  function seamIndex(start, end, acrossStart, acrossEnd, pointAt) {
    const middle = Math.floor((start + end) / 2);
    if (!settings.adaptive || end - start < 4) return middle;
    let best = middle,
      bestScore = 0;
    const margin = Math.ceil((end - start) * 0.25);
    for (let seam = start + margin; seam <= end - margin; seam++) {
      let turn = 0, peak = 0;
      for (let across = acrossStart; across <= acrossEnd; across++) {
        const p = pointAt(seam, across);
        const angle = p
          .clone()
          .sub(pointAt(seam - 1, across))
          .angleTo(pointAt(seam + 1, across).sub(p));
        turn += angle;
        peak = Math.max(peak, angle);
      }
      const score =
        0.5 * peak + 0.5 * turn / (acrossEnd - acrossStart + 1) -
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
    for (let r = r0; r <= r1; r++) {
      for (let col = c0; col <= c1; col++) {
        const p = point(r, col);
        samples.push(p);
        if (settings.adaptive && col > c0 && col < c1) {
          pinchWidth = Math.max(pinchWidth,
            p.clone().sub(point(r, col - 1)).angleTo(point(r, col + 1).sub(p)));
        }
        if (settings.adaptive && r > r0 && r < r1) {
          pinchHeight = Math.max(pinchHeight,
            p.clone().sub(point(r - 1, col)).angleTo(point(r + 1, col).sub(p)));
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
    const pinchedWidth = pinchWidth > pinchThreshold;
    const pinchedHeight = pinchHeight > pinchThreshold;
    // Broad folds can use a coarser planar approximation. Keep the original
    // fit target in tight folds and in the panel diagnostics.
    const fitAllowance = pinchedWidth || pinchedHeight ? 1 : (settings.calmFit ?? 1);
    const detail = deviation > settings.deviation * fitAllowance;
    const refineWidth = settings.adaptive && (pinchedWidth || (detail && !pinchedHeight));
    const refineHeight = settings.adaptive && (pinchedHeight || (detail && !pinchedWidth));
    const densityFactor = Math.max(1, settings.density / 0.6);
    const widthLimit = settings.maxWidth / densityFactor;
    const heightLimit = settings.maxHeight / densityFactor;
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
      (!splitHeight || width / widthLimit + pinchWidth / pinchThreshold >=
        height / heightLimit + pinchHeight / pinchThreshold)
    ) {
      const mid = seamIndex(c0, c1, r0, r1, (col, row) => point(row, col));
      tile(r0, r1, c0, mid);
      tile(r0, r1, mid, c1);
      return;
    }
    if (splitHeight) {
      const mid = seamIndex(r0, r1, c0, c1, point);
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
      add(
        plane,
        joints,
        key,
        deviation,
        sizeException ||
          deviation > settings.deviation ||
          curvature > settings.curvature,
      );
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
  for (let c = 0; c < columns; c += Math.floor(columns / 4))
    tile(0, rows - 1, c, Math.min(columns, c + Math.floor(columns / 4)));
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
