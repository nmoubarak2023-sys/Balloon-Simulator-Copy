export function populateAllZones(params) {
  if (!params.boundary?.zones?.length)
    throw Error("Import a zoned floor outline first.");
  return {
    ...structuredClone(params),
    ...(params.unclippedBalloons ? { clipFloor: true } : {}),
    populatedZones: params.boundary.zones.map((_, i) => i),
  };
}

// Start a manual zone-by-zone model without carrying forward geometry or
// per-balloon overrides from a previously automatic population. The caller
// retains the original snapshot as an undo checkpoint.
export function resetZonePopulation(snapshot) {
  if (!snapshot?.params?.boundary) return snapshot;
  const lifecycle = {
    edits: {},
    frozen: {},
    popped: [],
    popEvents: [],
    rotations: {},
    unclippedEdges: [],
    unclippedBottoms: [],
  };
  return {
    ...snapshot,
    params: {
      ...snapshot.params,
      ...lifecycle,
      directCells: true,
      populatedZones: [],
    },
    editing: {
      ...snapshot.editing,
      ...lifecycle,
      selectedId: 0,
      tool: "orbit",
    },
    result: null,
    stage: 0,
    resetStepMenu: true,
    view: { ...snapshot.view, showAllZones: true },
  };
}
