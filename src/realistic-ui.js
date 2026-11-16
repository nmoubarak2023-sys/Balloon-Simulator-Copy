import { UndoJournal, isUndoShortcut } from "./history.js";
import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { addTechnicalFrames } from "./frames.js";
import { geometry } from "./view.js";

export function initRealistic(pane, getFloors) {
  pane.classList.add("voronoi-uppercase");
  pane.innerHTML = `<div class="voro-layout">
    <section class="panel" data-frame-count="1">
      <div class="panel-heading">PERSPECTIVE <small>REALISTIC MODE</small></div>
      <div class="canvas-tools">
        <button id="realUndo" disabled>UNDO / CTRL+Z</button><button id="realFit" disabled>FIT ↗</button>
        <button id="realPlaceFigure" aria-pressed="false" disabled>PLACE SCALE FIGURE</button><button id="realEye" hidden>EYE LEVEL</button><button id="realDeleteFigure" hidden>DELETE FIGURE</button><button id="realClip" aria-pressed="false" disabled>CLIPPING PLANE</button>
        <button id="realMove" aria-pressed="true" hidden>MOVE PLANE</button>
        <button id="realRotate" aria-pressed="false" hidden>ROTATE PLANE</button>
      </div>
      <div id="realCanvas" class="voro-canvas"></div>
    </section>
    <aside><section class="panel" data-frame-count="2">
      <div class="panel-heading">BUILDING THICKNESS</div>
      <div class="voro-controls">
        <label for="realShell">SHELL THICKNESS <output id="realShellValue" for="realShell">1 FT</output></label>
        <input id="realShell" type="range" min="0.25" max="6" step="0.25" value="1">
        <label for="realSlab">FLOOR SLAB THICKNESS <output id="realSlabValue" for="realSlab">1 FT</output></label>
        <input id="realSlab" type="range" min="0.25" max="6" step="0.25" value="1">
      </div>
    </section></aside>
  </div>
  <div id="realStatus" class="status-bar" role="status">IMPORT FLOOR CURVES IN VORONOI BALLOONS TO BEGIN.</div>`;
  addTechnicalFrames(pane);
  const $ = (id) => pane.querySelector("#" + id);
  const viewport = $("realCanvas");
  const degrees = document.createElement("input");
  degrees.type = "number";
  degrees.step = "any";
  degrees.className = "section-degree-entry";
  degrees.hidden = true;
  viewport.append(degrees);
  let degreeAxis;
  degrees.onblur = () => {
    degrees.hidden = true;
  };
  degrees.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === "Escape") degrees.blur();
    if (event.key !== "Enter" || !Number.isFinite(degrees.valueAsNumber))
      return;
    event.preventDefault();
    const before = readState();
    pivot.rotateOnWorldAxis(
      degreeAxis,
      T.MathUtils.degToRad(degrees.valueAsNumber % 360),
    );
    updatePlane();
    remember(before);
    degrees.blur();
  };
  const scene = new T.Scene();
  scene.background = new T.Color(0x000000);
  const overlay = new T.Scene();
  const camera = new T.PerspectiveCamera(39, 1, 0.02, 10000);
  camera.up.set(0, 0, 1);
  const lights = new T.HemisphereLight(0xfff7ea, 0x646b72, 1.45);
  const sun = new T.DirectionalLight(0xfff1d8, 2.4);
  const lightDirection = new T.Vector3(-3, -5, 8).normalize();
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 3;
  sun.shadow.bias = -0.0001;
  const fill = new T.DirectionalLight(0xd3e8ff, 0.7);
  fill.position.set(2, 4, 3);
  scene.add(lights, sun, sun.target, fill);
  const surface = new T.MeshStandardMaterial({
    color: 0xc4bcb0,
    roughness: 0.88,
  });
  surface.clipShadows = true;
  const poche = new T.MeshBasicMaterial({
    color: 0x252c30,
    side: T.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const pivot = new T.Object3D();
  const plane = new T.Plane();
  const normal = new T.Vector3();
  const scaleFigures = new T.Group();
  const figureMaterial = new T.MeshStandardMaterial({
    color: 0xfb88fc,
    roughness: 0.78,
  });
  const headGeometry = new T.SphereGeometry(0.39, 12, 8);
  const bodyGeometry = new T.CapsuleGeometry(0.4, 1.65, 4, 8);
  const limbGeometry = new T.CylinderGeometry(1, 1, 1, 8);
  const figureRay = new T.Raycaster();
  const figurePositions = [];
  let placingFigure = false,
    selectedFigure,
    figureControl,
    figureDragStart,
    eyeCamera;
  scene.add(pivot, scaleFigures);
  function addFigure(position) {
    const figure = new T.Group();
    const head = new T.Mesh(headGeometry, figureMaterial);
    head.position.z = 5.61;
    const torso = new T.Mesh(bodyGeometry, figureMaterial);
    torso.rotation.x = Math.PI / 2;
    torso.scale.x = 1.35;
    torso.position.z = 3.97;
    figure.add(head, torso);
    function limb(from, to, radius) {
      const start = new T.Vector3(...from);
      const end = new T.Vector3(...to);
      const direction = end.clone().sub(start);
      const piece = new T.Mesh(limbGeometry, figureMaterial);
      piece.position.copy(start).lerp(end, 0.5);
      piece.quaternion.setFromUnitVectors(
        new T.Vector3(0, 1, 0),
        direction.clone().normalize(),
      );
      piece.scale.set(radius, direction.length(), radius);
      figure.add(piece);
    }
    limb([0, 0, 4.98], [0, 0, 5.35], 0.18);
    for (const side of [-1, 1]) {
      limb([side * 0.23, 0, 2.85], [side * 0.32, 0, 0.17], 0.17);
      limb([side * 0.46, 0, 4.86], [side * 0.75, 0, 2.8], 0.13);
    }
    figure.position.fromArray(position);
    scaleFigures.add(figure);
  }
  function selectFigure(figure) {
    selectedFigure = figure;
    figureControl.detach();
    if (figure && !eyeCamera) figureControl.attach(figure);
    if (sectionOn && !figure) gumball.attach(pivot);
    else gumball.detach();
    $("realEye").hidden = $("realDeleteFigure").hidden = !figure;
    needsRender = true;
  }
  function leaveEyeView() {
    if (!eyeCamera) return;
    camera.position.copy(eyeCamera.position);
    orbit.target.copy(eyeCamera.target);
    eyeCamera = undefined;
    orbit.enabled = true;
    if (selectedFigure) selectedFigure.visible = true;
    $("realEye").textContent = "EYE LEVEL";
    selectFigure(selectedFigure);
    orbit.update();
  }
  function toggleEyeView() {
    if (eyeCamera) return leaveEyeView();
    if (!selectedFigure) return;
    eyeCamera = {
      position: camera.position.clone(),
      target: orbit.target.clone(),
    };
    camera.position.copy(selectedFigure.position).add(new T.Vector3(0, 0, 5.6));
    orbit.target.copy(camera.position).add(new T.Vector3(0, -1, 0));
    selectedFigure.visible = false;
    figureControl.detach();
    orbit.enabled = true;
    $("realEye").textContent = "EXIT EYE LEVEL";
    orbit.update();
    needsRender = true;
  }
  function deleteFigure() {
    if (!selectedFigure) return;
    leaveEyeView();
    const before = readState();
    figurePositions.splice(scaleFigures.children.indexOf(selectedFigure), 1);
    scaleFigures.remove(selectedFigure);
    selectFigure(undefined);
    remember(before);
  }
  function setFigureTool(enabled) {
    if (enabled) {
      leaveEyeView();
      selectFigure(undefined);
    }
    placingFigure = enabled;
    $("realPlaceFigure").setAttribute("aria-pressed", enabled);
    if (renderer) renderer.domElement.style.cursor = enabled ? "crosshair" : "";
  }
  function aimFigureRay(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    camera.updateMatrixWorld();
    figureRay.setFromCamera(
      new T.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((event.clientY - rect.top) / rect.height) * 2,
      ),
      camera,
    );
  }
  function pickFigure(event) {
    aimFigureRay(event);
    const shown = ({ point }) =>
      !sectionOn || plane.distanceToPoint(point) >= -1e-5;
    const body = figureRay
      .intersectObjects(scaleFigures.children, true)
      .find(shown);
    const surfaceHit = figureRay.intersectObject(mesh, false).find(shown);
    selectFigure(
      body && (!surfaceHit || body.distance <= surfaceHit.distance)
        ? body.object.parent
        : undefined,
    );
  }
  function pickFigureFloor(event) {
    aimFigureRay(event);
    const hit = figureRay
      .intersectObject(mesh, false)
      .find(({ point }) => !sectionOn || plane.distanceToPoint(point) >= -1e-5);
    const floor = wanted.floors.find(
      (floor) =>
        floor.perimeter?.length &&
        hit &&
        Math.abs(hit.point.z - floor.elevation) < 0.025,
    );
    if (!hit || !floor || hit.face.normal.z < 0.9) {
      status(
        "Click the top of a visible floor slab. Use the clipping plane to expose interior floors.",
      );
      return;
    }
    const before = readState();
    const position = [hit.point.x, hit.point.y, floor.elevation];
    figurePositions.push(position);
    addFigure(position);
    remember(before);
    setFigureTool(false);
    needsRender = true;
    status("6 ft scale figure placed on " + floor.name + ".");
  }
  let renderer, orbit, gumball, worker, mesh, cap;
  let sectionOn = false,
    fitted = false;
  let wanted, inFlight, modelKey, failedKey;
  let requestedSection = 0,
    shownSection = -1,
    failedSection = -1;
  let lastUpdate = -Infinity;
  let needsRender = true;
  const ids = new WeakMap();
  let nextId = 0;
  const idOf = (raw) => {
    if (!raw) return 0;
    if (!ids.has(raw)) ids.set(raw, ++nextId);
    return ids.get(raw);
  };
  const status = (message) => {
    $("realStatus").textContent = message;
  };
  const history = new UndoJournal();
  let planeStart, thicknessStart;
  function readState() {
    return {
      sectionOn,
      figures: figurePositions.slice(),
      position: pivot.position.toArray(),
      rotation: pivot.quaternion.toArray(),
      mode: gumball?.getMode() ?? "translate",
      thickness: [$("realShell").value, $("realSlab").value],
    };
  }
  function remember(before) {
    if (!before || JSON.stringify(before) === JSON.stringify(readState()))
      return;
    history.push(before);
    $("realUndo").disabled = false;
  }
  function applyState(before) {
    if (gumball?.dragging || figureControl?.dragging) return;
    leaveEyeView();
    selectFigure(undefined);
    scaleFigures.clear();
    figurePositions.splice(0, figurePositions.length, ...before.figures);
    figurePositions.forEach(addFigure);
    pivot.position.fromArray(before.position);
    pivot.quaternion.fromArray(before.rotation);
    if (gumball) {
      setMode(before.mode);
      setSection(before.sectionOn);
    }
    ["realShell", "realSlab"].forEach((id, index) => {
      $(id).value = before.thickness[index];
      $(id + "Value").textContent = $(id).value + " FT";
    });
    thicknessStart = undefined;
    failedKey = undefined;
    $("realUndo").disabled = !history.length;
    refresh();
  }
  function undo() {
    if (gumball?.dragging || figureControl?.dragging) return;
    const before = history.pop();
    if (before) applyState(before);
  }
  function removeObject(object) {
    if (!object) return;
    object.removeFromParent();
    object.geometry.dispose();
  }
  function fit() {
    if (!mesh) return;
    const bounds = new T.Box3().setFromObject(mesh);
    const center = bounds.getCenter(new T.Vector3());
    const size = bounds.getSize(new T.Vector3()).length();
    const halfFov = T.MathUtils.degToRad(camera.fov / 2);
    const distance =
      (size * 0.6) / (Math.tan(halfFov) * Math.min(1, camera.aspect));
    orbit.target.copy(center);
    camera.position
      .copy(center)
      .addScaledVector(new T.Vector3(1, -1.45, 0.85).normalize(), distance);
    camera.far = Math.max(10000, distance * 12);
    camera.updateProjectionMatrix();
    orbit.update();
  }
  function frameLighting() {
    const bounds = new T.Box3().setFromObject(mesh);
    const center = bounds.getCenter(new T.Vector3());
    const radius = bounds.getSize(new T.Vector3()).length() / 2;
    sun.target.position.copy(center);
    sun.position.copy(center).addScaledVector(lightDirection, radius * 2);
    Object.assign(sun.shadow.camera, {
      left: -radius,
      right: radius,
      bottom: -radius,
      top: radius,
      near: 0.01,
      far: radius * 4,
    });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.normalBias = radius * 0.0004;
    renderer.shadowMap.needsUpdate = true;
  }
  function updatePlane() {
    normal.set(0, 0, 1).applyQuaternion(pivot.quaternion);
    plane.setFromNormalAndCoplanarPoint(normal, pivot.position);
    needsRender = true;
    requestedSection++;
    renderer.shadowMap.needsUpdate = true;
    if (cap) cap.visible = false;
  }
  function setSection(enabled) {
    needsRender = true;
    sectionOn = enabled;
    degrees.hidden = true;
    $("realClip").setAttribute("aria-pressed", enabled);
    $("realMove").hidden = $("realRotate").hidden = !enabled;
    surface.clippingPlanes = enabled ? [plane] : [];
    figureMaterial.clippingPlanes = surface.clippingPlanes;
    figureMaterial.needsUpdate = true;
    surface.needsUpdate = true;
    renderer.shadowMap.needsUpdate = true;
    if (enabled) {
      if (!selectedFigure) gumball.attach(pivot);
      updatePlane();
    } else {
      gumball.detach();
      if (cap) cap.visible = false;
    }
  }
  function setMode(mode) {
    needsRender = true;
    gumball.setMode(mode);
    $("realMove").setAttribute("aria-pressed", mode === "translate");
    $("realRotate").setAttribute("aria-pressed", mode === "rotate");
  }
  function resize() {
    needsRender = true;
    if (!renderer || pane.hidden) return;
    const { clientWidth: width, clientHeight: height } = viewport;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  function openRenderer() {
    if (renderer) return;
    renderer = new T.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
    renderer.localClippingEnabled = true;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.autoUpdate = false;
    viewport.append(renderer.domElement);
    orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.addEventListener("change", () => {
      needsRender = true;
    });
    camera.position.set(50, -70, 45);
    gumball = new TransformControls(camera, renderer.domElement);
    const canvas = renderer.domElement;
    figureControl = new TransformControls(camera, canvas);
    figureControl.setSize(0.8);
    figureControl.setSpace("world");
    figureControl.setColors(0x9af4f9, 0x21e0ed, 0x789fe8, 0xffffff);
    figureControl.addEventListener("change", () => {
      needsRender = true;
    });
    figureControl.addEventListener("dragging-changed", ({ value }) => {
      orbit.enabled = !value;
      if (value) figureDragStart = readState();
      else if (selectedFigure && figureDragStart) {
        const index = scaleFigures.children.indexOf(selectedFigure);
        figurePositions[index] = selectedFigure.position.toArray();
        remember(figureDragStart);
        figureDragStart = undefined;
      }
    });
    overlay.add(figureControl.getHelper());
    let figurePress;
    canvas.addEventListener("pointerdown", (event) => {
      figurePress = !eyeCamera && event.button === 0 ? event : null;
    });
    canvas.addEventListener(
      "pointerup",
      (event) => {
        const start = figurePress;
        figurePress = null;
        if (
          !mesh ||
          !start ||
          start.pointerId !== event.pointerId ||
          Math.hypot(
            start.clientX - event.clientX,
            start.clientY - event.clientY,
          ) > 4 ||
          (sectionOn && gumball.object && gumball.axis) ||
          (selectedFigure && figureControl.axis)
        )
          return;
        if (placingFigure) pickFigureFloor(event);
        else pickFigure(event);
      },
      true,
    );
    let press, click;
    canvas.addEventListener(
      "pointerdown",
      (event) => {
        press = event.button === 0 ? event : null;
        click = null;
      },
      true,
    );
    canvas.addEventListener(
      "pointerup",
      (event) => {
        if (
          press?.pointerId === event.pointerId &&
          Math.hypot(
            event.clientX - press.clientX,
            event.clientY - press.clientY,
          ) <= 4
        )
          click = event;
        press = null;
      },
      true,
    );
    gumball.addEventListener("mouseUp", () => {
      const axis = ["X", "Y", "Z"].indexOf(gumball.axis);
      if (!click || axis < 0 || !sectionOn) return;
      degreeAxis = new T.Vector3().setComponent(axis, 1);
      degrees.placeholder = gumball.axis + " DEGREES";
      degrees.setAttribute(
        "aria-label",
        "Rotate clipping plane about " + gumball.axis + " in degrees",
      );
      degrees.value = "";
      degrees.style.left =
        Math.max(4, Math.min(click.clientX + 10, innerWidth - 120)) + "px";
      degrees.style.top =
        Math.max(4, Math.min(click.clientY + 6, innerHeight - 42)) + "px";
      degrees.hidden = false;
      degrees.focus({ preventScroll: true });
      click = null;
    });
    gumball.setSpace("world");
    gumball.setSize(0.8);
    gumball.setColors(0x9af4f9, 0x21e0ed, 0x789fe8, 0xffffff);
    gumball.addEventListener("change", () => {
      needsRender = true;
    });
    gumball.addEventListener("objectChange", updatePlane);
    gumball.addEventListener("dragging-changed", ({ value }) => {
      orbit.enabled = !value;
      if (value) planeStart = readState();
      else {
        remember(planeStart);
        planeStart = undefined;
      }
    });
    overlay.add(gumball.getHelper());
    new ResizeObserver(resize).observe(viewport);
    requestAnimationFrame(frame);
  }
  function sourceRequest() {
    const floors = getFloors().map((floor) => ({
      ...floor,
      meshId: idOf(floor.raw),
    }));
    const shellThickness = $("realShell").valueAsNumber;
    const slabThickness = $("realSlab").valueAsNumber;
    const key = JSON.stringify([
      shellThickness,
      slabThickness,
      floors.map((floor) => [
        floor.index,
        floor.meshId,
        idOf(floor.perimeter),
        floor.elevation,
        floor.floor,
        floor.columns.map(idOf),
      ]),
    ]);
    return { kind: "build", key, floors, shellThickness, slabThickness };
  }
  function refresh() {
    wanted = sourceRequest();
    if (!wanted.floors.length) {
      removeObject(mesh);
      removeObject(cap);
      if (mesh || cap) needsRender = true;
      mesh = cap = undefined;
      fitted = false;
      modelKey = undefined;
      if (sectionOn) setSection(false);
      $("realFit").disabled =
        $("realClip").disabled =
        $("realPlaceFigure").disabled =
          true;
      setFigureTool(false);
      scaleFigures.visible = false;
      status("Import floor curves in Voronoi Balloons to begin.");
    }
    schedule();
  }
  function openWorker() {
    worker ??= new Worker(new URL("./realistic-worker.js", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({ data }) => {
      inFlight = undefined;
      needsRender = true;
      if (data.kind === "build" && data.key === wanted.key) {
        if (data.error) {
          failedKey = data.key;
          status(data.error);
        } else {
          modelKey = data.key;
          removeObject(mesh);
          mesh = new T.Mesh(geometry(data.mesh), surface);
          mesh.castShadow = mesh.receiveShadow = true;
          scene.add(mesh);
          frameLighting();
          if (!fitted) {
            fit();
            pivot.position.copy(orbit.target);
            pivot.rotation.set(-Math.PI / 2, 0, 0);
            fitted = true;
          }
          $("realFit").disabled =
            $("realClip").disabled =
            $("realPlaceFigure").disabled =
              false;
          scaleFigures.visible = true;
          status("Building ready.");
          updatePlane();
        }
      } else if (data.kind === "build" && !data.error) {
        // The worker now holds a different building. Rebuild the requested one
        // before allowing another section cut.
        modelKey = undefined;
      } else if (
        data.kind === "section" &&
        sectionOn &&
        data.key === requestedSection
      ) {
        if (data.error) {
          failedSection = data.key;
          status(data.error);
        } else {
          shownSection = data.key;
          removeObject(cap);
          cap = new T.Mesh(geometry(data.mesh), poche);
          scene.add(cap);
        }
      }
      schedule();
    };
    worker.onerror = () => {
      worker.terminate();
      worker = undefined;
      if (inFlight?.kind === "build") failedKey = inFlight.key;
      else failedSection = inFlight?.key;
      inFlight = undefined;
      modelKey = undefined;
      status("Model processing stopped. Adjust a thickness setting to retry.");
    };
  }
  function schedule() {
    if (pane.hidden || inFlight || !wanted?.floors.length) return;
    let task;
    if (wanted.key !== modelKey && wanted.key !== failedKey) {
      task = wanted;
      status("Updating shell, slabs, and columns…");
    } else if (
      sectionOn &&
      modelKey === wanted.key &&
      requestedSection !== shownSection &&
      requestedSection !== failedSection
    ) {
      pivot.updateMatrixWorld();
      task = {
        kind: "section",
        key: requestedSection,
        frame: pivot.matrixWorld.toArray(),
      };
    }
    if (!task) return;
    openWorker();
    inFlight = task;
    worker.postMessage(task);
  }
  function frame(now) {
    requestAnimationFrame(frame);
    if (pane.hidden) return;
    if (now - lastUpdate > 250) {
      lastUpdate = now;
      refresh();
    }
    orbit.update();
    if (!needsRender) return;
    needsRender = false;
    renderer.render(scene, camera);
    if (sectionOn || selectedFigure) {
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(overlay, camera);
      renderer.autoClear = true;
    }
  }
  $("realFit").onclick = () => {
    leaveEyeView();
    fit();
  };
  $("realEye").onclick = toggleEyeView;
  $("realDeleteFigure").onclick = deleteFigure;
  $("realPlaceFigure").onclick = () => {
    setFigureTool(!placingFigure);
    status(
      placingFigure
        ? "Click a visible floor slab to place a 6 ft figure."
        : "Figure placement cancelled.",
    );
  };
  $("realUndo").onclick = undo;
  $("realClip").onclick = () => {
    const before = readState();
    setSection(!sectionOn);
    remember(before);
  };
  for (const [id, mode] of [
    ["realMove", "translate"],
    ["realRotate", "rotate"],
  ]) {
    $(id).onclick = () => {
      const before = readState();
      leaveEyeView();
      selectFigure(undefined);
      setMode(mode);
      remember(before);
    };
  }
  for (const id of ["realShell", "realSlab"]) {
    const beginThickness = () => {
      thicknessStart ??= readState();
    };
    $(id).addEventListener("pointerdown", beginThickness);
    $(id).addEventListener("keydown", (event) => {
      if (
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
        ].includes(event.key)
      )
        beginThickness();
    });
    $(id).onblur = () => {
      thicknessStart = undefined;
    };
    $(id).oninput = () => {
      $(id + "Value").textContent = $(id).value + " FT";
    };
    $(id).onchange = () => {
      remember(thicknessStart);
      thicknessStart = undefined;
      refresh();
    };
  }
  window.addEventListener("keydown", (event) => {
    if (pane.hidden) return;
    if (isUndoShortcut(event)) {
      event.preventDefault();
      undo();
      return;
    }
    if (
      event.key === "Delete" &&
      selectedFigure &&
      !event.target?.matches?.("input, textarea, select, [contenteditable]")
    ) {
      event.preventDefault();
      deleteFigure();
      return;
    }
    if (event.key === "Escape" && eyeCamera) {
      leaveEyeView();
      return;
    }
    if (event.key === "Escape" && placingFigure) {
      setFigureTool(false);
      status("Figure placement cancelled.");
      return;
    }
    if (event.key !== "Escape" || !inFlight) return;
    event.preventDefault();
    worker.terminate();
    worker = undefined;
    failedKey = wanted.key;
    modelKey = undefined;
    inFlight = undefined;
    status("Processing cancelled. Change thickness to rebuild.");
  });
  let restored;
  function show() {
    openRenderer();
    resize();
    if (restored) {
      const state = restored;
      restored = undefined;
      applyState(state);
      fitted = !!state.camera;
      if (state.camera) {
        camera.position.fromArray(state.camera);
        orbit.target.fromArray(state.target);
        orbit.update();
      }
    }
    refresh();
  }
  show.saveSession = () =>
    restored ?? {
      ...readState(),
      camera: fitted ? camera.position.toArray() : null,
      target: fitted ? orbit.target.toArray() : null,
    };
  show.loadSession = (data) => {
    restored = data;
  };
  return show;
}
