import { mkdir, copyFile } from "node:fs/promises";
await mkdir("public/vendor", { recursive: true });
for (const name of ["rhino3dm.js", "rhino3dm.wasm"])
  await copyFile(`node_modules/rhino3dm/${name}`, `public/vendor/${name}`);
