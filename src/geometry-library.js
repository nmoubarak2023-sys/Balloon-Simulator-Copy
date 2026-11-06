const DB = "balloon-geometry-library";
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("geometries", {
        keyPath: "id",
      });
      store.createIndex("workspace", "workspace");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function geometryStore(action, value) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(
          "geometries",
          action === "list" || action === "get" ? "readonly" : "readwrite",
        ),
        store = tx.objectStore("geometries");
      let result;
      if (action === "list") {
        result = [];
        const cursor = store
          .index("workspace")
          .openCursor(IDBKeyRange.only(value));
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          const { id, name, workspace, savedAt, thumbnail, deleted } =
            row.value;
          result.push({ id, name, workspace, savedAt, thumbnail, deleted });
          row.continue();
        };
      } else {
        const request = action === "get" ? store.get(value) : store.put(value);
        request.onsuccess = () => {
          result = request.result;
        };
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error || Error("Browser geometry storage failed."));
    });
  } finally {
    db.close();
  }
}

export function canvasThumbnail(renderer, scene, camera) {
  renderer.render(scene, camera);
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 150;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 240, 150);
  const source = renderer.domElement,
    scale = Math.min(240 / source.width, 150 / source.height),
    w = source.width * scale,
    h = source.height * scale;
  ctx.drawImage(source, (240 - w) / 2, (150 - h) / 2, w, h);
  return canvas.toDataURL("image/jpeg", 0.7);
}

export function mountGeometryLibrary({
  workspace,
  container,
  save,
  load,
  thumbnail,
}) {
  const panel = document.createElement("details");
  panel.className = "geometry-library";
  panel.id = `saved-geometry-${workspace}`;
  panel.open = true;
  panel.innerHTML =
    '<summary>SAVED GEOMETRY</summary><div class="section-body"><label>Geometry name<input class="geometry-name" type="text" maxlength="100" placeholder="Name this geometry"></label><button class="geometry-save primary">SAVE GEOMETRY ↗</button><p class="note">Saved in this browser for this website address. Saved entries survive refresh. Download a project JSON for a portable backup.</p><label class="check"><input class="geometry-trash" type="checkbox"> Show removed geometries</label><div class="geometry-list"></div><p class="geometry-message note" role="status"></p></div>';
  container.prepend(panel);
  const name = panel.querySelector(".geometry-name"),
    list = panel.querySelector(".geometry-list"),
    status = panel.querySelector(".geometry-message"),
    trash = panel.querySelector(".geometry-trash");
  const toolbar = container.closest("main").querySelector(".canvas-tools"),
    shortcut = document.createElement("button");
  shortcut.type = "button";
  shortcut.className = "geometry-shortcut";
  shortcut.textContent = "SAVED GEOMETRY";
  shortcut.setAttribute("aria-controls", panel.id);
  shortcut.setAttribute("aria-expanded", "true");
  shortcut.onclick = () => {
    panel.open = true;
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    name.focus({ preventScroll: true });
    if (!busy) run(refresh);
  };
  toolbar.append(shortcut);
  let busy = false;
  async function refresh() {
    const rows = await geometryStore("list", workspace);
    rows.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    list.replaceChildren();
    const visible = rows.filter((row) => !!row.deleted === trash.checked);
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "note";
      empty.textContent = trash.checked
        ? "No removed geometries."
        : "No saved geometries yet.";
      list.append(empty);
    }
    for (const row of visible) {
      const card = document.createElement("article");
      card.className = "geometry-card";
      if (row.thumbnail) {
        const img = document.createElement("img");
        img.src = row.thumbnail;
        img.alt = `Saved geometry: ${row.name}`;
        card.append(img);
      }
      const title = document.createElement("strong");
      title.textContent = row.name;
      card.append(title);
      const date = document.createElement("small");
      date.textContent = new Date(row.savedAt).toLocaleString();
      card.append(date);
      const actions = document.createElement("div");
      actions.className = "pair";
      const open = document.createElement("button");
      open.textContent = row.deleted ? "RESTORE" : "LOAD";
      open.setAttribute(
        "aria-label",
        `${row.deleted ? "Restore" : "Load"} ${row.name}`,
      );
      open.onclick = () =>
        run(async () => {
          const saved = await geometryStore("get", row.id);
          if (!saved) throw Error("Saved geometry was not found.");
          if (row.deleted) {
            saved.deleted = false;
            await geometryStore("put", saved);
            await refresh();
            status.textContent = `Restored ${row.name}.`;
          } else {
            await load(saved.data);
            name.value = row.name;
            status.textContent = `Loaded ${row.name}.`;
          }
        });
      actions.append(open);
      if (!row.deleted) {
        const remove = document.createElement("button");
        remove.textContent = "REMOVE";
        remove.setAttribute("aria-label", `Remove ${row.name}`);
        remove.onclick = () =>
          run(async () => {
            const saved = await geometryStore("get", row.id);
            if (!saved) throw Error("Saved geometry was not found.");
            saved.deleted = true;
            await geometryStore("put", saved);
            await refresh();
            status.textContent = `Removed ${row.name}. Use Show removed geometries to restore it.`;
          });
        actions.append(remove);
      }
      card.append(actions);
      list.append(card);
    }
  }
  async function run(fn) {
    if (busy) return;
    busy = true;
    panel.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await fn();
    } catch (error) {
      status.textContent =
        error.name === "QuotaExceededError"
          ? "Browser storage is full. Download a project JSON backup."
          : error.message || "Browser storage is unavailable.";
    } finally {
      busy = false;
      panel.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  }
  panel.querySelector(".geometry-save").onclick = () =>
    run(async () => {
      const data = await save(),
        savedAt = new Date().toISOString(),
        label = name.value.trim() || `Geometry ${new Date().toLocaleString()}`;
      const image = thumbnail ? thumbnail() : null;
      await geometryStore("put", {
        id: crypto.randomUUID(),
        workspace,
        name: label,
        savedAt,
        thumbnail: image,
        data,
        deleted: false,
      });
      name.value = label;
      await refresh();
      status.textContent = `Saved ${label}. It will remain after refresh.`;
    });
  trash.onchange = () => run(refresh);
  panel.addEventListener("toggle", () => {
    shortcut.setAttribute("aria-expanded", String(panel.open));
    if (panel.open && !busy) run(refresh);
  });
  refresh().catch(
    (error) =>
      (status.textContent = error.message || "Browser storage is unavailable."),
  );
  return { panel, refresh };
}
