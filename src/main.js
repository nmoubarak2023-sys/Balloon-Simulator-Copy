import { scaleAxisEdit } from "./balloon-edit.js";
import { mountGeometryLibrary, canvasThumbnail } from "./geometry-library.js";
import { quadObj, quadMesh } from "./quad-mesh.js";
import "./style.css";
import { initBalloonParty } from "./party.js";
import { initVoronoi } from "./voronoi-ui.js";
import * as T from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { StudioView, geometry, rawGeometry } from "./view.js";
import { bounds, canonical } from "./engine.js";
import { rhinoRaw, addRhinoQuadMesh } from "./rhino-io.js";
import { transformMesh, draggedEdit, rotationMatrix } from "./interaction.js";
import { rotateClippingPlane } from "./interaction.js";
import { addTechnicalFrames } from "./frames.js";
import { UndoJournal, isUndoShortcut } from "./history.js";
import { meshQuality } from "./mesh-quality.js";
import {
  validateCurves,
  iterationStore,
  iterationSummary,
} from "./iterations.js";
let curves = [],
  activeCurve = 0;
function allCurves() {
  curves[activeCurve] = points;
  return curves;
}
function drawCurves() {
  view.curve(points, editCurve, true, allCurves(), activeCurve);
}
const $ = (id) => document.getElementById(id),
  paramsIDs = [
    "count",
    "pointSeed",
    "radiusMin",
    "radiusMax",
    "radiusSeed",
    "quality",
    "clearance",
    "strength",
    "influence",
    "tolerance",
  ];
let needsRestore = false;
const undoJournal = new UndoJournal(20);
let lastUIState = null,
  undoing = false,
  workerEpoch = 0,
  taskHadModelChange = false;
let selectedIDs = new Set();
let boundary,
  display,
  output = null,
  points = [],
  selected = 0,
  editCurve = false,
  busy = false,
  worker,
  seq = 0,
  pending = new Map(),
  rhinoPromise,
  configUsed,
  curveUsed,
  meshChoices = [],
  fileName = "Demonstration container";
