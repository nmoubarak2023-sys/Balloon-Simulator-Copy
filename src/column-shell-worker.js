import Module from "manifold-3d";
import wasmURL from "manifold-3d/manifold.wasm?url";
import { buildColumnShell } from "./column-shell.js";

const ready = Module({ locateFile: () => wasmURL }).then((m) => {
  m.setup();
  return m;
});

self.onmessage = async ({ data: { raw, thickness } }) => {
  try {
    const shell = buildColumnShell(await ready, raw, thickness);
    self.postMessage({ raw: shell }, [
      shell.positions.buffer,
      shell.indices.buffer,
    ]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
