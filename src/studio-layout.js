import { inLoops, loopBounds } from "./zones.js";
export function clearLobbyOverrides(state, zone) {
  const outside=id=>Number(id)<zone*150 || Number(id)>=(zone+1)*150;
  const clean={...state};
  for(const key of ['edits','frozen','rotations']) clean[key]=Object.fromEntries(Object.entries(state[key]??{}).filter(([id])=>outside(id)));
  for(const key of ['popped','unclippedEdges','unclippedBottoms']) clean[key]=(state[key]??[]).filter(outside);
  clean.popEvents=(state.popEvents??[]).filter(e=>e.zone!==zone);
  return clean;
}
export function lobbyZone(loops, height = 12) {
  if (!Number.isFinite(height) || height < 1)
    throw Error("ENTER A HEIGHT LIMIT OF AT LEAST 1 FT.");
  const b = loopBounds(loops),
    mid = b.min.map((v, i) => (v + b.max[i]) / 2);
  let center = inLoops(mid, loops) ? mid : null,
    best = Infinity;
  if (!center)
    for (let j = 0; j < 40; j++)
      for (let i = 0; i < 40; i++) {
        const p = [
          b.min[0] + ((i + 0.5) * b.width) / 40,
          b.min[1] + ((j + 0.5) * b.height) / 40,
        ];
        const d = Math.hypot(p[0] - mid[0], p[1] - mid[1]);
        if (inLoops(p, loops) && d < best) {
          center = p;
          best = d;
        }
      }
  if (!center) throw Error("THIS ZONE IS TOO NARROW FOR A LOBBY BALLOON.");
  const rx =
    Math.max(...loops.flat().map((p) => Math.abs(p[0] - center[0]))) *
    Math.SQRT2 *
    1.02;
  const ry =
    Math.max(...loops.flat().map((p) => Math.abs(p[1] - center[1]))) *
    Math.SQRT2 *
    1.02;
  return {
    spatialType: "lobby",
    count: 1,
    selected: 1,
    index: 0,
    studioHeight: height,
    lobbyX: center[0],
    lobbyY: center[1],
    lobbyRX: rx,
    lobbyRY: ry,
    radiusMin: ry,
    radiusMax: ry,
  };
}
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