function status(message, error = false) {
  $("status").textContent = message;
  $("status").parentElement.classList.toggle("error", error);
}
let nativeJobId;
function newWorker() {
  workerEpoch++;
  worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });
  worker.onmessage = ({ data }) => {
    if (data.progress !== undefined) {
      if (data.nativeJobId) nativeJobId = data.nativeJobId;
      $("progress").value = data.progress;
      status(data.text);
      return;
    }
    const p = pending.get(data.id);
    nativeJobId = undefined;
    if (!p) return;
    pending.delete(data.id);
    data.error ? p.reject(Error(data.error)) : p.resolve(data.result);
  };
  worker.onerror = (e) => {
    for (const p of pending.values())
      p.reject(Error(e.message || "Geometry worker failed."));
    pending.clear();
  };
}
function request(action, data = {}) {
  if (
    needsRestore &&
    ["edit", "output", "pop", "freeze", "merge", "popPressure"].includes(action)
  ) {
    if (!display || !configUsed)
      return Promise.reject(Error("Generate balloons first."));
    return request("restore", {
      boundary: display.boundary,
      params: configUsed,
      curve: curveUsed,
      edits: display.edits,
      session: display,
      recovery: true,
    }).then((restored) => {
      needsRestore = false;
      display.canAdjustPop = restored.canAdjustPop;
      return request(action, data);
    });
  }
  const tracksModel =
    [
      "generate",
      "restore",
      "edit",
      "pop",
      "freeze",
      "merge",
      "popPressure",
    ].includes(action) &&
    !undoing &&
    !data.recovery &&
    !data.undoRestore;
  const before = tracksModel
    ? {
        kind: "model",
        ui: lastUIState || captureUI(),
        model: display,
        epoch: workerEpoch,
        label: {
          generate: "Generate field",
          restore: "Open project",
          edit: "Move / scale balloon",
          pop: "Pop!",
          freeze: "Freeze / unfreeze",
          merge: "Merge",
          popPressure: "Pop pressure",
        }[action],
      }
    : null;
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, action, ...data });
  }).then((result) => {
    if (tracksModel) {
      taskHadModelChange = true;
      if (before.model) undoJournal.push(before);
    }
    return result;
  });
}
async function task(message, fn) {
  if (busy) return;
  busy = true;
  updateUndoButton();
  taskHadModelChange = false;
  const uiBefore = captureUI();
  let succeeded = false;
  view.setBusy(true);
  $("progress").hidden = false;
  $("cancelBtn").hidden = false;
  $("progress").value = 0;
  document
    .querySelectorAll(
      ".controls button,.controls input,.controls select,.canvas-tools button,.balloon-actions button,.balloon-actions input,.rotation-controls button,.rotation-controls input,.rotation-controls select,#curveEditBtn",
    )
    .forEach((e) => (e.disabled = true));
  status(message);
  try {
    await fn();
    succeeded = true;
  } catch (e) {
    status(e.message, true);
  } finally {
    busy = false;
    view.setBusy(false);
    $("progress").hidden = true;
    $("cancelBtn").hidden = true;
    document
      .querySelectorAll(
        ".controls button,.controls input,.controls select,.canvas-tools button,.balloon-actions button,.balloon-actions input,.rotation-controls button,.rotation-controls input,.rotation-controls select,#curveEditBtn",
      )
      .forEach((e) => (e.disabled = false));
    updateActionButtons();
    $("addCurve").disabled = curves.length >= 5;
    $("removeCurve").disabled = curves.length <= 1;
    if (
      !undoing &&
      succeeded &&
      !taskHadModelChange &&
      uiBefore.model &&
      uiSignature(uiBefore) !== uiSignature(captureUI())
    )
      undoJournal.push({
        kind: "ui",
        ui: uiBefore,
        label: message.replace(/…$/, ""),
      });
    if (!undoing) lastUIState = captureUI();
    updateUndoButton();
  }
}
function captureUI() {
  return {
    model: display,
    boundary,
    fileName,
    meshChoices,
    points: points.map((p) => p.slice()),
    curves: allCurves().map((c) => c.map((p) => p.slice())),
    activeCurve,
    clipping: view.clipState ? structuredClone(view.clipState) : null,
    configUsed,
    curveUsed,
    selected,
    selectedIDs: [...selectedIDs],
    tool: view.tool,
    editCurve,
    output,
    controls: Object.fromEntries(
      [
        ...document.querySelectorAll(
          "main:not(#voronoiWorkspace):not(#partyWorkspace):not(#columnWorkspace) input[id]:not([type=file]),main:not(#voronoiWorkspace):not(#partyWorkspace):not(#columnWorkspace) select[id]",
        ),
      ].map((el) => [
        el.id,
        {
          value: el.value,
          checked: el.checked,
          min: el.getAttribute("min"),
          max: el.getAttribute("max"),
          step: el.getAttribute("step"),
        },
      ]),
    ),
  };
}
function uiSignature(state) {
  return JSON.stringify({
    controls: state.controls,
    points: state.points,
    curves: state.curves,
    activeCurve: state.activeCurve,
    clipping: state.clipping,
    fileName: state.fileName,
    output: state.output
      ? {
          mode: state.output.mode,
          tolerance: state.output.tolerance,
          message: state.output.message,
        }
      : null,
  });
}
function recordUI(before, label) {
  if (busy || undoing || !before?.model) return;
  if (uiSignature(before) !== uiSignature(captureUI()))
    undoJournal.push({ kind: "ui", ui: before, label });
  lastUIState = captureUI();
  updateUndoButton();
}
function updateUndoButton() {
  const entry = undoJournal.peek();
  $("undoBtn").disabled = busy || !entry;
  $("undoBtn").title = entry
    ? `Undo ${entry.label} (Ctrl+Z)`
    : "Nothing to undo";
}
function restoreUI(context, result) {
  const oldBounds = display?.boundary ? bounds(display.boundary) : null,
    newBounds = bounds(context.model.boundary);
  const refit =
    oldBounds &&
    [...newBounds.center, ...newBounds.span].some(
      (v, i) =>
        Math.abs(v - [...oldBounds.center, ...oldBounds.span][i]) >
        Math.max(...newBounds.span) * 1e-8,
    );
  for (const [id, data] of Object.entries(context.controls)) {
    const el = $(id);
    if (!el) continue;
    for (const key of ["min", "max", "step"]) {
      if (data[key] !== null) el.setAttribute(key, data[key]);
      else el.removeAttribute(key);
    }
    el.value = data.value;
    if (typeof data.checked === "boolean") el.checked = data.checked;
  }
  points = context.points.map((p) => p.slice());
  curves = (context.curves || [points]).map((c) => c.map((p) => p.slice()));
  activeCurve = context.activeCurve || 0;
  points = curves[activeCurve];
  if (context.clipping) view.setClip(context.clipping);
  else if (view.clipState) view.setClip({ ...view.clipState, enabled: false });
  fileName = context.fileName;
  meshChoices = context.meshChoices;
  configUsed = context.configUsed;
  curveUsed = context.curveUsed;
  selected = context.selected;
  selectedIDs = new Set(context.selectedIDs);
  editCurve = context.editCurve;
  boundary = result?.boundary || context.boundary;
  $("fileName").textContent = fileName;
  view.selectedCurve = Number(context.controls.curvePoint.value) || 0;
  view.setTool(context.tool);
  rotationControls(context.tool);
  $("curveEditBtn").setAttribute("aria-pressed", editCurve);
  $("meshSelect").replaceChildren(
    ...meshChoices.map((mesh, i) => new Option(mesh.name, i)),
  );
  $("meshSelect").hidden = meshChoices.length < 2;
  $("meshSelect").value = context.controls.meshSelect.value;
  for (const id of ["meshFile", "curveFile", "projectFile"]) $(id).value = "";
  display = context.model;
  syncDisplay({ ...(result || display), selectedIndex: undefined }, false);
  if (refit) view.fit();
  curveUI();
  output = context.output;
  if (output) {
    $("outputStatus").textContent = output.message;
    $("outputStatus").classList.toggle("mesh-warning", !!output.incomplete);
    view.output(output.mode === "shell" ? output.shells : output.shells[0]);
  }
  view.transform.setRotationSnap(
    Number($("rotationSnap").value)
      ? (Number($("rotationSnap").value) * Math.PI) / 180
      : null,
  );
  $("popPressure").value = context.controls.popPressure.value;
  $("popPressureValue").value = `${$("popPressure").value}%`;
}
async function undoLast() {
  if (busy || !undoJournal.length) return;
  const entry = undoJournal.peek();
  undoing = true;
  try {
    await task(`Undoing ${entry.label}…`, async () => {
      let result;
      if (entry.kind === "model") {
        result =
          entry.epoch === workerEpoch && !needsRestore
            ? await request("undo")
            : await request("restore", {
                session: entry.model,
                undoRestore: true,
              });
        needsRestore = false;
      }
      restoreUI(entry.ui, result);
      undoJournal.pop();
      status(`Undid ${entry.label}.`);
    });
  } finally {
    undoing = false;
    lastUIState = captureUI();
    updateUndoButton();
  }
}
$("undoBtn").onclick = undoLast;
document.addEventListener("keydown", (event) => {
  if (document.querySelector("main").hidden) return;
  if (isUndoShortcut(event)) {
    event.preventDefault();
    $("undoBtn").click();
  }
});
document.addEventListener(
  "change",
  (event) => {
    const el = event.target;
    if (
      el.closest(
        "#voronoiWorkspace, #partyWorkspace, #columnWorkspace, .geometry-library",
      )
    )
      return;
    if (
      !el.id ||
      el.type === "file" ||
      ["balloonSelect", "curvePoint", "meshSelect"].includes(el.id)
    )
      return;
    queueMicrotask(() => {
      if (!busy && !undoing)
        recordUI(
          lastUIState,
          `Change ${el.labels?.[0]?.textContent?.trim() || el.id}`,
        );
    });
  },
  true,
);
function params() {
  const p = Object.fromEntries(
    paramsIDs.map((id) => [id, Number($(id).value)]),
  );
  p.pressureEnabled = $("pressureEnabled").checked;
  if (
    Object.values(p).some((v) => typeof v === "number" && !Number.isFinite(v))
  )
    throw Error("Enter finite numeric settings.");
  if (!Number.isInteger(p.count) || p.count < 1 || p.count > 40)
    throw Error("Count must be an integer from 1 to 40.");
  for (const k of ["pointSeed", "radiusSeed"])
    if (!Number.isInteger(p[k]) || p[k] < 0 || p[k] > 2147483647)
      throw Error("Seeds must be integers from 0 to 2147483647.");
  if (p.radiusMin <= 0 || p.radiusMax < p.radiusMin)
    throw Error("Radius maximum must be at least the positive radius minimum.");
  if (
    p.clearance <= 0 ||
    p.strength < 0 ||
    p.influence <= 0 ||
    p.tolerance <= 0
  )
    throw Error(
      "Gap, influence distance, and tolerance must be positive; pressure must be nonnegative.",
    );
  return p;
}
function invalidate() {
  output = null;
  if (view.field.children.length) view.output(null);
  $("outputStatus").textContent =
    "Output needs rebuilding after geometry changes. Separate input shells remain available.";
  $("outputStatus").classList.remove("mesh-warning");
}
function syncDisplay(result, fit = false) {
  const activeID = display?.meta?.[selected]?.id;
  display = result;
  boundary = result.boundary;
  invalidate();
  view.show(result, fit);
  $("balloonSelect").replaceChildren(
    ...result.balloons.map((_, i) => new Option(balloonLabel(i), i)),
  );
  selectedIDs = new Set(
    [...selectedIDs].filter((id) => result.meta?.some((m) => m.id === id)),
  );
  if (result.selectedIndex !== undefined) {
    selectedIDs = new Set([result.meta[result.selectedIndex].id]);
    selected = result.selectedIndex;
  } else if (activeID && result.meta?.some((m) => m.id === activeID))
    selected = result.meta.findIndex((m) => m.id === activeID);
  else selected = Math.min(selected, result.balloons.length - 1);
  if (!selectedIDs.size && result.meta?.[selected])
    selectedIDs.add(result.meta[selected].id);
  select(selected, false, true);
  const triangles = result.balloons.reduce(
    (n, b) => n + quadMesh(b).quads.length / 4,
    0,
  );
  $("meshStats").textContent =
    `${result.balloons.length} BALLOONS / ${triangles.toLocaleString()} QUADS`;
  $("fieldLabel").textContent = fileName.toUpperCase();
  drawCurves();
  if (view.clipState) view.setClip(view.clipState);
  if (result.canAdjustPop && result.popStrength !== undefined) {
    $("popPressure").value = Math.round(result.popStrength * 100);
    $("popPressureValue").value = `${$("popPressure").value}%`;
  }
}
function balloonLabel(i) {
  const m = display?.meta?.[i];
  return m
    ? `${m.members.length > 1 ? "MERGED" : "BALLOON"} ${m.members.map((v) => String(v + 1).padStart(2, "0")).join("+")}${m.frozen ? " [FROZEN]" : ""}`
    : `BALLOON ${i + 1}`;
}
function select(i, additive = false, preserve = false) {
  selected = display?.balloons.length ? Math.max(0, Number(i)) : -1;
  const id = display?.meta?.[selected]?.id;
  if (!preserve) {
    if (additive && id) {
      if (selectedIDs.has(id)) selectedIDs.delete(id);
      else selectedIDs.add(id);
    } else selectedIDs = id ? new Set([id]) : new Set();
  }
  if (additive && id && !selectedIDs.has(id))
    selected = (display?.meta || []).findIndex((m) => selectedIDs.has(m.id));
  $("balloonSelect").value = selected;
  view.select(
    selected,
    new Set(
      (display?.meta || [])
        .map((m, k) => (selectedIDs.has(m.id) ? k : -1))
        .filter((k) => k >= 0),
    ),
  );
  const e = display?.edits[selected] || [0, 0, 0, 1];
  ["moveX", "moveY", "moveZ", "scale"].forEach(
    (id, k) => ($(id).value = Number(e[k].toFixed(5))),
  );
  $("scale1dFactor").value = e[4 + Number($("scale1dAxis").value)] ?? 1;
  renderMergeChoices();
  updateActionButtons();
  if (!busy && !undoing && display) lastUIState = captureUI();
}
function renderMergeChoices() {
  $("mergeChoices").replaceChildren(
    ...(display?.meta || []).map((m, i) => {
      const label = document.createElement("label"),
        check = document.createElement("input");
      check.type = "checkbox";
      check.checked = selectedIDs.has(m.id);
      check.disabled = busy;
      check.onchange = () => select(i, true);
      label.append(check, document.createTextNode(balloonLabel(i)));
      return label;
    }),
  );
}
function updateActionButtons() {
  const meta = display?.meta?.[selected],
    locked = !!meta?.frozen,
    ids = (display?.meta || [])
      .map((m, i) => (selectedIDs.has(m.id) ? i : -1))
      .filter((i) => i >= 0);
  $("popBtn").disabled = busy || !meta || locked;
  $("freezeBtn").disabled = busy || !meta;
  $("freezeBtn").textContent = locked ? "Unfreeze" : "Freeze";
  $("freezeBtn").setAttribute("aria-pressed", locked);
  $("mergeBtn").disabled =
    busy || ids.length < 2 || ids.some((i) => display.meta[i].frozen);
  for (const id of [
    "moveX",
    "moveY",
    "moveZ",
    "scale",
    "applyBalloonBtn",
    "resetBalloonBtn",
    "scale1dAxis",
    "scale1dFactor",
    "applyScale1d",
  ])
    $(id).disabled = busy || !meta || locked;
  $("balloonState").textContent = meta
    ? `${balloonLabel(selected)} — ${locked ? "shape and position locked" : "editable"}. ${ids.length} selected for Merge.`
    : "No balloons remain. Reset the operations to start again.";
  $("operationHint").textContent = display?.canAdjustPop
    ? "Adjust the slider to update the last pop."
    : `${ids.length} selected · Shift/Ctrl-click or use merge checkboxes.`;
}
const view = new StudioView(
  (i, additive = false) => {
    if (!busy) {
      if (view.tool === "curve") activateTool("move");
      select(i, additive);
    }
  },
  (p, i, curveIndex = activeCurve) => {
    if (busy) return;
    activeCurve = curveIndex;
    points = p;
    curves[activeCurve] = p;
    editCurve = view.tool === "curve";
    drawCurves();
    $("curveSelect").value = activeCurve;
    if (i >= 0) $("curvePoint").value = i;
    showPoint();
    markCurveDirty();
  },
  onCanvasTransform,
);
function rotationControls(tool) {
  $("exactRotation").hidden = !["boundary", "clipRotate"].includes(tool);
  $("rotationContext").textContent =
    tool === "clipRotate"
      ? "CLIPPING PLANE · WORLD AXES · ABOUT PLANE CENTER"
      : "BOUNDARY · WORLD AXES · ABOUT MESH CENTER";
}
function activateTool(tool) {
  if (busy) return;
  if (output?.mode === "boolean" && !tool.startsWith("clip")) invalidate();
  if (tool === "boundary") $("showBoundary").checked = true;
  rotationControls(tool);
  editCurve = tool === "curve";
  if (tool.startsWith("clip") && !view.clipState?.enabled) {
    $("clippingEnabled").checked = true;
    view.setClip({
      enabled: true,
      position: view.clipState?.position || bounds(boundary).center,
      quaternion: view.clipState?.quaternion || [0, 0, 0, 1],
    });
  }
  $("curveEditBtn").setAttribute("aria-pressed", editCurve);
  view.setTool(tool);
  curveUI();
  if (!undoing && display) lastUIState = captureUI();
}
document
  .querySelectorAll("[data-canvas-tool]")
  .forEach(
    (button) =>
      (button.onclick = () => activateTool(button.dataset.canvasTool)),
  );
