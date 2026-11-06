import { Matrix4, Vector3, Quaternion } from "three";

export function rotateClippingPlane(state, axis, degrees) {
  if (!["X", "Y", "Z"].includes(axis) || !Number.isFinite(degrees))
    throw Error("Choose an axis and enter finite degrees.");
  const direction = new Vector3(
    axis === "X" ? 1 : 0,
    axis === "Y" ? 1 : 0,
    axis === "Z" ? 1 : 0,
  );
  const rotation = new Quaternion().setFromAxisAngle(
    direction,
    ((degrees % 360) * Math.PI) / 180,
  );
  return {
    ...state,
    position: [...state.position],
    quaternion: new Quaternion()
      .fromArray(state.quaternion)
      .premultiply(rotation)
      .normalize()
      .toArray(),
  };
}

export function rotationMatrix(center, axis, degrees) {
  if (!["X", "Y", "Z"].includes(axis) || !Number.isFinite(degrees))
    throw Error("Choose a rotation axis and enter finite degrees.");
  const vector = new Vector3(
    axis === "X" ? 1 : 0,
    axis === "Y" ? 1 : 0,
    axis === "Z" ? 1 : 0,
  );
  const rotation = new Matrix4().makeRotationAxis(
    vector,
    ((degrees % 360) * Math.PI) / 180,
  );
  rotation.elements = rotation.elements.map((v) =>
    Math.abs(v) < 1e-14
      ? 0
      : Math.abs(v - 1) < 1e-14
        ? 1
        : Math.abs(v + 1) < 1e-14
          ? -1
          : v,
  );
  return new Matrix4()
    .makeTranslation(...center)
    .multiply(rotation)
    .multiply(new Matrix4().makeTranslation(...center.map((v) => -v)))
    .toArray();
}

export function transformMesh(raw, matrix) {
  const m = new Matrix4().fromArray(matrix),
    p = new Vector3(),
    positions = new Float32Array(raw.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    p.fromArray(raw.positions, i).applyMatrix4(m).toArray(positions, i);
  }
  return { positions, indices: new Uint32Array(raw.indices) };
}
export function uniformFactor(scale) {
  return scale.reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a), 1);
}
export function draggedEdit(previous, delta, ratio = 1, axisRatios = null) {
  if (
    !previous ||
    delta.some((v) => !Number.isFinite(v)) ||
    !Number.isFinite(ratio)
  )
    throw Error("Invalid canvas transform.");
  const edit = [
    ...delta.map((v, k) => previous[k] + v),
    Math.max(0.1, Math.min(3, previous[3] * ratio)),
  ];
  if (previous.length === 7 || axisRatios)
    for (let k = 0; k < 3; k++)
      edit.push(
        Math.max(
          0.1,
          Math.min(3, (previous[4 + k] ?? 1) * (axisRatios?.[k] ?? 1)),
        ),
      );
  return edit;
}
