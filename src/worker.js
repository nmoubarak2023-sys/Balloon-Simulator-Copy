import Module from "manifold-3d";
import wasmURL from "manifold-3d/manifold.wasm?url";
import { BalloonEngine } from "./engine.js";
import { GeometryHistory } from "./history.js";
import { precisionOutput } from "./precision-client.js";
import { voronoiBuild } from "./voronoi-engine.js";
let engine;
let cachedOutput;
const history = new GeometryHistory(20);
const ready = Module({ locateFile: () => wasmURL }).then((m) => {
  m.setup();
  engine = new BalloonEngine(m);
});
self.onmessage = async ({ data }) => {
  const { id, action } = data;
  try {
    await ready;
    let result;
    if (action === "voronoi") {
      result = voronoiBuild(engine.m, data.params);
    } else if (action === "generate" || action === "restore") {
      const next = new BalloonEngine(engine.m);
      try {
        result =
          action === "restore" && data.session
            ? next.loadSession(data.session)
            : action === "restore"
              ? next.restore(data.boundary, data.params, data.curve, data.edits)
              : next.generate(
                  data.boundary,
                  data.params,
                  data.curve,
                  (value, text) => postMessage({ id, progress: value, text }),
                );
        if (action === "generate" && data.preserve !== false && engine.boundary)
          result = next.adoptLifecycle(engine.session(), engine);
      } catch (err) {
        next.clear();
        throw err;
      }
      engine = data.undoRestore
        ? history.replace(engine, next)
        : history.commit(engine, next, action);
    } else if (
      ["pop", "freeze", "merge", "popPressure", "edit"].includes(action)
    ) {
      const next = engine.fork();
      try {
        result =
          action === "edit"
            ? next.edit(data.index, data.edit)
            : action === "pop"
              ? next.pop(data.index, data.strength)
              : action === "freeze"
                ? next.freeze(data.index)
                : action === "merge"
                  ? next.merge(data.indices)
                  : next.changePopPressure(data.strength);
      } catch (err) {
        next.clear();
        throw err;
      }
      engine = history.commit(engine, next, action);
    } else if (action === "undo") {
      engine = history.undo(engine);
      result = engine.snapshot();
    } else if (action === "output") {
      const key = JSON.stringify([
        data.mode,
        data.tolerance,
        data.quality || "final",
        data.resolution || 160,
      ]);
      if (cachedOutput?.engine === engine && cachedOutput.key === key)
        result = cachedOutput.result;
      else {
        result =
          data.quality === "precision" && data.mode !== "shell"
            ? await precisionOutput(
                engine,
                data.tolerance,
                (progress, text, nativeJobId) =>
                  postMessage({ id, progress, text, nativeJobId }),
              )
            : engine.output(
                data.mode,
                data.tolerance,
                data.quality || "final",
                (progress, text) => postMessage({ id, progress, text }),
                data.resolution || 160,
              );
        cachedOutput = { engine, key, result };
      }
    } else throw Error("Unknown operation");
    postMessage({
      id,
      result: { ...result, historyDepth: history.past.length },
    });
  } catch (error) {
    postMessage({ id, error: error.message });
  }
};
