const INTERVAL = 10 * 60 * 1000;
const IDLE_DELAY = 5000;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("balloon-autosave", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("sessions");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function checkpoint(db, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      "sessions",
      value ? "readwrite" : "readonly",
    );
    const store = transaction.objectStore("sessions");
    const request = value
      ? store.put(value, location.pathname)
      : store.get(location.pathname);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function queueAutosave() {
  window.dispatchEvent(new Event("project-change"));
}

export async function startAutosave(adapters) {
  const status = document.createElement("output");
  status.className = "autosave-status";
  status.textContent = "AUTOSAVE STARTING";
  document.querySelector(".simulation-tabs").after(status);
  let db, previous;
  try {
    db = await openDatabase();
    previous = await checkpoint(db);
  } catch (error) {
    status.textContent = "AUTOSAVE UNAVAILABLE · BROWSER STORAGE";
    console.error("Autosave storage failed", error);
    return;
  }

  const time = (value) =>
    new Date(value).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  const state = previous?.version === 1 ? previous.state : {};
  const restoreFailures = new Set();
  if (previous?.version === 1) {
    for (const [key, adapter] of Object.entries(adapters)) {
      if (state[key] === undefined) continue;
      try {
        await adapter.load(state[key]);
      } catch (error) {
        restoreFailures.add(key);
        console.error("Autosave restore failed for " + key, error);
      }
    }
    status.textContent = restoreFailures.size
      ? "AUTOSAVE PARTIALLY RESTORED · CHECK SAVED PROJECTS"
      : "AUTOSAVE RESTORED · " + time(previous.savedAt);
  } else {
    status.textContent = "AUTOSAVE ON · THIS BROWSER";
  }

  let writing = false,
    queued = false,
    delay;
  async function save() {
    clearTimeout(delay);
    if (writing) {
      queued = true;
      return;
    }
    writing = true;
    try {
      const next = { ...state };
      let partial = restoreFailures.size > 0;
      for (const [key, adapter] of Object.entries(adapters)) {
        if (restoreFailures.has(key)) continue;
        try {
          const value = adapter.save();
          if (value !== undefined) next[key] = value;
        } catch (error) {
          partial = true;
          console.error("Autosave snapshot failed for " + key, error);
        }
      }
      const savedAt = Date.now();
      await checkpoint(db, { version: 1, state: next, savedAt });
      Object.assign(state, next);
      status.textContent = partial
        ? "AUTOSAVE PARTIAL · " + time(savedAt)
        : "AUTOSAVED · " + time(savedAt);
    } catch (error) {
      status.textContent = "AUTOSAVE FAILED · LAST CHECKPOINT KEPT";
      console.error("Autosave write failed", error);
    } finally {
      writing = false;
      if (queued) {
        queued = false;
        void save();
      }
    }
  }
  function changed() {
    clearTimeout(delay);
    delay = setTimeout(save, IDLE_DELAY);
  }
  for (const event of [
    "input",
    "change",
    "click",
    "pointerup",
    "keyup",
    "project-change",
  ])
    window.addEventListener(event, changed, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) void save();
  });
  setInterval(save, INTERVAL);
}
