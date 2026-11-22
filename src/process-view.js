import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
export function captureCamera(camera, orbit) {
  if (!camera) return;
  camera.updateMatrixWorld();
  return {
    position: camera.position.toArray(),
    quaternion: camera.quaternion.toArray(),
    up: camera.up.toArray(),
    target: orbit?.target.toArray(),
    fov: camera.fov,
    zoom: camera.zoom,
    near: camera.near,
    far: camera.far,
  };
}
export function applyCamera(camera, orbit, view) {
  if (!view) return;
  camera.position.fromArray(view.position);
  camera.quaternion.fromArray(view.quaternion);
  camera.up.fromArray(view.up);
  camera.fov = view.fov ?? 45;
  camera.zoom = view.zoom ?? 1;
  camera.near = view.near ?? 0.01;
  camera.far = view.far ?? 100000;
  if (view.target && orbit) orbit.target.fromArray(view.target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}
const geometryCache = new WeakMap();
export function captureProcessView(source) {
  if (!source?.camera) throw Error("Open a design viewport before recording.");
  const objects = [];
  for (const root of source.roots.filter(Boolean)) {
    root.updateWorldMatrix(true, true);
    root.traverseVisible((object) => {
      if (
        !(object.isMesh || object.isLine || object.isPoints) ||
        !object.geometry?.attributes.position
      )
        return;
      if (Array.isArray(object.material)) return;
      const material = object.material;
      if (!material || !material.visible) return;
      const g = object.geometry;
      let raw = geometryCache.get(g);
      if (!raw || raw.version !== g.attributes.position.version) {
        const positions = Float64Array.from(g.attributes.position.array);
        const indices = g.index ? Uint32Array.from(g.index.array) : undefined;
        raw = { positions, indices, version: g.attributes.position.version };
        geometryCache.set(g, raw);
      }
      objects.push({
        raw,
        matrix: object.matrixWorld.toArray(),
        type: object.isMesh
          ? "mesh"
          : object.isPoints
            ? "points"
            : object.isLineSegments
              ? "segments"
              : object.isLineLoop
                ? "loop"
                : "line",
        color: material.color?.getHex() ?? 0xffffff,
        opacity: material.opacity,
        side: material.side,
        wireframe: !!material.wireframe,
        size: material.size ?? 3,
        planes: (material.clippingPlanes ?? []).map((p) => [
          ...p.normal.toArray(),
          p.constant,
        ]),
        depthTest: material.depthTest,
        depthWrite: material.depthWrite,
      });
    });
  }
  return {
    workspace: source.workspace,
    camera: captureCamera(source.camera, source.orbit),
    objects,
  };
}
export function createProcessViewer(canvasHost) {
  const scene = new T.Scene();
  scene.background = new T.Color(0);
  const group = new T.Group();
  scene.add(group);
  scene.add(new T.HemisphereLight(0xffffff, 0x667788, 2));
  const light = new T.DirectionalLight(0xffffff, 2);
  light.position.set(1, -2, 4);
  scene.add(light);
  const camera = new T.PerspectiveCamera(45, 1, 0.01, 100000);
  camera.up.set(0, 0, 1);
  const renderer = new T.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.localClippingEnabled = true;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  canvasHost.append(renderer.domElement);
  const orbit = new OrbitControls(camera, renderer.domElement);
  let active = true, exportSize;
  function resize() {
    const w = exportSize?.[0] ?? canvasHost.clientWidth,
      h = exportSize?.[1] ?? canvasHost.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvasHost);
  function clear() {
    for (const object of [...group.children]) {
      object.geometry.dispose();
      object.material.dispose();
      group.remove(object);
    }
  }
  function show(view, preserveCamera = false) {
    clear();
    for (const item of view.objects) {
      const g = new T.BufferGeometry();
      g.setAttribute(
        "position",
        new T.BufferAttribute(Float32Array.from(item.raw.positions), 3),
      );
      if (item.raw.indices)
        g.setIndex(new T.BufferAttribute(item.raw.indices, 1));
      const props = {
        color: item.color,
        transparent: item.opacity < 1,
        opacity: item.opacity,
        depthWrite: item.depthWrite,
        depthTest: item.depthTest,
        clippingPlanes: item.planes.map(
          ([x, y, z, d]) => new T.Plane(new T.Vector3(x, y, z), d),
        ),
      };
      let object;
      if (item.type === "mesh") {
        g.computeVertexNormals();
        object = new T.Mesh(
          g,
          new T.MeshStandardMaterial({
            ...props,
            side: item.side,
            wireframe: item.wireframe,
            roughness: 0.65,
          }),
        );
      } else if (item.type === "points")
        object = new T.Points(
          g,
          new T.PointsMaterial({
            ...props,
            size: item.size,
            sizeAttenuation: false,
          }),
        );
      else {
        const Line =
          item.type === "segments"
            ? T.LineSegments
            : item.type === "loop"
              ? T.LineLoop
              : T.Line;
        object = new Line(g, new T.LineBasicMaterial(props));
      }
      object.matrixAutoUpdate = false;
      object.matrix.fromArray(item.matrix);
      group.add(object);
    }
    if (!preserveCamera) applyCamera(camera, orbit, view.camera);
    resize();
    render();
  }
  function render() {
    renderer.render(scene, camera);
  }
  function frame() {
    requestAnimationFrame(frame);
    if (active) {
      orbit.update();
      render();
    }
  }
  frame();
  return {
    show,
    render,
    camera,
    orbit,
    canvas: renderer.domElement,
    setExportSize(width, height) {
      exportSize = width ? [width, height] : undefined;
      renderer.setPixelRatio(exportSize ? 1 : Math.min(devicePixelRatio, 2));
      resize();
    },
    fit() {
      const bounds = new T.Box3().setFromObject(group);
      if (bounds.isEmpty()) return;
      const center = bounds.getCenter(new T.Vector3());
      const direction = camera.position.clone().sub(orbit.target).normalize();
      if (!direction.lengthSq()) direction.set(1, -1, 0.6).normalize();
      const radius = bounds.getSize(new T.Vector3()).length() / 2;
      const halfAngle = Math.min(T.MathUtils.degToRad(camera.fov / 2),
        Math.atan(Math.tan(T.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
      camera.zoom = 1;
      camera.position.copy(center).addScaledVector(direction, radius / Math.sin(halfAngle) * 1.08);
      orbit.target.copy(center);
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      render();
    },
    setCamera: (view) => applyCamera(camera, orbit, view),
    getCamera: () => captureCamera(camera, orbit),
    setActive: (value) => {
      active = value;
      resize();
    },
    transition(from, to, t) {
      camera.position.lerpVectors(
        new T.Vector3(...from.position),
        new T.Vector3(...to.position),
        t,
      );
      camera.quaternion.slerpQuaternions(
        new T.Quaternion(...from.quaternion),
        new T.Quaternion(...to.quaternion),
        t,
      );
      camera.fov = T.MathUtils.lerp(from.fov ?? 45, to.fov ?? 45, t);
      if (from.target && to.target)
        orbit.target.lerpVectors(
          new T.Vector3(...from.target),
          new T.Vector3(...to.target),
          t,
        );
      camera.updateProjectionMatrix();
    },
  };
}
