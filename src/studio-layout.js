import { inLoops, loopBounds } from "./zones.js";
export function studioLayout(
  loops,
  { studioAngle = 0, studioBay = 20, studioElongation = 2 } = {},
) {
  if (
    ![studioAngle, studioBay, studioElongation].every(Number.isFinite) ||
    studioBay < 2 ||
    studioElongation < 1 ||
    studioElongation > 4
  )
    throw Error(
      "USE A BAY SPACING OF AT LEAST 2 FT AND ELONGATION BETWEEN 1 AND 4.",
    );
  const a = (studioAngle * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a),
    b = loopBounds(loops),
    cx = (b.min[0] + b.max[0]) / 2,
    cy = (b.min[1] + b.max[1]) / 2;
  const local = loops
    .flat()
    .map(([x, y]) => [
      (x - cx) * c + (y - cy) * s,
      -(x - cx) * s + (y - cy) * c,
    ]);
  const us = local.map((p) => p[0]),
    vs = local.map((p) => p[1]),
    minU = Math.min(...us),
    maxU = Math.max(...us),
    minV = Math.min(...vs),
    maxV = Math.max(...vs);
  const nu = Math.max(
      1,
      Math.ceil((maxU - minU) / (studioBay * studioElongation)),
    ),
    nv = Math.max(1, Math.ceil((maxV - minV) / studioBay));
  if (nu * nv > 10000) throw Error("INCREASE BAY SPACING.");
  const points = [];
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const u = minU + ((i + 0.5) * (maxU - minU)) / nu,
        v = minV + ((j + 0.5) * (maxV - minV)) / nv,
        p = [cx + u * c - v * s, cy + u * s + v * c];
      if (inLoops(p, loops)) points.push(p);
    }
  if (!points.length)
    throw Error("NO BAYS FIT THIS ZONE. REDUCE SPACING OR CHANGE DIRECTION.");
  if (points.length > 150) throw Error("MORE THAN 150 BAYS. INCREASE SPACING.");
  return points;
}