function onCanvasTransform(change) {
  if (change.type === "clip") {
    const before = captureUI();
    before.clipping = view.startClip;
    recordUI(before, "Move clipping plane");
    status("Clipping view updated. Export geometry is unchanged.");
    return;
  }
  if (change.type === "cancel") {
    if (display) syncDisplay(display);
    return;
  }
  if (busy) return;
  const label =
    change.type === "boundary"
      ? "Rotating boundary and regenerating balloon field…"
      : change.type === "curve"
        ? "Updating curve pressure…"
        : "Checking dragged balloon against walls and neighbors…";
  task(label, async () => {
    try {
      if (change.type === "boundary") {
        boundary = transformMesh(display.boundary, change.matrix);
        await generate(true);
        status(
          change.degrees !== undefined
            ? `Boundary rotated ${change.degrees}° about world ${change.axis}. Unfrozen edits reset; frozen geometry retained.`
            : "Boundary rotated. Unfrozen edits reset; frozen geometry retained.",
        );
      } else if (change.type === "curve") {
        if ($("pressureEnabled").checked) {
          await generate();
          status(
            `${change.whole ? "Curve" : "Curve point"} moved. Pressure applied; frozen shapes retained and unfrozen edits reset.`,
          );
        } else
          status(
            `${change.whole ? "Curve" : "Curve point"} moved. Enable pressure to deform the balloons.`,
          );
      } else if (change.type === "balloon") {
        const edit = draggedEdit(
          display.edits[change.index],
          change.delta,
          change.ratio,
          change.axisRatios,
        );
        const result = await request("edit", { index: change.index, edit });
        syncDisplay(result);
        status(
          result.clamped
            ? `Move limited by a wall, frozen balloon, or insufficient space. ${result.deformedNeighbors} neighbors deformed.`
            : `Move applied. ${result.deformedNeighbors} neighboring balloons deformed to make space.`,
        );
      }
    } catch (err) {
      boundary = display.boundary;
      syncDisplay(display);
      throw err;
    }
  });
}
function exactRotation(degrees) {
  if (busy || !display) return;
  try {
    if (String(degrees).trim() === "" || !Number.isFinite(Number(degrees)))
      throw Error("Enter a finite rotation in degrees.");
    const angle = Number(degrees),
      axis = $("rotationAxis").value;
    if (angle % 360 === 0) {
      status("No orientation change: rotation is a multiple of 360°.");
      return;
    }
    if (view.tool === "clipRotate") {
      const before = captureUI();
      view.setClip(rotateClippingPlane(view.clipState, axis, angle));
      recordUI(before, "Rotate clipping plane");
      status(
        `Clipping plane rotated ${angle}° about world ${axis}. Export geometry is unchanged.`,
      );
      return;
    }
    activateTool("boundary");
    onCanvasTransform({
      type: "boundary",
      matrix: rotationMatrix(bounds(display.boundary).center, axis, angle),
      degrees: angle,
      axis,
    });
  } catch (err) {
    status(err.message, true);
  }
}
$("applyRotation").onclick = () => exactRotation($("rotationDegrees").value);
document.querySelectorAll("[data-rotate-degrees]").forEach(
  (button) =>
    (button.onclick = () => {
      $("rotationDegrees").value = button.dataset.rotateDegrees;
      exactRotation(button.dataset.rotateDegrees);
    }),
);
$("rotationDegrees").onkeydown = (e) => {
  if (e.key === "Enter") {
    $("applyRotation").click();
  }
};
$("rotationSnap").onchange = () => {
  const degrees = Number($("rotationSnap").value);
  view.transform.setRotationSnap(degrees ? (degrees * Math.PI) / 180 : null);
};
view.transform.setRotationSnap(Math.PI / 2);
addTechnicalFrames();
function resetCurve() {
  const b = bounds(boundary);
  points = [
    [-0.45, -0.2],
    [-0.15, 0.25],
    [0.15, -0.15],
    [0.45, 0.2],
  ].map(([x, y]) => [
    b.center[0] + x * b.span[0],
    b.center[1] + y * b.span[1],
    b.center[2],
  ]);
  curveUI();
}
function curveUI() {
  allCurves();
  $("curveSelect").replaceChildren(
    ...curves.map((_, i) => new Option(`CURVE ${i + 1}`, i)),
  );
  $("curveSelect").value = activeCurve;
  $("addCurve").disabled = curves.length >= 5;
  $("removeCurve").disabled = curves.length <= 1;
  const last = Number($("curvePoint").value) || 0;
  $("curvePoint").replaceChildren(
    ...points.map((_, i) => new Option(`POINT ${i + 1}`, i)),
  );
  $("curvePoint").value = Math.min(last, points.length - 1);
  showPoint();
  drawCurves();
}
function showPoint() {
  const p = points[Number($("curvePoint").value)] || [0, 0, 0];
  ["curveX", "curveY", "curveZ"].forEach(
    (id, k) => ($(id).value = Number(p[k].toFixed(4))),
  );
}
function markCurveDirty() {
  status("Curve updated. Apply pressure to regenerate geometry.");
}
async function generate(fit = false, preserve = true) {
  const p = params();
  const curve = validateCurves(allCurves()).map((c) => view.samples(c));
  const r = await request("generate", { boundary, params: p, curve, preserve });
  needsRestore = false;
  configUsed = p;
  curveUsed = curve;
  syncDisplay(r, fit);
  status(
    `Ready · ${r.balloons.length} closed balloons · full surface containment · disjoint contact cells.`,
  );
}
function demo() {
  curves = [];
  activeCurve = 0;
  const g = new T.BoxGeometry(120, 90, 65);
  boundary = canonical(rawGeometry(g));
  g.dispose();
  fileName = "Demonstration container";
  $("fileName").textContent = fileName;
  $("meshSelect").hidden = true;
  $("radiusMin").value = 14;
  $("radiusMax").value = 24;
  $("clearance").value = 0.12;
  resetCurve();
}
function rhino() {
  return (rhinoPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("vendor/rhino3dm.js", document.baseURI).href;
    script.onload = () =>
      window
        .rhino3dm({
          locateFile: () =>
            new URL("vendor/rhino3dm.wasm", document.baseURI).href,
        })
        .then(resolve, reject);
    script.onerror = () =>
      reject(Error("Rhino reader could not load. Refresh and retry."));
    document.head.appendChild(script);
  }));
}
async function readMeshes(file) {
  const ext = file.name.split(".").pop().toLowerCase(),
    buffer = await file.arrayBuffer(),
    items = [];
  if (ext === "3dm") {
    const r = await rhino(),
      doc = r.File3dm.fromByteArray(new Uint8Array(buffer));
    if (!doc) throw Error("Could not read this Rhino document.");
    const objects = doc.objects();
    for (let i = 0; i < objects.count; i++) {
      const obj = objects.get(i),
        g = obj.geometry();
      if (g instanceof r.Mesh) {
        const name = obj.attributes().name || `Mesh ${i + 1}`;
        items.push({ name, raw: rhinoRaw(g) });
      }
      g.delete();
      obj.delete();
    }
    doc.delete();
  } else if (ext === "stl") {
    const g = new STLLoader().parse(buffer);
    items.push({ name: file.name, raw: rawGeometry(g) });
    g.dispose();
  } else if (ext === "obj") {
    const root = new OBJLoader().parse(new TextDecoder().decode(buffer));
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (o.isMesh) {
        const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        items.push({
          name: o.name || `Mesh ${items.length + 1}`,
          raw: rawGeometry(g),
        });
        g.dispose();
      }
    });
  } else throw Error("Choose a .3dm, .stl, or .obj mesh.");
  if (!items.length)
    throw Error(
      "No meshes found. Convert the Rhino object to a closed mesh before exporting.",
    );
  return items;
}
async function loadBoundary(raw, name) {
  curves = [];
  activeCurve = 0;
  const checked = canonical(raw);
  boundary = checked;
  fileName = name;
  $("fileName").textContent = name;
  const b = bounds(boundary),
    s = Math.min(...b.span);
  $("radiusMin").value = +(s * 0.21).toPrecision(4);
  $("radiusMax").value = +(s * 0.36).toPrecision(4);
  $("clearance").value = +(s * 0.002).toPrecision(4);
  $("strength").max = $("strengthN").max = String(s);
  $("influence").max = $("influenceN").max = String(s * 2);
  $("strength").value = $("strengthN").value = +(s * 0.12).toPrecision(4);
  $("influence").value = $("influenceN").value = +(s * 0.4).toPrecision(4);
  resetCurve();
  await generate(true, false);
}
function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function currentOutput() {
  if (!output) throw Error("Build the output before exporting.");
  if (
    $("outputMode").value !== output.mode ||
    Number($("tolerance").value) !== output.tolerance ||
    (output.mode === "boolean" &&
      $("outputQuality").value !== output.quality) ||
    (output.quality === "rebuild" &&
      Number($("rebuildResolution").value) !== output.resolution)
  )
    throw Error("Output settings changed. Build the output again.");
  return output;
}
function mergedRaw(shells) {
  const p = [],
    idx = [];
  for (const s of shells) {
    const off = p.length / 3;
    for (const v of s.positions) p.push(v);
    for (const i of s.indices) idx.push(i + off);
  }
  return { positions: new Float64Array(p), indices: new Uint32Array(idx) };
}
["count", "strength", "influence"].forEach((id) => {
  for (const suffix of ["", "N"])
    $(id + suffix).addEventListener(
      "input",
      () => ($(id + (suffix ? "" : "N")).value = $(id + suffix).value),
    );
});
$("generateBtn").onclick = () =>
  task("Generating smooth balloon meshes…", () => generate());
