import { initFacade } from "./facade-ui.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { UndoJournal, isUndoShortcut } from "./history.js";
import { populateAllZones } from "./zone-population.js";
import { placeSavedFloor } from "./floor-placement.js";
import { loopBounds } from "./zones.js";
import { defaultZoneSettings, ZONE_STRIDE } from "./zoned-voronoi.js";
import { readBuildingCurves } from "./rhino-zones.js";
import { initColumns } from "./column-ui.js";
import { mountGeometryLibrary, canvasThumbnail } from "./geometry-library.js";
import { quadObj, quadMesh } from "./quad-mesh.js";
import { addTechnicalFrames } from "./frames.js";
import { createVoronoiEditing } from "./voronoi-editing.js";
import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { geometry, rawGeometry, quadWire } from "./view.js";
import { addRhinoQuadMesh } from "./rhino-io.js";
export function initVoronoi(
  workerFactory,
  rhino,
  useAsBoundary,
  party,
  showBalloonBuild,
) {
  const existing = document.querySelector("main"),
    pane = document.createElement("main");
  pane.id = "voronoiWorkspace";
  pane.hidden = true;
  const nav = document.createElement("nav");
  nav.className = "simulation-tabs";
  nav.setAttribute("aria-label", "Simulation workspaces");
  nav.innerHTML =
    '<button aria-pressed="true">VORONOI BALLOONS</button><button aria-pressed="false">COLUMN POPulate</button><button aria-pressed="false" aria-controls="facadeWorkspace">FACADE DESIGN</button>';
  existing.before(nav);
  const facade = document.createElement("main");
  facade.id = "facadeWorkspace";
  facade.hidden = true;
  existing.after(pane, facade);
  const fields = [
    ["count", "Seed point count", 40, 1, 150, 1],
    ["seed", "Point seed", 42, 0, 9999, 1],
    ["index", "Anchor point index (0 based)", 0, 0, 39, 1],
    ["selected", "Nearest points selected", 17, 1, 40, 1],
    ["radiusMin", "Radius min (ft)", 15, 1, 60, 0.5],
    ["radiusMax", "Radius max (ft)", 25, 1, 80, 0.5],
    ["radiusSeed", "Radius seed", 17, 0, 9999, 1],
    ["floor", "Floor plane Z (ft)", 0, -20, 20, 0.5],
    ["spacing", "Mesh spacing (ft)", 2, 0.5, 10, 0.5],
    ["smoothing", "Valley smoothing passes", 4, 0, 20, 1],
  ];
  let boundary = null,
    zoneConfigs = [],
    legacyRectangle = false,
    activeZone = 0,
    populatedZones = [],
    showAllZones = true;
  const zoneFields = [
    "count",
    "seed",
    "index",
    "selected",
    "radiusMin",
    "radiusMax",
    "radiusSeed",
  ];
  pane.innerHTML = `<div class="voro-layout"><section class="panel"><div class="panel-heading"><span>PERSPECTIVE <small>01 / VORONOI BALLOONS</small></span><button id="vFit">FIT ↗</button></div><div class="canvas-tools"><button id="vRoof" aria-pressed="true">ENCLOSURE</button><button id="vSpheres" aria-pressed="false">BALLOONS</button><button id="vPickZone" aria-pressed="false">PICK ZONE</button><button id="vIsolateCanvas" aria-pressed="false">ISOLATE ZONE</button><button id="vPopulateCanvas">POPULATE SELECTED ZONE ↗</button><button id="vPickAnchor" aria-pressed="false">PICK ANCHOR CENTER</button><button id="vSection" aria-pressed="false">CLIPPING PLANE</button><button id="vSectionMove" aria-pressed="false" hidden>ROTATE PLANE</button><button id="vUndo" disabled>UNDO / CTRL+Z</button><button id="vGhost" aria-pressed="false">GHOSTED</button><button id="vWire" aria-pressed="false">WIRE</button></div><div id="vPerspective" class="voro-canvas"><button id="vUploadPrompt" type="button">UPLOAD FLOOR CURVES</button></div><div class="viewer-footer">FULL BALLOONS / ROUNDED SURFACE UNION</div></section><aside><section class="panel"><div class="panel-heading">PLAN VIEW <small>02 / CELLS & SELECTED SEEDS</small></div><div id="vPlan" class="voro-plan"></div></section><section class="panel"><div class="panel-heading">CONTROL PANEL <small>03 / INDEPENDENT SIMULATION</small></div><div class="voro-controls"><label class="button" for="vBoundaryFile">IMPORT FLOOR CURVES .3DM ↗</label><input id="vBoundaryFile" type="file" accept=".3dm" hidden><p id="vBoundaryInfo" class="note"></p><label>Population zone<select id="vZone"></select></label><p id="vZoneInfo" class="note"></p><label><input id="vShowAllZones" type="checkbox"> Show all zones</label><select id="vSize" hidden><option value="160">160</option><option value="80" selected>80</option><option value="40">40</option></select>${fields.map(([id, label, value, min, max, step]) => `<div class="control"><label for="v_${id}">${label}</label><input id="vn_${id}" type="number" value="${value}" min="${min}" max="${max}" step="${step}" aria-label="${label}"><input id="v_${id}" type="range" value="${value}" min="${min}" max="${max}" step="${step}"></div>`).join("")}<button id="vGenerate" class="primary">POPULATE SELECTED ZONE ↗</button><button id="vPopulateFloor">POPULATE ALL ZONES ON THIS FLOOR ↗</button><button id="vPopulateBuilding">POPULATE ALL LOADED FLOORS ↗</button><div class="pair"><button id="vObj">EXPORT .OBJ</button><button id="v3dm">EXPORT .3DM</button></div><button id="vSave">SAVE SETTINGS & DATA</button><label class="button" for="vLoad">OPEN VORONOI PROJECT</label><input hidden id="vLoad" type="file" accept=".json"><details class="mesh-details"><summary>MESH DETAILS</summary><pre id="vReport" class="iteration-report">Generate an enclosure to check its mesh.</pre></details></div></section></aside></div><div class="status-bar" id="vStatus" role="status">Ready to generate.</div>`;
  for (const id of ["index", "selected", "smoothing"])
    pane.querySelector("#vn_" + id).closest(".control").hidden = true;
  pane.querySelector("#vPickAnchor").hidden = true;
  const stages = [
    "Boundary",
    "Seed points",
    "Voronoi cells",
    "Nearest cluster",
    "Zone-clipped balloons",
    "Floor-clipped balloons",
    "United floor footprint",
    "Smooth enclosure",
  ];
  const stepbar = document.createElement("div");
  stepbar.className = "voro-steps";
  stepbar.innerHTML =
    '<button id="vPrevious">← BACK</button><select id="vStage" aria-label="Construction step">' +
    stages
      .map((name, i) =>
        [0, 1, 2, 4, 7].includes(i)
          ? '<option value="' +
            i +
            '">' +
            ([0, 1, 2, 4, 7].indexOf(i) + 1) +
            ". " +
            (i === 4 ? "Full balloons" : name) +
            "</option>"
          : "",
      )
      .join("") +
    '</select><button id="vNext">NEXT →</button><button id="vPlay">PLAY STEPS</button><p id="vStepDescription" class="note"></p>';
  pane.querySelector(".canvas-tools").after(stepbar);
  let anchorDown;
  let resetStepMenu = false;
  let stage = 0,
    timer;
  const $ = (id) => pane.querySelector("#" + id);
  const loading = document.createElement("div");
  loading.className = "voronoi-loading";
  loading.hidden = true;
  loading.setAttribute("role", "status");
  loading.innerHTML = '<span aria-hidden="true"></span>Processing…';
  pane.append(loading);
  let backgroundTasks = 0;
  function updateLoading() {
    loading.hidden = !pending && backgroundTasks === 0;
  }
  function setPending(value) {
    pending = value;
    updateLoading();
  }
  function storeZone() {
    if (!boundary || !zoneConfigs[activeZone]) return;
    for (const id of zoneFields)
      zoneConfigs[activeZone][id] = Number($("vn_" + id).value);
    const cfg = zoneConfigs[activeZone];
    if (cfg.radiusMax < cfg.radiusMin) {
      cfg.radiusMax = cfg.radiusMin;
      $("vn_radiusMax").value = $("v_radiusMax").value = cfg.radiusMax;
    }
  }
  function zoneUI(load = true) {
    $("vZone").replaceChildren(
      ...(boundary
        ? boundary.zones.map((z, i) => new Option(z.name, i))
        : [new Option("Legacy rectangle", 0)]),
    );
    $("vZone").value = activeZone;
    $("vZone").disabled = !boundary;
    $("vShowAllZones").checked = showAllZones;
    $("vBoundaryInfo").textContent = boundary
      ? `${boundary.sourceName} · ${boundary.zones.length} zone(s) · feet${boundary.warnings?.length ? " · " + boundary.warnings.join(" ") : ""}`
      : "Legacy rectangle project. Import Rhino floor curves to use zones.";
    $("vZoneInfo").textContent = boundary
      ? `${boundary.zones[activeZone].name} · ${boundary.zones[activeZone].area.toFixed(2)} sq ft · ${populatedZones.includes(activeZone) ? "populated" : "not populated — press Populate Selected Zone"} · independent controls`
      : "";
    const count =
      load && boundary
        ? zoneConfigs[activeZone].count
        : Number($("vn_count").value);
    for (const prefix of ["v_", "vn_"]) {
      $(prefix + "index").max = count - 1;
      $(prefix + "selected").max = count;
    }
    if (load && boundary)
      for (const id of zoneFields)
        $("vn_" + id).value = $("v_" + id).value = zoneConfigs[activeZone][id];
  }
  function restoreZoneView(view) {
    activeZone = Math.max(
      0,
      Math.min(
        boundary ? boundary.zones.length - 1 : 0,
        Number.isInteger(view?.activeZone) ? view.activeZone : 0,
      ),
    );
    showAllZones = !!view?.showAllZones;
    $("vShowAllZones").checked = showAllZones;
  }
  function restoreBoundary(params) {
    boundary = structuredClone(params.boundary ?? null);
    legacyRectangle = !boundary && !params.empty;
    zoneConfigs = structuredClone(
      params.zoneSettings ?? (boundary ? defaultZoneSettings(boundary) : []),
    );
    activeZone = 0;
    populatedZones = structuredClone(
      params.populatedZones ?? boundary?.zones.map((_, i) => i) ?? [],
    );
    if (boundary) {
      const z = boundary.elevation ?? 0,
        span = Math.max(boundary.bounds.width, boundary.bounds.height);
      for (const id of ["vn_floor", "v_floor"]) {
        $(id).min = z - span;
        $(id).max = z + span;
      }
    }
    zoneUI(false);
  }
  $("vZone").onchange = () => {
    storeZone();
    activeZone = Number($("vZone").value);
    zoneUI();
    draw();
    editing?.selectZone(activeZone);
  };
  $("vShowAllZones").onchange = () => {
    showAllZones = $("vShowAllZones").checked;
    draw();
  };
  async function importBoundary(next) {
    if (pending)
      throw Error("Wait for generation to finish before importing a boundary.");
    if (activeFloor && Math.abs(next.elevation ?? 0) < 1e-8)
      next = { ...next, elevation: activeFloor * 20 };
    boundary = next;
    populatedZones = [];
    zoneConfigs = defaultZoneSettings(next, activeFloor);
    activeZone = 0;
    zoneUI();
    const elevation = next.elevation ?? 0,
      span = Math.max(next.bounds.width, next.bounds.height);
    for (const id of ["vn_floor", "v_floor"]) {
      $(id).min = elevation - span;
      $(id).max = elevation + span;
      $(id).value = elevation;
    }

    const spacing = Math.max(
      0.5,
      Math.round((Math.max(next.bounds.width, next.bounds.height) / 40) * 2) /
        2,
    );
    $("vn_spacing").value = $("v_spacing").value = spacing;
    const [x, y] = next.bounds.min,
      w = next.bounds.width,
      h = next.bounds.height,
      z = next.elevation ?? 0;
    editing?.load({
      curves: [
        [
          [x + w * 0.05, y + h * 0.3, z],
          [x + w * 0.35, y + h * 0.65, z],
          [x + w * 0.65, y + h * 0.35, z],
          [x + w * 0.95, y + h * 0.7, z],
        ],
      ],
      edits: {},
      pressureEnabled: false,
    });
    fitNext = true;
    stage = 0;
    generate("prepare");
  }
  $("vUploadPrompt").onclick = () => $("vBoundaryFile").click();
  $("vBoundaryFile").onchange = async () => {
    const file = $("vBoundaryFile").files[0];
    if (!file) return;
    remember(captureUndo());
    $("vProjectMessage").hidden = true;
    backgroundTasks++;
    updateLoading();
    try {
      if (file.size > 50 * 1024 * 1024)
        throw Error("Use a Rhino file smaller than 50 MB.");
      if (pending)
        throw Error("Wait for generation to finish before importing.");
      $("vStatus").textContent =
        "Reading Rhino curves and detecting population zones…";
      const r = await rhino(),
        input = readBuildingCurves(r, new Uint8Array(await file.arrayBuffer())),
        partitionWorker = workerFactory();
      const boundaries = [];
      try {
        for (const [i, floor] of input.floors.entries()) {
          const next = await new Promise((resolve, reject) => {
            partitionWorker.onmessage = ({ data }) =>
              data.error
                ? reject(Error(`Floor ${i + 1}: ${data.error}`))
                : resolve(data.result);
            partitionWorker.onerror = (e) => reject(Error(e.message));
            partitionWorker.postMessage({
              id: 1,
              action: "partitionZones",
              curves: floor.curves,
              options: {
                elevation: floor.elevation,
                sourceName: `${file.name} · Floor ${i + 1}`,
              },
            });
          });
          boundaries.push(next);
        }
      } finally {
        partitionWorker.terminate();
      }
      if (boundaries.length === 1) await importBoundary(boundaries[0]);
      else {
        // Validate every level before replacing any existing floor state.
        while (floorState.length < boundaries.length)
          floorState.push({
            name: `Floor ${floorState.length + 1}`,
            visible: true,
            snapshot: null,
          });
        floorState.forEach((f, i) => {
          f.snapshot = null;
          f.visible = true;
          const b = boundaries[i];
          if (!b) return;
          const configs = defaultZoneSettings(b, i),
            z = b.elevation ?? 0,
            span = Math.max(b.bounds.width, b.bounds.height);
          const params = {
            unclippedBalloons: true,
            clipFloor: true,
            boundary: b,
            zoneSettings: configs,
            populatedZones: [],
            width: b.bounds.width,
            height: b.bounds.height,
            origin: [...b.bounds.min],
            count: configs.reduce((n, c) => n + c.count, 0),
            index: 0,
            floor: z,
            spacing: Math.max(0.5, Math.round((span / 40) * 2) / 2),
            smoothing: 4,
          };
          f.snapshot = {
            params,
            result: null,
            editing: {
              curves: [
                [
                  [b.bounds.min[0], b.bounds.min[1], z],
                  [b.bounds.max[0], b.bounds.max[1], z],
                ],
              ],
              edits: {},
              pressureEnabled: false,
            },
            view: { activeZone: 0, showAllZones: true },
            stage: 0,
            wire: false,
          };
        });
        activeFloor = 0;
        isolateZone = false;
        $("vIsolateZone").checked = false;
        floorUI();
        restoreFloor(floorState[0].snapshot, false);
        generate("prepare");
        stage = 0;
        draw();
        fit();
      }
      $("vProjectMessage").textContent =
        `Imported ${boundaries.length} floor(s), ordered bottom to top: ${boundaries.map((b, i) => `Floor ${i + 1}: Z=${b.elevation.toFixed(3)} ft, ${b.zones.length} zones`).join("; ")}. Only the active floor generates its simulation. Other floors retain their own state.`;
    } catch (e) {
      $("vStatus").textContent = e.message;
      $("vProjectMessage").textContent = e.message;
      $("vProjectMessage").hidden = false;
    } finally {
      backgroundTasks--;
      updateLoading();
      $("vBoundaryFile").value = "";
    }
  };
  const floorState = Array.from({ length: 5 }, (_, i) => ({
    name: `Floor ${i + 1}`,
    visible: true,
    snapshot: null,
  }));
  let activeFloor = 0,
    isolateZone = false,
    pickZone = false;
  let zonePickTargets = [];
  const floorControls = document.createElement("div");
  floorControls.innerHTML = `<label>Editing floor<select id="vFloor" title="Only this floor is editable. Other visible floors are faded and locked.">${floorState.map((f, i) => `<option value="${i}">${f.name}</option>`).join("")}</select></label><div id="vFloorVisibility"></div><label><input type="checkbox" id="vIsolateZone"> Isolate active zone</label>`;
  floorControls.className = "floor-toolbar";
  floorControls.setAttribute("aria-label", "Building floors");
  floorControls.insertAdjacentHTML(
    "afterbegin",
    "<strong>BUILDING FLOORS</strong>",
  );
  floorControls.insertAdjacentHTML(
    "beforeend",
    '<span id="vProjectMessage" role="status" hidden></span>',
  );
  floorControls
    .querySelector("strong")
    .after(pane.querySelector('label[for="vBoundaryFile"]'));
  pane.querySelector(".voro-layout").before(floorControls);
  function floorUI() {
    $("vFloor").replaceChildren(
      ...floorState.map((f, i) => new Option(f.name, i)),
    );
    $("vFloor").value = activeFloor;
    $("vFloorVisibility").replaceChildren();
    floorState.forEach((f, i) => {
      const label = document.createElement("label"),
        check = document.createElement("input");
      check.type = "checkbox";
      check.checked = f.visible;
      check.setAttribute("aria-label", `Show Floor ${i + 1}`);
      check.onchange = () => {
        f.visible = check.checked;
        draw();
      };
      label.append(check, document.createTextNode(` Floor ${i + 1}`));
      $("vFloorVisibility").append(label);
    });
  }
  floorUI();
  function stashFloor() {
    floorState[activeFloor].snapshot = captureFloor();
  }
  function captureFloor() {
    return {
      params: parameters(),
      result,
      editing: editing?.save(),
      view: { activeZone, showAllZones },
      stage,
      resetStepMenu,
      wire,
      ghosted,
    };
  }
  function restoreFloor(
    snapshot,
    autoBuild = true,
    keepStage = false,
    exactStage = false,
  ) {
    resetStepMenu = keepStage || !!snapshot.resetStepMenu;
    const params = snapshot.params;
    restoreBoundary(params);
    restoreZoneView(snapshot.view);
    for (const [id] of fields)
      if (params[id] !== undefined)
        $("vn_" + id).value = $("v_" + id).value = params[id];
    zoneUI(!!boundary);
    editing?.load(snapshot.editing);
    result = snapshot.result ?? null;
    stage =
      !exactStage && !keepStage && [3, 5, 6].includes(snapshot.stage)
        ? 4
        : (snapshot.stage ?? 0);
    wire = !!snapshot.wire;
    ghosted = !!snapshot.ghosted;
    fitNext = true;
    draw();
    if (autoBuild && !result && !pending) generate("prepare");
  }
  $("vFloor").onchange = () => {
    if (pending) {
      $("vFloor").value = activeFloor;
      $("vStatus").textContent =
        "Wait for the current floor to finish building.";
      return;
    }
    stashFloor();
    activeFloor = Number($("vFloor").value);
    resetStepMenu = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
      $("vPlay").textContent = "PLAY STEPS";
    }
    if (floorState[activeFloor].snapshot)
      restoreFloor(floorState[activeFloor].snapshot, true, true);
    else {
      stage = 0;
      boundary = null;
      legacyRectangle = false;
      zoneConfigs = [];
      populatedZones = [];
      activeZone = 0;
      result = null;
      editing?.load({});
      zoneUI();
      draw();
      $("vStatus").textContent =
        `Import the outline for Floor ${activeFloor + 1}.`;
    }
  };
  $("vPickZone").onclick = () => {
    pickZone = !pickZone;
    draw();
    $("vStatus").textContent = pickZone
      ? "Click a zone in perspective or plan to select its floor and isolate it for editing."
      : "Zone picking off.";
  };
  $("vIsolateCanvas").onclick = () => {
    $("vIsolateZone").checked = !isolateZone;
    $("vIsolateZone").onchange();
  };
  $("vIsolateZone").onchange = () => {
    isolateZone = $("vIsolateZone").checked;
    if (!isolateZone) {
      showAllZones = true;
      zoneUI(false);
    }
    draw();
    fit();
  };
  function saveBuilding() {
    stashFloor();
    return { activeFloor, isolateZone, floors: structuredClone(floorState) };
  }
  function loadBuilding(building) {
    if (
      !building?.floors ||
      !building.floors.length ||
      building.floors.length > 20
    )
      return;
    floorState.splice(
      0,
      floorState.length,
      ...structuredClone(building.floors),
    );
    floorUI();
    building.floors.forEach((f, i) => Object.assign(floorState[i], f));
    activeFloor = Math.max(
      0,
      Math.min(floorState.length - 1, building.activeFloor ?? 0),
    );
    isolateZone = !!building.isolateZone;
    $("vFloor").value = activeFloor;
    $("vIsolateZone").checked = isolateZone;
    [...$("vFloorVisibility").querySelectorAll("input")].forEach(
      (c, i) => (c.checked = floorState[i].visible),
    );
    if (floorState[activeFloor].snapshot)
      restoreFloor(floorState[activeFloor].snapshot);
  }
  let editing;
  let worker,
    result,
    pending = false,
    mode = "roof",
    wire = false,
    ghosted = false,
    fitNext = true;
  const scene = new T.Scene(),
    group = new T.Group();
  scene.add(group, new T.AmbientLight(0xaff6ff, 2));
  const light = new T.DirectionalLight(0xaff6ff, 3);
  light.position.set(80, -80, 140);
  scene.add(light);
  const camera = new T.PerspectiveCamera(38, 1, 0.01, 10000);
  camera.up.set(0, 0, 1);
  const plan = new T.OrthographicCamera(-50, 50, 35, -35, 0.01, 10000);
  plan.up.set(0, 1, 0);
  const renderers = ["vPerspective", "vPlan"].map((id) => {
    const r = new T.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setClearColor(0, 0);
    $(id).append(r.domElement);
    return r;
  });
  const orbit = new OrbitControls(camera, renderers[0].domElement);
  orbit.enableDamping = true;
  const sectionPlane = new T.Plane(new T.Vector3(0, 0, 1), 0);
  const sectionCuts = new T.Group();
  scene.add(sectionCuts);
  let sectionCutsDirty = true;
  const sectionPivot = new T.Object3D();
  const sectionOutline = new T.PlaneHelper(sectionPlane, 1, 0xffffff);
  const sectionControl = new TransformControls(camera, renderers[0].domElement);
  const sectionGizmo = sectionControl.getHelper();
  let sectionEnabled = false;
  let orbitBeforeSectionDrag = true;
  sectionControl.setMode("translate");
  sectionControl.setSize(0.85);
  sectionControl.setColors(0x9af4f9, 0x21e0ed, 0x789fe8, 0xffffff);
  sectionControl.enabled = false;
  sectionOutline.visible = false;
  const sectionOverlay = new T.Scene();
  sectionOverlay.add(sectionGizmo);
  scene.add(sectionPivot, sectionOutline);
  function updateSectionPlane() {
    sectionCutsDirty = true;
    const normal = new T.Vector3(0, 0, 1).applyQuaternion(
      sectionPivot.quaternion,
    );
    sectionPlane.setFromNormalAndCoplanarPoint(normal, sectionPivot.position);
  }
  sectionControl.addEventListener("objectChange", updateSectionPlane);
  const sectionCanvas = renderers[0].domElement;
  const degreeEntry = document.createElement("input");
  degreeEntry.type = "number";
  degreeEntry.step = "any";
  degreeEntry.className = "section-degree-entry";
  degreeEntry.hidden = true;
  sectionCanvas.parentElement.append(degreeEntry);
  const axes = {
    X: new T.Vector3(1, 0, 0),
    Y: new T.Vector3(0, 1, 0),
    Z: new T.Vector3(0, 0, 1),
  };
  let rotationAxis;
  let press;
  let release;
  sectionCanvas.addEventListener(
    "pointerdown",
    (event) => {
      press = { x: event.clientX, y: event.clientY, moved: false };
      release = null;
    },
    true,
  );
  sectionCanvas.addEventListener(
    "pointermove",
    (event) => {
      if (
        press &&
        Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4
      ) {
        press.moved = true;
      }
    },
    true,
  );
  sectionCanvas.addEventListener(
    "pointerup",
    (event) => {
      release =
        press &&
        !press.moved &&
        Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 4
          ? event
          : null;
      press = null;
    },
    true,
  );
  sectionControl.addEventListener("mouseUp", () => {
    const axis = sectionControl.axis;
    if (!release || !axes[axis]) return;
    rotationAxis = axes[axis];
    degreeEntry.setAttribute(
      "aria-label",
      `Rotate clipping plane about ${axis} in degrees`,
    );
    degreeEntry.placeholder = `${axis} degrees`;
    degreeEntry.value = "";
    degreeEntry.style.left = `${Math.max(4, Math.min(release.clientX + 10, innerWidth - 120))}px`;
    degreeEntry.style.top = `${Math.max(4, Math.min(release.clientY + 6, innerHeight - 42))}px`;
    degreeEntry.hidden = false;
    degreeEntry.focus({ preventScroll: true });
  });
  degreeEntry.addEventListener("blur", () => {
    degreeEntry.hidden = true;
  });
  degreeEntry.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") degreeEntry.blur();
    if (event.key !== "Enter") return;
    event.preventDefault();
    const degrees = degreeEntry.valueAsNumber;
    if (!Number.isFinite(degrees)) return;
    remember(captureUndo());
    sectionPivot.rotateOnWorldAxis(
      rotationAxis,
      T.MathUtils.degToRad(degrees % 360),
    );
    updateSectionPlane();
    degreeEntry.blur();
  });
  sectionControl.addEventListener("dragging-changed", ({ value }) => {
    if (value) {
      orbitBeforeSectionDrag = orbit.enabled;
      orbit.enabled = false;
    } else {
      orbit.enabled = orbitBeforeSectionDrag;
    }
  });
  $("vSection").onclick = () => {
    degreeEntry.hidden = true;
    sectionEnabled = !sectionEnabled;
    sectionControl.enabled = sectionEnabled;
    sectionOutline.visible = sectionEnabled;
    if (sectionEnabled) {
      sectionControl.setMode("translate");
      sectionPivot.position.copy(orbit.target);
      updateSectionPlane();
      sectionOutline.size = Math.max(
        result?.params.width ?? 10,
        result?.params.height ?? 10,
      );
      sectionControl.attach(sectionPivot);
    } else {
      sectionControl.detach();
    }
    syncSectionButtons();
    draw();
  };
  $("vSectionMove").onclick = () => {
    const moving = sectionControl.getMode() === "rotate";
    sectionControl.setMode(moving ? "translate" : "rotate");
    syncSectionButtons();
  };
  function syncSectionButtons() {
    $("vSection").setAttribute("aria-pressed", sectionEnabled);
    $("vSectionMove").hidden = !sectionEnabled;
    const rotating = sectionControl.getMode() === "rotate";
    $("vSectionMove").textContent = rotating ? "MOVE PLANE" : "ROTATE PLANE";
    $("vSectionMove").setAttribute("aria-pressed", rotating);
  }

  const journal = new UndoJournal();
  function captureUndo() {
    const floors = floorState.map((floor, index) => ({
      ...floor,
      snapshot:
        index === activeFloor
          ? captureFloor()
          : floor.snapshot && { ...floor.snapshot },
    }));
    // Worker results are replaced, so keep references to the large mesh buffers.
    const signature = JSON.stringify({
      floors: floors.map(({ snapshot, ...floor }) => ({
        ...floor,
        snapshot: snapshot && { ...snapshot, result: undefined },
      })),
      activeFloor,
      isolateZone,
      mode,
      pickZone,
      sectionEnabled,
      cameraPosition: camera.position.toArray(),
      orbitTarget: orbit.target.toArray(),
      sectionMode: sectionControl.getMode(),
      position: sectionPivot.position.toArray(),
      rotation: sectionPivot.quaternion.toArray(),
    });
    return { floors, signature };
  }
  function sameUndoState(a, b) {
    return (
      a.signature === b.signature &&
      a.floors.every(
        (floor, index) =>
          floor.snapshot?.result === b.floors[index].snapshot?.result,
      )
    );
  }
  function remember(entry) {
    if (pending || backgroundTasks || !entry) return;
    if (!journal.length || !sameUndoState(entry, journal.peek()))
      journal.push(entry);
    $("vUndo").disabled = !journal.length;
  }
  function undo() {
    if (pending || backgroundTasks) return;
    const current = captureUndo();
    while (journal.length && sameUndoState(journal.peek(), current))
      journal.pop();
    const entry = journal.pop();
    $("vUndo").disabled = !journal.length;
    if (!entry) return;
    if (timer) {
      clearInterval(timer);
      timer = null;
      $("vPlay").textContent = "PLAY STEPS";
    }
    const state = JSON.parse(entry.signature);
    ({ activeFloor, isolateZone, mode, pickZone, sectionEnabled } = state);
    floorState.splice(0, floorState.length, ...entry.floors);
    floorUI();
    $("vIsolateZone").checked = isolateZone;
    sectionPivot.position.fromArray(state.position);
    sectionPivot.quaternion.fromArray(state.rotation);
    sectionControl.setMode(state.sectionMode);
    sectionControl.enabled = sectionEnabled;
    if (sectionEnabled) sectionControl.attach(sectionPivot);
    else sectionControl.detach();
    sectionOutline.visible = sectionEnabled;
    degreeEntry.hidden = true;
    updateSectionPlane();
    syncSectionButtons();
    restoreFloor(floorState[activeFloor].snapshot, false, false, true);
    camera.position.fromArray(state.cameraPosition);
    orbit.target.fromArray(state.orbitTarget);
    orbit.update();
    updateFloorReport();
    $("vStatus").textContent = "Last workspace action undone.";
  }
  $("vUndo").onclick = undo;
  window.addEventListener("keydown", (event) => {
    if (!pane.hidden && isUndoShortcut(event)) {
      event.preventDefault();
      undo();
    }
  });
  let inputStart;
  pane.addEventListener("focusin", ({ target }) => {
    if (target.matches("input, select") && target !== degreeEntry)
      inputStart = captureUndo();
  });
  pane.addEventListener(
    "pointerdown",
    ({ target }) => {
      if (target.matches("canvas")) remember(captureUndo());
      else if (target.matches("input, select") && target !== degreeEntry)
        inputStart = captureUndo();
    },
    true,
  );
  pane.addEventListener(
    "change",
    ({ target }) => {
      if (target === degreeEntry || target.type === "file") return;
      remember(inputStart);
      inputStart = null;
      queueMicrotask(() => {
        if (document.activeElement === target) inputStart = captureUndo();
      });
    },
    true,
  );
  pane.addEventListener(
    "click",
    ({ target }) => {
      const button = target.closest("button");
      if (button && !button.matches("#vUndo, #vObj, #v3dm, #vSave"))
        remember(captureUndo());
    },
    true,
  );
  sectionCanvas.addEventListener("wheel", () => remember(captureUndo()), {
    capture: true,
    passive: true,
  });
  const diagram = new T.Scene();
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
      } else if (result) {
        const width = result.params.width,
          height = result.params.height,
          aspect = w / h;
        plan.left = -Math.max(width, height * aspect) * 0.58;
        plan.right = -plan.left;
        plan.top = plan.right / aspect;
        plan.bottom = -plan.top;
        plan.updateProjectionMatrix();
      }
    });
  }
  renderers.forEach((r) =>
    new ResizeObserver(resize).observe(r.domElement.parentElement),
  );
  function clear(g) {
    for (const child of [...g.children]) {
      g.remove(child);
      child.traverse((o) => {
        o.geometry?.dispose();
        if (o.material) o.material.dispose();
      });
    }
  }
  function fit() {
    if (!result) return;
    if (!isolateZone) {
      const box = new T.Box3().setFromObject(group);
      if (!box.isEmpty()) {
        const center = box.getCenter(new T.Vector3()),
          size = box.getSize(new T.Vector3()),
          span = Math.max(size.x, size.y, size.z, 10);
        orbit.target.copy(center);
        camera.position.copy(center).add(new T.Vector3(span, -span, span));
        camera.lookAt(center);
        const [x, y] = result.params.origin ?? [0, 0];
        plan.position.set(
          x + result.params.width / 2,
          y + result.params.height / 2,
          box.max.z + span * 3,
        );
        plan.lookAt(
          x + result.params.width / 2,
          y + result.params.height / 2,
          box.min.z,
        );
        resize();
        return;
      }
    }
    if (isolateZone) {
      const box = new T.Box3().setFromObject(group);
      if (!box.isEmpty()) {
        const center = box.getCenter(new T.Vector3()),
          size = box.getSize(new T.Vector3()),
          span = Math.max(size.x, size.y, size.z, 10);
        orbit.target.copy(center);
        camera.position.copy(center).add(new T.Vector3(span, -span, span));
        camera.lookAt(center);
        resize();
        return;
      }
    }
    const { width: w, height: h } = result.params;
    const [x0, y0] = result.params.origin ?? [0, 0],
      z0 = result.params.floor;
    orbit.target.set(x0 + w / 2, y0 + h / 2, z0);
    camera.position.set(x0 + w * 1.1, y0 - w * 0.9, z0 + w * 0.9);
    camera.lookAt(orbit.target);
    plan.position.set(x0 + w / 2, y0 + h / 2, z0 + w * 3);
    plan.lookAt(x0 + w / 2, y0 + h / 2, z0);
    resize();
  }
  const enclosurePreviews = new WeakMap();
  function softenEnclosure(raw, floor) {
    const cached = enclosurePreviews.get(raw);
    if (cached?.floor === floor) return cached.mesh;
    const neighbors = Array.from(
      { length: raw.positions.length / 3 },
      () => new Set(),
    );
    for (let i = 0; i < raw.indices.length; i += 3) {
      for (let j = 0; j < 3; j++) {
        const a = raw.indices[i + j],
          b = raw.indices[i + ((j + 1) % 3)];
        neighbors[a].add(b);
        neighbors[b].add(a);
      }
    }
    const movable = neighbors.map(
      (ring, i) =>
        ring.size > 0 && Math.abs(raw.positions[i * 3 + 2] - floor) > 1e-5,
    );
    let positions = Float64Array.from(raw.positions);
    let next = positions.slice();
    for (let pass = 0; pass < 24; pass++) {
      for (let i = 0; i < neighbors.length; i++) {
        if (!movable[i]) continue;
        const ring = neighbors[i];
        let sumX = 0,
          sumY = 0,
          sumZ = 0;
        for (const j of ring) {
          const neighbor = j * 3;
          sumX += positions[neighbor];
          sumY += positions[neighbor + 1];
          sumZ += positions[neighbor + 2];
        }
        const k = i * 3;
        next[k] = positions[k] + 0.42 * (sumX / ring.size - positions[k]);
        next[k + 1] =
          positions[k + 1] + 0.42 * (sumY / ring.size - positions[k + 1]);
        const z =
          positions[k + 2] + 0.42 * (sumZ / ring.size - positions[k + 2]);
        next[k + 2] = raw.positions[k + 2] >= floor ? Math.max(floor, z) : z;
      }
      [positions, next] = [next, positions];
    }
    const mesh = { positions, indices: raw.indices };
    enclosurePreviews.set(raw, { floor, mesh });
    return mesh;
  }
  function enclosureGeometry(raw) {
    const g = geometry(raw);
    const smooth = toCreasedNormals(g, Math.PI * 0.65);
    if (smooth !== g) g.dispose();
    return smooth;
  }
  function updateSectionCuts() {
    sectionCutsDirty = false;
    clear(sectionCuts);
    if (!sectionEnabled || stage < 4) return;
    group.updateMatrixWorld(true);
    const inverse = new T.Matrix4();
    const localPlane = new T.Plane();
    const vertices = Array.from({ length: 3 }, () => new T.Vector3());
    const distances = new Float64Array(3);
    const point = new T.Vector3();
    const epsilon = 1e-7;
    group.traverseVisible((mesh) => {
      if (!mesh.isMesh || !mesh.material.clippingPlanes?.includes(sectionPlane))
        return;
      const geometry = mesh.geometry;
      const position = geometry.getAttribute("position");
      const index = geometry.getIndex();
      inverse.copy(mesh.matrixWorld).invert();
      localPlane.copy(sectionPlane).applyMatrix4(inverse);
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!localPlane.intersectsBox(geometry.boundingBox)) return;
      const segments = [];
      for (let i = 0; i < (index?.count ?? position.count); i += 3) {
        for (let j = 0; j < 3; j++) {
          vertices[j].fromBufferAttribute(
            position,
            index ? index.getX(i + j) : i + j,
          );
          const distance = localPlane.distanceToPoint(vertices[j]);
          distances[j] = Math.abs(distance) <= epsilon ? 0 : distance;
        }
        if (
          Math.min(distances[0], distances[1], distances[2]) >= 0 ||
          Math.max(distances[0], distances[1], distances[2]) < 0
        )
          continue;
        const start = segments.length;
        for (let j = 0; j < 3; j++) {
          const k = (j + 1) % 3;
          const a = distances[j],
            b = distances[k];
          if (a === 0) point.copy(vertices[j]);
          else if (a * b < 0)
            point.copy(vertices[j]).lerp(vertices[k], a / (a - b));
          else continue;
          point.applyMatrix4(mesh.matrixWorld);
          segments.push(point.x, point.y, point.z);
        }
        if (segments.length - start !== 6) segments.length = start;
      }
      if (!segments.length) return;
      const lines = new LineSegments2(
        new LineSegmentsGeometry().setPositions(segments),
        new LineMaterial({
          color: 0xffffff,
          linewidth: 2,
          clipping: true,
          clippingPlanes: mesh.material.clippingPlanes.filter(
            (plane) => plane !== sectionPlane,
          ),
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -2,
        }),
      );
      lines.renderOrder = 2;
      sectionCuts.add(lines);
    });
  }
  function draw() {
    sectionCutsDirty = true;
    for (const o of zonePickTargets) {
      o.geometry.dispose();
      o.material.dispose();
    }
    zonePickTargets = [];
    const floorSources = floorState.map((f, i) => ({
      floor: i,
      visible: f.visible,
      params:
        i === activeFloor
          ? (result?.params ?? (boundary ? { boundary } : null))
          : f.snapshot?.params,
      result: i === activeFloor ? result : f.snapshot?.result,
    }));
    $("vUploadPrompt").hidden = !!(
      boundary ||
      result ||
      floorSources.some(
        (source) =>
          source.visible &&
          !isolateZone &&
          (source.params?.boundary || source.result),
      )
    );
    for (const source of floorSources) {
      if (!source.visible || (isolateZone && source.floor !== activeFloor))
        continue;
      source.params?.boundary?.zones.forEach((z, zone) => {
        if (isolateZone && zone !== activeZone) return;
        const shapes = T.ShapeUtils.isClockWise(
          z.loops[0].map((p) => new T.Vector2(...p)),
        )
          ? z.loops[0].slice().reverse()
          : z.loops[0];
        const shape = new T.Shape(shapes.map((p) => new T.Vector2(...p)));
        z.loops
          .slice(1)
          .forEach((loop) =>
            shape.holes.push(new T.Path(loop.map((p) => new T.Vector2(...p)))),
          );
        const base = new T.ShapeGeometry(shape);
        base.translate(0, 0, source.params.boundary.elevation ?? 0);
        const targets = [base];
        const raw = source.result?.zones?.[zone]?.raw;
        if (raw?.indices.length) targets.push(geometry(raw));
        for (const g of targets) {
          const proxy = new T.Mesh(
            g,
            new T.MeshBasicMaterial({ side: T.DoubleSide }),
          );
          proxy.userData = { floor: source.floor, zone };
          proxy.updateMatrixWorld();
          zonePickTargets.push(proxy);
        }
      });
    }
    $("vPickZone").setAttribute("aria-pressed", pickZone);
    $("vIsolateCanvas").setAttribute("aria-pressed", isolateZone);
    clear(group);
    clear(diagram);
    if (!isolateZone)
      floorState.forEach((f, i) => {
        if (i === activeFloor || !f.visible || !f.snapshot) return;
        const stage = f.snapshot.stage ?? 0;
        const r = f.snapshot.result,
          b = f.snapshot.params.boundary;
        if (r?.spheres.length && (stage === 4 || stage === 5)) {
          for (const s of r.spheres) {
            const mesh = new T.Mesh(
              s.raw ? geometry(s.raw) : new T.SphereGeometry(s.radius, 64, 40),
              new T.MeshPhysicalMaterial({
                color: 0x4e9fa9,
                roughness: 0.3,
                metalness: 0.2,
                transparent: true,
                opacity: 1,
                side: T.DoubleSide,
                clippingPlanes:
                  !r.params.unclippedBalloons && stage === 5
                    ? [new T.Plane(new T.Vector3(0, 0, 1), -r.params.floor)]
                    : [],
              }),
            );
            if (!s.raw) {
              mesh.position.set(...s.center);
              mesh.scale.fromArray(s.axisScale || [1, 1, 1]);
            }
            if (wire) {
              const lines = quadWire(s.raw || rawGeometry(mesh.geometry));
              lines.material.clippingPlanes = mesh.material.clippingPlanes;
              mesh.add(lines);
            }
            mesh.userData.otherFloor = true;
            group.add(mesh);
          }
        } else if (r?.raw.indices.length && stage >= 6) {
          let raw = r.raw;
          if (stage === 6)
            raw = {
              positions: raw.positions,
              indices: Uint32Array.from(
                Array.from({ length: raw.indices.length / 3 }, (_, i) =>
                  Array.from(raw.indices.slice(i * 3, i * 3 + 3)),
                )
                  .filter((t) =>
                    t.every(
                      (j) =>
                        Math.abs(raw.positions[j * 3 + 2] - r.params.floor) <
                        1e-6,
                    ),
                  )
                  .flat(),
              ),
            };
          const mesh = new T.Mesh(
            enclosureGeometry(
              stage === 7 ? softenEnclosure(raw, r.params.floor) : raw,
            ),
            new T.MeshPhysicalMaterial({
              color: 0x4e9fa9,
              roughness: 0.55,
              metalness: 0.2,
              side: T.DoubleSide,
            }),
          );
          mesh.userData.otherFloor = true;
          group.add(mesh);
        }
        if (r && stage >= 1 && stage <= 3) {
          const chosen = new Set(stage >= 3 ? r.ids : []),
            z = r.params.floor + 0.06;
          r.points.forEach((p, id) => {
            if (!p) return;
            const dot = new T.Mesh(
              new T.CircleGeometry(r.params.width * 0.006, 12),
              new T.MeshBasicMaterial({
                color: chosen.has(id) ? 0xdc24f4 : 0x21e0ed,
                side: T.DoubleSide,
              }),
            );
            dot.position.set(...p, z);
            dot.userData.otherFloor = true;
            group.add(dot);
            if (stage >= 2)
              for (const loop of r.cellLoops?.[id]?.length
                ? r.cellLoops[id]
                : r.cells[id]?.length
                  ? [r.cells[id]]
                  : []) {
                const line = new T.LineLoop(
                  new T.BufferGeometry().setFromPoints(
                    loop.map((p) => new T.Vector3(...p, z)),
                  ),
                  new T.LineBasicMaterial({
                    color: chosen.has(id) ? 0xdc24f4 : 0x21e0ed,
                    transparent: true,
                    opacity: chosen.has(id) ? 1 : 0.45,
                  }),
                );
                line.userData.otherFloor = true;
                group.add(line);
              }
          });
        }
        if (b)
          for (const z of b.zones)
            for (const loop of z.loops) {
              const line = new T.LineLoop(
                new T.BufferGeometry().setFromPoints(
                  loop.map((p) => new T.Vector3(...p, b.elevation ?? 0)),
                ),
                new T.LineBasicMaterial({ color: 0x21e0ed }),
              );
              line.userData.otherFloor = true;
              group.add(line);
            }
      });
    // Context floors never enter the balloon editor's pick list. Draw them faintly
    // without writing depth, so they cannot conceal the active editing floor.
    for (const child of group.children)
      if (child.userData.otherFloor)
        child.traverse((o) => {
          if (!o.material) return;
          for (const material of Array.isArray(o.material)
            ? o.material
            : [o.material]) {
            material.transparent = true;
            material.opacity = o.isMesh ? 0.18 : 0.25;
            material.depthWrite = false;
          }
          o.renderOrder = -1;
        });
    const descriptions = [
      "Imported outer perimeter and subdivision zones.",
      "Deterministic candidate centers inside the rectangle.",
      "Original Voronoi territories for every seed.",
      "Click a Voronoi center to set the anchor index and rebuild its nearest cluster. Drag empty space to orbit.",
      "Full balloons grow from seeds inside the imported curves; zone and perimeter edges do not cut them. The underside is clipped at the floor plate.",
      "Sphere preview split at the horizontal floor plane.",
      "Union of original sphere sections, filled as one floor footprint.",
      "Union of the actual rounded balloon meshes. The rounded surfaces are retained, with a flat cut only at the floor plate.",
    ];
    const menuStage = resetStepMenu ? 0 : stage;
    $("vStage").value = menuStage;
    $("vStepDescription").textContent = descriptions[menuStage];
    $("vPrevious").disabled = menuStage === 0;
    $("vNext").disabled = menuStage === 7;
    if (!result) return;
    $("vPickAnchor").setAttribute("aria-pressed", stage >= 1 && stage <= 3);
    $("vRoof").setAttribute("aria-pressed", stage === 7);
    $("vSpheres").setAttribute("aria-pressed", stage === 4 || stage === 5);
    const visibleZone =
      result.params.boundary && (isolateZone || !showAllZones)
        ? activeZone
        : null;
    const visible = (id) =>
      visibleZone === null || Math.floor(id / ZONE_STRIDE) === visibleZone;
    const preview = visibleZone === null ? result : result.zones[visibleZone];
    editing?.setVisibleZone(visibleZone);
    const balloonMeshes = [];
    if (stage === 7 || stage === 6) {
      const mat = new T.MeshPhysicalMaterial({
        color: 0x4e9fa9,
        roughness: 0.55,
        metalness: 0.2,
        side: T.DoubleSide,
        wireframe: false,
      });
      let raw = preview.raw;
      if (stage === 6)
        raw = {
          positions: raw.positions,
          indices: Uint32Array.from(
            Array.from({ length: raw.indices.length / 3 }, (_, i) =>
              Array.from(raw.indices.slice(i * 3, i * 3 + 3)),
            )
              .filter((t) =>
                t.every(
                  (j) =>
                    Math.abs(raw.positions[j * 3 + 2] - result.params.floor) <
                    1e-8,
                ),
              )
              .flat(),
          ),
        };
      if (stage === 7) raw = softenEnclosure(raw, result.params.floor);
      const smooth = enclosureGeometry(raw);
      const mesh = new T.Mesh(smooth, mat);
      if (wire) mesh.add(quadWire(raw));
      group.add(mesh);
    } else if (stage === 4 || stage === 5) {
      const { width: w, height: h, floor } = result.params;
      const planes = [
        new T.Plane(new T.Vector3(1, 0, 0), 0),
        new T.Plane(new T.Vector3(-1, 0, 0), w),
        new T.Plane(new T.Vector3(0, 1, 0), 0),
        new T.Plane(new T.Vector3(0, -1, 0), h),
        new T.Plane(new T.Vector3(0, 0, 1), -floor),
      ];
      renderers[0].localClippingEnabled = true;
      for (const s of result.spheres.filter((s) => visible(s.id))) {
        const mesh = new T.Mesh(
          s.raw ? geometry(s.raw) : new T.SphereGeometry(s.radius, 64, 40),
          new T.MeshPhysicalMaterial({
            color: 0x4e9fa9,
            roughness: 0.3,
            metalness: 0.2,
            transparent: true,
            opacity: 1,
            side: T.DoubleSide,
            wireframe: false,
            clippingPlanes: result.params.unclippedBalloons
              ? []
              : result.params.boundary
                ? stage === 4
                  ? []
                  : [planes[4]]
                : stage === 4
                  ? planes.slice(0, 4)
                  : planes,
          }),
        );
        if (!s.raw) {
          mesh.position.set(...s.center);
          mesh.scale.fromArray(s.axisScale || [1, 1, 1]);
        }
        if (wire) {
          const lines = quadWire(s.raw || rawGeometry(mesh.geometry));
          lines.material.clippingPlanes = result.params.unclippedBalloons
            ? []
            : stage === 4
              ? planes.slice(0, 4)
              : planes;
          mesh.add(lines);
        }
        mesh.userData.balloonId = s.id;
        balloonMeshes.push(mesh);
        group.add(mesh);
      }
    }
    const { width: w, height: h } = result.params;
    const perimeter = result.params.boundary?.perimeter ?? [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ];
    const drawLoop = (loop, color, opacity = 1) => {
      diagram.add(
        new T.LineLoop(
          new T.BufferGeometry().setFromPoints(
            loop.map((p) => new T.Vector3(...p, result.params.floor + 0.05)),
          ),
          new T.LineBasicMaterial({ color, transparent: true, opacity }),
        ),
      );
    };
    if (!isolateZone) drawLoop(perimeter, 0x21e0ed);
    result.params.boundary?.zones.forEach(
      (z, i) =>
        (!isolateZone || i === activeZone) &&
        z.loops.forEach((loop) =>
          drawLoop(
            loop,
            i === activeZone ? 0xdc24f4 : 0x21e0ed,
            i === activeZone ? 1 : 0.45,
          ),
        ),
    );
    const chosen = new Set(stage >= 3 ? result.ids : []);
    result.cells.forEach((cell, i) => {
      if (!cell.length || !visible(i)) return;
      for (const outline of result.cellLoops?.[i]?.length
        ? result.cellLoops[i]
        : [cell]) {
        const line = new T.LineLoop(
          new T.BufferGeometry().setFromPoints(
            outline.map((p) => new T.Vector3(...p, result.params.floor + 0.08)),
          ),
          new T.LineBasicMaterial({
            color: chosen.has(i) ? 0xdc24f4 : 0x21e0ed,
            transparent: true,
            opacity: chosen.has(i) ? 1 : 0.45,
          }),
        );
        if (stage >= 2) diagram.add(line);
        else {
          line.geometry.dispose();
          line.material.dispose();
        }
      }
      const dot = new T.Mesh(
        new T.CircleGeometry(
          result.params.width *
            (i ===
            (result.params.boundary
              ? activeZone * ZONE_STRIDE + zoneConfigs[activeZone].index
              : result.params.index)
              ? 0.01
              : 0.006),
          16,
        ),
        new T.MeshBasicMaterial({
          side: T.DoubleSide,
          color:
            i ===
            (result.params.boundary
              ? activeZone * ZONE_STRIDE + zoneConfigs[activeZone].index
              : result.params.index)
              ? 0xffffff
              : chosen.has(i)
                ? 0xdc24f4
                : 0x21e0ed,
        }),
      );
      dot.position.set(...result.points[i], result.params.floor + 0.1);
      if (stage >= 1) diagram.add(dot);
      else {
        dot.geometry.dispose();
        dot.material.dispose();
      }
    });
    for (const loop of stage >= 6 ? preview.loops : []) {
      const outline = new T.LineLoop(
        new T.BufferGeometry().setFromPoints(
          loop.map((p) => new T.Vector3(...p, result.params.floor + 0.2)),
        ),
        new T.LineBasicMaterial({ color: 0xffffff }),
      );
      diagram.add(outline);
    }
    if (stage <= 3 || result.params.boundary) {
      const overlay = diagram.clone(true);
      overlay.traverse((o) => {
        if (o.geometry) o.geometry = o.geometry.clone();
        if (o.material) o.material = o.material.clone();
      });
      group.add(overlay);
    }
    if (fitNext) {
      fit();
      fitNext = false;
    }
    if (!floorState[activeFloor].visible && !isolateZone) {
      for (const child of [...group.children])
        if (!child.userData.otherFloor) child.visible = false;
    }
    $("vGhost").setAttribute("aria-pressed", ghosted);
    if (ghosted) {
      for (const mesh of group.children) {
        if (!mesh.isMesh || mesh.userData.otherFloor) continue;
        mesh.material.transparent = true;
        mesh.material.opacity = 0.35;
        mesh.material.depthWrite = false;
      }
    }
    if (sectionEnabled && stage >= 4) {
      group.traverse((object) => {
        if (!object.material || (!object.isMesh && !object.isLineSegments))
          return;
        object.material.clippingPlanes = [
          ...(object.material.clippingPlanes ?? []),
          sectionPlane,
        ];
      });
    }
    editing?.update(balloonMeshes, pending);
  }
  function updateFloorReport() {
    if (!result) return;
    $("vReport").textContent = JSON.stringify(
      {
        activeFloor: activeFloor + 1,
        balloons: result.spheres.length,
        closed: result.closed,
        connectedComponents: result.components,
        nakedEdges: result.quality.boundaryEdges,
        nonManifoldEdges: result.quality.nonManifoldEdges,
        volumeCubicFeet: result.volume,
        zones: result.zones?.map((z) => ({
          name: z.name,
          balloons: z.balloons,
          closed: z.closed,
        })),
        floors: floorState.map((f, i) => ({
          floor: i + 1,
          balloons:
            (i === activeFloor ? result : f.snapshot?.result)?.spheres.length ??
            0,
        })),
      },
      null,
      2,
    );
  }
  function parameters() {
    if (boundary) {
      storeZone();
      return {
        unclippedBalloons: true,
        clipFloor: true,
        boundary: structuredClone(boundary),
        zoneSettings: structuredClone(zoneConfigs),
        populatedZones: [...populatedZones],
        width: boundary.bounds.width,
        height: boundary.bounds.height,
        origin: [...boundary.bounds.min],
        count: zoneConfigs.reduce((s, c) => s + c.count, 0),
        index: 0,
        floor: Number($("vn_floor").value),
        spacing: Number($("vn_spacing").value),
        smoothing: Number($("vn_smoothing").value),
        ...(editing?.settings() || {}),
      };
    }
    const width = Number($("vSize").value);
    return {
      unclippedBalloons: true,
      clipFloor: true,
      empty: !legacyRectangle,
      width,
      height: width * 0.625,
      ...Object.fromEntries(
        fields.map(([id]) => [id, Number($("vn_" + id).value)]),
      ),
      ...(editing?.settings() || {}),
    };
  }
  function generate(populate = false) {
    if (pending || (!boundary && !legacyRectangle)) return;
    if ((populate === "floor" || populate === "prepare") && boundary)
      populatedZones = populateAllZones(parameters()).populatedZones;
    if (populate === true && boundary && !populatedZones.includes(activeZone))
      populatedZones.push(activeZone);
    zoneUI(false);
    setPending(true);
    editing?.setBusy(true);
    $("vStatus").textContent = "Updating balloons and enclosure…";
    $("vGenerate").disabled = $("vPopulateCanvas").disabled = true;
    worker ??= workerFactory();
    worker.onmessage = ({ data }) => {
      setPending(false);
      $("vGenerate").disabled = $("vPopulateCanvas").disabled = false;
      if (data.error) {
        editing?.rejectBuild();
        editing?.setBusy(false);
        $("vStatus").textContent = data.error;
        return;
      }
      result = data.result;
      stashFloor();
      if (populate === true || populate === "floor") {
        if (populate === "floor") {
          showAllZones = true;
          isolateZone = false;
          $("vIsolateZone").checked = false;
          zoneUI(false);
        }
        if (timer) {
          clearInterval(timer);
          timer = null;
          $("vPlay").textContent = "PLAY STEPS";
        }
        resetStepMenu = false;
        stage = 4;
        mode = "spheres";
      }
      draw();
      const q = result.quality;
      $("vReport").textContent = JSON.stringify(
        {
          connectedComponents: result.components,
          closed: result.closed,
          nakedEdges: q.boundaryEdges,
          nonManifoldEdges: q.nonManifoldEdges,
          degenerateFaces: q.degenerateFaces,
          quadFaces: quadMesh(result.raw).quads.length / 4,
          volumeCubicFeet: result.volume,
          selectedOriginalIndices: result.ids,
          zones: result.zones?.map((z) => ({
            name: z.name,
            balloons: z.balloons,
            closed: z.closed,
            components: z.components,
            volumeCubicFeet: z.volume,
          })),
        },
        null,
        2,
      );
      $("vStatus").textContent = !result.spheres.length
        ? "Select a zone and press Populate Selected Zone."
        : result.closed && result.components === 1
          ? "One connected closed enclosure · 0 naked edges · 0 non-manifold edges"
          : `${result.components} component(s) · ${q.boundaryEdges} naked edges · ${q.nonManifoldEdges} non-manifold edges. Review the mesh report.`;
      if (JSON.stringify(parameters()) !== JSON.stringify(result.params))
        generate();
    };
    worker.onerror = (e) => {
      editing?.rejectBuild();
      editing?.setBusy(false);
      setPending(false);
      $("vGenerate").disabled = $("vPopulateCanvas").disabled = false;
      $("vStatus").textContent = e.message;
    };
    worker.postMessage({ id: 1, action: "voronoi", params: parameters() });
  }
  // Capture center clicks before balloon/curve editing, while leaving orbit drags alone.
  const zoneRay = new T.Raycaster();
  function zoneHit(e, renderer, cam) {
    const rect = renderer.domElement.getBoundingClientRect();
    cam.updateMatrixWorld();
    zoneRay.setFromCamera(
      new T.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      cam,
    );
    return zoneRay.intersectObjects(zonePickTargets, false)[0]?.object.userData;
  }
  renderers.forEach((renderer, index) => {
    let down = null;
    renderer.domElement.addEventListener(
      "pointerdown",
      (e) => {
        down = null;
        if (!pickZone || pending || e.button !== 0) return;
        const hit = zoneHit(e, renderer, index ? plan : camera);
        if (!hit) return;
        down = { ...hit, x: e.clientX, y: e.clientY };
        e.stopImmediatePropagation();
      },
      true,
    );
    renderer.domElement.addEventListener(
      "pointerup",
      (e) => {
        if (!down) return;
        const hit = down;
        down = null;
        e.stopImmediatePropagation();
        if (pending || Math.hypot(e.clientX - hit.x, e.clientY - hit.y) > 5)
          return;
        if (hit.floor !== activeFloor) {
          stashFloor();
          activeFloor = hit.floor;
          $("vFloor").value = activeFloor;
          const snapshot = floorState[activeFloor].snapshot;
          if (snapshot) restoreFloor(snapshot, true, true);
        }
        storeZone();
        activeZone = hit.zone;
        zoneUI();
        isolateZone = true;
        pickZone = false;
        $("vIsolateZone").checked = true;
        draw();
        editing?.selectZone(activeZone);
        fit();
        $("vStatus").textContent =
          `Floor ${activeFloor + 1} · ${boundary.zones[activeZone].name} isolated. Edit its balloons, or turn off Isolate Zone to return to the building.`;
      },
      true,
    );
    renderer.domElement.addEventListener(
      "pointercancel",
      () => {
        down = null;
      },
      true,
    );
  });
  const anchorCanvas = renderers[0].domElement;
  function centerAt(e) {
    if (!result || pending || stage < 1 || stage > 3) return null;
    const rect = anchorCanvas.getBoundingClientRect();
    camera.updateMatrixWorld();
    let nearest = null,
      distance = 16;
    result.points.forEach((point, index) => {
      if (
        !Array.isArray(point) ||
        (boundary &&
          !showAllZones &&
          Math.floor(index / ZONE_STRIDE) !== activeZone)
      )
        return;
      const [x, y] = point;
      const p = new T.Vector3(x, y, result.params.floor + 0.1).project(camera);
      if (p.z < -1 || p.z > 1) return;
      const d = Math.hypot(
        e.clientX - rect.left - ((p.x + 1) * rect.width) / 2,
        e.clientY - rect.top - ((1 - p.y) * rect.height) / 2,
      );
      if (d < distance) {
        nearest = index;
        distance = d;
      }
    });
    return nearest;
  }
  anchorCanvas.addEventListener(
    "pointerdown",
    (e) => {
      anchorDown = null;
      if (e.button !== 0) return;
      const index = centerAt(e);
      if (index === null) return;
      anchorDown = { index, x: e.clientX, y: e.clientY };
      e.stopImmediatePropagation();
    },
    true,
  );
  anchorCanvas.addEventListener(
    "pointerup",
    (e) => {
      const down = anchorDown;
      anchorDown = null;
      if (!down) return;
      e.stopImmediatePropagation();
      if (
        pending ||
        Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 ||
        centerAt(e) !== down.index
      )
        return;
      if (boundary) {
        storeZone();
        activeZone = Math.floor(down.index / ZONE_STRIDE);
        zoneUI();
      }
      $("v_index").value = $("vn_index").value = boundary
        ? down.index % ZONE_STRIDE
        : down.index;
      stage = 2;
      draw();
      generate();
    },
    true,
  );
  anchorCanvas.addEventListener(
    "pointercancel",
    () => {
      anchorDown = null;
    },
    true,
  );
  $("vPickAnchor").onclick = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
      $("vPlay").textContent = "PLAY STEPS";
    }
    stage = 2;
    draw();
    $("vStatus").textContent =
      "Click a Voronoi center in the perspective view to set its anchor index. The white center is the current anchor.";
  };
  fields.forEach(([id]) => {
    const range = $("v_" + id),
      number = $("vn_" + id);
    range.oninput = () => {
      number.value = range.value;
    };
    number.oninput = () => {
      range.value = number.value;
    };
    for (const input of [range, number])
      input.onchange = () => {
        if (id === "radiusMin" || id === "radiusMax") {
          const min = Number($("vn_radiusMin").value),
            max = Number($("vn_radiusMax").value);
          if (min > max) {
            const other = id === "radiusMin" ? "radiusMax" : "radiusMin";
            $("vn_" + other).value = $("v_" + other).value = Number(
              number.value,
            );
          }
        }
        if (id === "count") {
          const n = Number(number.value);
          for (const name of ["index", "selected"])
            for (const prefix of ["v_", "vn_"]) {
              const el = $(prefix + name);
              el.max = name === "index" ? n - 1 : n;
              el.value = Math.min(Number(el.value), Number(el.max));
            }
        }
        generate();
      };
  });
  $("vSize").onchange = () => {
    fitNext = true;
    generate();
  };
  $("vGenerate").onclick = $("vPopulateCanvas").onclick = () => generate(true);
  $("vPopulateFloor").onclick = () => {
    if (!boundary) {
      $("vStatus").textContent = "Import a zoned floor outline first.";
      return;
    }
    generate("floor");
  };
  $("vPopulateBuilding").onclick = async () => {
    if (pending) return;
    stashFloor();
    const next = structuredClone(floorState),
      targets = next.filter((f) => f.snapshot?.params.boundary);
    if (!targets.length) {
      $("vStatus").textContent =
        "Import at least one zoned floor outline first.";
      return;
    }
    setPending(true);
    editing?.setBusy(true);
    const locked = [...pane.querySelectorAll("input,button,select")].map(
      (el) => [el, el.disabled],
    );
    locked.forEach(([el]) => (el.disabled = true));
    const batchWorker = workerFactory();
    try {
      for (const f of targets) {
        $("vStatus").textContent = `Populating all zones on ${f.name}…`;
        const params = populateAllZones(f.snapshot.params);
        const built = await new Promise((resolve, reject) => {
          batchWorker.onmessage = ({ data }) =>
            data.error
              ? reject(Error(`${f.name}: ${data.error}`))
              : resolve(data.result);
          batchWorker.onerror = (e) => reject(Error(e.message));
          batchWorker.postMessage({ id: 1, action: "voronoi", params });
        });
        f.snapshot.params = params;
        f.snapshot.result = built;
        f.snapshot.stage = 4;
        f.snapshot.view.showAllZones = true;
      }
      next.forEach((f, i) => Object.assign(floorState[i], f));
      isolateZone = false;
      $("vIsolateZone").checked = false;
      setPending(false);
      restoreFloor(floorState[activeFloor].snapshot);
      $("vStatus").textContent =
        `All zones populated across ${targets.length} loaded floor(s). Existing edits retained.`;
    } catch (e) {
      $("vStatus").textContent = e.message;
    } finally {
      batchWorker.terminate();
      setPending(false);
      locked.forEach(([el, disabled]) => (el.disabled = disabled));
      editing?.setBusy(false);
      draw();
      fit();
    }
  };
  $("vFit").onclick = fit;
  $("vRoof").onclick = () => {
    resetStepMenu = false;
    stage = 7;
    mode = "roof";
    $("vRoof").setAttribute("aria-pressed", true);
    $("vSpheres").setAttribute("aria-pressed", false);
    draw();
  };
  $("vSpheres").onclick = () => {
    resetStepMenu = false;
    stage = 4;
    mode = "spheres";
    $("vRoof").setAttribute("aria-pressed", false);
    $("vSpheres").setAttribute("aria-pressed", true);
    draw();
  };
  $("vStage").onchange = () => {
    resetStepMenu = false;
    stage = Number($("vStage").value);
    draw();
  };
  $("vPrevious").onclick = () => {
    stage = [0, 1, 2, 4, 7][Math.max(0, [0, 1, 2, 4, 7].indexOf(stage) - 1)];
    draw();
  };
  $("vNext").onclick = () => {
    if (resetStepMenu) stage = 0;
    resetStepMenu = false;
    stage = [0, 1, 2, 4, 7][Math.min(4, [0, 1, 2, 4, 7].indexOf(stage) + 1)];
    draw();
  };
  $("vPlay").onclick = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
      $("vPlay").textContent = "PLAY STEPS";
      return;
    }
    resetStepMenu = false;
    stage = 0;
    draw();
    $("vPlay").textContent = "PAUSE";
    timer = setInterval(() => {
      if (pane.hidden) return;
      if (stage === 7) {
        clearInterval(timer);
        timer = null;
        $("vPlay").textContent = "PLAY STEPS";
        return;
      }
      stage = [0, 1, 2, 4, 7][Math.min(4, [0, 1, 2, 4, 7].indexOf(stage) + 1)];
      draw();
    }, 1800);
  };
  $("vGhost").onclick = () => {
    ghosted = !ghosted;
    draw();
  };
  $("vWire").onclick = () => {
    wire = !wire;
    $("vWire").setAttribute("aria-pressed", wire);
    draw();
  };
  const download = (data, name) => {
    const url = URL.createObjectURL(new Blob([data]));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  function accepted() {
    if (!result) throw Error("Generate an enclosure first.");
    const signature = (p) => {
      const q = { ...p };
      if (!q.pressureEnabled) {
        delete q.curves;
        delete q.strength;
        delete q.influence;
      }
      return JSON.stringify(q);
    };
    if (signature(parameters()) !== signature(result.params))
      throw Error("Controls changed. Generate again before exporting.");
    return result;
  }
  const guarded = (fn) => async () => {
    backgroundTasks++;
    updateLoading();
    try {
      await fn();
    } catch (e) {
      $("vStatus").textContent = e.message;
      $("vProjectMessage").textContent = e.message;
    } finally {
      backgroundTasks--;
      updateLoading();
    }
  };
  $("vObj").onclick = guarded(() => {
    const { raw } = accepted();
    if (!raw.indices.length) throw Error("Populate a zone first.");
    const text = quadObj(raw, "VoronoiBalloons").text;
    download(text, "voronoi-balloons.obj");
  });
  $("v3dm").onclick = guarded(async () => {
    const r = await rhino(),
      doc = new r.File3dm();
    try {
      doc.settings().modelUnitSystem = r.UnitSystem.Feet;
      addRhinoQuadMesh(r, doc, accepted().raw, "Voronoi Balloons / enclosure");
      download(doc.toByteArray(), "voronoi-balloons.3dm");
    } finally {
      doc.delete();
    }
  });
  $("vSave").onclick = guarded(() =>
    download(
      JSON.stringify(
        {
          building: saveBuilding(),
          format: "voronoi-balloons",
          version: 2,
          ...accepted(),
          editing: editing?.save(),
          view: { activeZone, showAllZones },
        },
        (_, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v),
      ),
      "voronoi-balloons.json",
    ),
  );
  $("vLoad").onchange = guarded(async () => {
    if (pending)
      throw Error("Wait for generation to finish before opening a project.");
    const file = $("vLoad").files[0];
    if (!file) return;
    $("vProjectMessage").textContent = `Opening ${file.name}…`;
    const before = captureUndo();
    const data = JSON.parse(await file.text());
    if (data.format !== "voronoi-balloons")
      throw Error("Open a Voronoi Balloons project.");
    remember(before);
    restoreBoundary(data.params);
    restoreZoneView(data.view);
    editing?.load(data.editing);
    $("vSize").value = data.params.width;
    for (const [id] of fields) {
      $("vn_" + id).value = data.params[id];
      $("v_" + id).value = data.params[id];
    }
    zoneUI(!!boundary);
    if (data.building) loadBuilding(data.building);
    let balloonCount = data.building
      ? data.building.floors.reduce(
          (n, f) => n + (f.snapshot?.result?.spheres?.length ?? 0),
          0,
        )
      : (data.spheres?.length ?? 0);
    const loadedFloors = data.building
      ? data.building.floors.filter(
          (f) =>
            f.snapshot?.params.boundary ||
            f.snapshot?.result?.raw.indices.length,
        ).length
      : 1;
    $("vProjectMessage").textContent =
      `Opened ${file.name}: ${loadedFloors} loaded floor(s), ${balloonCount} saved balloon(s).${balloonCount ? "" : " This project has no balloons yet. Use Populate All Zones on This Floor to create them."}`;
    $("vLoad").value = "";
    fitNext = true;
    if (data.building && result) {
      draw();
      updateFloorReport();
    } else generate();
  });
  mountGeometryLibrary({
    initiallyOpen: false,
    workspace: "voronoi",
    container: pane.querySelector(".voro-controls"),
    save: () => {
      if (pending) throw Error("Wait for generation to finish before saving.");
      return {
        building: saveBuilding(),
        format: "saved-voronoi-geometry",
        result: accepted(),
        editing: editing.save(),
        view: { activeZone, showAllZones },
        stage,
        wire,
        ghosted,
        report: $("vReport").textContent,
      };
    },
    load: (data) => {
      if (pending) throw Error("Wait for generation to finish before loading.");
      if (data.format !== "saved-voronoi-geometry" || !data.result?.raw)
        throw Error("Invalid saved Voronoi geometry.");
      if (!data.building) {
        const destination =
          boundary?.elevation ?? result?.params.floor ?? activeFloor * 20;
        data = placeSavedFloor(data, destination);
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
        $("vPlay").textContent = "PLAY STEPS";
      }
      result = structuredClone(data.result);
      restoreBoundary(result.params);
      restoreZoneView(data.view);
      $("vSize").value = result.params.width;
      for (const prefix of ["v_", "vn_"]) {
        $(prefix + "index").max = result.params.count - 1;
        $(prefix + "selected").max = result.params.count;
      }
      for (const [id] of fields) {
        $("vn_" + id).value = result.params[id];
        $("v_" + id).value = result.params[id];
      }
      stage = Math.max(0, Math.min(7, data.stage ?? 7));
      wire = !!data.wire;
      ghosted = !!data.ghosted;
      $("vWire").setAttribute("aria-pressed", wire);
      zoneUI(!!boundary);
      editing.load(data.editing);
      fitNext = true;
      draw();
      if (data.building) loadBuilding(data.building);
      stashFloor();
      updateFloorReport();
      $("vStatus").textContent = data.building
        ? "Saved building restored without regenerating."
        : `Saved floor restored on Floor ${activeFloor + 1} at Z=${result.params.floor} ft. Older saves replace the whole active floor, not a single zone.`;
    },
    thumbnail: () => canvasThumbnail(renderers[0], scene, camera),
  });
  const columns = initColumns(rhino, accepted);
  const showFacade = initFacade(
    facade,
    () => {
      if (pending || backgroundTasks)
        throw Error("Wait for Voronoi to finish processing.");
      return floorState
        .flatMap((floor, index) => {
          const current = index === activeFloor;
          const source = current ? boundary : floor.snapshot?.params.boundary;
          if (!source) return [];
          return [
            {
              loop: source.perimeter,
              z: source.elevation ?? 0,
              raw: (current ? result : floor.snapshot?.result)?.raw,
            },
          ];
        })
        .sort((a, b) => a.z - b.z);
    },
    rhino,
  );
  [...nav.children].forEach(
    (button, i) =>
      (button.onclick = () => {
        const facadeSelected =
          button.getAttribute("aria-controls") === facade.id;
        facade.hidden = !facadeSelected;
        if (facadeSelected) showFacade();
        existing.hidden = facadeSelected || i !== 2;
        pane.hidden = i !== 0;
        party.pane.hidden = i !== 3;
        columns.pane.hidden = i !== 1;
        document.querySelector(".header-actions").hidden = existing.hidden;
        [...nav.children].forEach((b, j) =>
          b.setAttribute("aria-pressed", i === j),
        );
        if (i === 3) party.show();
        if (i === 1) columns.show();
        if (!existing.hidden) showBalloonBuild();
        if (i === 0) {
          resize();
          if (!result && !pending) draw();
        }
      }),
  );
  pane
    .querySelectorAll(".panel")
    .forEach((panel, i) => (panel.dataset.frameCount = i + 1));
  addTechnicalFrames(pane);
  editing = createVoronoiEditing({
    pane,
    existing,
    scene,
    camera,
    plan,
    renderers,
    orbit,
    getResult: () => result,
    rebuild: generate,
    showBalloons: () => {
      resetStepMenu = false;
      stage = 4;
      draw();
    },
    rhino,
  });
  function frame() {
    requestAnimationFrame(frame);
    if (pane.hidden) return;
    orbit.update();
    if (sectionCutsDirty) updateSectionCuts();
    renderers[0].localClippingEnabled = true;
    renderers[0].render(scene, camera);
    if (result) editing?.renderPerspective(renderers[0]);
    if (sectionEnabled) {
      renderers[0].autoClear = false;
      renderers[0].clearDepth();
      renderers[0].render(sectionOverlay, camera);
      renderers[0].autoClear = true;
    }
    editing?.beforePlan();
    renderers[1].localClippingEnabled = true;
    sectionOutline.visible = sectionGizmo.visible = false;
    renderers[1].render(scene, plan);
    sectionOutline.visible = sectionGizmo.visible = sectionEnabled;
    renderers[1].autoClear = false;
    renderers[1].clearDepth();
    renderers[1].render(diagram, plan);
    renderers[1].autoClear = true;
    if (result) editing?.renderPlan(renderers[1], plan);
    editing?.afterPlan();
  }
  frame();
  zoneUI();
  nav.children[0].click();
  return {};
}
