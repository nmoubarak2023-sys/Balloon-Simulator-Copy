export function populateAllZones(params) {
  if (!params.boundary?.zones?.length)
    throw Error("Import a zoned floor outline first.");
  return {
    ...structuredClone(params),
    populatedZones: params.boundary.zones.map((_, i) => i),
  };
}