$("pressureBtn").onclick = () =>
  task("Applying curve pressure…", () => generate());
$("meshFile").onchange = () =>
  task("Reading local container…", async () => {
    const file = $("meshFile").files[0];
    if (!file) return;
    if (file.size > 50e6) throw Error("Choose a mesh file under 50 MB.");
    meshChoices = await readMeshes(file);
    $("meshSelect").replaceChildren(
      ...meshChoices.map((m, i) => new Option(m.name, i)),
    );
    $("meshSelect").hidden = meshChoices.length < 2;
    await loadBoundary(
      meshChoices[0].raw,
      `${file.name} / ${meshChoices[0].name}`,
    );
  });
$("meshSelect").onchange = () =>
  task("Loading selected boundary…", () =>
    loadBoundary(
      meshChoices[Number($("meshSelect").value)].raw,
      meshChoices[Number($("meshSelect").value)].name,
    ),
  );
$("demoBtn").onclick = () =>
  task("Restoring demonstration container…", async () => {
    demo();
    await generate(true, false);
  });
$("shuffleBtn").onclick = () => {
  const before = captureUI();
  $("pointSeed").value =
    crypto.getRandomValues(new Uint32Array(1))[0] % 2147483647;
  recordUI(before, "Shuffle point seed");
};
$("balloonSelect").onchange = () => select($("balloonSelect").value);
$("popBtn").onclick = () =>
  task("Popping balloon and applying local pressure…", async () => {
    const result = await request("pop", {
      index: selected,
      strength: Number($("popPressure").value) / 100,
    });
    syncDisplay(result);
    status(result.message);
  });
