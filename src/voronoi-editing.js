import { validateVoronoiLifecycle } from "./voronoi-lifecycle.js";
import { validBalloonEdit, scaleAxisEdit } from "./balloon-edit.js";
import * as T from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { validateCurves } from "./iterations.js";

export function createVoronoiEditing({
  pane,
  existing,
  scene,
  camera,
  plan,
  renderers,
  orbit,
  getResult,
  rebuild,
  showBalloons,
  rhino,
}) {
  const controls = pane.querySelector(".voro-controls"),
    sections = [];
  for (const sourceId of ["curveSelect", "balloonSelect"]) {
    const section = existing
      .querySelector("#" + sourceId)
      .closest("details")
      .cloneNode(true);
    section.querySelectorAll("[id]").forEach((el) => (el.id = "ve_" + el.id));
    section
      .querySelectorAll("[for]")
      .forEach((el) => (el.htmlFor = "ve_" + el.htmlFor));
    for (const note of section.querySelectorAll(
      ".note:not(.scale1d-controls .note)",
    ))
      note.textContent =
        sourceId === "curveSelect"
          ? "Up to five pink curves. Drag a complete curve with MOVE CURVE, or edit its points with CURVE POINTS. Strength and influence are shared. Enable pressure applies immediately."
          : "Click a balloon in either canvas. Move X / Y / Z and Scale apply to that original seed. Edits rebuild the united footprint and enclosure; the original Voronoi cells are retained.";
    sections.push(section);
    controls.insertBefore(section, controls.querySelector("#vGenerate"));
  }
  const $ = (id) => pane.querySelector("#ve_" + id);
  const tools = document.createElement("div");
  tools.className = "canvas-tools";
  tools.innerHTML = [
    "orbit",
    "move",
    "scale",
    "scale1d",
    "rotate",
    "curve",
    "curveMove",
  ]
    .map(
      (key, i) =>
        `<button data-ve-tool="${key}" aria-pressed="${i === 0}">${["ORBIT", "MOVE BALLOON", "SCALE BALLOON", "SCALE 1D", "ROTATE BALLOON", "CURVE POINTS", "MOVE CURVE"][i]}</button>`,
    )
    .join("");
  const axisTools = document.createElement("div");
  axisTools.setAttribute("aria-label", "Scale 1D direction");
  axisTools.innerHTML =
    '<button type="button" data-axis="0">X</button><button type="button" data-axis="1">Y</button><button type="button" data-axis="2">Z (VERTICAL)</button>';
  pane.querySelector(".voro-steps").after(tools, axisTools);
  const operations = document.createElement("div");
  operations.className = "balloon-actions";
  operations.setAttribute("aria-label", "Voronoi balloon operations");
  operations.innerHTML =
    '<button id="ve_pop" class="pop-button">Pop!</button><button id="ve_freeze" aria-pressed="false">Freeze</button><label>Pop pressure <output id="ve_popPressureValue">25%</output><input id="ve_popPressure" type="range" min="0" max="100" value="25" aria-label="Voronoi pop pressure"></label><button id="ve_unclipEdge" aria-pressed="false">UNCLIP FLOORPLATE EDGE</button><button id="ve_unclipBottom" aria-pressed="false">UNCLIP FLOORPLATE BOTTOM</button><button id="ve_restorePopped">RESTORE POPPED</button><button id="ve_undoOperation">UNDO OPERATION</button><span id="ve_operationState" class="note"></span>';

  const rotationControls = document.createElement("div");
  rotationControls.className = "scale1d-controls";
  rotationControls.innerHTML =
    '<label for="ve_rotateAxis">Rotation axis</label><select id="ve_rotateAxis"><option value="0">X</option><option value="1">Y</option><option value="2" selected>Z (vertical)</option></select><label for="ve_rotateDegrees">Degrees</label><input id="ve_rotateDegrees" type="number" step="any" value="0"><button id="ve_rotateBalloon">ROTATE SELECTED</button><button id="ve_resetRotation">RESET ROTATION</button>';
  const dock = document.createElement("section");
  dock.className = "voronoi-operation-dock";
  dock.setAttribute("aria-label", "Balloon editing controls");
  pane.querySelector("#vPlan").closest(".panel").before(dock);
  dock.append(tools, axisTools, rotationControls, operations);
  pane.classList.add("voronoi-uppercase");
  const degreeEntry = document.createElement("input");
  degreeEntry.type = "number";
  degreeEntry.step = "any";
  degreeEntry.className = "section-degree-entry";
  degreeEntry.hidden = true;
  pane.append(degreeEntry);
  let rotatePress, rotateRelease, degreeAxis;
  let frozen = {},
    unclippedEdges = [],
    unclippedBottoms = [],
    rotations = {},
    popped = [],
    popEvents = [],
    popPressure = 0.25,
    operationHistory = [],
    pendingOperation = null;
  const recordOperation = () => {
    pendingOperation = structuredClone({
      frozen,
      popped,
      popEvents,
      popPressure,
      unclippedEdges: [...unclippedEdges],
      unclippedBottoms: [...unclippedBottoms],
      rotations: structuredClone(rotations),
    });
    operationHistory.push(
      structuredClone({
        frozen,
        popped,
        popEvents,
        popPressure,
        unclippedEdges,
        unclippedBottoms,
        rotations,
      }),
    );
    if (operationHistory.length > 20) operationHistory.shift();
  };
  const isFrozen = () => !!frozen[selectedId];
  let curves = [],
    active = 0,
    point = 0,
    selectedId = null,
    visibleZone = null,
    edits = {},
    tool = "orbit",
    drag = null,
    dirty = false,
    drawn = false,
    busy = false;
  const overlays = new T.Group();
  const overlayScene = new T.Scene();
  overlayScene.add(overlays);
  const proxy = new T.Object3D();
  scene.add(proxy);
  const transform = new TransformControls(camera, renderers[0].domElement);
  transform.setSize(0.85);
  transform.setColors(0x9af4f9, 0x21e0ed, 0x789fe8, 0xffffff);
  scene.add(transform.getHelper());
  const ray = new T.Raycaster(),
    pointer = new T.Vector2();
  let handles = [],
    lines = [],
    meshes = [],
    baseline,
    target;
  function result() {
    return getResult();
  }
  function resetCurve() {
    const r = result(),
      w = r?.params.width || 80,
      h = r?.params.height || 50;
    curves[active] = [
      [w * 0.05, h * 0.3, 0],
      [w * 0.35, h * 0.65, 0],
      [w * 0.65, h * 0.35, 0],
      [w * 0.95, h * 0.7, 0],
    ];
  }
  function ensure() {
    if (!curves.length) resetCurve();
  }
  function sample(c) {
    return new T.CatmullRomCurve3(
      c.map((p) => new T.Vector3(...p)),
      false,
      "centripetal",
    )
      .getPoints(Math.max(100, c.length * 12))
      .map((p) => p.toArray());
  }
  function settings() {
    ensure();
    return {
      edits: structuredClone(edits),
      frozen: structuredClone(frozen),
      popped: [...new Set(popped)],
      popEvents: structuredClone(popEvents),
      popPressure,
      unclippedEdges: [...unclippedEdges],
      unclippedBottoms: [...unclippedBottoms],
      rotations: structuredClone(rotations),
      curves: curves.map(sample),
      pressureEnabled: $("pressureEnabled").checked,
      strength: Number($("strength").value),
      influence: Number($("influence").value),
    };
  }
  function clear() {
    for (const o of [...overlays.children]) {
      overlays.remove(o);
      o.geometry?.dispose();
      o.material?.dispose();
    }
  }
  function paint() {
    rotationControls.hidden = tool !== "rotate";
    rotationControls.classList.toggle(
      "scale1d-controls",
      !rotationControls.hidden,
    );
    axisTools.hidden = tool !== "scale1d";
    axisTools.classList.toggle("canvas-tools", !axisTools.hidden);
    for (const button of axisTools.children)
      button.setAttribute(
        "aria-pressed",
        button.dataset.axis === $("scale1dAxis").value,
      );
    for (const b of tools.children)
      b.setAttribute("aria-pressed", b.dataset.veTool === tool);
    ensure();
    clear();
    handles = [];
    lines = [];
    const w = result()?.params.width || 80;
    curves.forEach((c, i) => {
      const spline = new T.CatmullRomCurve3(
        c.map((p) => new T.Vector3(...p)),
        false,
        "centripetal",
      );
      const stroke = new T.Mesh(
        new T.TubeGeometry(spline, 100, w * 0.0028, 8, false),
        new T.MeshBasicMaterial({
          color: 0xdc24f4,
          depthTest: false,
          depthWrite: false,
          transparent: true,
          opacity: i === active ? 1 : 0.65,
        }),
      );
      stroke.renderOrder = 20;
      overlays.add(stroke);
      const pick = new T.Mesh(
        new T.TubeGeometry(spline, 100, w * 0.01, 6, false),
        new T.MeshBasicMaterial({ visible: false }),
      );
      pick.userData.curve = i;
      overlays.add(pick);
      lines.push(pick);
      if (tool === "curve" && i === active)
        c.forEach((p, j) => {
          const dot = new T.Mesh(
            new T.SphereGeometry(w * 0.012, 12, 8),
            new T.MeshBasicMaterial({ color: 0xdc24f4, depthTest: false }),
          );
          dot.position.fromArray(p);
          dot.userData.point = j;
          dot.renderOrder = 30;
          overlays.add(dot);
          handles.push(dot);
        });
    });
    overlays.updateMatrixWorld(true);
    if (!drag && !transform.dragging) attach();
  }
  function ui() {
    ensure();
    $("curveSelect").replaceChildren(
      ...curves.map((_, i) => new Option(`CURVE ${i + 1}`, i)),
    );
    $("curveSelect").value = active;
    $("addCurve").disabled = curves.length >= 5;
    $("removeCurve").disabled = curves.length <= 1;
    point = Math.min(point, curves[active].length - 1);
    $("curvePoint").replaceChildren(
      ...curves[active].map((_, i) => new Option(`POINT ${i + 1}`, i)),
    );
    $("curvePoint").value = point;
    ["curveX", "curveY", "curveZ"].forEach(
      (id, k) => ($(id).value = Number(curves[active][point][k].toFixed(4))),
    );
    const spheres = (result()?.spheres || []).filter(
      (s) => visibleZone === null || s.zone === visibleZone,
    );
    if (!spheres.some((s) => s.id === selectedId))
      selectedId = spheres[0]?.id ?? null;
    $("balloonSelect").replaceChildren(
      ...spheres.map(
        (s) =>
          new Option(
            `${s.zone !== undefined ? "ZONE " + (s.zone + 1) + " / " : ""}BALLOON ${String((s.zone !== undefined ? s.id % 150 : s.id) + 1).padStart(2, "0")}${frozen[s.id] ? " · FROZEN" : ""}`,
            s.id,
          ),
      ),
    );
    $("balloonSelect").value = selectedId;
    const edit = edits[selectedId] || [0, 0, 0, 1];
    ["moveX", "moveY", "moveZ", "scale"].forEach(
      (id, k) => ($(id).value = Number(edit[k].toFixed(4))),
    );
    $("scale1dFactor").value = edit[4 + Number($("scale1dAxis").value)] ?? 1;
    $("balloonState").textContent =
      selectedId === null
        ? "No balloon selected."
        : `BALLOON ${selectedId + 1} selected / original seed ${selectedId}${isFrozen() ? " · FROZEN — shape locked" : ""}.`;
    for (const id of [
      "moveX",
      "moveY",
      "moveZ",
      "scale",
      "scale1dAxis",
      "scale1dFactor",
      "applyScale1d",
      "applyBalloonBtn",
      "resetBalloonBtn",
    ])
      $(id).disabled = busy || selectedId === null || isFrozen();
    $("pop").disabled = busy || selectedId === null || spheres.length <= 1;
    $("freeze").disabled = busy || selectedId === null;
    $("freeze").textContent = isFrozen() ? "Unfreeze" : "Freeze";
    $("freeze").setAttribute("aria-pressed", isFrozen());
    const uncut = unclippedEdges.includes(selectedId);
    $("unclipEdge").disabled = busy || selectedId === null;
    $("unclipEdge").textContent = uncut
      ? "CLIP FLOORPLATE EDGE"
      : "UNCLIP FLOORPLATE EDGE";
    $("unclipEdge").setAttribute("aria-pressed", uncut);
    const openBottom = unclippedBottoms.includes(selectedId);
    $("unclipBottom").disabled = busy || selectedId === null;
    $("unclipBottom").textContent = openBottom
      ? "CLIP FLOORPLATE BOTTOM"
      : "UNCLIP FLOORPLATE BOTTOM";
    $("unclipBottom").setAttribute("aria-pressed", openBottom);
    const rotationDisabled = busy || selectedId === null || isFrozen();
    for (const id of ["rotateAxis", "rotateDegrees", "rotateBalloon"])
      $(id).disabled = rotationDisabled;
    $("resetRotation").disabled = rotationDisabled || !rotations[selectedId];
    $("restorePopped").disabled = busy || !popped.length;
    $("undoOperation").disabled = busy || !operationHistory.length;
    $("popPressure").disabled = busy;
    $("popPressure").value = popPressure * 100;
    $("popPressureValue").textContent = Math.round(popPressure * 100) + "%";
    $("operationState").textContent =
      `${Object.keys(frozen).length} frozen · ${popped.length} popped`;
    for (const mesh of meshes)
      mesh.material.emissive?.setHex(
        mesh.userData.balloonId === selectedId ? 0x087079 : 0x000000,
      );
  }
  function changed() {
    dirty = true;
    ui();
    paint();
    if ($("pressureEnabled").checked) rebuild();
  }
  function commit() {
    dirty = true;
    rebuild();
  }
  function anchor() {
    if (tool === "curve") return curves[active]?.[point];
    if (tool === "curveMove")
      return [0, 1, 2].map(
        (k) =>
          curves[active].reduce((s, p) => s + p[k], 0) / curves[active].length,
      );
    return result()?.spheres.find((s) => s.id === selectedId)?.center;
  }
  function attach() {
    transform.detach();
    target = null;
    if (tool === "orbit" || busy) return;
    const a = anchor();
    if (!a || (!["curve", "curveMove"].includes(tool) && isFrozen())) return;
    target = tool === "curve" || tool === "curveMove" ? "curve" : "balloon";
    proxy.position.fromArray(a);
    proxy.scale.setScalar(1);
    proxy.quaternion.identity();
    proxy.updateMatrixWorld();
    const axis = Number($("scale1dAxis").value);
    transform.showX = tool !== "scale1d" || axis === 0;
    transform.showY = tool !== "scale1d" || axis === 1;
    transform.showZ = tool !== "scale1d" || axis === 2;
    transform.setMode(
      ["scale", "scale1d"].includes(tool) ? "scale" : "translate",
    );
    transform.setSpace("world");
    transform.attach(proxy);
  }
  function setTool(next) {
    tool = next;
    for (const b of tools.children)
      b.setAttribute("aria-pressed", b.dataset.veTool === tool);
    if (["move", "scale", "scale1d", "rotate"].includes(tool)) showBalloons();
    paint();
  }
  tools
    .querySelectorAll("button")
    .forEach((b) => (b.onclick = () => setTool(b.dataset.veTool)));
  function begin() {
    if (!target || busy || (target === "balloon" && isFrozen())) return;
    ensure();
    meshes
      .find((o) => o.userData.balloonId === selectedId)
      ?.updateMatrixWorld(true);
    baseline = {
      meshMatrix: meshes
        .find((o) => o.userData.balloonId === selectedId)
        ?.matrix.clone(),
      anchor: proxy.position.clone(),
      points: curves[active].map((p) => p.slice()),
      edit: [...(edits[selectedId] || [0, 0, 0, 1])],
      type: target,
      id: selectedId,
      active,
      point,
      tool,
    };
    orbit.enabled = false;
    drawn = false;
  }
  function gumballRotation() {
    const axis = ["X", "Y", "Z"].indexOf(transform.axis);
    if (axis < 0 || !baseline) return new T.Quaternion();
    const radius =
      result()?.spheres.find((s) => s.id === baseline.id)?.radius ?? 1;
    const distance =
      proxy.position.getComponent(axis) - baseline.anchor.getComponent(axis);
    const direction = new T.Vector3().setComponent(axis, 1);
    return new T.Quaternion().setFromAxisAngle(direction, distance / radius);
  }
  function preview() {
    if (!baseline) return;
    if (baseline.tool === "rotate") {
      const mesh = meshes.find((o) => o.userData.balloonId === baseline.id);
      if (!mesh || !baseline.meshMatrix) return;
      mesh.matrixAutoUpdate = false;
      mesh.matrix
        .makeTranslation(...baseline.anchor.toArray())
        .multiply(new T.Matrix4().makeRotationFromQuaternion(gumballRotation()))
        .multiply(
          new T.Matrix4().makeTranslation(
            ...baseline.anchor.clone().negate().toArray(),
          ),
        )
        .multiply(baseline.meshMatrix);
      mesh.matrixWorldNeedsUpdate = true;
      return;
    }
    const delta = proxy.position.clone().sub(baseline.anchor).toArray();
    drawn = true;
    if (baseline.type === "curve") {
      if (baseline.tool === "curve")
        curves[baseline.active][baseline.point] = proxy.position.toArray();
      else
        curves[baseline.active] = baseline.points.map((p) =>
          p.map((v, k) => v + delta[k]),
        );
      paint();
    } else {
      const edit = [...baseline.edit];
      for (let k = 0; k < 3; k++) edit[k] += delta[k];
      if (baseline.tool === "scale") {
        const values = proxy.scale.toArray();
        const ratio = values.reduce(
          (a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a),
          1,
        );
        edit[3] = Math.max(0.1, Math.min(3, baseline.edit[3] * ratio));
      }
      if (baseline.tool === "scale1d") {
        const axis = Number($("scale1dAxis").value),
          factor = Math.max(
            0.1,
            Math.min(
              3,
              (baseline.edit[4 + axis] ?? 1) * proxy.scale.getComponent(axis),
            ),
          );
        const axial = scaleAxisEdit(edit, axis, factor);
        edit.splice(0, edit.length, ...axial);
      }
      edits[baseline.id] = edit;
      const mesh = meshes.find((o) => o.userData.balloonId === baseline.id);
      if (mesh) {
        const scale = edit[3] / baseline.edit[3];
        const matrix = new T.Matrix4()
          .makeTranslation(
            ...baseline.anchor
              .clone()
              .add(new T.Vector3(...delta))
              .toArray(),
          )
          .multiply(
            new T.Matrix4().makeScale(
              ...[0, 1, 2].map(
                (k) =>
                  (scale * (edit[4 + k] ?? 1)) / (baseline.edit[4 + k] ?? 1),
              ),
            ),
          )
          .multiply(
            new T.Matrix4().makeTranslation(
              ...baseline.anchor.clone().negate().toArray(),
            ),
          )
          .multiply(baseline.meshMatrix || new T.Matrix4());
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(matrix);
        mesh.matrixWorldNeedsUpdate = true;
      }
    }
    ui();
  }
  function finish() {
    const had = drawn,
      type = baseline?.type;
    baseline = null;
    orbit.enabled = true;
    if (had) {
      dirty = true;
      if (type === "balloon" || $("pressureEnabled").checked) commit();
      else paint();
    }
  }
  transform.addEventListener("mouseDown", begin);
  transform.addEventListener("objectChange", preview);
  const canvas = renderers[0].domElement;
  canvas.addEventListener(
    "pointerdown",
    (event) => {
      rotatePress = tool === "rotate" && event.button === 0 ? event : null;
      rotateRelease = null;
    },
    true,
  );
  canvas.addEventListener(
    "pointerup",
    (event) => {
      if (rotatePress?.pointerId === event.pointerId) rotateRelease = event;
    },
    true,
  );
  transform.addEventListener("mouseUp", () => {
    if (baseline?.tool !== "rotate") return finish();
    const axis = ["X", "Y", "Z"].indexOf(transform.axis);
    const click =
      rotatePress &&
      rotateRelease &&
      Math.hypot(
        rotateRelease.clientX - rotatePress.clientX,
        rotateRelease.clientY - rotatePress.clientY,
      ) <= 4;
    const turn = gumballRotation();
    proxy.position.copy(baseline.anchor);
    proxy.updateMatrixWorld();
    const mesh = meshes.find((o) => o.userData.balloonId === baseline.id);
    if (mesh && baseline.meshMatrix) {
      mesh.matrix.copy(baseline.meshMatrix);
      mesh.matrixWorldNeedsUpdate = true;
    }
    finish();
    proxy.quaternion.identity();
    if (click && axis >= 0) {
      degreeAxis = axis;
      degreeEntry.value = "";
      degreeEntry.placeholder = `${transform.axis} DEGREES`;
      degreeEntry.setAttribute(
        "aria-label",
        `Rotate balloon about ${transform.axis} in degrees`,
      );
      degreeEntry.style.left = `${Math.max(4, Math.min(rotateRelease.clientX + 10, innerWidth - 120))}px`;
      degreeEntry.style.top = `${Math.max(4, Math.min(rotateRelease.clientY + 6, innerHeight - 42))}px`;
      degreeEntry.hidden = false;
      degreeEntry.focus({ preventScroll: true });
    } else if (!click && turn.angleTo(new T.Quaternion()) > 1e-6) {
      applyRotation(turn);
    }
  });
  degreeEntry.onblur = () => {
    degreeEntry.hidden = true;
  };
  degreeEntry.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === "Escape") degreeEntry.blur();
    if (event.key === "Enter" && Number.isFinite(degreeEntry.valueAsNumber)) {
      event.preventDefault();
      rotateDegrees(degreeAxis, degreeEntry.valueAsNumber);
      degreeEntry.blur();
    }
  };
  function setRay(e, i) {
    const rect = renderers[i].domElement.getBoundingClientRect();
    pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      1 - ((e.clientY - rect.top) / rect.height) * 2,
    );
    ray.setFromCamera(pointer, i ? plan : camera);
  }
  renderers.forEach((r, i) => {
    let orbitClick;
    r.domElement.addEventListener("pointerdown", (e) => {
      orbitClick =
        e.button === 0 && tool === "orbit" && !busy && !e.shiftKey
          ? [e.pointerId, e.clientX, e.clientY]
          : null;
    });
    r.domElement.addEventListener("pointerup", (e) => {
      const start = orbitClick;
      orbitClick = null;
      if (
        !start ||
        start[0] !== e.pointerId ||
        tool !== "orbit" ||
        busy ||
        Math.hypot(e.clientX - start[1], e.clientY - start[2]) > 4
      )
        return;
      setRay(e, i);
      const hit = ray.intersectObjects(meshes, false)[0];
      if (!hit) return;
      selectedId = hit.object.userData.balloonId;
      ui();
      paint();
    });
    r.domElement.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0 || busy || tool === "orbit") return;
        setRay(e, i);
        if (!i && transform.object) {
          transform.pointerHover({ x: pointer.x, y: pointer.y, button: 0 });
          if (transform.axis) {
            orbit.enabled = false;
            return;
          }
        }
        let hit = ray.intersectObjects(handles, false)[0];
        if (hit) {
          point = hit.object.userData.point;
          tool = "curve";
        } else {
          hit = ray.intersectObjects(lines, false)[0];
          if (hit) {
            active = hit.object.userData.curve;
            tool = "curveMove";
          } else {
            hit = ray.intersectObjects(meshes, false)[0];
            if (!hit) return;
            selectedId = hit.object.userData.balloonId;
            if (!["scale", "scale1d", "rotate"].includes(tool)) tool = "move";
          }
        }
        ui();
        paint();
        if (tool === "rotate") return;
        begin();
        if (!baseline) return;
        const normal = i
            ? new T.Vector3(0, 0, 1)
            : camera.getWorldDirection(new T.Vector3()),
          plane = new T.Plane().setFromNormalAndCoplanarPoint(
            normal,
            proxy.position,
          ),
          start = new T.Vector3();
        if (!ray.ray.intersectPlane(plane, start)) return;
        drag = {
          plane,
          start,
          anchor: proxy.position.clone(),
          view: i,
          screenY: e.clientY,
        };
        r.domElement.setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
    r.domElement.addEventListener(
      "pointermove",
      (e) => {
        if (!drag || drag.view !== i) return;
        setRay(e, i);
        const p = new T.Vector3();
        if (ray.ray.intersectPlane(drag.plane, p)) {
          if (baseline?.tool === "scale")
            proxy.scale.setScalar(Math.exp((drag.screenY - e.clientY) * 0.01));
          else if (baseline?.tool === "scale1d") {
            proxy.scale.setScalar(1);
            proxy.scale.setComponent(
              Number($("scale1dAxis").value),
              Math.exp((drag.screenY - e.clientY) * 0.01),
            );
          } else proxy.position.copy(drag.anchor).add(p.sub(drag.start));
          proxy.updateMatrixWorld();
          preview();
        }
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
    r.domElement.addEventListener(
      "pointerup",
      (e) => {
        if (!drag || drag.view !== i) return;
        drag = null;
        finish();
        attach();
        e.stopImmediatePropagation();
      },
      true,
    );
    r.domElement.addEventListener(
      "pointercancel",
      () => {
        if (!baseline) return;
        if (baseline.type === "curve")
          curves[baseline.active] = baseline.points;
        else edits[baseline.id] = baseline.edit;
        drag = null;
        baseline = null;
        orbit.enabled = true;
        ui();
        paint();
        rebuild();
      },
      true,
    );
  });
  $("curveSelect").onchange = () => {
    active = Number($("curveSelect").value);
    point = 0;
    ui();
    paint();
  };
  $("curvePoint").onchange = () => {
    point = Number($("curvePoint").value);
    ui();
    paint();
  };
  $("addCurve").onclick = () => {
    if (curves.length >= 5) return;
    curves.push(
      curves[active].map((p) => [
        p[0],
        p[1] + (result()?.params.width || 80) * 0.08,
        p[2],
      ]),
    );
    active = curves.length - 1;
    changed();
  };
  $("removeCurve").onclick = () => {
    if (curves.length <= 1) return;
    curves.splice(active, 1);
    active = Math.min(active, curves.length - 1);
    changed();
  };
  $("resetCurveBtn").onclick = () => {
    resetCurve();
    changed();
  };
  $("updateCurveBtn").onclick = () => {
    const p = ["curveX", "curveY", "curveZ"].map((id) => Number($(id).value));
    if (!p.every(Number.isFinite)) return;
    curves[active][point] = p;
    changed();
  };
  for (const id of ["strength", "influence"]) {
    $(id).oninput = () => ($(id + "N").value = $(id).value);
    $(id + "N").oninput = () => ($(id).value = $(id + "N").value);
    $(id).onchange = $(id + "N").onchange = () => {
      dirty = true;
      if ($("pressureEnabled").checked) rebuild();
    };
  }
  $("pressureEnabled").onchange = () => {
    dirty = true;
    rebuild();
  };
  $("pressureBtn").onclick = commit;
  $("balloonSelect").onchange = () => {
    selectedId = Number($("balloonSelect").value);
    ui();
    setTool("move");
  };
  $("scale1dAxis").onchange = () => {
    ui();
    paint();
  };
  for (const button of axisTools.children)
    button.onclick = () => {
      if (busy || drag || transform.dragging) return;
      $("scale1dAxis").value = button.dataset.axis;
      $("scale1dAxis").onchange();
    };
  $("applyScale1d").onclick = () => {
    if (selectedId === null || busy || isFrozen()) return;
    try {
      edits[selectedId] = scaleAxisEdit(
        edits[selectedId] || [0, 0, 0, 1],
        Number($("scale1dAxis").value),
        Number($("scale1dFactor").value),
      );
      commit();
    } catch (e) {
      pane.querySelector("#vStatus").textContent = e.message;
    }
  };
  $("applyBalloonBtn").onclick = () => {
    if (selectedId === null || busy || isFrozen()) return;
    const values = ["moveX", "moveY", "moveZ", "scale"].map((id) =>
      Number($(id).value),
    );
    if (!values.every(Number.isFinite) || values[3] < 0.1 || values[3] > 3)
      return;
    if (edits[selectedId]?.length === 7)
      values.push(...edits[selectedId].slice(4));
    edits[selectedId] = values;
    commit();
  };
  $("resetBalloonBtn").onclick = () => {
    if (selectedId === null || busy || isFrozen()) return;
    delete edits[selectedId];
    commit();
  };
  $("unclipEdge").onclick = () => {
    if (busy || selectedId === null) return;
    recordOperation();
    unclippedEdges = unclippedEdges.includes(selectedId)
      ? unclippedEdges.filter((id) => id !== selectedId)
      : [...unclippedEdges, selectedId];
    commit();
  };
  $("unclipBottom").onclick = () => {
    if (busy || selectedId === null) return;
    recordOperation();
    unclippedBottoms = unclippedBottoms.includes(selectedId)
      ? unclippedBottoms.filter((id) => id !== selectedId)
      : [...unclippedBottoms, selectedId];
    commit();
  };
  $("rotateBalloon").onclick = () =>
    rotateDegrees(
      Number($("rotateAxis").value),
      $("rotateDegrees").valueAsNumber,
    );
  function rotateDegrees(axis, degrees) {
    if (!Number.isFinite(degrees) || degrees % 360 === 0) return;
    const direction = new T.Vector3().setComponent(axis, 1);
    const turn = new T.Quaternion().setFromAxisAngle(
      direction,
      T.MathUtils.degToRad(degrees % 360),
    );
    applyRotation(turn);
  }
  function applyRotation(turn) {
    if (busy || selectedId === null || isFrozen()) return;
    const current = new T.Quaternion().fromArray(
      rotations[selectedId] ?? [0, 0, 0, 1],
    );
    recordOperation();
    rotations[selectedId] = current.premultiply(turn).normalize().toArray();
    commit();
  }
  $("resetRotation").onclick = () => {
    if (busy || selectedId === null || isFrozen() || !rotations[selectedId])
      return;
    recordOperation();
    delete rotations[selectedId];
    commit();
  };
  $("freeze").onclick = () => {
    if (busy || selectedId === null) return;
    const balloon = result()?.spheres.find((s) => s.id === selectedId);
    if (!balloon) return;
    recordOperation();
    if (isFrozen()) delete frozen[selectedId];
    else
      frozen[selectedId] = structuredClone({
        center: balloon.center,
        radius: balloon.radius,
        axisScale: balloon.axisScale ?? [1, 1, 1],
        ...(balloon.raw ? { raw: balloon.fullRaw ?? balloon.raw } : {}),
      });
    commit();
  };
  $("pop").onclick = () => {
    const balloon = result()?.spheres.find((s) => s.id === selectedId);
    if (busy || !balloon || result().spheres.length <= 1) return;
    recordOperation();
    if (popped.includes(selectedId)) {
      rebuild();
      return;
    }
    popped.push(selectedId);
    delete frozen[selectedId];
    popEvents.push({
      center: [...balloon.center],
      radius: balloon.radius * Math.max(...(balloon.axisScale ?? [1, 1, 1])),
      zone: balloon.zone,
    });
    commit();
  };
  $("restorePopped").onclick = () => {
    if (busy) return;
    recordOperation();
    popped = [];
    popEvents = [];
    commit();
  };
  $("undoOperation").onclick = () => {
    if (busy || !operationHistory.length) return;
    ({
      frozen,
      popped,
      popEvents,
      popPressure,
      unclippedEdges,
      unclippedBottoms,
      rotations,
    } = operationHistory.pop());
    commit();
  };
  $("popPressure").oninput = () =>
    ($("popPressureValue").textContent = $("popPressure").value + "%");
  $("popPressure").onchange = () => {
    if (busy) return;
    recordOperation();
    popPressure = Number($("popPressure").value) / 100;
    commit();
  };
  $("curveFile").onchange = async () => {
    try {
      const file = $("curveFile").files[0];
      if (!file) return;
      const r = await rhino(),
        doc = r.File3dm.fromByteArray(new Uint8Array(await file.arrayBuffer())),
        found = [];
      if (!doc) throw Error("Could not read Rhino file.");
      try {
        const objects = doc.objects();
        for (let i = 0; i < objects.count; i++) {
          const obj = objects.get(i),
            g = obj.geometry();
          if (g instanceof r.Curve) {
            const [a, b] = g.domain;
            found.push(
              Array.from({ length: 17 }, (_, k) =>
                g.pointAt(a + ((b - a) * k) / 16),
              ),
            );
          }
          g.delete();
          obj.delete();
        }
      } finally {
        doc.delete();
      }
      if (!found.length || found.length > 5)
        throw Error("Import a Rhino file containing 1–5 curves.");
      curves = found;
      active = 0;
      point = 0;
      changed();
    } catch (e) {
      pane.querySelector("#vStatus").textContent = e.message;
    }
  };
  function update(nextMeshes, locked = false) {
    if (!locked) pendingOperation = null;
    meshes = nextMeshes;
    busy = locked;
    transform.enabled = !locked;
    ui();
    paint();
    dirty = false;
    meshes.forEach((o) => {
      if (o.userData.balloonId === selectedId)
        o.material.emissive?.setHex(0x087079);
    });
  }
  function load(data) {
    if (!data) {
      curves = [];
      resetCurve();
      edits = {};
      frozen = {};
      unclippedEdges = [];
      unclippedBottoms = [];
      rotations = {};
      popped = [];
      popEvents = [];
      popPressure = 0.25;
      operationHistory = [];
      $("pressureEnabled").checked = false;
      ui();
      paint();
      return;
    }
    if (Array.isArray(data.popped))
      data = { ...data, popped: [...new Set(data.popped)] };
    validateVoronoiLifecycle(data);
    const nextCurves = validateCurves(data.curves);
    const nextEdits = data.edits || {};
    if (Object.values(nextEdits).some((e) => !validBalloonEdit(e)))
      throw Error("Invalid saved balloon edits.");
    curves = nextCurves;
    edits = structuredClone(nextEdits);
    frozen = structuredClone(data.frozen ?? {});
    popped = [...new Set(data.popped ?? [])];
    unclippedEdges = [...new Set(data.unclippedEdges ?? [])];
    unclippedBottoms = [...new Set(data.unclippedBottoms ?? [])];
    rotations = structuredClone(data.rotations ?? {});
    popEvents = structuredClone(data.popEvents ?? []);
    popPressure = data.popPressure ?? 0.25;
    operationHistory = [];
    active = Math.max(0, Math.min(curves.length - 1, Number(data.active) || 0));
    point = Math.max(
      0,
      Math.min(curves[active].length - 1, Number(data.point) || 0),
    );
    selectedId = Number.isInteger(data.selectedId) ? data.selectedId : null;
    $("scale1dAxis").value = [0, 1, 2].includes(data.scaleAxis)
      ? data.scaleAxis
      : 0;
    tool = [
      "orbit",
      "move",
      "scale",
      "scale1d",
      "rotate",
      "curve",
      "curveMove",
    ].includes(data.tool)
      ? data.tool
      : "orbit";
    for (const id of ["strength", "influence"])
      if (data[id] !== undefined) {
        $(id).value = data[id];
        $(id + "N").value = data[id];
      }
    $("pressureEnabled").checked = !!data.pressureEnabled;
    ensure();
    ui();
    paint();
  }
  ensure();
  ui();
  paint();
  return {
    settings,
    rejectBuild() {
      if (pendingOperation) {
        ({
          frozen,
          popped,
          popEvents,
          popPressure,
          unclippedEdges,
          unclippedBottoms,
          rotations,
        } = pendingOperation);
        pendingOperation = null;
        operationHistory.pop();
        ui();
        paint();
      }
    },
    setVisibleZone(zone) {
      visibleZone = zone;
    },
    selectZone(zone) {
      selectedId =
        result()?.spheres.find((s) => s.zone === zone)?.id ?? selectedId;
      ui();
      paint();
    },
    update,
    save: () => ({
      active,
      point,
      selectedId,
      tool,
      scaleAxis: Number($("scale1dAxis").value),
      curves: structuredClone(curves),
      frozen: structuredClone(frozen),
      popped: [...new Set(popped)],
      popEvents: structuredClone(popEvents),
      popPressure,
      unclippedEdges: [...unclippedEdges],
      unclippedBottoms: [...unclippedBottoms],
      rotations: structuredClone(rotations),
      edits: structuredClone(edits),
      strength: Number($("strength").value),
      influence: Number($("influence").value),
      pressureEnabled: $("pressureEnabled").checked,
    }),
    load,
    renderPlan(renderer, planCamera) {
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(overlayScene, planCamera);
      renderer.autoClear = true;
    },
    renderPerspective(renderer) {
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(overlayScene, camera);
      renderer.autoClear = true;
    },
    setBusy(value) {
      busy = value;
      transform.enabled = !value;
      ui();
      if (value) transform.detach();
      else attach();
    },
    beforePlan() {
      transform.getHelper().visible = false;
    },
    afterPlan() {
      transform.getHelper().visible = !!transform.object;
    },
    get dirty() {
      return dirty;
    },
  };
}
