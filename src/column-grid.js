import { findSupportSites } from "./boolean-supports.js";

export function gridBounds(raw) {
  const min = [Infinity, Infinity],
    max = [-Infinity, -Infinity];
  for (let i = 0; i < raw.positions.length; i += 3)
    for (let k = 0; k < 2; k++) {
      min[k] = Math.min(min[k], raw.positions[i + k]);
      max[k] = Math.max(max[k], raw.positions[i + k]);
    }
  return { min, max };
}
export function chooseGridCollisions(
  sites,
  bounds,
  spacing = 30,
  distance = 5,
) {
  if (!Number.isFinite(spacing) || spacing < 10 || spacing > 50)
    throw Error("USE GRID SPACING FROM 10 TO 50 FT.");
  if (!Number.isFinite(distance) || distance < 1 || distance > 25)
    throw Error("USE COLLISION SEARCH DISTANCE FROM 1 TO 25 FT.");
  const pairs = [];
  sites.forEach((site, index) => {
    for (
      let j = Math.ceil((site.y - distance) / spacing);
      j <= Math.floor((site.y + distance) / spacing);
      j++
    )
      for (
        let i = Math.ceil((site.x - distance) / spacing);
        i <= Math.floor((site.x + distance) / spacing);
        i++
      ) {
        const x = i * spacing,
          y = j * spacing;
        if (
          x < bounds.min[0] ||
          x > bounds.max[0] ||
          y < bounds.min[1] ||
          y > bounds.max[1]
        )
          continue;
        const d = Math.hypot(site.x - x, site.y - y);
        if (d <= distance) pairs.push({ index, i, j, d });
      }
  });
  pairs.sort(
    (a, b) => a.d - b.d || a.j - b.j || a.i - b.i || a.index - b.index,
  );
  const usedSites = new Set(),
    usedTargets = new Set(),
    chosen = [];
  for (const { index, i, j, d } of pairs) {
    const target = i + ":" + j;
    if (usedSites.has(index) || usedTargets.has(target)) continue;
    usedSites.add(index);
    usedTargets.add(target);
    chosen.push({
      ...sites[index],
      grid: [i, j],
      gridTarget: [i * spacing, j * spacing],
      gridDistance: d,
    });
  }
  return chosen.sort((a, b) => a.grid[1] - b.grid[1] || a.grid[0] - b.grid[0]);
}
export function columnGridSites(source, spacing = 30, distance = 5) {
  return chooseGridCollisions(
    findSupportSites(source, false),
    gridBounds(source.raw),
    spacing,
    distance,
  );
}
