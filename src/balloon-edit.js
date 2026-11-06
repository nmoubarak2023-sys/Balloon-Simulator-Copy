export function validBalloonEdit(edit) {
  return (
    Array.isArray(edit) &&
    [4, 7].includes(edit.length) &&
    edit.every(Number.isFinite) &&
    edit.slice(3).every((v) => v >= 0.1 && v <= 3)
  );
}
export function expandedEdit(edit) {
  return [...edit.slice(0, 4), edit[4] ?? 1, edit[5] ?? 1, edit[6] ?? 1];
}
export function editScale(edit) {
  return [0, 1, 2].map((k) => edit[3] * (edit[4 + k] ?? 1));
}
export function scaleAxisEdit(edit, axis, factor) {
  if (
    ![0, 1, 2].includes(axis) ||
    !Number.isFinite(factor) ||
    factor < 0.1 ||
    factor > 3
  )
    throw Error("Choose X, Y or Z and a factor between 0.1 and 3.");
  const next = expandedEdit(edit);
  next[4 + axis] = factor;
  return next;
}
