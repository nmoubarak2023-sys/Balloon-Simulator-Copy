import { mountGeometryLibrary, canvasThumbnail } from "./geometry-library.js";
import { quadObj, quadMesh } from "./quad-mesh.js";
import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { geometry, quadWire } from "./view.js";
import { bounds } from "./engine.js";
import { addTechnicalFrames } from "./frames.js";
import { addRhinoQuadMesh } from "./rhino-io.js";
import { isUndoShortcut } from "./history.js";

export function initBalloonParty(rhino) {
  const pane = document.createElement("main");
  pane.id = "partyWorkspace";
  pane.hidden = true;
  document.querySelector("main").after(pane);
  const axes = ["X", "Y", "Z"];
  pane.innerHTML = `<div class="voro-layout"><section class="panel" data-frame-count="1"><div class="panel-heading"><span>PERSPECTIVE <small>01 / BALLOON PARTY</small></span><button id="pFit">FIT ↗</button></div><div class="canvas-tools">${["orbit", "move", "rotate", "scale", "clipMove", "clipRotate"].map((t) => `<button data-party-tool="${t}" aria-pressed="${t === "move"}">${t === "clipMove" ? "MOVE CLIP" : t === "clipRotate" ? "ROTATE CLIP" : t.toUpperCase()}</button>`).join("")}<button id="pShaded" aria-pressed="true">SHADED</button><button id="pGhosted" aria-pressed="false">GHOSTED</button><button id="pClipToggle" aria-pressed="false">CLIP OFF</button><button id="pWire" aria-pressed="false">WIRE</button></div><div id="pPerspective" class="voro-canvas"></div><div class="viewer-footer">CLICK TO SELECT · DRAG TO MOVE · EMPTY SPACE ORBITS</div></section><aside><section class="panel" data-frame-count="2"><div class="panel-heading">PLAN VIEW <small>02 / XY ASSEMBLY</small></div><div id="pPlan" class="voro-plan"></div></section><section class="panel" data-frame-count="3"><div class="panel-heading">CONTROL PANEL <small>03 / ASSEMBLY</small></div><div class="voro-controls"><p class="note">Send geometry from Balloon Build using SEND TO BALLOON PARTY. Each item is an independent snapshot. Overlap is allowed; the assembly keeps separate shells.</p><label>Assembly item<select id="pItems"></select></label><label>Item name<input id="pName" type="text"></label>${["Move", "Rotation"].map((kind) => `<div><p>${kind}${kind === "Rotation" ? " (degrees)" : " (model units)"}</p><div class="triple">${axes.map((axis) => `<label>${axis}<input id="p${kind}${axis}" aria-label="Party ${kind} ${axis}" type="number" step="${kind === "Rotation" ? 1 : 0.1}" value="0"></label>`).join("")}</div></div>`).join("")}<label>Uniform scale<input id="pScale" type="number" min="0.01" step="0.1" value="1"></label><button id="pApply">APPLY TRANSFORM ↗</button><div class="pair"><button id="pDuplicate">DUPLICATE</button><button id="pDelete">REMOVE ITEM</button></div><button id="pReset">RESET TRANSFORM</button><button id="pUndo">UNDO / CTRL+Z</button><details><summary>CLIPPING PLANE</summary><div class="section-body"><label class="check"><input id="pClipEnabled" type="checkbox"> Enable clipping plane</label>${["Position", "Rotation"].map((kind) => `<p>Plane ${kind.toLowerCase()}${kind === "Rotation" ? " (degrees)" : ""}</p><div class="triple">${axes.map((axis) => `<label>${axis}<input id="pClip${kind}${axis}" aria-label="Clip ${kind} ${axis}" type="number" value="0" step="${kind === "Rotation" ? 1 : 0.1}"></label>`).join("")}</div>`).join("")}<button id="pClipApply">APPLY PLANE ↗</button><label>Rotation axis<select id="pClipAxis"><option>X</option><option>Y</option><option>Z</option></select></label><div class="pair"><button id="pClip90">+90°</button><button id="pClip180">+180°</button></div><button id="pClipReset">RESET PLANE</button><p class="note">MOVE CLIP drags the plane. ROTATE CLIP uses snapped 15° rings. Exact degree values and presets are available here. Clipping affects both views; exports retain the complete geometry.</p></div></details><div class="pair"><button id="p3dm">EXPORT .3DM</button><button id="pObj">EXPORT .OBJ</button></div><button id="pSave">SAVE PARTY PROJECT</button><label class="button" for="pLoad">OPEN PARTY PROJECT</label><input hidden id="pLoad" type="file" accept=".json"><pre id="pReport" class="iteration-report"></pre></div></section></aside></div><div class="status-bar" id="pStatus" role="status">Send geometry from Balloon Build to start your party.</div>`;
  const $ = (id) => pane.querySelector("#" + id);
  const scene = new T.Scene(),
    root = new T.Group();
  scene.add(root, new T.AmbientLight(0xffffff, 2));
  const light = new T.DirectionalLight(0xffffff, 3);
  light.position.set(100, -100, 200);
  scene.add(light);
  const camera = new T.PerspectiveCamera(38, 1, 0.01, 1e6);
  camera.up.set(0, 0, 1);
  const plan = new T.OrthographicCamera(-50, 50, 50, -50, 0.01, 1e6);
  plan.up.set(0, 1, 0);
  const renderers = ["pPerspective", "pPlan"].map((id) => {
    const r = new T.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setClearColor(0, 0);
    r.localClippingEnabled = true;
    $(id).append(r.domElement);
    return r;
  });
  const orbit = new OrbitControls(camera, renderers[0].domElement);
  orbit.enableDamping = true;
  const transform = new TransformControls(camera, renderers[0].domElement),
    helper = transform.getHelper();
  transform.setRotationSnap(Math.PI / 12);
  scene.add(helper);
  const clipMesh = new T.Mesh(
    new T.PlaneGeometry(1, 1),
    new T.MeshBasicMaterial({
      color: 0x21e0ed,
      side: T.DoubleSide,
      transparent: true,
      opacity: 0.07,
      depthWrite: false,
    }),
  );
  clipMesh.add(
    new T.LineSegments(
      new T.EdgesGeometry(clipMesh.geometry),
      new T.LineBasicMaterial({
        color: 0x21e0ed,
        transparent: true,
        opacity: 0.65,
      }),
    ),
  );
  scene.add(clipMesh);
  let clip = { enabled: false, position: [0, 0, 0], rotation: [0, 0, 0] },
    ghosted = false;
  const clipPlane = new T.Plane();
  let items = [],
    selected = -1,
    tool = "move",
    wire = false,
    history = [],
    drag,
    span = 100;
  const ray = new T.Raycaster(),
    pointer = new T.Vector2();
  const message = (text) => ($("pStatus").textContent = text);
  function snapshot() {
    return {
      items: items.map(({ raw, name, position, rotation, scale }) => ({
        raw,
        name,
        position: [...position],
        rotation: [...rotation],
        scale,
      })),
      selected,
      clip: structuredClone(clip),
      ghosted,
    };
  }
  function checkpoint() {
    history.push(snapshot());
    if (history.length > 30) history.shift();
  }
  function selectedItem() {
    return items[selected];
  }
  function ui() {
    $("pItems").replaceChildren(
      ...items.map((o, i) => new Option(`${i + 1}. ${o.name}`, i)),
    );
    $("pItems").value = selected;
    const o = selectedItem();
    $("pName").value = o?.name || "";
    axes.forEach((axis, k) => {
      $("pMove" + axis).value = o?.position[k] ?? 0;
      $("pRotation" + axis).value = o?.rotation[k] ?? 0;
    });
    $("pScale").value = o?.scale ?? 1;
    for (const id of [
      "pApply",
      "pDuplicate",
      "pDelete",
      "pReset",
      "pName",
      "pScale",
    ])
      $(id).disabled = !o;
    $("pUndo").disabled = !history.length;
    $("pShaded").setAttribute("aria-pressed", !ghosted);
    $("pGhosted").setAttribute("aria-pressed", ghosted);
    $("pClipToggle").setAttribute("aria-pressed", clip.enabled);
    $("pClipToggle").textContent = clip.enabled ? "CLIP ON" : "CLIP OFF";
    $("pClipEnabled").checked = clip.enabled;
    axes.forEach((a, k) => {
      $("pClipPosition" + a).value = clip.position[k];
      $("pClipRotation" + a).value = clip.rotation[k];
    });
    $("pReport").textContent = JSON.stringify(
      {
        items: items.length,
        quadFaces: items.reduce(
          (n, o) => n + quadMesh(o.raw).quads.length / 4,
          0,
        ),
        selected: selected + 1,
        position: o?.position,
        rotationDegrees: o?.rotation,
        scale: o?.scale,
        displayMode: ghosted ? "ghosted" : "shaded",
        clippingPlane: clip,
      },
      null,
      2,
    );
    pane
      .querySelectorAll("[data-party-tool]")
      .forEach((b) =>
        b.setAttribute("aria-pressed", b.dataset.partyTool === tool),
      );
  }
  function attach() {
    transform.showX = transform.showY = transform.showZ = tool !== "scale";
    transform.detach();
    if (tool.startsWith("clip")) {
      if (clip.enabled) {
        transform.setMode(tool === "clipMove" ? "translate" : "rotate");
        transform.attach(clipMesh);
      }
      return;
    }
    if (selectedItem() && tool !== "orbit") {
      transform.setMode(tool === "move" ? "translate" : tool);
      transform.attach(root.children[selected]);
    }
  }
  function draw() {
    transform.detach();
    for (const o of [...root.children]) {
      root.remove(o);
      o.traverse((child) => {
        child.geometry?.dispose();
        child.material?.dispose();
      });
    }
    items.forEach((o, i) => {
      const mesh = new T.Mesh(
        geometry(o.raw),
        new T.MeshPhysicalMaterial({
          color: 0xfb88fc,
          emissive: i === selected ? 0xfb88fc : 0x000000,
          emissiveIntensity: 0.12,
          transparent: ghosted,
          opacity: ghosted ? 0.25 : 1,
          depthWrite: !ghosted,
          roughness: 0.3,
          metalness: 0.2,
          side: T.DoubleSide,
          wireframe: false,
        }),
      );
      mesh.position.fromArray(o.position);
      mesh.rotation.set(...o.rotation.map(T.MathUtils.degToRad));
      mesh.scale.setScalar(o.scale);
      const lines = quadWire(o.raw, [0, 0, 0], 0xffffff);
      lines.visible = wire;
      mesh.add(lines);
      mesh.userData.item = i;
      root.add(mesh);
    });
    updateClip();
    attach();
    ui();
  }
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
      } else {
        plan.left = ((-span * w) / h) * 0.6;
        plan.right = -plan.left;
        plan.top = span * 0.6;
        plan.bottom = -plan.top;
        plan.updateProjectionMatrix();
      }
    });
  }
  renderers.forEach((r) =>
    new ResizeObserver(resize).observe(r.domElement.parentElement),
  );
  function fit() {
    const box = new T.Box3().setFromObject(root),
      center = new T.Vector3();
    if (box.isEmpty()) {
      center.set(0, 0, 0);
      span = 100;
    } else {
      box.getCenter(center);
      span = Math.max(...box.getSize(new T.Vector3()).toArray(), 1);
    }
    orbit.target.copy(center);
    camera.position.copy(center).add(new T.Vector3(span, -span, span));
    camera.near = span / 10000;
    camera.far = span * 100;
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    plan.position.copy(center).add(new T.Vector3(0, 0, span * 3));
    plan.near = span / 10000;
    plan.far = span * 100;
    plan.lookAt(center);
    resize();
    updateClip();
  }
  function updateClip() {
    clipMesh.visible = clip.enabled;
    clipMesh.position.fromArray(clip.position);
    clipMesh.rotation.set(...clip.rotation.map(T.MathUtils.degToRad));
    clipMesh.scale.setScalar(span * 1.3);
    const normal = new T.Vector3(0, 0, 1).applyEuler(clipMesh.rotation);
    clipPlane.setFromNormalAndCoplanarPoint(normal, clipMesh.position);
    root.traverse((mesh) => {
      if (!mesh.material) return;
      mesh.material.clippingPlanes = clip.enabled ? [clipPlane] : [];
      mesh.material.needsUpdate = true;
    });
  }
  function readMesh() {
    if (tool.startsWith("clip")) {
      clip.position = clipMesh.position.toArray();
      clip.rotation = [
        clipMesh.rotation.x,
        clipMesh.rotation.y,
        clipMesh.rotation.z,
      ].map(T.MathUtils.radToDeg);
      updateClip();
      ui();
      return;
    }
    const mesh = root.children[selected],
      o = selectedItem();
    if (!o || !mesh) return;
    o.position = mesh.position.toArray();
    o.rotation = [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z].map(
      T.MathUtils.radToDeg,
    );
    o.scale = Math.max(0.01, Math.abs(mesh.scale.x));
    mesh.scale.setScalar(o.scale);
    ui();
  }
  transform.addEventListener("mouseDown", () => checkpoint());
  transform.addEventListener("objectChange", readMesh);
  transform.addEventListener("dragging-changed", (e) => {
    orbit.enabled = !e.value;
  });
  function cast(e, i) {
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
        if (e.button !== 0 || tool === "orbit") return;
        cast(e, i);
        if (!i && transform.object) {
          transform.pointerHover({ x: pointer.x, y: pointer.y, button: 0 });
          if (transform.axis) return;
        }
        const clippingTool = tool.startsWith("clip");
        const hit = clippingTool
          ? clip.enabled
            ? ray.intersectObject(clipMesh, false)[0]
            : null
          : ray
              .intersectObjects(root.children, false)
              .find(
                (h) => !clip.enabled || clipPlane.distanceToPoint(h.point) >= 0,
              );
        if (clippingTool) {
          if (!hit || tool !== "clipMove") return;
          checkpoint();
          const plane = new T.Plane().setFromNormalAndCoplanarPoint(
              i
                ? new T.Vector3(0, 0, 1)
                : camera.getWorldDirection(new T.Vector3()),
              hit.point,
            ),
            point = new T.Vector3();
          if (!ray.ray.intersectPlane(plane, point)) return;
          drag = {
            view: i,
            plane,
            point,
            position: clipMesh.position.clone(),
            clip: true,
          };
          orbit.enabled = false;
          r.domElement.setPointerCapture(e.pointerId);
          e.stopImmediatePropagation();
          return;
        }
        if (!hit) return;
        selected = hit.object.userData.item;
        draw();
        if (tool !== "move") return;
        const mesh = root.children[selected],
          plane = new T.Plane().setFromNormalAndCoplanarPoint(
            i
              ? new T.Vector3(0, 0, 1)
              : camera.getWorldDirection(new T.Vector3()),
            mesh.position,
          ),
          point = new T.Vector3();
        if (!ray.ray.intersectPlane(plane, point)) return;
        checkpoint();
        drag = { view: i, plane, point, position: mesh.position.clone() };
        orbit.enabled = false;
        r.domElement.setPointerCapture(e.pointerId);
        e.stopImmediatePropagation();
      },
      true,
    );
    r.domElement.addEventListener(
      "pointermove",
      (e) => {
        if (drag?.view !== i) return;
        cast(e, i);
        const p = new T.Vector3();
        if (ray.ray.intersectPlane(drag.plane, p)) {
          (drag.clip ? clipMesh : root.children[selected]).position
            .copy(drag.position)
            .add(p.sub(drag.point));
          readMesh();
        }
        e.stopImmediatePropagation();
      },
      true,
    );
    r.domElement.addEventListener(
      "pointerup",
      (e) => {
        if (drag?.view !== i) return;
        drag = null;
        orbit.enabled = true;
        attach();
        e.stopImmediatePropagation();
      },
      true,
    );
    r.domElement.addEventListener(
      "pointercancel",
      () => {
        if (drag) {
          drag = null;
          undo();
          orbit.enabled = true;
        }
      },
      true,
    );
  });
  function undo() {
    if (!history.length) return;
    const state = history.pop();
    items = state.items;
    selected = state.selected;
    clip = state.clip;
    ghosted = state.ghosted;
    draw();
    message("Undid last party action.");
  }
  $("pUndo").onclick = undo;
  document.addEventListener("keydown", (e) => {
    if (!pane.hidden && isUndoShortcut(e)) {
      e.preventDefault();
      undo();
    }
  });
  pane.querySelectorAll("[data-party-tool]").forEach(
    (b) =>
      (b.onclick = () => {
        tool = b.dataset.partyTool;
        if (tool.startsWith("clip") && !clip.enabled) {
          checkpoint();
          clip.enabled = true;
          updateClip();
        }
        attach();
        ui();
      }),
  );
  $("pShaded").onclick = () => {
    if (ghosted) {
      checkpoint();
      ghosted = false;
      draw();
    }
  };
  $("pGhosted").onclick = () => {
    if (!ghosted) {
      checkpoint();
      ghosted = true;
      draw();
    }
  };
  function toggleClip(enabled) {
    checkpoint();
    clip.enabled = enabled;
    updateClip();
    attach();
    ui();
  }
  $("pClipToggle").onclick = () => toggleClip(!clip.enabled);
  $("pClipEnabled").onchange = () => toggleClip($("pClipEnabled").checked);
  $("pClipApply").onclick = () => {
    const position = axes.map((a) => Number($("pClipPosition" + a).value)),
      rotation = axes.map((a) => Number($("pClipRotation" + a).value));
    if ([...position, ...rotation].some((v) => !Number.isFinite(v))) {
      message("Enter finite plane coordinates and angles.");
      return;
    }
    checkpoint();
    clip = { enabled: clip.enabled, position, rotation };
    updateClip();
    attach();
    ui();
  };
  for (const [id, degrees] of [
    ["pClip90", 90],
    ["pClip180", 180],
  ])
    $(id).onclick = () => {
      checkpoint();
      clip.rotation[axes.indexOf($("pClipAxis").value)] += degrees;
      updateClip();
      attach();
      ui();
    };
  $("pClipReset").onclick = () => {
    checkpoint();
    clip = {
      enabled: clip.enabled,
      position: new T.Box3().setFromObject(root).isEmpty()
        ? [0, 0, 0]
        : new T.Box3().setFromObject(root).getCenter(new T.Vector3()).toArray(),
      rotation: [0, 0, 0],
    };
    updateClip();
    attach();
    ui();
  };
  $("pItems").onchange = () => {
    selected = Number($("pItems").value);
    draw();
  };
  $("pApply").onclick = () => {
    const o = selectedItem();
    if (!o) return;
    const position = axes.map((a) => Number($("pMove" + a).value)),
      rotation = axes.map((a) => Number($("pRotation" + a).value)),
      scale = Number($("pScale").value);
    if (
      [...position, ...rotation, scale].some((n) => !Number.isFinite(n)) ||
      scale <= 0
    ) {
      message("Enter finite coordinates and a positive scale.");
      return;
    }
    checkpoint();
    Object.assign(o, {
      position,
      rotation,
      scale,
      name: $("pName").value.trim() || o.name,
    });
    draw();
    message("Item transform applied.");
  };
  $("pDuplicate").onclick = () => {
    const o = selectedItem();
    if (!o) return;
    checkpoint();
    const box = new T.Box3().setFromObject(root.children[selected]);
    items.push({
      ...o,
      name: o.name + " copy",
      position: [
        o.position[0] + Math.max(box.max.x - box.min.x, 1) * 1.1,
        o.position[1],
        o.position[2],
      ],
      rotation: [...o.rotation],
    });
    selected = items.length - 1;
    draw();
    fit();
    message("Independent copy added.");
  };
  $("pDelete").onclick = () => {
    if (!selectedItem()) return;
    checkpoint();
    items.splice(selected, 1);
    selected = Math.min(selected, items.length - 1);
    draw();
  };
  $("pReset").onclick = () => {
    if (!selectedItem()) return;
    checkpoint();
    Object.assign(selectedItem(), {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: 1,
    });
    draw();
    fit();
  };
  $("pFit").onclick = fit;
  $("pWire").onclick = () => {
    wire = !wire;
    $("pWire").setAttribute("aria-pressed", wire);
    draw();
  };
  function download(data, name) {
    const url = URL.createObjectURL(new Blob([data])),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function transformed(o, i) {
    root.updateMatrixWorld(true);
    const mesh = root.children[i],
      p = new T.Vector3(),
      positions = new Float64Array(o.raw.positions.length);
    for (let j = 0; j < positions.length; j += 3) {
      p.fromArray(o.raw.positions, j).applyMatrix4(mesh.matrixWorld);
      positions.set(p.toArray(), j);
    }
    return { positions, indices: o.raw.indices };
  }
  const guarded = (fn) => async () => {
    try {
      if (!items.length) throw Error("Send geometry from Balloon Build first.");
      await fn();
    } catch (e) {
      message(e.message);
    }
  };
  $("pObj").onclick = guarded(() => {
    let text = "# Balloon Party / separate assembly items\n",
      offset = 1;
    items.forEach((o, i) => {
      const raw = transformed(o, i);
      const q = quadObj(raw, `Item_${i + 1}`, offset);
      text += q.text;
      offset += q.vertices;
    });
    download(text, "balloon-party.obj");
    message("Party exported as quad mesh OBJ.");
  });
  $("p3dm").onclick = guarded(async () => {
    const r = await rhino(),
      doc = new r.File3dm();
    try {
      items.forEach((o, i) =>
        addRhinoQuadMesh(r, doc, transformed(o, i), o.name),
      );
      download(doc.toByteArray(), "balloon-party.3dm");
      message(
        "Party exported as separate Rhino mesh objects. Coordinates retain source model units.",
      );
    } finally {
      doc.delete();
    }
  });
  $("pSave").onclick = guarded(() =>
    download(
      JSON.stringify(
        { format: "balloon-party", version: 1, ...snapshot() },
        (_, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v),
      ),
      "balloon-party.json",
    ),
  );
  function loadPartyProject(d) {
    if (
      d.format !== "balloon-party" ||
      d.version !== 1 ||
      !Array.isArray(d.items)
    )
      throw Error("Choose a Balloon Party project.");
    const next = d.items.map((o) => {
      if (
        !o.raw?.positions?.length ||
        o.raw.positions.length % 3 ||
        !o.raw.indices?.length ||
        o.raw.indices.length % 3 ||
        [...o.raw.positions, ...o.position, ...o.rotation, o.scale].some(
          (v) => !Number.isFinite(v),
        ) ||
        o.position.length !== 3 ||
        o.rotation.length !== 3 ||
        o.scale <= 0 ||
        o.raw.indices.some(
          (v) =>
            !Number.isInteger(v) || v < 0 || v >= o.raw.positions.length / 3,
        )
      )
        throw Error("Invalid party geometry or transform.");
      return {
        ...o,
        raw: {
          positions: new Float64Array(o.raw.positions),
          indices: new Uint32Array(o.raw.indices),
        },
      };
    });
    const savedClip = d.clip || {
      enabled: false,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    };
    if (
      !Array.isArray(savedClip.position) ||
      savedClip.position.length !== 3 ||
      !Array.isArray(savedClip.rotation) ||
      savedClip.rotation.length !== 3 ||
      [...savedClip.position, ...savedClip.rotation].some(
        (v) => !Number.isFinite(v),
      )
    )
      throw Error("Invalid clipping plane settings.");
    checkpoint();
    items = next;
    clip = {
      enabled: !!savedClip.enabled,
      position: [...savedClip.position],
      rotation: [...savedClip.rotation],
    };
    ghosted = !!d.ghosted;
    selected = items.length
      ? Math.max(0, Math.min(items.length - 1, Number(d.selected) || 0))
      : -1;
    draw();
    fit();
    message("Party project restored.");
  }
  $("pLoad").onchange = async () => {
    try {
      const f = $("pLoad").files[0];
      if (!f) return;
      if (f.size > 80e6) throw Error("Choose a Party project under 80 MB.");
      loadPartyProject(JSON.parse(await f.text()));
    } catch (e) {
      message(e.message);
    } finally {
      $("pLoad").value = "";
    }
  };
  mountGeometryLibrary({
    workspace: "party",
    container: pane.querySelector(".voro-controls"),
    save: () => {
      if (!items.length)
        throw Error("Add geometry to Balloon Party before saving.");
      return { format: "balloon-party", version: 1, ...snapshot() };
    },
    load: loadPartyProject,
    thumbnail: () => canvasThumbnail(renderers[0], scene, camera),
  });
  addTechnicalFrames(pane);
  draw();
  fit();
  function frame() {
    requestAnimationFrame(frame);
    if (pane.hidden) return;
    orbit.update();
    renderers[0].render(scene, camera);
    const visible = helper.visible;
    helper.visible = false;
    renderers[1].render(scene, plan);
    helper.visible = visible;
  }
  frame();
  function celebrate() {
    pane.querySelector(".party-balloon-flight")?.remove();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const flight = document.createElement("div");
    flight.className = "party-balloon-flight";
    flight.setAttribute("aria-hidden", "true");
    flight.innerHTML = [0, 1, 2]
      .map(
        (i) =>
          `<svg class="party-flying-balloon" style="--lane:${20 + i * 27}%;--delay:${i * 0.22}s;--sway:${i % 2 ? "-" : "+"}45px" viewBox="0 0 100 190"><defs><radialGradient id="partyBalloon${i}" cx="30%" cy="25%" r="80%"><stop stop-color="#a7ecff"/><stop offset="0.4" stop-color="#1EC1F2"/><stop offset="1" stop-color="#1299c4"/></radialGradient></defs><ellipse cx="50" cy="52" rx="36" ry="46" fill="url(#partyBalloon${i})" stroke="#FFFFFF" stroke-width="2"/><path d="M50 98l-5 7h10z" fill="#1EC1F2" stroke="#FFFFFF" stroke-width="1.5"/><path d="M50 104c-25 27 25 45 0 80" fill="none" stroke="#FFFFFF" stroke-width="1.5"/></svg>`,
      )
      .join("");
    pane.append(flight);
    setTimeout(() => flight.remove(), 4000);
  }
  return {
    pane,
    show() {
      resize();
      fit();
      celebrate();
    },
    add(raw, name) {
      checkpoint();
      const center = new T.Vector3(...bounds(raw).center);
      const positions = new Float64Array(raw.positions);
      for (let i = 0; i < positions.length; i++)
        positions[i] -= center.getComponent(i % 3);
      const x = items.length
        ? new T.Box3().setFromObject(root).max.x +
          Math.max(...bounds(raw).span) * 0.6
        : 0;
      items.push({
        name,
        raw: { positions, indices: new Uint32Array(raw.indices) },
        position: [x, 0, 0],
        rotation: [0, 0, 0],
        scale: 1,
      });
      selected = items.length - 1;
      draw();
      fit();
      message(
        "Balloon Build snapshot added. Move, rotate, scale or duplicate it to build your assembly.",
      );
    },
  };
}