$("freezeBtn").onclick = () =>
  task("Updating frozen balloon…", async () => {
    const result = await request("freeze", { index: selected });
    syncDisplay(result);
    status(result.message);
  });
$("mergeBtn").onclick = () =>
  task("Joining selected balloons into one volume…", async () => {
    const indices = display.meta
        .map((m, i) => (selectedIDs.has(m.id) ? i : -1))
        .filter((i) => i >= 0),
      result = await request("merge", { indices });
    syncDisplay(result);
    status(result.message);
  });
$("popPressure").oninput = () => {
  $("popPressureValue").value = `${$("popPressure").value}%`;
};
$("popPressure").onchange = () => {
  if (!display?.canAdjustPop) {
    status("Pressure set for the next Pop!");
    return;
  }
  const strength = Number($("popPressure").value) / 100;
  task("Updating last pop pressure…", async () => {
    try {
      const result = await request("popPressure", { strength });
      syncDisplay(result);
      status(result.message);
    } catch (err) {
      $("popPressure").value = Math.round(display.popStrength * 100);
      $("popPressureValue").value = `${$("popPressure").value}%`;
      throw err;
    }
  });
};
$("resetOperationsBtn").onclick = () =>
  task("Resetting balloon operations…", async () => {
    selectedIDs.clear();
    await generate(false, false);
    status(
      "Pop, Freeze, and Merge reset. A fresh balloon field was generated.",
    );
  });
$("scale1dAxis").onchange = () => {
  $("scale1dFactor").value =
    display?.edits[selected]?.[4 + Number($("scale1dAxis").value)] ?? 1;
  if (view.tool === "scale1d") view.attachTool();
};
$("applyScale1d").onclick = () =>
  task("Applying one-axis balloon scale…", async () => {
    const edit = scaleAxisEdit(
      display.edits[selected],
      Number($("scale1dAxis").value),
      Number($("scale1dFactor").value),
    );
    const result = await request("edit", { index: selected, edit });
    syncDisplay(result);
    status(
      result.clamped
        ? "Scale 1D limited by containment, frozen geometry or available space."
        : "Scale 1D applied. The other axes and uniform scale are unchanged.",
    );
  });
