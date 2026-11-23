import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { sharedBoundaries } from "./zone-boundaries.js";
import { geometry } from "./view.js";
export function mountZoneBoundaries({
  pane,
  renderers,
  cameras,
  getState,
  preview,
  apply,
}) {
  const button = document.createElement("button");
  button.textContent = "EDIT ZONE BOUNDARIES";
  button.setAttribute("aria-pressed", "false");
  pane.querySelector(".canvas-tools").append(button);
  const panel = document.createElement("section");
  panel.className = "collaboration-layout zone-boundary-editor";
  panel.hidden = true;
  panel.innerHTML = `<strong>SHARED ZONE BOUNDARY</strong><label>BOUNDARY<select data-edge aria-label="SHARED ZONE BOUNDARY"></select></label><label>TYPE<select data-mode><option value="open">OPEN</option><option value="soft">SOFT</option></select></label><div data-soft><label>TRANSITION WIDTH (FT)<input data-width type="number" min="2" max="100" value="12"></label><label>VALLEY HEIGHT (FT)<input data-height type="number" min="1" max="100" value="8"></label></div><button data-preview>PREVIEW BOUNDARY</button><button data-apply>APPLY BOUNDARY</button><label><input data-guides type="checkbox"> SHOW BOUNDARY TYPES</label><div data-viewport style="height:220px;background:#000" hidden></div><output role="status">HOVER AND CLICK A SHARED EDGE IN EITHER VIEW.</output>`;
  pane.querySelector("#vZoneInfo").after(panel);
  const q = (s) => panel.querySelector(s),
    overlay = new T.Scene(),
    ray = new T.Raycaster();
  let active = false,
    boundary,
    edges = [],
    selected = null,
    hover = null,
    key = "",
    previewRenderer,
    previewMesh,
    previewControls;
  function disposePreview() {
    if (previewMesh) {
      previewMesh.geometry.dispose();
      previewMesh.material.dispose();
      previewMesh = null;
    }
    previewControls?.dispose();
    previewControls = null;
    previewRenderer?.dispose();
    previewRenderer = null;
    q("[data-viewport]").replaceChildren();
    q("[data-viewport]").hidden = true;
  }
  function selection(id) {
    selected = id;
    const rule = boundary?.edgeTreatments?.[id] ?? {
      mode: "open",
      width: 12,
      height: 8,
    };
    q("[data-edge]").value = id ?? "";
    q("[data-mode]").value = rule.mode === "soft" ? "soft" : "open";
    q("[data-width]").value = rule.width ?? 12;
    q("[data-height]").value = rule.height ?? 8;
    q("[data-soft]").hidden = rule.mode !== "soft";
    key = "";
    disposePreview();
  }
  function current() {
    if (!selected) throw Error("SELECT A SHARED ZONE BOUNDARY.");
    return {
      mode: q("[data-mode]").value,
      width: Number(q("[data-width]").value),
      height: Number(q("[data-height]").value),
    };
  }
  function rebuild() {
    const state = getState(),
      b = state.boundary;
    if (b !== boundary) {
      boundary = b;
      edges = sharedBoundaries(b);
      q("[data-edge]").replaceChildren(
        new Option("PICK A SHARED EDGE", ""),
        ...edges.map(
          (e) =>
            new Option(
              e.zones.map((i) => b.zones[i].name.toUpperCase()).join(" ↔ "),
              e.id,
            ),
        ),
      );
      selection(null);
    }
    button.disabled = !edges.length || state.busy;
    const next = JSON.stringify([
      active,
      q("[data-guides]").checked,
      selected,
      hover,
      state.floor,
      b?.edgeTreatments,
    ]);
    if (next === key) return;
    key = next;
    for (const o of [...overlay.children]) {
      o.geometry.dispose();
      o.material.dispose();
      overlay.remove(o);
    }
    if (!active && !q("[data-guides]").checked) return;
    const span = Math.max(b?.bounds.width ?? 1, b?.bounds.height ?? 1);
    for (const edge of edges) {
      const mode = b.edgeTreatments?.[edge.id]?.mode ?? "open",
        color =
          edge.id === selected
            ? 0xffffff
            : edge.id === hover
              ? 0xff5284
              : mode === "soft"
                ? 0xff5284
                : 0x21e0ed;
      const g = new T.BufferGeometry().setFromPoints(
        edge.segments.flatMap((segment) =>
          segment.map((p) => new T.Vector3(...p, state.floor + 0.15)),
        ),
      );
      const material = new T.LineDashedMaterial({
        color,
        depthTest: false,
        dashSize: span * 0.012,
        gapSize: span * 0.006,
      });
      const line = new T.LineSegments(g, material);
      line.computeLineDistances();
      line.userData.edge = edge.id;
      line.renderOrder = 100;
      overlay.add(line);
    }
  }
  function pick(event, index) {
    rebuild();
    const rect = renderers[index].domElement.getBoundingClientRect();
    ray.params.Line.threshold =
      Math.max(boundary?.bounds.width ?? 1, boundary?.bounds.height ?? 1) *
      0.008;
    cameras[index].updateMatrixWorld();
    ray.setFromCamera(
      new T.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      cameras[index],
    );
    return (
      ray.intersectObjects(overlay.children, false)[0]?.object.userData.edge ??
      null
    );
  }
  renderers.forEach((renderer, i) => {
    let down;
    renderer.domElement.addEventListener("pointermove", (e) => {
      if (!active) return;
      hover = pick(e, i);
      renderer.domElement.style.cursor = hover ? "pointer" : "";
      if (hover)
        q("output").textContent = edges
          .find((edge) => edge.id === hover)
          .zones.map((z) => boundary.zones[z].name.toUpperCase())
          .join(" ↔ ");
    });
    renderer.domElement.addEventListener(
      "pointerdown",
      (e) => {
        down = null;
        if (!active || e.button !== 0) return;
        const id = pick(e, i);
        if (id) {
          down = { id, x: e.clientX, y: e.clientY };
          e.stopImmediatePropagation();
        }
      },
      true,
    );
    renderer.domElement.addEventListener(
      "pointerup",
      (e) => {
        if (!down) return;
        e.stopImmediatePropagation();
        const d = down;
        down = null;
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) selection(d.id);
      },
      true,
    );
  });
  button.onclick = () => {
    active = !active;
    panel.hidden = !active;
    button.setAttribute("aria-pressed", active);
    key = "";
    rebuild();
  };
  q("[data-edge]").onchange = () => selection(q("[data-edge]").value || null);
  q("[data-mode]").onchange = () => {
    q("[data-soft]").hidden = q("[data-mode]").value !== "soft";
    disposePreview();
  };
  q("[data-guides]").onchange = () => {
    key = "";
    rebuild();
  };
  q("[data-preview]").onclick = async () => {
    try {
      const id = selected,
        rule = current();
      q("[data-preview]").disabled = true;
      q("output").textContent = "BUILDING PREVIEW…";
      const raw = await preview(id, rule);
      if (id !== selected) return;
      disposePreview();
      const viewport = q("[data-viewport]");
      viewport.hidden = false;
      previewRenderer = new T.WebGLRenderer({ antialias: true });
      previewRenderer.setPixelRatio(Math.min(2, devicePixelRatio));
      previewRenderer.setSize(Math.max(180, viewport.clientWidth), 220);
      viewport.append(previewRenderer.domElement);
      const scene = new T.Scene(),
        camera = new T.PerspectiveCamera(
          40,
          Math.max(180, viewport.clientWidth) / 220,
          0.1,
          100000,
        );
      scene.background = new T.Color(0);
      previewMesh = new T.Mesh(
        geometry(raw),
        new T.MeshStandardMaterial({
          color: 0x80dce7,
          roughness: 0.65,
          side: T.DoubleSide,
        }),
      );
      scene.add(previewMesh, new T.HemisphereLight(0xffffff, 0x555555, 2));
      const light = new T.DirectionalLight(0xffffff, 2);
      light.position.set(1, -2, 4);
      scene.add(light);
      const box = new T.Box3().setFromObject(previewMesh),
        center = box.getCenter(new T.Vector3()),
        size = box.getSize(new T.Vector3()).length();
      camera.up.set(0, 0, 1);
      camera.position.copy(center).add(new T.Vector3(size, -size, size * 0.7));
      camera.lookAt(center);
      previewControls = new OrbitControls(camera, previewRenderer.domElement);
      previewControls.target.copy(center);
      previewControls.addEventListener("change", () =>
        previewRenderer?.render(scene, camera),
      );
      previewControls.update();
      previewRenderer.render(scene, camera);
      q("output").textContent =
        "PREVIEW ONLY · DRAG TO ORBIT · BUILDING UNCHANGED";
    } catch (e) {
      q("output").textContent = e.message;
    } finally {
      q("[data-preview]").disabled = false;
    }
  };
  q("[data-apply]").onclick = () => {
    try {
      if (getState().busy) throw Error("WAIT FOR THE CURRENT OPERATION.");
      apply(selected, current());
      q("output").textContent = "BOUNDARY APPLIED · UNDO AVAILABLE";
    } catch (e) {
      q("output").textContent = e.message;
    }
  };
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && active && !pane.hidden) {
      active = false;
      panel.hidden = true;
      button.setAttribute("aria-pressed", "false");
      key = "";
    }
  });
  return {
    render(index) {
      rebuild();
      if (!overlay.children.length) return;
      const renderer = renderers[index];
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(overlay, cameras[index]);
      renderer.autoClear = true;
    },
  };
}
