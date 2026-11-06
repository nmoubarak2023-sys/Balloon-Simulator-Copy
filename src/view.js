import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { bounds } from "./engine.js";
import { uniformFactor } from "./interaction.js";
import { quadMesh } from "./quad-mesh.js";
export function quadWire(raw, origin = [0, 0, 0], color = 0x9effff) {
  const q = quadMesh(raw),
    edges = [],
    seen = new Set();
  for (let i = 0; i < q.quads.length; i += 4)
    for (let k = 0; k < 4; k++) {
      const a = q.quads[i + k],
        b = q.quads[i + ((k + 1) % 4)],
        key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(a, b);
      }
    }
  const g = new T.BufferGeometry();
  g.setAttribute(
    "position",
    new T.BufferAttribute(
      Float32Array.from(q.positions, (v, i) => v - origin[i % 3]),
      3,
    ),
  );
  g.setIndex(edges);
  const wire = new T.LineSegments(
    g,
    new T.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    }),
  );
  wire.userData.quadWire = true;
  return wire;
}
export function geometry(raw, origin = [0, 0, 0]) {
  const g = new T.BufferGeometry();
  g.setAttribute(
    "position",
    new T.BufferAttribute(
      Float32Array.from(raw.positions, (v, i) => v - origin[i % 3]),
      3,
    ),
  );
  g.setIndex(new T.BufferAttribute(new Uint32Array(raw.indices), 1));
  g.computeVertexNormals();
  return g;
}
export function rawGeometry(g) {
  return {
    positions: new Float32Array(g.attributes.position.array),
    indices: g.index
      ? new Uint32Array(g.index.array)
      : new Uint32Array(
          Array.from({ length: g.attributes.position.count }, (_, i) => i),
        ),
  };
}
export class StudioView {
  constructor(onSelect, onCurve, onTransform) {
    this.onSelect = onSelect;
    this.onCurve = onCurve;
    this.onTransform = onTransform;
    this.scene = new T.Scene();
    this.scene.add(new T.AmbientLight(0xaff6ff, 1.5));
    for (const [p, intensity] of [
      [[80, -100, 150], 3],
      [[-90, 80, 60], 2],
    ]) {
      const l = new T.DirectionalLight(0xaafaff, intensity);
      l.position.set(...p);
      this.scene.add(l);
    }
    this.field = new T.Group();
    this.curveGroup = new T.Group();
    this.scene.add(this.field, this.curveGroup);
    this.perspective = new T.PerspectiveCamera(38, 1, 0.01, 10000);
    this.perspective.up.set(0, 0, 1);
    this.plan = new T.OrthographicCamera(-100, 100, 100, -100, 0.01, 10000);
    this.plan.up.set(0, 1, 0);
    this.renderers = ["viewport", "planViewport"].map((id) => {
      const el = document.getElementById(id),
        r = new T.WebGLRenderer({ antialias: true, alpha: true });
      r.setPixelRatio(Math.min(devicePixelRatio, 2));
      r.setClearColor(0x000000, 0);
      r.outputColorSpace = T.SRGBColorSpace;
      r.localClippingEnabled = true;
      el.appendChild(r.domElement);
      r.domElement.tabIndex = 0;
      r.domElement.setAttribute(
        "aria-label",
        id === "viewport" ? "3D geometry canvas" : "Plan geometry canvas",
      );
      return r;
    });
    this.orbit = new OrbitControls(
      this.perspective,
      this.renderers[0].domElement,
    );
    this.orbit.enableDamping = true;
    this.orbit.autoRotateSpeed = 0.65;
    this.ray = new T.Raycaster();
    this.pointer = new T.Vector2();
    this.meshes = [];
    this.wire = false;
    this.editCurve = false;
    this.selected = -1;
    this.span = 120;
    this.tool = "move";
    this.selectedCurve = 0;
    this.proxy = new T.Object3D();
    this.scene.add(this.proxy);
    this.transform = new TransformControls(
      this.perspective,
      this.renderers[0].domElement,
    );
    this.transform.setSize(0.85);
    this.transform.setColors(0x9af4f9, 0x21e0ed, 0x789fe8, 0xffffff);
    this.transformHelper = this.transform.getHelper();
    this.scene.add(this.transformHelper);
    this.transform.addEventListener("mouseDown", () => {
      this.beginTransform();
      this.orbit.enabled = false;
    });
    this.transform.addEventListener("objectChange", () =>
      this.previewTransform(),
    );
    this.transform.addEventListener("mouseUp", () => {
      this.finishTransform();
      this.orbit.enabled = !this.busy;
    });
    this.renderers.forEach((r, i) => {
      new ResizeObserver(() => this.resize(i)).observe(
        r.domElement.parentElement,
      );
      r.domElement.addEventListener(
        "pointerdown",
        (e) => this.pointerDown(e, i),
        true,
      );
      r.domElement.addEventListener(
        "pointermove",
        (e) => this.pointerMove(e, i),
        true,
      );
      r.domElement.addEventListener(
        "pointerup",
        (e) => this.pointerUp(e, i),
        true,
      );
      r.domElement.addEventListener(
        "pointercancel",
        (e) => this.cancelDrag(e, i),
        true,
      );
    });
    this.animate();
  }
  setBusy(value) {
    this.busy = value;
    this.transform.enabled = !value;
    this.orbit.enabled = !value;
    if (value) this.transform.detach();
    else this.attachTool();
  }
  setTool(tool) {
    this.tool = tool;
    if (tool === "boundary")
      this.boundaryGroup && (this.boundaryGroup.visible = true);
    this.attachTool();
    const hint = {
      orbit: "DRAG TO ORBIT · SCROLL TO ZOOM",
      move: "CLICK A BALLOON · DRAG IT OR ITS AXIS ARROWS · EMPTY SPACE ORBITS",
      scale: "CLICK A BALLOON · DRAG A SCALE HANDLE · RELEASE TO CHECK FIT",
      scale1d:
        "CHOOSE X / Y / Z IN INDIVIDUAL BALLOON · DRAG THE SINGLE AXIS HANDLE",
      boundary: "ENTER EXACT DEGREES ABOVE · OR DRAG A SNAPPED ROTATION RING",
      curve: "DRAG A CURVE POINT · AXIS ARROWS CONTROL X / Y / Z",
      curveMove: "CLICK A PINK CURVE · DRAG THE WHOLE CURVE OR ITS AXIS ARROWS",
      clipMove: "DRAG THE CLIPPING PLANE OR ITS AXIS ARROWS",
      clipRotate: "DRAG THE ROTATION RINGS TO TURN THE CLIPPING PLANE",
    };
    document.getElementById("canvasHint").textContent = hint[tool];
    document
      .querySelectorAll("[data-canvas-tool]")
      .forEach((b) =>
        b.setAttribute("aria-pressed", b.dataset.canvasTool === tool),
      );
  }
  attachTool() {
    if (this.busy || this.directDrag || this.transform.dragging) return;
    this.transform.detach();
    this.target = null;
    if (this.result && !this.tool.startsWith("clip")) return;
    let anchor, mode;
    if (this.tool.startsWith("clip") && this.clipState?.enabled) {
      anchor = this.clipState.position;
      mode = this.tool === "clipRotate" ? "rotate" : "translate";
      this.target = { type: "clip" };
    } else if (this.tool === "curveMove" && this.points?.length) {
      anchor = [0, 1, 2].map(
        (k) => this.points.reduce((s, p) => s + p[k], 0) / this.points.length,
      );
      mode = "translate";
      this.target = { type: "curve", whole: true, index: -1 };
    } else if (this.tool === "boundary" && this.box) {
      anchor = this.box.center;
      mode = "rotate";
      this.target = { type: "boundary" };
    } else if (this.tool === "curve" && this.editCurve && this.points?.length) {
      anchor = this.points[this.selectedCurve] || this.points[0];
      mode = "translate";
      this.target = { type: "curve", index: this.selectedCurve };
    } else if (
      ["move", "scale", "scale1d"].includes(this.tool) &&
      this.meshes[this.selected]
    ) {
      if (this.data.meta?.[this.selected]?.frozen) {
        document.getElementById("selectionInfo").textContent =
          "FROZEN BALLOON / LOCKED";
        return;
      }
      const c = this.data.centers[this.selected],
        edit = this.data.edits[this.selected];
      anchor = c.map((v, k) => v + edit[k]);
      mode = ["scale", "scale1d"].includes(this.tool) ? "scale" : "translate";
      this.target = { type: "balloon", index: this.selected };
    }
    if (!anchor) {
      if (["move", "scale", "scale1d"].includes(this.tool))
        document.getElementById("selectionInfo").textContent =
          "NO BALLOON SELECTED";
      return;
    }
    this.anchor = new T.Vector3(...anchor);
    this.proxy.position.copy(this.anchor);
    this.proxy.quaternion.identity();
    if (this.target.type === "clip")
      this.proxy.quaternion.fromArray(this.clipState.quaternion);
    this.proxy.scale.setScalar(1);
    this.proxy.updateMatrixWorld();
    const axis = Number(document.getElementById("scale1dAxis")?.value || 0);
    this.transform.showX = this.tool !== "scale1d" || axis === 0;
    this.transform.showY = this.tool !== "scale1d" || axis === 1;
    this.transform.showZ = this.tool !== "scale1d" || axis === 2;
    this.transform.setMode(mode);
    if (this.tool === "boundary" || this.tool === "clipRotate") {
      const degrees = Number(
        document.getElementById("rotationSnap")?.value || 0,
      );
      this.transform.setRotationSnap?.(
        degrees ? (degrees * Math.PI) / 180 : null,
      );
    }
    this.transform.setSpace("world");
    this.transform.attach(this.proxy);
    document.getElementById("selectionInfo").textContent =
      this.target.type === "balloon"
        ? `${this.data.meta?.[this.selected]?.members.length > 1 ? "MERGED" : "BALLOON"} ${this.data.meta?.[this.selected]?.members.map((v) => String(v + 1).padStart(2, "0")).join("+") || String(this.selected + 1).padStart(2, "0")} SELECTED`
        : this.target.type === "curve"
          ? this.target.whole
            ? `CURVE ${(this.activeCurve || 0) + 1} SELECTED`
            : `CURVE POINT ${this.selectedCurve + 1} SELECTED`
          : this.target.type === "clip"
            ? "CLIPPING PLANE"
            : "BOUNDARY ROTATION";
  }
  beginTransform() {
    if (!this.target) return;
    this.activeTarget = { ...this.target };
    this.startAnchor = this.anchor.clone();
    this.startPoints = this.points?.map((p) => p.slice());
    this.startClip = this.clipState ? structuredClone(this.clipState) : null;
    this.changed = false;
    this.orbit.autoRotate = false;
    document.getElementById("rotateBtn").setAttribute("aria-pressed", "false");
  }
  previewTransform() {
    if (!this.activeTarget || !this.startAnchor) return;
    const target = this.activeTarget;
    const matrix = new T.Matrix4()
      .compose(
        this.proxy.position,
        this.proxy.quaternion,
        this.tool === "scale1d"
          ? new T.Vector3(...this.previewAxisRatios())
          : new T.Vector3().setScalar(this.previewRatio()),
      )
      .multiply(
        new T.Matrix4().makeTranslation(
          ...this.startAnchor.clone().negate().toArray(),
        ),
      );
    this.changed = this.changed || !matrix.equals(new T.Matrix4());
    if (target.type === "clip") {
      this.setClip({
        ...this.clipState,
        position: this.proxy.position.toArray(),
        quaternion: this.proxy.quaternion.toArray(),
      });
    } else if (target.type === "curve") {
      if (target.whole) {
        const delta = this.proxy.position
          .clone()
          .sub(this.startAnchor)
          .toArray();
        this.points = this.startPoints.map((p) =>
          p.map((v, k) => v + delta[k]),
        );
      } else this.points[target.index] = this.proxy.position.toArray();
      this.onCurve(
        this.points.map((p) => p.slice()),
        target.index,
        this.activeCurve || 0,
      );
    } else {
      const object =
        target.type === "boundary"
          ? this.boundaryGroup
          : this.meshes[target.index];
      if (object) {
        object.matrixAutoUpdate = false;
        object.matrix.copy(matrix);
        object.matrixWorldNeedsUpdate = true;
      }
    }
  }
  previewAxisRatios() {
    const edit = this.data.edits[this.activeTarget.index],
      axis = Number(document.getElementById("scale1dAxis").value),
      values = this.proxy.scale.toArray();
    return [0, 1, 2].map((k) =>
      k === axis
        ? Math.max(
            0.1 / (edit[4 + k] ?? 1),
            Math.min(3 / (edit[4 + k] ?? 1), values[k]),
          )
        : 1,
    );
  }
  previewRatio() {
    if (this.tool === "scale1d") return 1;
    const previous =
      this.activeTarget?.type === "balloon"
        ? this.data.edits[this.activeTarget.index][3]
        : 1;
    return Math.max(
      0.1 / previous,
      Math.min(3 / previous, uniformFactor(this.proxy.scale.toArray())),
    );
  }
  finishTransform() {
    if (!this.activeTarget) return;
    const target = this.activeTarget,
      delta = this.proxy.position.clone().sub(this.startAnchor).toArray(),
      ratio = this.previewRatio(),
      matrix = new T.Matrix4()
        .compose(
          this.proxy.position,
          this.proxy.quaternion,
          this.tool === "scale1d"
            ? new T.Vector3(...this.previewAxisRatios())
            : new T.Vector3().setScalar(ratio),
        )
        .multiply(
          new T.Matrix4().makeTranslation(
            ...this.startAnchor.clone().negate().toArray(),
          ),
        );
    const changed = this.changed;
    this.previewAxisRatiosForFinished =
      this.tool === "scale1d" ? this.previewAxisRatios() : null;
    this.activeTarget = null;
    this.startAnchor = null;
    if (changed)
      this.onTransform({
        ...target,
        delta,
        ratio,
        ...(this.tool === "scale1d"
          ? { axisRatios: this.previewAxisRatiosForFinished }
          : {}),
        matrix: matrix.toArray(),
        clipping: this.clipState,
      });
  }
  pointerDown(e, i) {
    if (this.busy || e.button !== 0) return;
    this.renderers[i].domElement.focus?.({ preventScroll: true });
    this.down = [e.clientX, e.clientY];
    this.selectedOnDown = false;
    const additive = !!(e.shiftKey || e.ctrlKey || e.metaKey);
    if (
      i === 0 &&
      this.transform.object &&
      this.transform.enabled &&
      !additive
    ) {
      this.setRay(e, i);
      // Refresh hover for touch and a first click with no preceding mousemove.
      this.transform.pointerHover({
        x: this.pointer.x,
        y: this.pointer.y,
        button: 0,
      });
      if (this.transform.axis) {
        this.orbit.enabled = false;
        return;
      }
    }
    let target;
    if (
      this.tool === "clipMove" &&
      this.clipMesh &&
      this.hit(e, i, [this.clipMesh]).length
    ) {
      target = { type: "clip" };
    }
    if (this.editCurve || this.tool === "curveMove" || this.tool === "move") {
      const hit = this.hit(e, i, this.handles || [])[0];
      if (hit) {
        this.selectedCurve = hit.object.userData.index;
        this.tool = "curve";
        this.attachTool();
        this.setTool("curve");
        target = { type: "curve", index: this.selectedCurve };
        document.getElementById("curvePoint").value = this.selectedCurve;
        this.onCurve(
          this.points.map((p) => p.slice()),
          this.selectedCurve,
          this.activeCurve || 0,
        );
      }
      if (!target) {
        const lineHit = this.hit(e, i, this.curveLines || [])[0];
        if (lineHit) {
          const index = lineHit.object.userData.curveIndex;
          this.activeCurve = index;
          this.points = this.allCurves[index].map((p) => p.slice());
          this.tool = "curveMove";
          this.curveWhole = true;
          this.onCurve(
            this.points.map((p) => p.slice()),
            -1,
            index,
          );
          this.setTool("curveMove");
          target = { type: "curve", whole: true, index: -1 };
        }
      }
    }
    if (
      !target &&
      !["boundary", "clipMove", "clipRotate", "curveMove", "curve"].includes(
        this.tool,
      )
    ) {
      const hit = this.hit(
        e,
        i,
        this.meshes.filter((m) => m.visible),
      )[0];
      if (hit) {
        this.onSelect(hit.object.userData.index, additive);
        this.selectedOnDown = true;
        if (additive) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        if (this.tool === "move" && !this.data.meta?.[this.selected]?.frozen)
          target = { type: "balloon", index: this.selected };
      }
    }
    if (!target) return;
    this.beginTransform();
    const camera = i ? this.plan : this.perspective,
      normal = i
        ? new T.Vector3(0, 0, 1)
        : camera.getWorldDirection(new T.Vector3());
    const plane = new T.Plane().setFromNormalAndCoplanarPoint(
        normal,
        this.proxy.position,
      ),
      start = new T.Vector3();
    this.setRay(e, i);
    if (!this.ray.ray.intersectPlane(plane, start)) return;
    this.directDrag = {
      plane,
      start,
      anchor: this.proxy.position.clone(),
      pointerId: e.pointerId,
      view: i,
    };
    this.orbit.enabled = false;
    rCapture(this.renderers[i].domElement, e.pointerId);
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  pointerMove(e, i) {
    const d = this.directDrag;
    if (!d || d.view !== i) return;
    this.setRay(e, i);
    const p = new T.Vector3();
    if (!this.ray.ray.intersectPlane(d.plane, p)) return;
    this.proxy.position.copy(d.anchor).add(p.sub(d.start));
    this.proxy.updateMatrixWorld();
    this.previewTransform();
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  pointerUp(e, i) {
    if (this.directDrag?.view === i) {
      this.directDrag = null;
      this.finishTransform();
      this.orbit.enabled = !this.busy;
      this.attachTool();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (i === 0 && this.transform.dragging) return;
    if (
      this.down &&
      Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) < 5 &&
      this.tool !== "boundary" &&
      !this.selectedOnDown &&
      !this.busy
    ) {
      const hit = this.hit(
        e,
        i,
        this.meshes.filter((m) => m.visible),
      )[0];
      if (hit)
        this.onSelect(
          hit.object.userData.index,
          !!(e.shiftKey || e.ctrlKey || e.metaKey),
        );
    }
    this.orbit.enabled = !this.busy;
  }
  cancelDrag(e, i) {
    if (this.directDrag?.view !== i) return;
    if (this.activeTarget?.type === "curve" && this.startPoints)
      this.onCurve(
        this.startPoints.map((p) => p.slice()),
        this.activeTarget.index,
        this.activeCurve || 0,
      );
    if (this.activeTarget?.type === "clip" && this.startClip)
      this.setClip(this.startClip);
    this.directDrag = null;
    this.activeTarget = null;
    this.orbit.enabled = !this.busy;
    this.onTransform({ type: "cancel" });
  }
  setRay(e, i) {
    const rect = this.renderers[i].domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      (-(e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.ray.setFromCamera(this.pointer, i ? this.plan : this.perspective);
  }
  hit(e, i, objects) {
    this.setRay(e, i);
    return this.ray
      .intersectObjects(objects, false)
      .filter(
        (hit) =>
          !(hit.object.material?.clippingPlanes || []).some(
            (plane) => plane.distanceToPoint(hit.point) < 0,
          ),
      );
  }
  resize(i) {
    const el = this.renderers[i].domElement.parentElement,
      w = el.clientWidth,
      h = el.clientHeight;
    this.renderers[i].setSize(w, h);
    if (i === 0) {
      this.perspective.aspect = w / h;
      this.perspective.updateProjectionMatrix();
    } else {
      const aspect = w / h,
        half = this.span * 0.65;
      this.plan.left = -half * aspect;
      this.plan.right = half * aspect;
      this.plan.top = half;
      this.plan.bottom = -half;
      this.plan.updateProjectionMatrix();
    }
  }
  disposeGroup(g) {
    for (const c of [...g.children]) {
      g.remove(c);
      c.traverse((o) => {
        o.geometry?.dispose();
        if (o.material)
          Array.isArray(o.material)
            ? o.material.forEach((m) => m.dispose())
            : o.material.dispose();
      });
    }
  }
  show(data, fit = false) {
    this.transform.detach();
    this.data = data;
    this.result = null;
    this.disposeGroup(this.field);
    this.meshes = [];
    const raw = data.boundary,
      b = bounds(raw);
    this.box = b;
    this.span = Math.max(...b.span);
    this.boundaryGroup = new T.Group();
    const g = geometry(raw),
      shell = new T.Mesh(
        g,
        new T.MeshPhysicalMaterial({
          color: 0x82d7df,
          transparent: true,
          opacity: 0.06,
          side: T.DoubleSide,
          depthWrite: false,
          roughness: 0.5,
        }),
      );
    this.boundaryGroup.add(
      shell,
      new T.LineSegments(
        new T.EdgesGeometry(g, 25),
        new T.LineBasicMaterial({
          color: 0x59bbc7,
          transparent: true,
          opacity: 0.65,
        }),
      ),
    );
    this.field.add(this.boundaryGroup);
    this.boundaryGroup.visible =
      document.getElementById("showBoundary").checked;
    data.balloons.forEach((raw, i) => {
      const g = geometry(raw),
        color = data.meta?.[i]?.frozen
          ? new T.Color(0x839bb7)
          : new T.Color().setHSL(
              0.51 + (i % 4) * 0.009,
              0.48,
              0.43 + (i % 3) * 0.055,
            ),
        m = new T.Mesh(
          g,
          new T.MeshPhysicalMaterial({
            color,
            metalness: 0.22,
            roughness: 0.23,
            clearcoat: 0.8,
            clearcoatRoughness: 0.2,
            side: T.FrontSide,
          }),
        );
      m.userData.index = i;
      this.meshes.push(m);
      const wire = quadWire(raw);
      wire.visible = this.wire;
      m.add(wire);
      this.field.add(m);
    });
    this.plan.position.set(b.center[0], b.center[1], b.max[2] + this.span * 4);
    this.plan.lookAt(...b.center);
    this.plan.far = this.span * 20;
    this.plan.updateProjectionMatrix();
    this.resize(1);
    if (fit) this.fit();
    this.select(Math.min(Math.max(this.selected, 0), data.balloons.length - 1));
  }
  fit() {
    if (!this.box) return;
    const c = new T.Vector3(...this.box.center),
      radius = Math.hypot(...this.box.span) / 2,
      halfFov = Math.atan(
        Math.tan((this.perspective.fov * Math.PI) / 360) *
          Math.min(1, this.perspective.aspect),
      ),
      distance = (radius / Math.sin(halfFov)) * 1.12;
    this.perspective.position
      .copy(c)
      .add(new T.Vector3(1, -0.95, 0.8).normalize().multiplyScalar(distance));
    this.perspective.near = this.span * 0.001;
    this.perspective.far = this.span * 100;
    this.perspective.updateProjectionMatrix();
    this.orbit.target.copy(c);
    this.orbit.update();
  }
  select(index, indices) {
    this.selected = index;
    if (indices !== undefined) this.selectedIndices = indices;
    const selection = this.selectedIndices || new Set([index]);
    this.meshes.forEach((m, i) => {
      m.material.emissive.setHex(selection.has(i) ? 0x087079 : 0x000000);
      m.material.emissiveIntensity = selection.has(i)
        ? i === index
          ? 0.9
          : 0.6
        : 0;
    });
    this.attachTool();
  }
  curve(points, editing, visible, curves = [points], active = 0) {
    this.allCurves = curves.map((c) => c.map((p) => p.slice()));
    this.activeCurve = active;
    this.selectedCurve = Math.max(
      0,
      Math.min(this.selectedCurve, points.length - 1),
    );
    this.points = points.map((p) => p.slice());
    this.editCurve = editing;
    this.disposeGroup(this.curveGroup);
    this.handles = [];
    this.curveLines = [];
    if (points.length < 2 || !visible) return;
    curves.forEach((control, curveIndex) => {
      const spline = new T.CatmullRomCurve3(
        control.map((p) => new T.Vector3(...p)),
        false,
        "centripetal",
      );
      this.curveSamples = spline
        .getPoints(Math.max(100, points.length * 12))
        .map((p) => p.toArray());
      const line = new T.Mesh(
        new T.TubeGeometry(
          spline,
          Math.max(100, control.length * 12),
          this.span * (curveIndex === active ? 0.0024 : 0.0018),
          8,
          false,
        ),
        new T.MeshBasicMaterial({
          color: 0xdc24f4,
          transparent: true,
          opacity: curveIndex === active ? 1 : 0.72,
          depthTest: false,
          depthWrite: false,
        }),
      );
      line.renderOrder = 10;
      line.userData.curveIndex = curveIndex;
      this.curveGroup.add(line);
      // Generous invisible pick area keeps thin strokes easy to select.
      const picker = new T.Mesh(
        new T.TubeGeometry(
          spline,
          Math.max(100, control.length * 12),
          this.span * 0.008,
          6,
          false,
        ),
        new T.MeshBasicMaterial({ visible: false }),
      );
      picker.userData.curveIndex = curveIndex;
      this.curveLines.push(picker);
      this.curveGroup.add(picker);
    });
    if (editing)
      points.forEach((p, i) => {
        const handle = new T.Mesh(
          new T.SphereGeometry(this.span * 0.012, 16, 12),
          new T.MeshBasicMaterial({ color: 0xdc24f4, depthTest: false }),
        );
        handle.position.set(...p);
        handle.userData.index = i;
        handle.renderOrder = 20;
        this.handles.push(handle);
        this.curveGroup.add(handle);
      });
    this.attachTool();
  }
  samples(points) {
    return new T.CatmullRomCurve3(
      points.map((p) => new T.Vector3(...p)),
      false,
      "centripetal",
    )
      .getPoints(Math.max(100, points.length * 12))
      .map((p) => p.toArray());
  }
  setClip(state) {
    if (
      !Array.isArray(state.position) ||
      state.position.length !== 3 ||
      state.position.some((v) => !Number.isFinite(v)) ||
      !Array.isArray(state.quaternion) ||
      state.quaternion.length !== 4 ||
      state.quaternion.some((v) => !Number.isFinite(v)) ||
      Math.hypot(...state.quaternion) < 1e-12
    )
      throw Error("Invalid clipping plane coordinates or orientation.");
    state = {
      ...state,
      quaternion: new T.Quaternion()
        .fromArray(state.quaternion)
        .normalize()
        .toArray(),
    };
    this.clipState = {
      enabled: !!state.enabled,
      position: [...state.position],
      quaternion: [...state.quaternion],
    };
    const toggle = document.getElementById("clipToggle");
    if (toggle) {
      toggle.textContent = state.enabled ? "CLIP ON" : "CLIP OFF";
      toggle.setAttribute("aria-pressed", String(!!state.enabled));
    }
    const checkbox = document.getElementById("clippingEnabled");
    if (checkbox) checkbox.checked = !!state.enabled;
    const normal = new T.Vector3(0, 0, 1).applyQuaternion(
      new T.Quaternion().fromArray(state.quaternion),
    );
    const plane = new T.Plane().setFromNormalAndCoplanarPoint(
      normal,
      new T.Vector3(...state.position),
    );
    this.field.traverse((object) => {
      if (!object.material) return;
      for (const material of Array.isArray(object.material)
        ? object.material
        : [object.material]) {
        material.clippingPlanes = state.enabled ? [plane] : [];
        material.needsUpdate = true;
      }
    });
    if (!this.clipMesh) {
      this.clipMesh = new T.Mesh(
        new T.PlaneGeometry(1, 1),
        new T.MeshBasicMaterial({
          color: 0x21e0ed,
          transparent: true,
          opacity: 0.12,
          side: T.DoubleSide,
          depthWrite: false,
        }),
      );
      this.clipMesh.add(
        new T.LineSegments(
          new T.EdgesGeometry(this.clipMesh.geometry),
          new T.LineBasicMaterial({ color: 0x21e0ed }),
        ),
      );
      this.scene.add(this.clipMesh);
    }
    this.clipMesh.visible = state.enabled;
    this.clipMesh.position.fromArray(state.position);
    this.clipMesh.quaternion.fromArray(state.quaternion);
    this.clipMesh.scale.setScalar(this.span * 1.25);
    if (!this.activeTarget) this.attachTool();
  }
  output(raw) {
    if (raw) this.transform.detach();
    if (this.result) {
      this.field.remove(this.result);
      this.result.traverse((object) => {
        object.geometry?.dispose();
        object.material?.dispose();
      });
    }
    this.result = null;
    if (raw) {
      this.meshes.forEach((m) => (m.visible = false));
      this.boundaryGroup.visible = false;
      const assembly = Array.isArray(raw);
      this.result = new T.Group();
      for (const [index, shell] of (assembly ? raw : [raw]).entries()) {
        const container = assembly && index === 0;
        const origin = bounds(shell).center;
        const mesh = new T.Mesh(
          geometry(shell, origin),
          new T.MeshPhysicalMaterial({
            color: container ? 0x21e0ed : 0x4e9fa9,
            wireframe: false,
            metalness: container ? 0 : 0.25,
            roughness: 0.28,
            side: T.DoubleSide,
            transparent: container,
            opacity: container ? 0.12 : 1,
            depthWrite: !container,
          }),
        );
        mesh.position.fromArray(origin);
        const wire = quadWire(shell, origin);
        wire.visible = this.wire;
        mesh.add(wire);
        this.result.add(mesh);
      }
      this.field.add(this.result);
    } else {
      this.meshes.forEach((m) => (m.visible = true));
      this.boundaryGroup.visible =
        document.getElementById("showBoundary").checked;
      this.attachTool();
    }
    if (this.clipState) this.setClip(this.clipState);
  }
  animate() {
    requestAnimationFrame(() => this.animate());
    this.orbit.update();
    this.renderers[0].render(this.scene, this.perspective);
    const visible = this.transformHelper.visible;
    this.transformHelper.visible = false;
    this.renderers[1].render(this.scene, this.plan);
    this.transformHelper.visible = visible;
  }
}
function rCapture(canvas, id) {
  try {
    canvas.setPointerCapture(id);
  } catch {}
}