$("applyBalloonBtn").onclick = () =>
  task("Checking walls and neighboring balloons…", async () => {
    const edit = ["moveX", "moveY", "moveZ", "scale"].map((id) =>
      Number($(id).value),
    );
    if (display.edits[selected].length === 7)
      edit.push(...display.edits[selected].slice(4));
    const result = await request("edit", { index: selected, edit });
    syncDisplay(result);
    status(
      result.clamped
        ? `Edit limited by a wall, frozen balloon, or insufficient space. ${result.deformedNeighbors} neighbors deformed.`
        : `Edit applied. ${result.deformedNeighbors} neighbors deformed to make space.`,
    );
  });
$("resetBalloonBtn").onclick = () =>
  task("Resetting selected balloon…", async () => {
    const r = await request("edit", { index: selected, edit: [0, 0, 0, 1] });
    syncDisplay(r);
    status(
      r.clamped
        ? "Reset clamped because another edited balloon occupies the baseline."
        : "Selected balloon reset to its post-pressure baseline.",
    );
  });
$("curvePoint").onchange = () => {
  view.selectedCurve = Number($("curvePoint").value);
  showPoint();
  view.attachTool();
};
$("curveSelect").onchange = () => {
  allCurves();
  activeCurve = Number($("curveSelect").value);
  points = curves[activeCurve];
  view.selectedCurve = 0;
  curveUI();
};
async function curveChanged(label) {
  curveUI();
  if ($("pressureEnabled").checked) await task(label, () => generate());
  else markCurveDirty();
}
$("addCurve").onclick = async () => {
  if (curves.length >= 5) return;
  const before = captureUI();
  allCurves();
  const offset = Math.max(...bounds(boundary).span) * 0.08;
  curves.push(points.map((p) => [p[0], p[1] + offset, p[2]]));
  activeCurve = curves.length - 1;
  points = curves[activeCurve];
  recordUI(before, "Add curve");
  await curveChanged("Applying added curve…");
};
$("removeCurve").onclick = async () => {
  if (curves.length <= 1) return;
  const before = captureUI();
  curves.splice(activeCurve, 1);
  activeCurve = Math.min(activeCurve, curves.length - 1);
  points = curves[activeCurve];
  recordUI(before, "Remove curve");
  await curveChanged("Removing curve pressure…");
};
$("clippingEnabled").onchange = () => {
  view.setClip({
    ...view.clipState,
    enabled: $("clippingEnabled").checked,
    position: view.clipState?.position || bounds(boundary).center,
    quaternion: view.clipState?.quaternion || [0, 0, 0, 1],
  });
  if ($("clippingEnabled").checked && !view.tool.startsWith("clip"))
    activateTool("clipMove");
};
$("clipToggle").onclick = () => {
  if (busy) return;
  const before = captureUI();
  $("clippingEnabled").checked = !view.clipState?.enabled;
  $("clippingEnabled").onchange();
  recordUI(before, "Toggle clipping plane");
  status(
    view.clipState.enabled
      ? "Clipping on."
      : "Clipping off. Plane position and rotation retained.",
  );
};
$("resetClip").onclick = () => {
  view.setClip({
    enabled: $("clippingEnabled").checked,
    position: bounds(boundary).center,
    quaternion: [0, 0, 0, 1],
  });
};
$("resetCurveBtn").onclick = () => {
  const before = captureUI();
  resetCurve();
  markCurveDirty();
  recordUI(before, "Reset curve");
};
$("updateCurveBtn").onclick = () => {
  const before = captureUI();
  const p = ["curveX", "curveY", "curveZ"].map((id) => Number($(id).value));
  if (p.some((v) => !Number.isFinite(v))) {
    status("Enter finite curve coordinates.", true);
    return;
  }
  points[Number($("curvePoint").value)] = p;
  curveUI();
  markCurveDirty();
  recordUI(before, "Move curve point");
};
$("curveEditBtn").onclick = () => {
  activateTool(editCurve ? "move" : "curve");
};
$("pressureEnabled").onchange = () => {
  curveUI();
  task("Updating curve pressure…", () => generate());
};
$("curveFile").onchange = () =>
  task("Reading Rhino attractor curve…", async () => {
    const file = $("curveFile").files[0];
    if (!file) return;
    const r = await rhino(),
      doc = r.File3dm.fromByteArray(new Uint8Array(await file.arrayBuffer()));
    if (!doc) throw Error("Could not read Rhino file.");
    const found = [];
    try {
      const objs = doc.objects();
      for (let i = 0; i < objs.count; i++) {
        const o = objs.get(i),
          g = o.geometry();
        if (g instanceof r.Curve) {
          const d = g.domain;
          found.push(
            Array.from({ length: 17 }, (_, k) =>
              g.pointAt(d[0] + ((d[1] - d[0]) * k) / 16),
            ),
          );
        }
        g.delete();
        o.delete();
      }
    } finally {
      doc.delete();
    }
    if (!found.length)
      throw Error(
        "No Rhino curve found. Export 1–5 attractor curves in the file.",
      );
    if (found.length > 5)
      throw Error(
        "The Rhino file has more than five curves. Export up to five attractor curves.",
      );
    curves = validateCurves(found);
    activeCurve = 0;
    points = curves[0];
    curveUI();
    if ($("pressureEnabled").checked) await generate();
    else markCurveDirty();
  });
$("showBoundary").onchange = () => {
  if (view.boundaryGroup)
    view.boundaryGroup.visible = $("showBoundary").checked && !output?.checks;
};
$("homeBtn").onclick = () => view.fit();
$("rotateBtn").onclick = () => {
  view.orbit.autoRotate = !view.orbit.autoRotate;
  $("rotateBtn").setAttribute("aria-pressed", view.orbit.autoRotate);
};
$("wireBtn").onclick = () => {
  view.wire = !view.wire;
  $("wireBtn").setAttribute("aria-pressed", view.wire);
  view.meshes.forEach((m) =>
    m.children.forEach((c) => (c.visible = view.wire)),
  );
  if (view.result)
    view.result.traverse((object) => {
      if (object.userData.quadWire) object.visible = view.wire;
    });
};
$("outputBtn").onclick = () =>
  task("Building and verifying mesh output…", async () => {
    const p = params(),
      r = await request("output", {
        mode: $("outputMode").value,
        tolerance: p.tolerance,
        quality: $("outputQuality").value,
        resolution: Number($("rebuildResolution").value),
      });
    output = { ...r, tolerance: p.tolerance };
    $("outputStatus").textContent = r.message;
    $("outputStatus").classList.toggle(
      "mesh-warning",
      !!r.incomplete || !!r.qualityWarning,
    );
    view.output(r.mode === "shell" ? r.shells : r.shells[0]);
    status(r.message, !!r.incomplete || !!r.qualityWarning);
  });
