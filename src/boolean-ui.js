import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { geometry } from "./view.js";
import { addTechnicalFrames } from "./frames.js";
import { queueAutosave } from "./autosave.js";
import { isUndoShortcut } from "./history.js";
import {
  booleanExportPieces,
  addRhinoBuildingPiece,
} from "./boolean-export.js";

export function initBoolean(getFloors, rhino) {
  const pane = document.createElement("main");
  pane.id = "booleanWorkspace";
  pane.hidden = true;
  pane.className = "voronoi-uppercase";
  pane.innerHTML =
    '<div class="voro-layout"><section class="panel" data-frame-count="1"><div class="panel-heading">PERSPECTIVE <small>BOOLEAN</small><button id="bFit">FIT</button></div><div class="canvas-tools"><button id="bAdd">ADD BOOLEAN BALLOON</button><button id="bMove">MOVE</button><button id="bScale">SCALE / SCALE 1D</button><button id="bRotate">ROTATE</button><button id="bGhost" aria-pressed="true">GHOSTED</button><button id="bWire" aria-pressed="false">WIRE</button><button id="bClip" aria-pressed="false">CLIPPING PLANE</button><button id="bPlane">MOVE / ROTATE PLANE</button><button id="bUndo">UNDO / CTRL+Z</button></div><div id="bCanvas" class="voro-canvas"></div></section><aside><section class="panel" data-frame-count="2"><div class="panel-heading">BOOLEAN BALLOONS</div><div class="voro-controls"><label>SELECT BALLOON<select id="bSelected"></select></label><label>NAME<input id="bName" type="text"></label><label class="check"><input type="checkbox" id="bEnabled"> ENABLE BOOLEAN</label><label class="check"><input type="checkbox" id="bVisible" checked> SHOW CUTTERS</label><div class="pair"><button id="bDuplicate">DUPLICATE</button><button id="bDelete">DELETE BALLOON</button></div><label>MODE<select id="bMode"><option value="void">VOID ONLY</option><option value="shell">VOID + SHELL</option></select></label><div id="bNumbers"></div><label>THICKNESS DIRECTION<select id="bOffset"><option value="outward">OUTWARD</option><option value="inward">INWARD</option><option value="centered">CENTERED</option></select></label><label>MESH QUALITY<select id="bQuality"><option value="48">DRAFT · 48</option><option value="96" selected>SMOOTH · 96</option><option value="192">FINE · 192</option></select></label><strong>AFFECTED FLOORS</strong><div id="bFloors"></div><strong>CUT ELEMENTS</strong><div class="pair"><button id="bVaultsOnly">VAULTS ONLY</button><button id="bAllElements">ALL ELEMENTS</button></div><div id="bTargets"></div><label>VAULT SHELL THICKNESS (FT)<input id="bVault" type="number" min="0.05" step="0.05" value="1"></label><label>SLAB THICKNESS (FT)<input id="bSlab" type="number" min="0.05" step="0.05" value="1"></label><label class="check"><input id="bJoin" type="checkbox" checked> JOIN RESULT</label><button id="bApply" class="primary">APPLY BOOLEAN</button><label>RHINO EXPORT<select id="bExportParts"><option value="joined">JOINED RESULT</option><option value="separate">SEPARATE PARTS</option></select></label><button id="bExport">EXPORT RESULT .3DM</button><div id="bState" role="status"></div></div></section></aside></div><div class="status-bar" id="bStatus" role="status">ADD A BOOLEAN BALLOON TO BEGIN.</div>';
  const $ = (id) => pane.querySelector("#" + id);
  const progress = document.createElement("output");
  progress.id = "bProgress";
  progress.setAttribute("role", "status");
  progress.style.cssText =
    "display:block;padding:12px;color:#80dce7;border-bottom:1px solid #355c62;";
  $("bCanvas").before(progress);
  const cancelButton = document.createElement("button");
  cancelButton.id = "bCancel";
  cancelButton.textContent = "CANCEL BOOLEAN / ESC";
  cancelButton.hidden = true;
  cancelButton.onclick = () => cancel();
  $("bApply").after(cancelButton);
  const scene = new T.Scene();
  scene.background = new T.Color(0);
  scene.add(new T.HemisphereLight(0xffffff, 0x55616b, 2));
  const light = new T.DirectionalLight(0xffffff, 3);
  light.position.set(1, -2, 4);
  scene.add(light);
  const camera = new T.PerspectiveCamera(45, 1, 0.05, 100000);
  camera.up.set(0, 0, 1);
  const building = new T.Group(),
    tools = new T.Group();
  scene.add(building, tools);
  const pivot = new T.Object3D();
  pivot.rotation.order = "ZYX";
  scene.add(pivot);
  const clipPlane = new T.Plane(new T.Vector3(0, 0, -1), 0);
  const planePivot = new T.Object3D();
  scene.add(planePivot);
  let renderer,
    orbit,
    control,
    worker,
    busy = false,
    selected = -1;
  let cutters = [],
    outputs,
    appliedKey,
    ghost = true,
    wire = false,
    visible = true,
    clipping = false;
  let floors = [],
    fitted = false,
    beforeDrag,
    planeEditing = false;
  const history = [];
  const fields = [];
  for (const [group, title, values] of [
    ["position", "POSITION", ["X", "Y", "Z"]],
    ["size", "SIZE", ["X", "Y", "Z"]],
    ["rotation", "ROTATION", ["X", "Y", "Z"]],
  ])
    for (const [axis, name] of values.entries()) {
      const label = document.createElement("label");
      label.textContent =
        title + " " + name + (group === "rotation" ? " (DEGREES)" : " (FT)");
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      if (group === "size") input.min = "0.1";
      label.append(input);
      $("bNumbers").append(label);
      fields.push({ group, axis, input });
      input.onchange = () =>
        edit((c) => {
          c[group][axis] = Number(input.value);
        });
    }
  const thicknessLabel = document.createElement("label");
  thicknessLabel.textContent = "SHELL THICKNESS (FT)";
  const thickness = document.createElement("input"),
    thicknessRange = document.createElement("input");
  thickness.type = "number";
  thickness.min = "0.01";
  thickness.step = "0.05";
  thicknessRange.type = "range";
  thicknessRange.min = "0.05";
  thicknessRange.max = "10";
  thicknessRange.step = "0.05";
  thicknessLabel.append(thickness, thicknessRange);
  $("bNumbers").append(thicknessLabel);
  thickness.onchange = () =>
    edit((c) => {
      c.thickness = Number(thickness.value);
    });
  thicknessRange.oninput = () => {
    thickness.value = thicknessRange.value;
  };
  thicknessRange.onchange = () => thickness.onchange();
  const targetNames = ["slabs", "vaults", "columns", "walls"];
  const degrees = document.createElement("input");
  degrees.type = "number";
  degrees.step = "any";
  degrees.hidden = true;
  degrees.setAttribute("aria-label", "AXIS ROTATION DEGREES");
  degrees.style.cssText =
    "position:fixed;width:140px;max-width:140px;z-index:1000;background:#000;color:#80dce7;border:1px solid #355c62;padding:8px;";
  pane.append(degrees);
  let degreeAxis;
  degrees.onkeydown = (event) => {
    if (event.key === "Escape") {
      degrees.hidden = true;
      event.stopPropagation();
    }
    if (event.key !== "Enter" || !Number.isFinite(degrees.valueAsNumber))
      return;
    const axis = new T.Vector3().setComponent(degreeAxis, 1);
    const rotation = new T.Quaternion().setFromAxisAngle(
      axis,
      T.MathUtils.degToRad(degrees.valueAsNumber),
    );
    if (planeEditing) {
      planePivot.quaternion.premultiply(rotation);
      clipPlane.normal.set(0, 0, -1).applyQuaternion(planePivot.quaternion);
      clipPlane.constant = -clipPlane.normal.dot(planePivot.position);
      draw();
    } else
      edit((c) => {
        const q = new T.Quaternion().setFromEuler(
          new T.Euler(...c.rotation.map(T.MathUtils.degToRad), "ZYX"),
        );
        const e = new T.Euler().setFromQuaternion(
          q.premultiply(rotation),
          "ZYX",
        );
        c.rotation = [e.x, e.y, e.z].map(T.MathUtils.radToDeg);
      });
    degrees.hidden = true;
  };
  const targetInputs = targetNames.map((target) => {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    label.append(
      input,
      " " + (target === "slabs" ? "CUT FLOOR PLATES" : target.toUpperCase()),
    );
    $("bTargets").append(label);
    input.onchange = () =>
      edit((c) => {
        c.targets = targetNames.filter((_, i) => targetInputs[i].checked);
      });
    return input;
  });
  function snapshot() {
    return {
      cutters: structuredClone(cutters),
      selected,
      slab: $("bSlab").value,
      vault: $("bVault").value,
      joinResult: $("bJoin").checked,
    };
  }
  function remember() {
    history.push(snapshot());
    if (history.length > 20) history.shift();
  }
  function clear(group) {
    for (const item of [...group.children]) {
      group.remove(item);
      item.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
    }
  }
  let envelopeKey, envelopes;
  const hashCache = new WeakMap();
  function key(includeSupports = true) {
    let hash = 2166136261;
    const arrays = floors.flatMap((floor) => [
      floor.raw?.positions,
      floor.raw?.indices,
      floor.perimeter?.flat(),
      ...(includeSupports ? (floor.columns ?? []) : []).flatMap((raw) => [
        raw.positions,
        raw.indices,
      ]),
      ...(includeSupports ? (floor.walls ?? []) : []).flatMap((raw) => [
        raw.positions,
        raw.indices,
      ]),
    ]);
    for (const values of arrays) {
      if (!values) continue;
      let itemHash = hashCache.get(values);
      if (itemHash === undefined) {
        itemHash = 2166136261;
        for (const value of values) {
          const text = String(value);
          for (let i = 0; i < text.length; i++)
            itemHash = Math.imul(itemHash ^ text.charCodeAt(i), 16777619);
        }
        hashCache.set(values, itemHash);
      }
      hash = Math.imul(hash ^ itemHash, 16777619);
    }
    return JSON.stringify([
      hash,
      floors.map((f) => f.index),
      cutters,
      $("bSlab").value,
      $("bVault").value,
      $("bJoin").checked,
      "hollow-export-v3",
    ]);
  }
  function isCurrent() {
    return outputs && appliedKey === key();
  }
  function status() {
    $("bState").textContent = busy
      ? "BOOLEAN PROCESSING · SEE PROGRESS ABOVE"
      : cutters.length
        ? isCurrent()
          ? "BOOLEAN RESULT CURRENT"
          : "PREVIEW CHANGED · APPLY BOOLEAN"
        : "NO BOOLEAN CUTTERS";
    $("bExport").disabled = !isCurrent() || busy;
  }
  new MutationObserver(() => {
    progress.textContent = $("bStatus").textContent;
    $("bApply").textContent = busy ? "PROCESSING BOOLEAN…" : "APPLY BOOLEAN";
    $("bApply").disabled = busy;
    cancelButton.hidden = !busy;
    status();
  }).observe($("bStatus"), {
    childList: true,
    characterData: true,
    subtree: true,
  });
  function changed() {
    appliedKey = undefined;
    outputs = undefined;
    envelopes = undefined;
    envelopeKey = undefined;
    draw();
    sync();
    queueAutosave();
  }
  function edit(fn) {
    if (!cutters[selected]) return;
    const before = snapshot();
    fn(cutters[selected]);
    const c = cutters[selected];
    if (
      ![...c.position, ...c.rotation, ...c.size, c.thickness].every(
        Number.isFinite,
      ) ||
      c.size.some((v) => v <= 0) ||
      c.thickness <= 0
    ) {
      cutters = before.cutters;
      sync();
      $("bStatus").textContent =
        "ENTER FINITE COORDINATES AND POSITIVE DIMENSIONS.";
      return;
    }
    history.push(before);
    if (history.length > 20) history.shift();
    changed();
  }
  function sync() {
    $("bSelected").replaceChildren(
      ...cutters.map(
        (c, i) =>
          new Option(
            c.name +
              " · " +
              (c.enabled
                ? c.mode === "shell"
                  ? "VOID + SHELL"
                  : "VOID ONLY"
                : "DISABLED"),
            i,
          ),
      ),
    );
    $("bSelected").value = selected;
    const c = cutters[selected];
    for (const id of [
      "bName",
      "bEnabled",
      "bMode",
      "bOffset",
      "bQuality",
      "bDelete",
      "bDuplicate",
    ])
      $(id).disabled = !c;
    for (const field of fields) {
      field.input.disabled = !c;
      field.input.value = c?.[field.group][field.axis] ?? "";
    }
    thickness.disabled = thicknessRange.disabled = !c || c.mode !== "shell";
    thickness.value = thicknessRange.value = c?.thickness ?? 1;
    if (c) {
      $("bName").value = c.name;
      $("bEnabled").checked = c.enabled;
      $("bMode").value = c.mode;
      $("bOffset").value = c.offset;
      $("bQuality").value = c.quality;
    }
    targetInputs.forEach((input, i) => {
      input.disabled = !c;
      input.checked = !!c?.targets.includes(targetNames[i]);
    });
    $("bFloors").replaceChildren(
      ...floors.map((floor) => {
        const label = document.createElement("label");
        label.className = "check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.disabled = !c;
        input.checked = !!c?.floors.includes(floor.index);
        input.onchange = () =>
          edit((item) => {
            item.floors = input.checked
              ? [...item.floors, floor.index]
              : item.floors.filter((i) => i !== floor.index);
          });
        label.append(input, " " + floor.name.toUpperCase());
        return label;
      }),
    );
    if (control) {
      if (c && !planeEditing) {
        pivot.position.fromArray(c.position);
        pivot.rotation.set(...c.rotation.map(T.MathUtils.degToRad), "ZYX");
        pivot.scale.fromArray(c.size);
        control.attach(pivot);
      } else if (!planeEditing) control.detach();
    }
    status();
  }
  function resultPieces() {
    return booleanExportPieces(outputs);
  }
  function draw() {
    clear(building);
    clear(tools);
    if (!outputs)
      for (const floor of floors) {
        if (!floor.perimeter?.length) continue;
        const shape = new T.Shape(
          floor.perimeter.map((p) => new T.Vector2(...p)),
        );
        const slab = new T.Mesh(
          new T.ExtrudeGeometry(shape, {
            depth: Number($("bSlab").value) || 1,
            bevelEnabled: false,
          }),
          new T.MeshPhysicalMaterial({
            color: 0xa8c8cd,
            transparent: ghost,
            opacity: ghost ? 0.22 : 1,
            side: T.DoubleSide,
            clippingPlanes: clipping ? [clipPlane] : [],
          }),
        );
        slab.position.z = floor.elevation - (Number($("bSlab").value) || 1);
        building.add(slab);
      }
    const pieces = outputs
      ? resultPieces()
      : floors.flatMap((f) => (f.raw?.indices.length ? [{ raw: f.raw }] : []));
    for (const { raw } of pieces)
      building.add(
        new T.Mesh(
          geometry(raw),
          new T.MeshPhysicalMaterial({
            color: 0xb9ced0,
            roughness: 0.6,
            side: T.DoubleSide,
            transparent: ghost,
            opacity: ghost ? 0.25 : 1,
            depthWrite: !ghost,
            wireframe: wire,
            clippingPlanes: clipping ? [clipPlane] : [],
          }),
        ),
      );
    if (visible)
      for (const [i, c] of cutters.entries()) {
        const object = new T.Mesh(
          new T.SphereGeometry(
            0.5,
            Math.min(c.quality, 96),
            Math.min(c.quality / 2, 48),
          ),
          new T.MeshPhysicalMaterial({
            color: i === selected ? 0xff5284 : 0xfb88fc,
            transparent: true,
            opacity: 0.3,
            depthWrite: false,
            wireframe: wire,
          }),
        );
        object.position.fromArray(c.position);
        object.rotation.set(...c.rotation.map(T.MathUtils.degToRad), "ZYX");
        object.scale.fromArray(c.size);
        object.userData.cutter = i;
        if (!c.enabled) object.material.opacity = 0.1;
        tools.add(object);
      }
    status();
  }
  function fit() {
    const box = new T.Box3().setFromObject(building);
    if (box.isEmpty()) box.setFromObject(tools);
    if (box.isEmpty())
      box.set(new T.Vector3(-50, -50, 0), new T.Vector3(50, 50, 100));
    const size = Math.max(box.getSize(new T.Vector3()).length(), 10);
    box.getCenter(orbit.target);
    camera.position
      .copy(orbit.target)
      .add(new T.Vector3(size, -size, size * 0.75));
    orbit.update();
    fitted = true;
  }
  function resize() {
    if (!renderer || pane.hidden) return;
    const el = $("bCanvas");
    renderer.setSize(el.clientWidth, el.clientHeight, false);
    camera.aspect = el.clientWidth / Math.max(el.clientHeight, 1);
    camera.updateProjectionMatrix();
  }
  function open() {
    if (renderer) return;
    renderer = new T.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    $("bCanvas").append(renderer.domElement);
    orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    control = new TransformControls(camera, renderer.domElement);
    control.setColors(0x9af4f9, 0x21e0ed, 0x789fe8, 0xffffff);
    control.setSize(0.8);
    scene.add(control.getHelper());
    control.addEventListener("dragging-changed", ({ value }) => {
      orbit.enabled = !value;
      if (value) beforeDrag = snapshot();
      else if (beforeDrag) {
        history.push(beforeDrag);
        beforeDrag = undefined;
        changed();
      }
    });
    control.addEventListener("objectChange", () => {
      if (planeEditing) {
        clipPlane.normal.set(0, 0, -1).applyQuaternion(planePivot.quaternion);
        clipPlane.constant = -clipPlane.normal.dot(planePivot.position);
        draw();
        return;
      }
      const c = cutters[selected];
      if (!c) return;
      c.position = pivot.position.toArray();
      c.size = pivot.scale.toArray().map((v) => Math.max(0.1, v));
      c.rotation = [pivot.rotation.x, pivot.rotation.y, pivot.rotation.z].map(
        T.MathUtils.radToDeg,
      );
      draw();
    });
    let press, pointer;
    renderer.domElement.addEventListener("pointermove", (event) => {
      pointer = [event.clientX, event.clientY];
    });
    control.addEventListener("mouseUp", () => {
      const axis = ["X", "Y", "Z"].indexOf(control.axis);
      if (
        control.getMode() !== "rotate" ||
        axis < 0 ||
        !pointer ||
        !press ||
        Math.hypot(pointer[0] - press[0], pointer[1] - press[1]) > 4
      )
        return;
      degreeAxis = axis;
      degrees.value = "";
      degrees.placeholder = control.axis + " DEGREES";
      degrees.style.left = Math.min(pointer[0] + 10, innerWidth - 160) + "px";
      degrees.style.top = Math.min(pointer[1] + 10, innerHeight - 55) + "px";
      degrees.hidden = false;
      degrees.focus();
    });
    renderer.domElement.addEventListener("pointerdown", (e) => {
      press = [e.clientX, e.clientY];
    });
    renderer.domElement.addEventListener("pointerup", (e) => {
      if (
        !press ||
        Math.hypot(e.clientX - press[0], e.clientY - press[1]) > 4 ||
        control.axis
      )
        return;
      const rect = renderer.domElement.getBoundingClientRect(),
        ray = new T.Raycaster();
      ray.setFromCamera(
        new T.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          1 - ((e.clientY - rect.top) / rect.height) * 2,
        ),
        camera,
      );
      const hit = ray.intersectObjects(tools.children)[0];
      if (hit) {
        selected = hit.object.userData.cutter;
        sync();
        draw();
      }
    });
    new ResizeObserver(resize).observe($("bCanvas"));
    function frame() {
      requestAnimationFrame(frame);
      if (!pane.hidden) {
        orbit.update();
        renderer.render(scene, camera);
      }
    }
    frame();
  }
  $("bAdd").onclick = () => {
    remember();
    const box = new T.Box3().setFromObject(building);
    const position = box.isEmpty()
      ? [0, 0, 30]
      : box.getCenter(new T.Vector3()).toArray();
    cutters.push({
      name: "BOOLEAN BALLOON " + (cutters.length + 1),
      position,
      size: [40, 40, 80],
      rotation: [0, 0, 0],
      enabled: true,
      mode: "void",
      thickness: 1,
      offset: "outward",
      quality: 96,
      floors: floors.map((f) => f.index),
      targets: [...targetNames],
    });
    selected = cutters.length - 1;
    planeEditing = false;
    changed();
    if (!fitted) fit();
  };
  $("bSelected").onchange = () => {
    selected = Number($("bSelected").value);
    planeEditing = false;
    sync();
    draw();
  };
  $("bName").onchange = () =>
    edit((c) => {
      c.name = $("bName").value.toUpperCase();
    });
  $("bEnabled").onchange = () =>
    edit((c) => {
      c.enabled = $("bEnabled").checked;
    });
  $("bMode").onchange = () =>
    edit((c) => {
      c.mode = $("bMode").value;
    });
  $("bOffset").onchange = () =>
    edit((c) => {
      c.offset = $("bOffset").value;
    });
  $("bQuality").onchange = () =>
    edit((c) => {
      c.quality = Number($("bQuality").value);
    });
  $("bSlab").onchange = () => {
    if (Number($("bSlab").value) > 0) changed();
  };
  $("bVault").onchange = $("bSlab").onchange;
  $("bJoin").onchange = changed;
  $("bVaultsOnly").onclick = () =>
    edit((c) => {
      c.targets = ["vaults"];
    });
  $("bAllElements").onclick = () =>
    edit((c) => {
      c.targets = [...targetNames];
    });
  $("bDuplicate").onclick = () => {
    if (!cutters[selected]) return;
    remember();
    const c = structuredClone(cutters[selected]);
    c.name += " COPY";
    c.position[0] += 5;
    cutters.push(c);
    selected = cutters.length - 1;
    changed();
  };
  $("bDelete").onclick = () => {
    if (!cutters[selected]) return;
    remember();
    cutters.splice(selected, 1);
    selected = Math.min(selected, cutters.length - 1);
    changed();
  };
  $("bUndo").onclick = () => {
    const state = history.pop();
    if (!state) return;
    cutters = state.cutters;
    selected = state.selected;
    $("bSlab").value = state.slab;
    $("bVault").value = state.vault ?? 1;
    $("bJoin").checked = state.joinResult !== false;
    changed();
  };
  for (const [id, mode] of [
    ["bMove", "translate"],
    ["bScale", "scale"],
    ["bRotate", "rotate"],
  ])
    $(id).onclick = () => {
      planeEditing = false;
      sync();
      control.setMode(mode);
    };
  $("bFit").onclick = fit;
  $("bGhost").onclick = () => {
    ghost = !ghost;
    $("bGhost").setAttribute("aria-pressed", ghost);
    draw();
  };
  $("bWire").onclick = () => {
    wire = !wire;
    $("bWire").setAttribute("aria-pressed", wire);
    draw();
  };
  $("bVisible").onchange = () => {
    visible = $("bVisible").checked;
    draw();
  };
  $("bClip").onclick = () => {
    clipping = !clipping;
    $("bClip").setAttribute("aria-pressed", clipping);
    planePivot.position.copy(orbit.target);
    planePivot.quaternion.identity();
    clipPlane.normal.set(0, 0, -1);
    clipPlane.constant = orbit.target.z;
    draw();
  };
  $("bPlane").onclick = () => {
    if (!clipping) $("bClip").click();
    planeEditing = true;
    control.attach(planePivot);
    control.setMode(control.getMode() === "rotate" ? "translate" : "rotate");
  };
  function cancel() {
    degrees.hidden = true;
    if (worker) {
      worker.terminate();
      worker = undefined;
      busy = false;
      $("bApply").disabled = false;
    }
    if (beforeDrag) {
      cutters = beforeDrag.cutters;
      beforeDrag = undefined;
      changed();
    }
    control?.detach();
    if (orbit) orbit.enabled = true;
    $("bStatus").textContent = "COMMAND CANCELLED.";
  }
  window.addEventListener("keydown", (e) => {
    if (pane.hidden) return;
    if (e.key === "Escape") {
      cancel();
      return;
    }
    if (isUndoShortcut(e)) {
      e.preventDefault();
      $("bUndo").click();
    }
  });
  function apply() {
    if (busy) return;
    floors = getFloors();
    if (isCurrent()) {
      visible = false;
      $("bVisible").checked = false;
      draw();
      $("bStatus").textContent =
        "BOOLEAN RESULT CURRENT · NO RECALCULATION NEEDED";
      return;
    }
    if (!floors.some((f) => f.raw?.indices.length || f.perimeter?.length)) {
      $("bStatus").textContent = "IMPORT FLOOR CURVES FIRST.";
      return;
    }
    if (
      ![Number($("bSlab").value), Number($("bVault").value)].every(
        (v) => Number.isFinite(v) && v > 0,
      )
    ) {
      $("bStatus").textContent = "THICKNESSES MUST BE POSITIVE.";
      return;
    }
    const requestKey = key();
    busy = true;
    $("bApply").disabled = true;
    $("bExport").disabled = true;
    $("bStatus").textContent = "CALCULATING CLOSED BOOLEAN MESHES…";
    worker = new Worker(new URL("./boolean-worker.js", import.meta.url), {
      type: "module",
    });
    const finish = () => {
      worker?.terminate();
      worker = undefined;
      busy = false;
      $("bApply").disabled = false;
    };
    worker.onmessage = ({ data }) => {
      if (data.progress) {
        $("bStatus").textContent = data.progress;
        return;
      }
      if (data.preview) {
        floors = getFloors();
        if (key() !== requestKey) return;
        outputs = data.preview;
        envelopes = data.preview.floors;
        envelopeKey = key(false);
        visible = false;
        $("bVisible").checked = false;
        draw();
        return;
      }
      finish();
      if (data.error) {
        $("bStatus").textContent = data.error;
        return;
      }
      floors = getFloors();
      if (key() !== requestKey) {
        $("bStatus").textContent = "GEOMETRY CHANGED. APPLY AGAIN.";
        return;
      }
      outputs = data;
      visible = false;
      $("bVisible").checked = false;
      appliedKey = requestKey;
      envelopes = data.floors;
      envelopeKey = key(false);
      draw();
      sync();
      $("bStatus").textContent =
        "BOOLEAN COMPLETE · CLOSED MESHES · 0 NAKED EDGES";
      queueAutosave();
    };
    worker.onerror = (e) => {
      finish();
      $("bStatus").textContent = e.message;
    };
    worker.postMessage({
      floors,
      cutters,
      slabThickness: Number($("bSlab").value),
      vaultThickness: Number($("bVault").value),
      joinResult: $("bJoin").checked,
    });
  }
  $("bApply").onclick = apply;
  $("bExport").onclick = async () => {
    if (!isCurrent()) return;
    try {
      const r = await rhino(),
        doc = new r.File3dm();
      try {
        doc.settings().modelUnitSystem = r.UnitSystem.Feet;
        const separate = $("bExportParts").value === "separate";
        for (const piece of booleanExportPieces(outputs, separate))
          if (piece.raw.indices.length) addRhinoBuildingPiece(r, doc, piece);
        const url = URL.createObjectURL(new Blob([doc.toByteArray()]));
        const a = document.createElement("a");
        a.href = url;
        a.download = separate
          ? "boolean-building-separate-parts.3dm"
          : "boolean-building.3dm";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } finally {
        doc.delete();
      }
    } catch (e) {
      $("bStatus").textContent = e.message;
    }
  };
  addTechnicalFrames(pane);
  return {
    pane,
    async exportBuilding({ separate, onProgress = () => {} }) {
      if (busy) throw Error("WAIT FOR THE CURRENT BOOLEAN OPERATION.");
      const source = getFloors();
      if (
        !source.some(
          (f) =>
            f.raw?.indices.length ||
            f.perimeter?.length ||
            f.columns?.length ||
            f.walls?.length,
        )
      )
        throw Error("CREATE BUILDING GEOMETRY BEFORE EXPORTING.");
      const exportWorker = new Worker(
        new URL("./boolean-worker.js", import.meta.url),
        { type: "module" },
      );
      try {
        const data = await new Promise((resolve, reject) => {
          exportWorker.onerror = (e) => reject(Error(e.message));
          exportWorker.onmessage = ({ data }) => {
            if (data.progress) {
              onProgress(data.progress);
              return;
            }
            if (data.preview) return;
            if (data.error) reject(Error(data.error));
            else resolve(data);
          };
          exportWorker.postMessage({
            floors: source,
            cutters: structuredClone(cutters),
            vaultThickness: Number($("bVault").value),
            slabThickness: Number($("bSlab").value),
            joinResult: !separate,
          });
        });
        const r = await rhino(),
          doc = new r.File3dm();
        try {
          doc.settings().modelUnitSystem = r.UnitSystem.Feet;
          for (const piece of booleanExportPieces(data, separate))
            addRhinoBuildingPiece(r, doc, piece);
          const url = URL.createObjectURL(new Blob([doc.toByteArray()]));
          const a = document.createElement("a");
          a.href = url;
          a.download = separate
            ? "building-separate-parts.3dm"
            : "building-joined.3dm";
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } finally {
          doc.delete();
        }
      } finally {
        exportWorker.terminate();
      }
    },
    reset() {
      cutters = [];
      selected = -1;
      outputs = undefined;
      envelopes = undefined;
      appliedKey = undefined;
      envelopeKey = undefined;
      history.length = 0;
      building.clear();
      tools.clear();
    },
    processView: () => ({
      camera,
      orbit,
      roots: [building, tools],
      workspace: "BOOLEAN",
    }),
    isBusy: () => busy,
    show() {
      open();
      floors = getFloors();
      if (outputs && !isCurrent()) outputs = undefined;
      resize();
      draw();
      sync();
      if (!fitted) fit();
    },
    resolve(index, enclosure) {
      if (
        !cutters.some(
          (c) => c.enabled && c.floors.includes(index) && c.targets.length,
        )
      )
        return enclosure;
      floors = getFloors();
      // Placement excludes voids analytically, even while the rendered Boolean
      // is pending/stale. An unrelated floor must not lock all support tools.
      const cut =
        envelopes && envelopeKey === key(false)
          ? envelopes.find((f) => f.index === index)
          : undefined;
      return {
        ...enclosure,
        raw: cut?.raw ?? enclosure.raw,
        collisionRaw: enclosure.raw,
        booleanFloor: index,
        booleanCutters: cutters,
      };
    },
    cutters: () => structuredClone(cutters),
    saveSession: () => ({
      ...snapshot(),
      outputs,
      appliedKey,
      envelopes,
      envelopeKey,
      ghost,
      wire,
      visible,
      clipping,
      planePosition: planePivot.position.toArray(),
      planeRotation: planePivot.quaternion.toArray(),
    }),
    loadSession(data) {
      if (!data) return;
      cutters = data.cutters;
      selected = data.selected;
      $("bSlab").value = data.slab;
      $("bVault").value = data.vault ?? 1;
      $("bJoin").checked = data.joinResult !== false;
      outputs = data.outputs;
      appliedKey = data.appliedKey;
      envelopes = data.envelopes;
      envelopeKey = data.envelopeKey;
      ghost = data.ghost;
      wire = data.wire;
      visible = data.visible;
      clipping = !!data.clipping;
      if (data.planePosition) planePivot.position.fromArray(data.planePosition);
      if (data.planeRotation)
        planePivot.quaternion.fromArray(data.planeRotation);
      clipPlane.normal.set(0, 0, -1).applyQuaternion(planePivot.quaternion);
      clipPlane.constant = -clipPlane.normal.dot(planePivot.position);
      $("bClip").setAttribute("aria-pressed", clipping);
      $("bGhost").setAttribute("aria-pressed", ghost);
      $("bWire").setAttribute("aria-pressed", wire);
      $("bVisible").checked = visible;
    },
  };
}
