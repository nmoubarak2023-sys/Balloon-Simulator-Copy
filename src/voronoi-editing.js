import {
  validBalloonEdit,
  scaleAxisEdit,
} from "./balloon-edit.js";
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
    for (const note of section.querySelectorAll(".note:not(.scale1d-controls .note)"))
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
  tools.innerHTML = ["orbit", "move", "scale", "scale1d", "curve", "curveMove"]
    .map(
      (key, i) =>
        `<button data-ve-tool="${key}" aria-pressed="${i === 0}">${["ORBIT", "MOVE BALLOON", "SCALE BALLOON", "SCALE 1D", "CURVE POINTS", "MOVE CURVE"][i]}</button>`,
    )
    .join("");
  pane.querySelector(".voro-steps").after(tools);
  let curves = [],
    active = 0,
    point = 0,
    selectedId = null,
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
    const spheres = result()?.spheres || [];
    if (!spheres.some((s) => s.id === selectedId))
      selectedId = spheres[0]?.id ?? null;
    $("balloonSelect").replaceChildren(
      ...spheres.map(
        (s) => new Option(`BALLOON ${String(s.id + 1).padStart(2, "0")}`, s.id),
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
        : `BALLOON ${selectedId + 1} selected / original seed ${selectedId}.`;
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
    if (!a) return;
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
    if (["move", "scale", "scale1d"].includes(tool)) showBalloons();
    paint();
  }
  tools
    .querySelectorAll("button")
    .forEach((b) => (b.onclick = () => setTool(b.dataset.veTool)));
  function begin() {
    if (!target || busy) return;
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
  function preview() {
    if (!baseline) return;
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
  transform.addEventListener("mouseUp", finish);
  function setRay(e, i) {
    const rect = renderers[i].domElement.getBoundingClientRect();
    pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      1 - ((e.clientY - rect.top) / rect.height) * 2,
    );
    ray.setFromCamera(pointer, i ? plan : camera);
  }
  renderers.forEach((r, i) => {
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
            if (!["scale", "scale1d"].includes(tool)) tool = "move";
          }
        }
        ui();
        paint();
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
    attach();
  };
  $("applyScale1d").onclick = () => {
    if (selectedId === null || busy) return;
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
    delete edits[selectedId];
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
      $("pressureEnabled").checked = false;
      ui();
      paint();
      return;
    }
    const nextCurves = validateCurves(data.curves);
    const nextEdits = data.edits || {};
    if (Object.values(nextEdits).some((e) => !validBalloonEdit(e)))
      throw Error("Invalid saved balloon edits.");
    curves = nextCurves;
    edits = structuredClone(nextEdits);
    active = Math.max(0, Math.min(curves.length - 1, Number(data.active) || 0));
    point = Math.max(
      0,
      Math.min(curves[active].length - 1, Number(data.point) || 0),
    );
    selectedId = Number.isInteger(data.selectedId) ? data.selectedId : null;
    tool = ["orbit", "move", "scale", "scale1d", "curve", "curveMove"].includes(
      data.tool,
    )
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
    update,
    save: () => ({
      active,
      point,
      selectedId,
      tool,
      curves: structuredClone(curves),
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