$("outputMode").onchange = () => {
  invalidate();
  status("Output mode changed. Build output to preview and export.");
};
$("tolerance").oninput = invalidate;
$("outputQuality").onchange = invalidate;
$("rebuildResolution").onchange = invalidate;
$("exportQuality").onclick = () =>
  task("Preparing mesh quality report…", async () => {
    const o = currentOutput();
    if (!o.diagnostics)
      throw Error("Build a Boolean output to download its quality report.");
    download(
      JSON.stringify(
        {
          tolerance: o.tolerance,
          quality: o.quality,
          checks: o.checks,
          ...o.diagnostics,
        },
        null,
        2,
      ),
      "balloon-build-mesh-quality.json",
      "application/json",
    );
  });
$("exportObj").onclick = () =>
  task("Preparing OBJ export…", async () => {
    const o = currentOutput();
    let txt = "# Balloon Build — " + o.mode + "\no BalloonBuild\n",
      offset = 1;
    o.shells.forEach((s, n) => {
      const q = quadObj(s, `shell_${n}`, offset);
      txt += q.text;
      offset += q.vertices;
    });
    download(txt, `balloon-build-${o.mode}.obj`, "text/plain");
    status("Quad mesh OBJ exported in model coordinates.");
  });
$("exportStl").onclick = () =>
  task("Preparing STL export…", async () => {
    const o = currentOutput(),
      g = geometry(mergedRaw(o.shells)),
      m = new T.Mesh(g),
      stl = new STLExporter().parse(m, { binary: true });
    const precisionCheck = meshQuality({
      positions: g.attributes.position.array,
      indices: g.index.array,
    });
    download(stl, `balloon-build-${o.mode}.stl`, "application/octet-stream");
    g.dispose();
    status(
      precisionCheck.degenerateFaces
        ? `STL exported with ${precisionCheck.degenerateFaces} degenerate faces at single precision. Use Rhino or OBJ to retain double-precision detail.`
        : o.mode === "shell"
          ? "STL exported as triangles (STL cannot store quads). Shell assembly preserves separate shells."
          : "STL exported from the displayed Boolean mesh. STL stores single-precision coordinates; review the output warnings.",
      !!precisionCheck.degenerateFaces || !!o.incomplete,
    );
  });
$("export3dm").onclick = () =>
  task("Preparing Rhino export…", async () => {
    const o = currentOutput(),
      r = await rhino(),
      doc = new r.File3dm();
    addRhinoQuadMesh(r, doc, mergedRaw(o.shells), `Balloon Build / ${o.mode}`);
    download(
      doc.toByteArray(),
      `balloon-build-${o.mode}.3dm`,
      "application/octet-stream",
    );
    doc.delete();
    status(
      o.incomplete
        ? "Rhino mesh exported with remaining geometric warnings. Review the quality report before fabrication."
        : "Rhino quad mesh exported. Use your original model units when importing.",
    );
  });
function projectData() {
  if (!configUsed || !display) throw Error("Generate geometry first.");
  return {
    format: "balloon-build",
    version: 3,
    savedAt: new Date().toISOString(),
    iterationName: $("iterationName").value.trim() || "Untitled iteration",
    curves: validateCurves(allCurves()),
    activeCurve,
    controlSettings: params(),
    clipping: view.clipState,
    fileName,
    params: configUsed,
    curve: curveUsed,
    points,
    boundary: {
      positions: Array.from(display.boundary.positions),
      indices: Array.from(display.boundary.indices),
    },
    edits: display.edits,
    session: display,
    popPressure: Number($("popPressure").value) / 100,
  };
}
$("saveProject").onclick = () =>
  task("Saving project…", async () => {
    if (!configUsed || !display) throw Error("Generate geometry first.");
    const obj = projectData();
    download(
      JSON.stringify(obj, (_, value) =>
        ArrayBuffer.isView(value) ? Array.from(value) : value,
      ),
      "balloon-build-project.json",
      "application/json",
    );
    status(
      "Project saved with the last generated settings and accepted edits.",
    );
  });
async function refreshIterations(selectedId = "") {
  const rows = await iterationStore("list");
  rows.sort((a, b) => b.project.savedAt.localeCompare(a.project.savedAt));
  $("iterationSelect").replaceChildren(
    new Option("CURRENT ITERATION", ""),
    ...rows.map((row) => new Option(row.name, row.id)),
  );
  $("iterationSelect").value = selectedId;
}
async function selectedIteration() {
  const id = $("iterationSelect").value;
  if (!id) return projectData();
  const row = await iterationStore("get", id);
  if (!row) throw Error("Saved iteration was not found.");
  return row.project;
}
$("saveIteration").onclick = () =>
  task("Saving iteration on this browser…", async () => {
    const project = projectData(),
      id = crypto.randomUUID();
    await iterationStore("put", { id, name: project.iterationName, project });
    await refreshIterations(id);
    $("iterationReport").hidden = false;
    $("iterationReport").textContent = JSON.stringify(
      iterationSummary(project),
      null,
      2,
    );
    status(
      "Iteration saved on this browser. Download JSON for a portable backup.",
    );
  });
$("loadIteration").onclick = () =>
  task("Loading saved iteration…", async () => {
    if (!$("iterationSelect").value)
      throw Error("Select a saved iteration first.");
    const project = await selectedIteration();
    await restoreProject(project);
    $("iterationName").value = project.iterationName || "";
  });
$("deleteIteration").onclick = () =>
  task("Removing saved iteration…", async () => {
    const id = $("iterationSelect").value;
    if (!id) throw Error("Select a saved iteration first.");
    await iterationStore("delete", id);
    await refreshIterations();
    $("iterationReport").hidden = true;
  });
$("iterationData").onclick = () =>
  task("Reading numerical iteration data…", async () => {
    $("iterationReport").textContent = JSON.stringify(
      iterationSummary(await selectedIteration()),
      null,
      2,
    );
    $("iterationReport").hidden = false;
  });
$("downloadIteration").onclick = () =>
  task("Downloading iteration…", async () => {
    const project = await selectedIteration();
    download(
      JSON.stringify(project, (_, v) =>
        ArrayBuffer.isView(v) ? Array.from(v) : v,
      ),
      "balloon-build-iteration.json",
      "application/json",
    );
  });
