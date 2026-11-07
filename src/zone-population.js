export function populateAllZones(params) {
  if (!params.boundary?.zones?.length)
    throw Error("Import a zoned floor outline first.");
  return {
    ...structuredClone(params),
    ...(params.unclippedBalloons ? {clipFloor:true} : {}),
    populatedZones: params.boundary.zones.map((_, i) => i),
  };
}
