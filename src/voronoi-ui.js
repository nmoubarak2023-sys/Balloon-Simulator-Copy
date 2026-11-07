import { populateAllZones } from "./zone-population.js";
import { placeSavedFloor } from "./floor-placement.js";
import { demoBoundary, loopBounds } from "./zones.js";
import { defaultZoneSettings, ZONE_STRIDE } from "./zoned-voronoi.js";
import { readBoundaryCurves } from "./rhino-zones.js";
import { initColumns } from "./column-ui.js";
import { mountGeometryLibrary, canvasThumbnail } from "./geometry-library.js";
import { quadObj, quadMesh } from "./quad-mesh.js";
import { addTechnicalFrames } from "./frames.js";
import { createVoronoiEditing } from "./voronoi-editing.js";
import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { geometry, rawGeometry, quadWire } from "./view.js";
import { addRhinoQuadMesh } from "./rhino-io.js";
export function initVoronoi(workerFactory, rhino, useAsBoundary, party) {
  const existing = document.querySelector("main"),
    pane = document.createElement("main");
  pane.id = "voronoiWorkspace";
  pane.hidden = true;
  const nav = document.createElement("nav");
  nav.className = "simulation-tabs";
  nav.setAttribute("aria-label", "Simulation workspaces");
  nav.innerHTML =
    '<button aria-pressed="true">VORONOI BALLOONS</button><button aria-pressed="false">COLUMN POPulate</button>';
  existing.before(nav);
  existing.after(pane);
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
  let boundary = demoBoundary(),
    zoneConfigs = defaultZoneSettings(boundary),
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
  pane.innerHTML = `<div class="voro-layout"><section class="panel"><div class="panel-heading"><span>PERSPECTIVE <small>01 / VORONOI BALLOONS</small></span><button id="vFit">FIT ↗</button></div><div class="canvas-tools"><button id="vRoof" aria-pressed="true">ENCLOSURE</button><button id="vSpheres" aria-pressed="false">BALLOONS</button><button id="vPickZone" aria-pressed="false">PICK ZONE</button><button id="vIsolateCanvas" aria-pressed="false">ISOLATE ZONE</button><button id="vPopulateCanvas">POPULATE SELECTED ZONE ↗</button><button id="vPickAnchor" aria-pressed="false">PICK ANCHOR CENTER</button><button id="vWire" aria-pressed="false">WIRE</button></div><div id="vPerspective" class="voro-canvas"></div><div class="viewer-footer">ROOF / FLAT FLOOR / PERIMETER ONLY</div></section><aside><section class="panel"><div class="panel-heading">PLAN VIEW <small>02 / CELLS & SELECTED SEEDS</small></div><div id="vPlan" class="voro-plan"></div></section><section class="panel"><div class="panel-heading">CONTROL PANEL <small>03 / INDEPENDENT SIMULATION</small></div><div class="voro-controls"><label class="button" for="vBoundaryFile">IMPORT FLOOR CURVES .3DM ↗</label><input id="vBoundaryFile" type="file" accept=".3dm" hidden><button id="vBoundaryDemo">EXAMPLE PERIMETER & ZONES</button><p id="vBoundaryInfo" class="note"></p><label>Population zone<select id="vZone"></select></label><p id="vZoneInfo" class="note"></p><label><input id="vShowAllZones" type="checkbox"> Show all zones</label><p class="note">Preview the selected zone, or show all populated zones. Exports include all populated zones.</p><p class="note">Import one closed perimeter and closed zone outlines or connected divider curves on the same horizontal plane. Rhino model units are converted to feet. Population controls below apply to the selected zone.</p><select id="vSize" hidden><option value="160">160</option><option value="80" selected>80</option><option value="40">40</option></select>${fields.map(([id, label, value, min, max, step]) => `<div class="control"><label for="v_${id}">${label}</label><input id="vn_${id}" type="number" value="${value}" min="${min}" max="${max}" step="${step}" aria-label="${label}"><input id="v_${id}" type="range" value="${value}" min="${min}" max="${max}" step="${step}"></div>`).join("")}<button id="vGenerate" class="primary">POPULATE SELECTED ZONE ↗</button><button id="vPopulateFloor">POPULATE ALL ZONES ON THIS FLOOR ↗</button><button id="vPopulateBuilding">POPULATE ALL LOADED FLOORS ↗</button><p class="note">These actions fill the remaining zones using each zone’s own settings. Existing edits, frozen balloons and popped balloons are preserved. Empty floor slots are skipped.</p><p class="note">Nearest-point selection retains original Voronoi cells. The roof uses the highest edited balloon surface; smoothing changes interior heights only. Disconnected footprints remain separate and are reported.</p><div class="pair"><button id="vObj">EXPORT .OBJ</button><button id="v3dm">EXPORT .3DM</button></div><button id="vSave">SAVE SETTINGS & DATA</button><label class="button" for="vLoad">OPEN VORONOI PROJECT</label><input hidden id="vLoad" type="file" accept=".json"><pre id="vReport" class="iteration-report">Generate an enclosure to check its mesh.</pre></div></section></aside></div><div class="status-bar" id="vStatus" role="status">Ready to generate.</div>`;
  const globalSettingsNote = document.createElement("p");
  globalSettingsNote.className = "note";
  globalSettingsNote.textContent =
    "Floor plane, mesh spacing and valley smoothing apply to all zones.";
  pane
    .querySelector("#vn_floor")
    .closest(".control")
    .before(globalSettingsNote);
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
      .map(
        (name, i) =>
          '<option value="' + i + '">' + (i + 1) + ". " + name + "</option>",
      )
      .join("") +
    '</select><button id="vNext">NEXT →</button><button id="vPlay">PLAY STEPS</button><p id="vStepDescription" class="note"></p>';
  pane.querySelector(".canvas-tools").after(stepbar);
  let anchorDown;
  let stage = 0,
    timer;
  const $ = (id) => pane.querySelector("#" + id);
  function storeZone() {
    if (!boundary || !zoneConfigs[activeZone]) return;
    for (const id of zoneFields)
      zoneConfigs[activeZone][id] = Number($("vn_" + id).value);
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
    zoneConfigs = defaultZoneSettings(next);
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
    generate();
  }
  $("vBoundaryDemo").onclick = () =>
    importBoundary(demoBoundary()).catch(
      (e) => ($("vStatus").textContent = e.message),
    );
  $("vBoundaryFile").onchange = async () => {
    const file = $("vBoundaryFile").files[0];
    if (!file) return;
    try {
      if (file.size > 50 * 1024 * 1024)
        throw Error("Use a Rhino file smaller than 50 MB.");
      if (pending)
        throw Error("Wait for generation to finish before importing.");
      $("vStatus").textContent =
        "Reading Rhino curves and detecting population zones…";
      const r = await rhino(),
        input = readBoundaryCurves(r, new Uint8Array(await file.arrayBuffer())),
        partitionWorker = workerFactory();
      let next;
      try {
        next = await new Promise((resolve, reject) => {
          partitionWorker.onmessage = ({ data }) =>
            data.error ? reject(Error(data.error)) : resolve(data.result);
          partitionWorker.onerror = (e) => reject(Error(e.message));
          partitionWorker.postMessage({
            id: 1,
            action: "partitionZones",
            curves: input.curves,
            options: { elevation: input.elevation, sourceName: file.name },
          });
        });
      } finally {
        partitionWorker.terminate();
      }
      await importBoundary(next);
    } catch (e) {
      $("vStatus").textContent = e.message;
    } finally {
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
  floorControls.innerHTML = `<label>Active floor<select id="vFloor">${floorState.map((f, i) => `<option value="${i}">${f.name}</option>`).join("")}</select></label><div id="vFloorVisibility"></div><label><input type="checkbox" id="vIsolateZone"> Isolate active zone</label><p class="note">Import an outline into each floor separately. Rhino elevations are retained; outlines at Z=0 are stacked at 20 ft intervals. Each floor keeps its own zones, balloons and edits.</p>`;
  floorControls.className = "floor-toolbar";
  floorControls.setAttribute("aria-label", "Building floors");
  floorControls.insertAdjacentHTML(
    "afterbegin",
    "<strong>BUILDING FLOORS</strong>",
  );
  floorControls.insertAdjacentHTML(
    "beforeend",
    '<label class="button" for="vLoad">OPEN BUILDING PROJECT .JSON ↗</label><p id="vProjectMessage" role="status" class="note"></p>',
  );
  pane.querySelector(".voro-layout").before(floorControls);
  floorState.forEach((f, i) => {
    const label = document.createElement("label"),
      check = document.createElement("input");
    check.type = "checkbox";
    check.checked = true;
    check.setAttribute("aria-label", `Show Floor ${i + 1}`);
    check.onchange = () => {
      f.visible = check.checked;
      draw();
    };
    label.append(check, document.createTextNode(` Floor ${i + 1}`));
    $("vFloorVisibility").append(label);
  });
  function stashFloor() {
    floorState[activeFloor].snapshot = {
      params: parameters(),
      result: result ? structuredClone(result) : null,
      editing: editing?.save(),
      view: { activeZone, showAllZones },
      stage,
      wire,
    };
  }
  function restoreFloor(snapshot) {
    const params = snapshot.params;
    restoreBoundary(params);
    restoreZoneView(snapshot.view);
    for (const [id] of fields)
      if (params[id] !== undefined)
        $("vn_" + id).value = $("v_" + id).value = params[id];
    zoneUI(!!boundary);
    editing?.load(snapshot.editing);
    result = snapshot.result ? structuredClone(snapshot.result) : null;
    stage = snapshot.stage ?? 0;
    wire = !!snapshot.wire;
    fitNext = true;
    draw();
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
    if (floorState[activeFloor].snapshot)
      restoreFloor(floorState[activeFloor].snapshot);
    else {
      boundary = demoBoundary();
      zoneConfigs = defaultZoneSettings(boundary);
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
    draw();
    fit();
  };
  function saveBuilding() {
    stashFloor();
    return { activeFloor, isolateZone, floors: structuredClone(floorState) };
  }
  function loadBuilding(building) {
    if (!building?.floors || building.floors.length !== 5) return;
    building.floors.forEach((f, i) => Object.assign(floorState[i], f));
    activeFloor = Math.max(0, Math.min(4, building.activeFloor ?? 0));
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
  function draw() {
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
                opacity: 0.7,
                side: T.DoubleSide,
                clippingPlanes:
                  stage === 5
                    ? [new T.Plane(new T.Vector3(0, 0, 1), -r.params.floor)]
                    : [],
              }),
            );
            if (!s.raw) {
              mesh.position.set(...s.center);
              mesh.scale.fromArray(s.axisScale || [1, 1, 1]);
            }
            const lines = quadWire(s.raw || rawGeometry(mesh.geometry));
            lines.visible = wire;
            lines.material.clippingPlanes = mesh.material.clippingPlanes;
            mesh.add(lines);
            mesh.userData.otherFloor = true;
            group.add(mesh);
          }
        } else if (r?.raw.indices.length) {
          const mesh = new T.Mesh(
            geometry(r.raw),
            new T.MeshPhysicalMaterial({
              color: 0x4e9fa9,
              roughness: 0.3,
              metalness: 0.2,
              side: T.DoubleSide,
            }),
          );
          mesh.userData.otherFloor = true;
          group.add(mesh);
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
        roughness: 0.3,
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
      const g = geometry(raw),
        smooth = toCreasedNormals(g, Math.PI / 4);
      if (smooth !== g) g.dispose();
      const mesh = new T.Mesh(smooth, mat),
        lines = quadWire(raw);
      lines.visible = wire;
      mesh.add(lines);
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
            opacity: 0.7,
            side: T.DoubleSide,
            wireframe: false,
            clippingPlanes: result.params.boundary
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
        const lines = quadWire(s.raw || rawGeometry(mesh.geometry));
        lines.material.clippingPlanes =
          stage === 4 ? planes.slice(0, 4) : planes;
        lines.visible = wire;
        mesh.add(lines);
        mesh.userData.balloonId = s.id;
        balloonMeshes.push(mesh);
        group.add(mesh);
      }
    }
    const descriptions = [
      "Imported outer perimeter and subdivision zones.",
      "Deterministic candidate centers inside the rectangle.",
      "Original Voronoi territories for every seed.",
      "Click a Voronoi center to set the anchor index and rebuild its nearest cluster. Drag empty space to orbit.",
      "Balloons are clipped to their own population zones.",
      "Sphere preview split at the horizontal floor plane.",
      "Union of original sphere sections, filled as one floor footprint.",
      "Upper envelope of edited balloons, relaxed interior heights, flat bottom and perimeter closure.",
    ];
    $("vStage").value = stage;
    $("vStepDescription").textContent = descriptions[stage];
    $("vPrevious").disabled = stage === 0;
    $("vNext").disabled = stage === 7;
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
          loop.map((p) => new T.Vector3(...p, 0.2)),
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
      width,
      height: width * 0.625,
      ...Object.fromEntries(
        fields.map(([id]) => [id, Number($("vn_" + id).value)]),
      ),
      ...(editing?.settings() || {}),
    };
  }
  function generate(populate = false) {
    if (pending) return;
    if (populate === "floor" && boundary)
      populatedZones = populateAllZones(parameters()).populatedZones;
    if (populate === true && boundary && !populatedZones.includes(activeZone))
      populatedZones.push(activeZone);
    zoneUI(false);
    pending = true;
    editing?.setBusy(true);
    $("vStatus").textContent = "Building footprint, roof and flat floor…";
    $("vGenerate").disabled = $("vPopulateCanvas").disabled = true;
    worker ??= workerFactory();
    worker.onmessage = ({ data }) => {
      pending = false;
      $("vGenerate").disabled = $("vPopulateCanvas").disabled = false;
      if (data.error) {
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
      editing?.setBusy(false);
      pending = false;
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
          if (snapshot) restoreFloor(snapshot);
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
      stage = 3;
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
    stage = 3;
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
    pending = true;
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
      pending = false;
      restoreFloor(floorState[activeFloor].snapshot);
      $("vStatus").textContent =
        `All zones populated across ${targets.length} loaded floor(s). Existing edits retained.`;
    } catch (e) {
      $("vStatus").textContent = e.message;
    } finally {
      batchWorker.terminate();
      pending = false;
      locked.forEach(([el, disabled]) => (el.disabled = disabled));
      editing?.setBusy(false);
      draw();
      fit();
    }
  };
  $("vFit").onclick = fit;
  $("vRoof").onclick = () => {
    stage = 7;
    mode = "roof";
    $("vRoof").setAttribute("aria-pressed", true);
    $("vSpheres").setAttribute("aria-pressed", false);
    draw();
  };
  $("vSpheres").onclick = () => {
    stage = 4;
    mode = "spheres";
    $("vRoof").setAttribute("aria-pressed", false);
    $("vSpheres").setAttribute("aria-pressed", true);
    draw();
  };
  $("vStage").onchange = () => {
    stage = Number($("vStage").value);
    draw();
  };
  $("vPrevious").onclick = () => {
    stage = Math.max(0, stage - 1);
    draw();
  };
  $("vNext").onclick = () => {
    stage = Math.min(7, stage + 1);
    draw();
  };
  $("vPlay").onclick = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
      $("vPlay").textContent = "PLAY STEPS";
      return;
    }
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
      stage++;
      draw();
    }, 1800);
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
    try {
      await fn();
    } catch (e) {
      $("vStatus").textContent = e.message;
      $("vProjectMessage").textContent = e.message;
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
    const data = JSON.parse(await file.text());
    if (data.format !== "voronoi-balloons")
      throw Error("Open a Voronoi Balloons project.");
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
  [...nav.children].forEach(
    (button, i) =>
      (button.onclick = () => {
        existing.hidden = i !== 2;
        pane.hidden = i !== 0;
        party.pane.hidden = i !== 3;
        columns.pane.hidden = i !== 1;
        document.querySelector(".header-actions").hidden = i !== 2;
        [...nav.children].forEach((b, j) =>
          b.setAttribute("aria-pressed", i === j),
        );
        if (i === 3) party.show();
        if (i === 1) columns.show();
        if (i === 0) {
          resize();
          if (!result && !pending) generate();
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
      stage = 5;
      draw();
    },
    rhino,
  });
  function frame() {
    requestAnimationFrame(frame);
    if (pane.hidden) return;
    orbit.update();
    renderers[0].render(scene, camera);
    editing?.renderPerspective(renderers[0]);
    editing?.beforePlan();
    if (stage >= 4) {
      renderers[1].localClippingEnabled = true;
      renderers[1].render(scene, plan);
      renderers[1].autoClear = false;
      renderers[1].clearDepth();
    }
    renderers[1].render(diagram, plan);
    renderers[1].autoClear = true;
    editing?.renderPlan(renderers[1], plan);
    editing?.afterPlan();
  }
  frame();
  zoneUI();
  nav.children[0].click();
  return {};
}
