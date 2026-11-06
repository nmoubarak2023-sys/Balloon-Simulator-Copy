// Produce one self-contained HTML file for simple GitHub Pages uploads.
// The regular Vite build and its source remain the primary development format.
import fs from "node:fs/promises";
const files = await fs.readdir("dist/assets");
const mainName = files.find((n) => /^index-.*\.js$/.test(n));
const workerName = files.find((n) => /^worker-.*\.js$/.test(n));
const wasmName = files.find((n) => /^manifold-.*\.wasm$/.test(n));
const cssName = files.find((n) => n.endsWith(".css"));
const dataURI = async (path, type) =>
  `data:${type};base64,${(await fs.readFile(path)).toString("base64")}`;
let main = await fs.readFile(`dist/assets/${mainName}`, "utf8");
let worker = await fs.readFile(`dist/assets/${workerName}`, "utf8");
worker = worker.replaceAll(
  wasmName,
  await dataURI(`dist/assets/${wasmName}`, "application/wasm"),
);
const workerExpr = `new URL(new URL(\`${workerName}\`,import.meta.url).href,\`\`+import.meta.url)`;
if (!main.includes(workerExpr))
  throw Error("Worker build structure changed; review standalone packaging.");
main = main.replaceAll(workerExpr, "embeddedWorkerURL");
const jsExpr = "new URL(`vendor/rhino3dm.js`,document.baseURI).href";
const wasmExpr = "new URL(`vendor/rhino3dm.wasm`,document.baseURI).href";
if (!main.includes(jsExpr) || !main.includes(wasmExpr))
  throw Error("Rhino build structure changed.");
main = main
  .replace(jsExpr, "embeddedRhinoURL")
  .replace(
    wasmExpr,
    JSON.stringify(
      await dataURI("dist/vendor/rhino3dm.wasm", "application/wasm"),
    ),
  );
const encode = (s) => Buffer.from(s).toString("base64");
const bootstrap = `const embeddedWorkerURL=URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(encode(worker))}),c=>c.charCodeAt(0))],{type:'text/javascript'}));\nconst embeddedRhinoURL=URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(encode(await fs.readFile("dist/vendor/rhino3dm.js", "utf8")))}),c=>c.charCodeAt(0))],{type:'text/javascript'}));\n`;
let html = await fs.readFile("dist/index.html", "utf8");
html = html.replace(
  /<script type="module"[^>]+src="[^"]+"[^>]*><\/script>/,
  () =>
    '<script type="module">' +
    (bootstrap + main).replace(/<\/script/gi, "<\\/script") +
    "</script>",
);
html = html.replace(
  /<link rel="stylesheet"[^>]+>/,
  "<style>" +
    (await fs.readFile(`dist/assets/${cssName}`, "utf8")) +
    "</style>",
);
await fs.writeFile("dist/standalone.html", html);
await fs.mkdir("standalone", { recursive: true });
await fs.writeFile("standalone/index.html", html);
await fs.copyFile(
  "THIRD_PARTY_NOTICES.md",
  "standalone/THIRD_PARTY_NOTICES.txt",
);
await fs.writeFile("standalone/.nojekyll", "");
console.log("Standalone website created: standalone/index.html");
