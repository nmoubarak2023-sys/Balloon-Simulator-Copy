import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const stateFile = ".local-runtime/server.json";
const explicitPort = process.argv[2] ? Number(process.argv[2]) : undefined;
if (explicitPort !== undefined &&
    (!Number.isInteger(explicitPort) || explicitPort < 1024 || explicitPort > 65525))
  throw Error("Use a port between 1024 and 65525.");

function openBrowser(url) {
  if (process.env.BALLOON_NO_BROWSER === "1") return;
  const browser = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  browser.on("error", () => console.log("Open " + url + " in your browser."));
  browser.unref();
}

async function remember(port) {
  await mkdir(".local-runtime", { recursive: true });
  await writeFile(stateFile, JSON.stringify({ port }));
}

async function main() {
  let preferred = 5183;
  try {
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    if (Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65525)
      preferred = saved.port;
  } catch {
    // The first launch uses the original local address.
  }
  preferred = explicitPort ?? preferred;
  await access("node_modules/vite/bin/vite.js").catch(() => {
    throw Error("Project dependencies are missing. Keep node_modules with this local project.");
  });
  await import("./prepare-vendor.js");
  const { createServer } = await import("vite");

  for (let port = preferred; port < preferred + 10; port++) {
    const url = "http://127.0.0.1:" + port + "/";
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const html = await response.text();
      if (response.ok && html.includes("<title>Balloon Build")) {
        await remember(port);
        console.log("The website is already running at " + url);
        openBrowser(url);
        return;
      }
    } catch {
      // Try starting the project if the current port is not responding.
    }
    const server = await createServer({
      clearScreen: false,
      server: { host: "127.0.0.1", port, strictPort: true },
    });
    try {
      await server.listen();
    } catch (error) {
      await server.close();
      if (!/already in use|EADDRINUSE/.test(error.message)) throw error;
      console.log("Port " + port + " is occupied. Trying the next port.");
      continue;
    }
    await remember(port);
    if (port !== preferred)
      console.log("The new address has separate browser autosaves. Previous saves remain at the old address.");
    console.log("\nWebsite ready at " + url);
    console.log("Keep this window open while working. Source edits update the website automatically.");
    openBrowser(url);
    return;
  }
  throw Error("All ten local ports are occupied. Close an old website server window and retry.");
}

main().catch((error) => {
  console.error("\nCould not start the website. " + error.message);
  process.exitCode = 1;
});
