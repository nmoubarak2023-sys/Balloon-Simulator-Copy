import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { geometry, quadWire } from "./view.js";
import { quadObj } from "./quad-mesh.js";
import { addRhinoQuadMesh } from "./rhino-io.js";
import { addTechnicalFrames } from "./frames.js";
import { mountGeometryLibrary, canvasThumbnail } from "./geometry-library.js";
import {
  collisionSites,
  columnMesh,
  resizePlacedColumnBase,
} from "./columns.js";
import { meshQuality } from "./mesh-quality.js";
import { isUndoShortcut } from "./history.js";
export function initColumns(rhino, getVoronoi, getFloors) {
  const pane = document.createElement("main");
  pane.id = "columnWorkspace";
  pane.hidden = true;
  document.querySelector("main").after(pane);
  pane.innerHTML = `<div class="floor-toolbar" aria-label="Building floors"><strong>BUILDING FLOORS</strong><label>Editing floor<select id="cFloor"></select></label><button id="cImport" class="primary">COPY SELECTED FLOOR ↗</button><div class="column-floor-visibility-row"><div id="cFloorVisibility"></div><label class="check"><input id="cIsolateFloor" type="checkbox"> ISOLATE FLOOR</label></div></div><div class="voro-layout"><section class="panel" data-frame-count="1"><div class="panel-heading"><span>PERSPECTIVE <small>01 / COLUMN POPULATE</small></span><button id="cFit">FIT ↗</button></div><div class="canvas-tools"><button id="cPick" aria-pressed="true">PICK COLLISION</button><button id="cGhost" aria-pressed="true">GHOST ENCLOSURE</button><button id="cFocus">FOCUS COLUMN</button><button id="cWire" aria-pressed="false">WIRE</button></div><div id="cPerspective" class="voro-canvas"></div></section><aside><section class="panel" data-frame-count="2"><div class="panel-heading">PLAN VIEW <small>02 / SUPPORT LOCATIONS</small></div><div id="cPlan" class="voro-plan"></div></section><section class="panel" data-frame-count="3"><div class="panel-heading">CONTROL PANEL <small>03 / COLUMN POPULATE</small></div><div class="voro-controls"><label>Collision location<select id="cSites"></select></label><button id="cPlace">PLACE AT SELECTED COLLISION ↗</button><label>Placed column<select id="cColumns"></select></label>${[
    ["Bottom", "Bottom radius (ft)", 1, 0.1, 20, 0.1],
    ["Flare", "Top radius (ft)", 5, 0.1, 30, 0.1],
    ["Blend", "Canopy blend (%)", 55, 10, 90, 1],
  ]
    .map(
      ([id, label, v, min, max, step]) =>
        `<div class="control"><label for="c${id}">${label}</label><input id="c${id}" type="number" min="${min}" max="${max}" step="${step}" value="${v}"><input id="cr${id}" aria-label="${label} slider" type="range" min="${min}" max="${max}" step="${step}" value="${v}"></div>`,
    )
    .join(
      "",
    )}<label>COLUMN CONTROL<select id="cScope"><option value="individual">INDIVIDUAL</option><option value="floor">GLOBAL · EDITING FLOOR</option><option value="global">GLOBAL · ALL FLOORS</option></select></label><button id="cApply">APPLY TO SELECTED COLUMN ↗</button><div class="pair"><button id="cRemove">REMOVE COLUMN</button><button id="cUndo">UNDO / CTRL+Z</button></div><label class="check"><input id="cRoofExport" type="checkbox" checked> Include hollow enclosure and floor plate</label><label>Shell thickness (ft)<input id="cShellThickness" type="number" value="1" min="0.1" step="any" required></label><div class="pair"><button id="cObj">EXPORT .OBJ</button><button id="c3dm">EXPORT .3DM</button></div><button id="cSave">SAVE COLUMN PROJECT</button><label class="button" for="cLoad">OPEN COLUMN PROJECT</label><input id="cLoad" type="file" accept=".json" hidden><pre id="cReport" class="iteration-report">Copy a Voronoi enclosure to begin.</pre></div></section></aside></div><div class="status-bar" id="cStatus" role="status">Generate in Voronoi Balloons, then copy it here.</div>`;
  const $ = (id) => pane.querySelector("#" + id),
    status = (s) => {
      $("cStatus").textContent = s;
    };
  let source,
    sites = [],
    columns = [],
    selected = -1,
    ghost = true,
    wire = false,
    pick = true,
    history = [];
  const globalFields = new Set();
  const allFloors = () => $("cScope").value === "global";
  const globalMode = () => $("cScope").value !== "individual";
  const floorWork = new Map();
  let planExtent,
    isolateEditingFloor = false;
  let workingFloor,
    buildingFloors = [];
  const floorVisibility = new Map();
  const context = new T.Group();
  const scene = new T.Scene(),
    root = new T.Group(),
    markers = new T.Group();
  scene.add(context, root, markers, new T.AmbientLight(0xffffff, 2));
  const light = new T.DirectionalLight(0xffffff, 3);
  light.position.set(80, -80, 150);
  scene.add(light);
  const camera = new T.PerspectiveCamera(38, 1, 0.01, 10000);
  camera.up.set(0, 0, 1);
  const plan = new T.OrthographicCamera(-50, 50, 35, -35, 0.01, 10000);
  plan.up.set(0, 1, 0);
  const renderers = ["cPerspective", "cPlan"].map((id) => {
    const r = new T.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setClearColor(0, 0);
    $(id).append(r.domElement);
    return r;
  });
  const orbit = new OrbitControls(camera, renderers[0].domElement);
  orbit.enableDamping = true;
  function resize() {
    renderers.forEach((r, i) => {
      const el = r.domElement.parentElement,
        w = el.clientWidth,
        h = el.clientHeight;
      if (!w || !h) return;
      r.setSize(w, h, false);
      if (!i) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      } else if (planExtent) {
        const aspect = w / h;
        plan.right = Math.max(planExtent.x, planExtent.y * aspect, 1) * 0.58;
        plan.left = -plan.right;
        plan.top = plan.right / aspect;
        plan.bottom = -plan.top;
        plan.updateProjectionMatrix();
      }
    });
  }
  renderers.forEach((r) =>
    new ResizeObserver(resize).observe(r.domElement.parentElement),
  );
  function fit() {
    const bounds = new T.Box3().setFromObject(context);
    if (root.visible) bounds.expandByObject(root);
    if (bounds.isEmpty()) return;
    const size = bounds.getSize(new T.Vector3());
    planExtent = size;
    const w = Math.max(size.x, size.y, size.z, 1);
    const h = size.y;
    const floor = bounds.getCenter(new T.Vector3()).z;
    const x0 = bounds.min.x + (size.x - w) / 2;
    const y0 = bounds.min.y;
    orbit.target.set(x0 + w / 2, y0 + h / 2, floor);
    camera.position.set(x0 + w * 1.1, y0 - w * 0.9, floor + w * 0.9);
    camera.lookAt(orbit.target);
    plan.position.set(x0 + w / 2, y0 + h / 2, floor + w * 3);
    plan.lookAt(x0 + w / 2, y0 + h / 2, floor);
    resize();
  }
  function clear(group) {
    for (const o of [...group.children]) {
      group.remove(o);
      o.traverse((n) => {
        n.geometry?.dispose();
        n.material?.dispose();
      });
    }
  }
  const settings = () => ({
    radius: Number($("cBottom").value),
    bottomRadius: Number($("cBottom").value),
    flare: Number($("cFlare").value),
    blend: Number($("cBlend").value) / 100,
  });
  const rawCopy = (r) => ({
    positions: new Float64Array(r.positions),
    indices: new Uint32Array(r.indices),
  });
  function snapshot() {
    return {
      format: "column-populate",
      version: 1,
      source: structuredClone(source),
      columns: structuredClone(columns),
      selected,
      settings: settings(),
      ghost,
      wire,
    };
  }
  function remember() {
    history.push({ floor: workingFloor, project: snapshot() });
    if (history.length > 20) history.shift();
  }
  function isFloorVisible(index) {
    return isolateEditingFloor
      ? index === workingFloor
      : floorVisibility.get(index) !== false;
  }
  function displayFloors() {
    for (const toggle of $("cFloorVisibility").querySelectorAll("input")) {
      toggle.checked = floorVisibility.get(Number(toggle.value)) !== false;
    }
    clear(context);
    const addContextMesh = (raw, color, opacity) => {
      context.add(
        new T.Mesh(
          geometry(raw),
          new T.MeshPhysicalMaterial({
            color,
            transparent: true,
            opacity,
            depthWrite: false,
            side: T.DoubleSide,
          }),
        ),
      );
    };
    for (const floor of buildingFloors) {
      if (
        floor.index === workingFloor
          ? !isFloorVisible(floor.index)
          : floorVisibility.get(floor.index) === false
      )
        continue;
      if (floor.index === workingFloor && source) continue;
      const saved = floorWork.get(floor.index);
      const raw = saved?.source.raw ?? floor.raw;
      if (raw?.indices.length) addContextMesh(raw, 0xd2d5d8, 0.19);
      else if (floor.perimeter?.length)
        context.add(
          new T.LineLoop(
            new T.BufferGeometry().setFromPoints(
              floor.perimeter.map(
                ([x, y]) => new T.Vector3(x, y, floor.elevation),
              ),
            ),
            new T.LineBasicMaterial({
              color: 0xd2d5d8,
              transparent: true,
              opacity: 0.3,
            }),
          ),
        );
      for (const column of saved?.columns ?? [])
        addContextMesh(column.raw, 0xd2d5d8, 0.45);
    }
    root.visible = markers.visible = isFloorVisible(workingFloor);
  }
  function updateColumnControls() {
    const global = globalMode();
    const hasColumns =
      columns.length > 0 ||
      (allFloors() &&
        [...floorWork].some(
          ([index, floor]) => index !== workingFloor && floor.columns.length,
        ));
    $("cApply").textContent = global
      ? allFloors()
        ? "APPLY TO ALL COLUMNS ↗"
        : "APPLY TO EDITING FLOOR ↗"
      : "APPLY TO SELECTED COLUMN ↗";
    $("cApply").disabled = global ? !hasColumns : selected < 0;
    $("cUndo").disabled = !history.length;
  }
  function display() {
    updateColumnControls();
    displayFloors();
    clear(root);
    clear(markers);
    if (!source) return;
    const roof = new T.Mesh(
      geometry(source.raw),
      new T.MeshPhysicalMaterial({
        color: 0x4e9fa9,
        roughness: 0.4,
        metalness: 0.1,
        side: T.DoubleSide,
        transparent: ghost,
        opacity: ghost ? 0.12 : 1,
        depthWrite: !ghost,
      }),
    );
    const edges = quadWire(source.raw);
    edges.visible = wire;
    roof.add(edges);
    root.add(roof);
    columns.forEach((c, i) => {
      const mesh = new T.Mesh(
        geometry(c.raw),
        new T.MeshPhysicalMaterial({
          color: i === selected ? 0xfb88fc : 0x21e0ed,
          roughness: 0.3,
          metalness: 0.15,
        }),
      );
      mesh.userData.column = i;
      root.add(mesh);
      if (wire) mesh.add(quadWire(c.raw));
    });
    if (pick)
      for (const site of sites) {
        const used = columns.some((c) => c.site.id === site.id);
        const marker = new T.Mesh(
          new T.SphereGeometry(
            Math.max(0.3, source.params.width * 0.006),
            12,
            8,
          ),
          new T.MeshBasicMaterial({
            color: used ? 0xffffff : 0xdc24f4,
            depthTest: false,
            transparent: true,
            opacity: used ? 0.45 : 1,
          }),
        );
        marker.position.set(site.x, site.y, site.z);
        marker.userData.site = site.id;
        marker.renderOrder = 50;
        markers.add(marker);
      }
    $("cColumns").replaceChildren(
      ...columns.map(
        (c, i) =>
          new Option(
            `${i + 1}. Collision ${c.site.id + 1} · ${c.site.kind}`,
            i,
          ),
      ),
    );
    $("cColumns").value = selected;
    for (const id of ["cRemove", "cFocus"]) $(id).disabled = selected < 0;
    $("cUndo").disabled = !history.length;
    $("cGhost").setAttribute("aria-pressed", ghost);
    $("cWire").setAttribute("aria-pressed", wire);
    $("cPick").setAttribute("aria-pressed", pick);
    $("cReport").textContent = JSON.stringify(
      {
        collisionLocations: sites.length,
        columns: columns.length,
        units: "feet",
        export: "Separate shells",
        supports: columns.map((c, i) => {
          const q = meshQuality(c.raw);
          return {
            column: i + 1,
            collision: c.site.id + 1,
            balloonIndices: c.site.balloons,
            location: [c.site.x, c.site.y],
            ...c.settings,
            effectiveFlare: c.raw.effectiveFlare,
            nakedEdges: q.boundaryEdges,
            nonManifoldEdges: q.nonManifoldEdges,
          };
        }),
      },
      null,
      2,
    );
  }
  function syncSettings() {
    if (selected < 0 || globalMode()) return;
    const s = columns[selected].settings;
    for (const [id, v] of [
      ["Bottom", s.bottomRadius ?? s.radius],
      ["Flare", s.flare],
      ["Blend", Math.round(s.blend * 100)],
    ])
      $("c" + id).value = $("cr" + id).value = v;
  }
  function place(site) {
    if (!source) throw Error("Copy a Voronoi enclosure first.");
    const found = columns.findIndex((c) => c.site.id === site.id);
    if (found >= 0) {
      selected = found;
      syncSettings();
      display();
      status("Existing column selected.");
      return;
    }
    const s = settings(),
      raw = columnMesh(source, site, s);
    remember();
    columns = [...columns, { site: structuredClone(site), settings: s, raw }];
    selected = columns.length - 1;
    display();
    status(`Column ${selected + 1} placed at collision ${site.id + 1}.`);
  }
  function guarded(fn) {
    return async (...args) => {
      try {
        await fn(...args);
      } catch (e) {
        status(e.message);
      }
    };
  }
  let copiedEnclosure;
  function accept(result) {
    if (!result?.raw?.indices.length)
      throw Error("Generate a Voronoi enclosure first.");
    copiedEnclosure = result.raw;
    const next = {
      raw: rawCopy(result.raw),
      closed: result.closed,
      params: structuredClone(result.params),
      spheres: structuredClone(result.spheres),
      ids: [...result.ids],
    };
    const found = collisionSites(next);
    if (source) remember();
    source = next;
    sites = found;
    columns = [];
    selected = -1;
    $("cSites").replaceChildren(
      ...sites.map(
        (s) =>
          new Option(
            `${s.id + 1}. ${s.kind} · X ${s.x.toFixed(2)}, Y ${s.y.toFixed(2)}`,
            s.id,
          ),
      ),
    );
    display();
    fit();
    status(
      `${sites.length} collision locations found. Click a pink marker to place a column.`,
    );
  }
  function selectFloor(index) {
    if (workingFloor !== undefined && source)
      floorWork.set(workingFloor, {
        source,
        sites,
        columns,
        selected,
        copiedEnclosure,
      });
    workingFloor = index;
    const saved = floorWork.get(index);
    source = saved?.source;
    sites = saved?.sites ?? [];
    columns = saved?.columns ?? [];
    selected = saved?.selected ?? -1;
    copiedEnclosure = saved?.copiedEnclosure;
    $("cSites").replaceChildren(
      ...sites.map(
        (site) =>
          new Option(
            site.id +
              1 +
              ". " +
              site.kind +
              " · X " +
              site.x.toFixed(2) +
              ", Y " +
              site.y.toFixed(2),
            site.id,
          ),
      ),
    );
    if (source && !columns.length) {
      try {
        const fresh = getVoronoi(index);
        if (fresh.raw !== copiedEnclosure) {
          accept(fresh);
          return;
        }
      } catch {
        // Keep the copied floor available while Voronoi has no result.
      }
    }
    if (source) {
      syncSettings();
      display();
      fit();
      status(
        "Floor " + (index + 1) + " · " + columns.length + " placed column(s).",
      );
      return;
    }
    $("cColumns").replaceChildren();
    $("cUndo").disabled = !history.length;
    $("cReport").textContent = "Copy a Voronoi enclosure to begin.";
    display();
    accept(getVoronoi(index));
  }
  $("cIsolateFloor").onchange = () => {
    isolateEditingFloor = $("cIsolateFloor").checked;
    displayFloors();
  };
  $("cFloor").onchange = guarded(() => selectFloor(Number($("cFloor").value)));
  $("cImport").onclick = guarded(() => accept(getVoronoi(workingFloor)));
  $("cPlace").onclick = guarded(() => {
    const site = sites[Number($("cSites").value)];
    if (!site)
      throw Error(
        "No collision locations. Copy a Voronoi enclosure with overlapping balloons.",
      );
    place(site);
  });
  $("cScope").onchange = () => {
    globalFields.clear();
    syncSettings();
    updateColumnControls();
  };
  $("cApply").onclick = guarded(() => {
    if (globalMode()) {
      if ($("cApply").disabled) return;
      const requested = settings();
      const changes = {};
      if (!globalFields.size || globalFields.has("Bottom"))
        changes.bottomRadius = requested.bottomRadius;
      if (globalFields.has("Flare")) changes.flare = requested.flare;
      if (globalFields.has("Blend")) changes.blend = requested.blend;
      globalFields.clear();
      const edits = [];
      const failures = [];
      function rebuild(index, currentSource, placed) {
        if (!placed.length) return;
        let count = 0;
        const updated = placed.map((column, i) => {
          const settings = { ...column.settings, ...changes };
          const actualBase = Math.hypot(
            column.raw.positions[0] - column.site.x,
            column.raw.positions[1] - column.site.y,
          );
          if (
            (changes.bottomRadius === undefined ||
              Math.abs(actualBase - changes.bottomRadius) < 1e-6) &&
            Object.keys(changes).every(
              (key) => settings[key] === column.settings[key],
            )
          )
            return column;
          try {
            const raw =
              Object.keys(changes).length === 1 &&
              changes.bottomRadius !== undefined
                ? resizePlacedColumnBase(
                    column.raw,
                    column.site,
                    changes.bottomRadius,
                  )
                : columnMesh(currentSource, column.site, settings);
            count++;
            return { ...column, settings, raw };
          } catch (error) {
            failures.push(
              "Floor " +
                (index + 1) +
                ", column " +
                (i + 1) +
                ": " +
                error.message,
            );
            return column;
          }
        });
        if (count) edits.push({ index, previous: placed, updated, count });
      }
      rebuild(workingFloor, source, columns);
      if (allFloors())
        for (const [index, floor] of floorWork)
          if (index !== workingFloor)
            rebuild(index, floor.source, floor.columns);
      if (edits.length)
        history.push({
          global: edits.map(({ index, previous }) => ({ index, previous })),
        });
      if (history.length > 20) history.shift();
      for (const { index, updated } of edits) {
        if (index === workingFloor) columns = updated;
        else floorWork.get(index).columns = updated;
      }
      display();
      status(
        edits.reduce((count, edit) => count + edit.count, 0) +
          " columns updated." +
          (!edits.length && !failures.length
            ? " The columns in this scope already match."
            : "") +
          (failures.length
            ? " " + failures.length + " could not update. " + failures[0]
            : ""),
      );
      return;
    }
    if (selected < 0) return;
    const s = settings();
    const current = columns[selected].settings;
    if (
      s.bottomRadius === (current.bottomRadius ?? current.radius) &&
      s.flare === current.flare &&
      s.blend === current.blend
    )
      return;
    const raw =
      s.flare === current.flare && s.blend === current.blend
        ? resizePlacedColumnBase(
            columns[selected].raw,
            columns[selected].site,
            s.bottomRadius,
          )
        : columnMesh(source, columns[selected].site, s);
    remember();
    columns = columns.map((column, i) =>
      i === selected ? { ...column, settings: s, raw } : column,
    );
    display();
    status("Column dimensions updated.");
  });
  $("cRemove").onclick = () => {
    if (selected < 0) return;
    remember();
    columns = columns.filter((_, index) => index !== selected);
    selected = Math.min(selected, columns.length - 1);
    syncSettings();
    display();
    status("Column removed. Undo restores it.");
  };
  $("cColumns").onchange = () => {
    selected = Number($("cColumns").value);
    syncSettings();
    display();
  };
  for (const id of ["Bottom", "Flare", "Blend"]) {
    const number = $("c" + id),
      range = $("cr" + id);
    number.oninput = () => {
      range.value = number.value;
      if (globalMode()) globalFields.add(id);
    };
    range.oninput = () => {
      number.value = range.value;
      if (globalMode()) globalFields.add(id);
    };
    const apply = () => {
      if (globalMode()) {
        globalFields.clear();
        globalFields.add(id);
      }
      if (!$("cApply").disabled && number.reportValidity()) $("cApply").click();
    };
    number.onchange = range.onchange = apply;
    number.onkeydown = (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      number.blur();
    };
  }
  $("cGhost").onclick = () => {
    ghost = !ghost;
    display();
  };
  $("cWire").onclick = () => {
    wire = !wire;
    display();
  };
  $("cPick").onclick = () => {
    pick = !pick;
    display();
  };
  $("cFit").onclick = fit;
  $("cFocus").onclick = () => {
    if (selected < 0) return;
    const box = new T.Box3(),
      p = columns[selected].raw.positions;
    for (let i = 0; i < p.length; i += 3)
      box.expandByPoint(new T.Vector3(p[i], p[i + 1], p[i + 2]));
    const center = box.getCenter(new T.Vector3()),
      size = box.getSize(new T.Vector3());
    orbit.target.copy(center);
    camera.position
      .copy(center)
      .add(
        new T.Vector3(1, -1, 0.25)
          .normalize()
          .multiplyScalar(Math.max(size.x, size.y, size.z) * 2.1),
      );
    camera.lookAt(center);
  };
  function restore(data) {
    if (
      data.format !== "column-populate" ||
      data.version !== 1 ||
      !data.source?.raw ||
      !Array.isArray(data.columns) ||
      data.columns.length > 200
    )
      throw Error("Not a Column POPulate project.");
    const next = structuredClone(data.source);
    next.raw = rawCopy(next.raw);
    if (!Number.isFinite(next.params?.width) || !next.spheres?.length)
      throw Error("Invalid enclosure.");
    const found = collisionSites(next),
      rebuilt = data.columns.map((c) => {
        if (!c.site || ![c.site.x, c.site.y].every(Number.isFinite))
          throw Error("Invalid column location.");
        return {
          ...c,
          raw:
            c.raw?.baseResized && c.raw.sides === 64 && c.raw.rings === 65
              ? { ...c.raw, ...rawCopy(c.raw) }
              : columnMesh(next, c.site, c.settings),
        };
      });
    source = next;
    sites = found;
    columns = rebuilt;
    selected = Math.min(Math.max(-1, data.selected), columns.length - 1);
    ghost = data.ghost !== false;
    wire = !!data.wire;
    $("cSites").replaceChildren(
      ...sites.map(
        (s) =>
          new Option(
            `${s.id + 1}. ${s.kind} · X ${s.x.toFixed(2)}, Y ${s.y.toFixed(2)}`,
            s.id,
          ),
      ),
    );
    syncSettings();
    display();
    fit();
    status("Column project restored.");
  }
  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    if (previous.global) {
      for (const { index, previous: placed } of previous.global) {
        if (index === workingFloor) columns = placed;
        else if (floorWork.has(index)) floorWork.get(index).columns = placed;
      }
      syncSettings();
      display();
    } else {
      if (previous.floor !== workingFloor) {
        selectFloor(previous.floor);
        $("cFloor").value = previous.floor;
      }
      restore(previous.project);
    }
    history.pop();
    $("cUndo").disabled = !history.length;
    status("Last column action undone.");
  }
  $("cUndo").onclick = guarded(undo);
  document.addEventListener("keydown", (e) => {
    if (!pane.hidden && isUndoShortcut(e)) {
      e.preventDefault();
      undo();
    }
  });
  const ray = new T.Raycaster();
  renderers.forEach((r, i) => {
    let down;
    r.domElement.addEventListener("pointerdown", (e) => {
      down = [e.clientX, e.clientY];
    });
    r.domElement.addEventListener(
      "pointerup",
      guarded((e) => {
        if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5)
          return;
        const rect = r.domElement.getBoundingClientRect();
        ray.setFromCamera(
          new T.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            (-(e.clientY - rect.top) / rect.height) * 2 + 1,
          ),
          i ? plan : camera,
        );
        if (pick && markers.visible) {
          const view = i ? plan : camera;
          view.updateMatrixWorld();
          let nearest = null,
            distance = 14;
          for (const s of sites) {
            const p = new T.Vector3(s.x, s.y, s.z).project(view);
            if (p.z < -1 || p.z > 1) continue;
            const d = Math.hypot(
              e.clientX - rect.left - ((p.x + 1) * rect.width) / 2,
              e.clientY - rect.top - ((1 - p.y) * rect.height) / 2,
            );
            if (d < distance) {
              distance = d;
              nearest = s;
            }
          }
          if (nearest) {
            const site = nearest;
            $("cSites").value = site.id;
            place(site);
            return;
          }
        }
        const hit = ray
          .intersectObjects(root.visible ? root.children : [])
          .find((h) => h.object.userData.column !== undefined);
        if (hit) {
          selected = hit.object.userData.column;
          syncSettings();
          display();
        }
      }),
    );
  });
  function download(data, name) {
    const url = URL.createObjectURL(new Blob([data])),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  let cancelShell;
  window.addEventListener("keydown", (event) => {
    if (pane.hidden || event.key !== "Escape" || !cancelShell) return;
    event.preventDefault();
    cancelShell();
  });
  const exported = async () => {
    if (cancelShell) throw Error("A shell export is already running.");
    if (!source) throw Error("Copy an enclosure first.");
    const includeShell = $("cRoofExport").checked;
    if (!includeShell && !columns.length)
      throw Error("Place at least one column first.");
    const columnItems = columns.map((column, i) => ({
      name: "Column " + (i + 1),
      raw: column.raw,
    }));
    let shell;
    if (includeShell) {
      if (source.closed === false)
        throw Error("The enclosure must be closed to export a hollow shell.");
      const thickness = $("cShellThickness");
      if (!thickness.reportValidity())
        throw Error("Enter a valid shell thickness.");
      status("Building the hollow enclosure and floor plate…");
      const worker = new Worker(
        new URL("./column-shell-worker.js", import.meta.url),
        { type: "module" },
      );
      try {
        shell = await new Promise((resolve, reject) => {
          cancelShell = () => reject(Error("Shell export cancelled."));
          worker.onmessage = ({ data }) =>
            data.error ? reject(Error(data.error)) : resolve(data.raw);
          worker.onerror = (event) =>
            reject(Error(event.message || "Shell export failed."));
          worker.postMessage({
            raw: source.raw,
            thickness: thickness.valueAsNumber,
          });
        });
      } finally {
        cancelShell = undefined;
        worker.terminate();
      }
    }
    return [
      ...(shell
        ? [{ name: "Hollow balloon enclosure and floor plate", raw: shell }]
        : []),
      ...columnItems,
    ];
  };
  $("cObj").onclick = guarded(async () => {
    let offset = 1,
      text = "";
    for (const item of await exported()) {
      const out = quadObj(item.raw, item.name.replaceAll(" ", "_"), offset);
      text += out.text;
      offset += out.vertices;
    }
    download(text, "column-populate.obj");
    status("OBJ exported.");
  });
  $("c3dm").onclick = guarded(async () => {
    const items = await exported(),
      r = await rhino(),
      doc = new r.File3dm();
    try {
      doc.settings().modelUnitSystem = r.UnitSystem.Feet;
      for (const item of items) addRhinoQuadMesh(r, doc, item.raw, item.name);
      download(doc.toByteArray(), "column-populate.3dm");
      status("Rhino assembly exported.");
    } finally {
      doc.delete();
    }
  });
  const serialize = (data) =>
    JSON.stringify(data, (_, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
  $("cSave").onclick = guarded(() => {
    if (!source) throw Error("Copy an enclosure first.");
    download(serialize(snapshot()), "column-populate.json");
  });
  $("cLoad").onchange = guarded(async () => {
    const file = $("cLoad").files[0];
    if (!file) return;
    const data = JSON.parse(await file.text());
    if (source) remember();
    restore(data);
    $("cLoad").value = "";
  });
  mountGeometryLibrary({
    workspace: "columns",
    showStorageNote: false,
    container: pane.querySelector(".voro-controls"),
    save: () => {
      if (!source) throw Error("Copy an enclosure first.");
      return snapshot();
    },
    load: async (data) => {
      if (source) remember();
      restore(data);
    },
    thumbnail: () => canvasThumbnail(renderers[0], scene, camera),
  });
  addTechnicalFrames(pane);
  function frame() {
    requestAnimationFrame(frame);
    if (pane.hidden) return;
    orbit.update();
    renderers[0].render(scene, camera);
    renderers[1].render(scene, plan);
  }
  frame();
  return {
    pane,
    accept,
    getPlacedColumns(index) {
      const placed =
        index === workingFloor ? columns : floorWork.get(index)?.columns;
      return (placed ?? []).map((column) => column.raw);
    },
    show() {
      resize();
      const { floors, active } = getFloors();
      buildingFloors = floors;
      $("cFloorVisibility").replaceChildren(
        ...floors.map((floor) => {
          const label = document.createElement("label");
          const toggle = document.createElement("input");
          toggle.type = "checkbox";
          toggle.value = floor.index;
          toggle.checked = floorVisibility.get(floor.index) !== false;
          toggle.setAttribute("aria-label", "Show " + floor.name);
          toggle.onchange = () => {
            floorVisibility.set(floor.index, toggle.checked);
            displayFloors();
          };
          label.append(toggle, floor.name);
          return label;
        }),
      );
      const chosen =
        floors.find((floor) => floor.index === workingFloor) ??
        floors.find((floor) => floor.index === active) ??
        floors[0];
      $("cFloor").replaceChildren(
        ...floors.map((floor) => new Option(floor.name, floor.index)),
      );
      $("cFloor").disabled = !chosen;
      $("cImport").disabled = !chosen;
      $("cIsolateFloor").disabled = !chosen;
      if (!chosen) return;
      $("cFloor").value = chosen.index;
      if (
        !source ||
        !columns.length ||
        (workingFloor !== undefined && workingFloor !== chosen.index)
      ) {
        try {
          selectFloor(chosen.index);
        } catch (error) {
          status(error.message);
        }
      } else {
        workingFloor = chosen.index;
      }
      displayFloors();
      fit();
    },
  };
}