refreshIterations().catch(() =>
  status(
    "Browser iteration storage is unavailable. SAVE PROJECT still downloads a portable JSON backup.",
    true,
  ),
);
async function restoreProject(obj) {
  if (obj.format !== "balloon-build" || ![1, 2, 3].includes(obj.version))
    throw Error("Unsupported project file.");
  for (const id of paramsIDs) $(id).value = obj.params[id];
  $("pressureEnabled").checked = !!obj.params.pressureEnabled;
  const p = params();
  if (
    !Array.isArray(obj.points) ||
    obj.points.length < 2 ||
    obj.points.length > 200 ||
    obj.points.some((a) => a.length !== 3 || a.some((v) => !Number.isFinite(v)))
  )
    throw Error("Invalid saved curve.");
  const raw = canonical(obj.boundary);
  if (
    obj.version === 1 &&
    (!Array.isArray(obj.edits) ||
      obj.edits.length !== p.count ||
      obj.edits.some(
        (e) =>
          !Array.isArray(e) ||
          e.length !== 4 ||
          e.some((v) => !Number.isFinite(v)),
      ))
  )
    throw Error("Invalid saved balloon edits.");
  boundary = raw;
  curves = validateCurves(obj.curves || [obj.points]);
  activeCurve = Math.max(
    0,
    Math.min(curves.length - 1, Number(obj.activeCurve) || 0),
  );
  points = curves[activeCurve];
  fileName = String(obj.fileName || "Saved project");
  $("fileName").textContent = fileName;
  curveUI();
  const curve = obj.curve || allCurves().map((c) => view.samples(c)),
    result = await request("restore", {
      boundary,
      params: p,
      curve,
      edits: obj.edits,
      session: obj.version >= 2 ? { ...obj.session, boundary: raw } : undefined,
    });
  if (obj.clipping) {
    view.setClip(obj.clipping);
    $("clippingEnabled").checked = !!obj.clipping.enabled;
  } else {
    view.setClip({
      enabled: false,
      position: bounds(raw).center,
      quaternion: [0, 0, 0, 1],
    });
    $("clippingEnabled").checked = false;
  }
  needsRestore = false;
  configUsed = p;
  curveUsed = curve;
  syncDisplay(result, true);
  if (obj.controlSettings) {
    for (const id of paramsIDs)
      if (obj.controlSettings[id] !== undefined)
        $(id).value = obj.controlSettings[id];
    $("pressureEnabled").checked = !!obj.controlSettings.pressureEnabled;
  }
  $("popPressure").value = Math.round(
    (obj.popPressure ?? obj.session?.popStrength ?? 0.25) * 100,
  );
  $("popPressureValue").value = `${$("popPressure").value}%`;
  ["count", "strength", "influence"].forEach(
    (id) => ($(id + "N").value = $(id).value),
  );
  status(
    "Project restored with saved geometry settings and collision-checked edits.",
  );
}
$("projectFile").onchange = () =>
  task("Restoring project…", async () => {
    const f = $("projectFile").files[0];
    if (!f) return;
    if (f.size > 80e6) throw Error("Project is too large.");
    await restoreProject(JSON.parse(await f.text()));
  });

$("cancelBtn").onclick = () => {
  if (nativeJobId)
    fetch("http://127.0.0.1:8788/jobs/" + nativeJobId, {
      method: "DELETE",
    }).catch(() => {});
  nativeJobId = undefined;
  worker.terminate();
  for (const p of pending.values())
    p.reject(Error("Operation canceled. Generate again to resume editing."));
  pending.clear();
  newWorker();
  needsRestore = true;
  invalidate();
};
$("helpBtn").onclick = () => $("help").showModal();
$("closeHelp").onclick = () => $("help").close();
mountGeometryLibrary({
  workspace: "balloon-build",
  container: document.querySelector(".control-scroll"),
  save: () => {
    if (busy)
      throw Error("Wait for the current operation to finish before saving.");
    let built = null;
    try {
      if (output) built = currentOutput();
    } catch {}
    return {
      project: projectData(),
      output: built,
      outputSettings: {
        mode: $("outputMode").value,
        quality: $("outputQuality").value,
        resolution: $("rebuildResolution").value,
        tolerance: $("tolerance").value,
      },
    };
  },
  load: async (data) => {
    if (busy)
      throw Error("Wait for the current operation to finish before loading.");
    let loaded = false;
    await task("Loading saved geometry…", async () => {
      await restoreProject(data.project);
      const settings = data.outputSettings;
      if (settings) {
        $("outputMode").value = settings.mode;
        $("outputQuality").value = settings.quality;
        $("rebuildResolution").value = settings.resolution;
        $("tolerance").value = settings.tolerance;
      }
      if (data.output) {
        output = data.output;
        $("outputStatus").textContent = output.message;
        $("outputStatus").classList.toggle(
          "mesh-warning",
          !!output.incomplete || !!output.qualityWarning,
        );
        view.output(output.mode === "shell" ? output.shells : output.shells[0]);
      }
      status(
        "Saved geometry restored, including its built output when available.",
      );
      loaded = true;
    });
    if (!loaded) throw Error($("status").textContent);
  },
  thumbnail: () =>
    canvasThumbnail(view.renderers[0], view.scene, view.perspective),
});
newWorker();
const party = initBalloonParty(rhino);
const partySend = document.createElement("div");
partySend.innerHTML =
  '<label for="partySource">Send to Balloon Party</label><select id="partySource"><option value="output">Built output</option><option value="balloons">Balloons only</option><option value="assembly">Container + balloons</option></select><button id="sendParty" class="primary">SEND TO BALLOON PARTY ↗</button><p class="note">Copies this geometry into the assembly workspace. Use Built output for your shell assembly or Boolean result. Party edits leave this simulation unchanged.</p>';
$("exportStl").after(partySend);
$("sendParty").onclick = () =>
  task("Sending snapshot to Balloon Party…", async () => {
    if (!display) throw Error("Generate balloons before sending geometry.");
    const source = $("partySource").value;
    const raw =
      source === "output"
        ? mergedRaw(currentOutput().shells)
        : mergedRaw(
            source === "balloons"
              ? display.balloons
              : [display.boundary, ...display.balloons],
          );
    if (!raw.indices.length) throw Error("No geometry is available to send.");
    party.add(
      raw,
      `${fileName} / ${source === "output" ? output.mode : source}`,
    );
    workspaces.showParty();
  });
const workspaces = initVoronoi(
  () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
  rhino,
  async (raw, showBalloonBuild) => {
    if (busy)
      throw Error("Wait for the current Balloon Build operation to finish.");
    canonical(raw); // Validate before changing either workspace.
    showBalloonBuild();
    await task("Using Voronoi enclosure as container…", async () => {
      await loadBoundary(raw, "Voronoi Balloons / enclosure (feet)");
      meshChoices = [{ name: "Voronoi enclosure (feet)", raw: boundary }];
      $("meshSelect").replaceChildren(new Option(meshChoices[0].name, 0));
      $("meshSelect").hidden = true;
      $("meshFile").value = "";
      status(
        "Voronoi enclosure loaded as container (feet). New balloons generated inside it. Undo restores the previous Balloon Build model.",
      );
    });
  },
  party,
);
demo();
task("Generating demonstration balloon field…", () => generate(true));
