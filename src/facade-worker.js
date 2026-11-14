import Module from "manifold-3d";
import wasmURL from "manifold-3d/manifold.wasm?url";
import { offsetWrap, facadeMesh, lowPolyWrap } from "./facade-wrap.js";

const ready = Module({ locateFile: () => wasmURL }).then((m) => {
  m.setup();
  return m;
});
let wrap;
self.onmessage = async ({ data }) => {
  try {
    const m = await ready;
    let mesh;
    if (data.floors) {
      const next = offsetWrap(m, data.floors, data.offset, data.resolution);
      wrap?.solid.delete();
      wrap = next;
      mesh = facadeMesh(wrap.solid);
    } else {
      if (!wrap) throw Error("Build the offset wrap first.");
      mesh = lowPolyWrap(m, wrap, data.target);
    }
    self.postMessage({ mesh }, [mesh.positions.buffer, mesh.indices.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
