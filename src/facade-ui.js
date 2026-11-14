import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { geometry } from "./view.js";
import { addTechnicalFrames } from "./frames.js";

export function initFacade(pane, readFloors, rhino) {
  pane.innerHTML = `<div class="voro-layout"><section class="panel" data-frame-count="1">
    <div class="panel-heading">PERSPECTIVE <small>FACADE DESIGN</small></div>
    <div class="canvas-tools"><button id="fFit">FIT</button><button id="fWire" aria-pressed="false">WIRE</button>
    <label>Stage <select id="fStage" disabled><option value="wrap">Offset wrap</option><option value="low" disabled>Low-poly mesh</option><option value="panels" disabled>Planar panels</option></select></label>
    <label>Panel finish <select id="fFinish" disabled><option value="foil">Foil</option><option value="concrete">Concrete</option></select></label></div>
    <div id="fCanvas" class="voro-canvas"></div></section><aside>
    <section class="panel" data-frame-count="2"><div class="panel-heading">FACADE DESIGN</div>
    <div class="voro-controls">
    <label>Offset (ft)<input id="fOffset" type="number" min="0" max="100" value="3" step="any" required></label>
    <label>Wrap resolution<input id="fResolution" type="number" min="24" max="96" value="56" required></label>
    <button id="fBuild" class="primary">1. BUILD OFFSET WRAP</button>
    <p id="fOriginalCount">Original wrap: — triangles</p>
    <label>Target triangles<input id="fTarget" type="number" min="32" max="10000" value="400" required></label>
    <button id="fRemesh" disabled>2. REMESH LOW POLY</button>
    <button id="fPlanar" disabled>3. CREATE PLANAR PANELS</button>
    <button id="fExport" disabled>EXPORT CURRENT STAGE .3DM</button>
    </div></section></aside></div>
    <div id="fStatus" class="status-bar" role="status">Import floor curves in Voronoi Balloons to begin.</div>`;
  addTechnicalFrames(pane);
  const $ = (id) => pane.querySelector("#" + id);
  const scene = new T.Scene();
  scene.background = new T.Color(0);
  const camera = new T.PerspectiveCamera(42, 1, 0.01, 100000);
  camera.up.set(0, 0, 1);
  const material = new T.MeshPhysicalMaterial({
    color: 0xe2e2e2,
    metalness: 1,
    roughness: 0.19,
    envMapIntensity: 1.55,
  });
  material.polygonOffset = true;
  material.polygonOffsetFactor = 1;
  material.polygonOffsetUnits = 1;
  scene.add(new T.HemisphereLight(0xffffff, 0x667788, 2));
  const concrete = new T.MeshStandardMaterial({
    roughness: 0.93,
    metalness: 0,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const concreteJoints = new T.LineBasicMaterial({ color: 0x514b43 });
  const keyLight = new T.DirectionalLight(0xfff3df, 2);
  keyLight.position.set(-3, -4, 6);
  keyLight.visible = false;
  scene.add(keyLight);
  let renderer,
    orbit,
    mesh,
    edges,
    worker,
    busy = false;
  const stages = {};
  const showEdges = { wrap: false, low: true, panels: true };
  const edgeMaterial = new T.LineBasicMaterial({ color: 0xffffff });
  const render = () => {
    if (renderer && !pane.hidden) renderer.render(scene, camera);
  };
  const resize = () => {
    if (!renderer || pane.hidden) return;
    const canvas = $("fCanvas");
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    camera.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    camera.updateProjectionMatrix();
    render();
  };
  const fit = () => {
    if (!mesh) return;
    const box = new T.Box3().setFromObject(mesh);
    const span = box.getSize(new T.Vector3()).length();
    box.getCenter(orbit.target);
    camera.position
      .copy(orbit.target)
      .addScaledVector(new T.Vector3(0.9, -1.2, 0.65), span);
    orbit.update();
    render();
  };
  const display = () => {
    const stage = $("fStage").value;
    const raw = stages[stage];
    if (!raw) return;
    if (mesh) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      edges.geometry.dispose();
    }
    const isConcrete = stage === "panels" && $("fFinish").value === "concrete";
    $("fFinish").disabled = stage !== "panels";
    keyLight.visible = isConcrete;
    const surface = geometry(raw);
    if (isConcrete) {
      const colors = new Float32Array(raw.positions.length);
      const base = new T.Color(0xb5afa4);
      const tone = new T.Color();
      for (let i = 0; i < raw.indices.length; i += 3) {
        const variation = (Math.imul(i + 1, 2654435761) >>> 0) / 2 ** 32 - 0.5;
        tone.copy(base).multiplyScalar(1 + variation * 0.16);
        for (let j = 0; j < 3; j++)
          tone.toArray(colors, raw.indices[i + j] * 3);
      }
      surface.setAttribute("color", new T.BufferAttribute(colors, 3));
    }
    mesh = new T.Mesh(surface, isConcrete ? concrete : material);
    edges = new T.LineSegments(
      new T.WireframeGeometry(mesh.geometry),
      isConcrete ? concreteJoints : edgeMaterial,
    );
    edges.visible = showEdges[stage];
    mesh.add(edges);
    $("fWire").setAttribute("aria-pressed", edges.visible);
    scene.add(mesh);
    $("fStatus").textContent =
      stage === "wrap"
        ? `Offset wrap · ${raw.indices.length / 3} triangles`
        : stage === "panels"
          ? `${raw.indices.length / 3} planar triangular panels`
          : `Low-poly mesh · ${raw.indices.length / 3} triangles · target ${raw.target}`;
    render();
  };
  const controls = () => {
    $("fBuild").disabled = busy;
    $("fRemesh").disabled = busy || !stages.wrap;
    $("fPlanar").disabled = busy || !stages.low;
    $("fStage").options[2].disabled = !stages.panels;
    $("fExport").disabled = busy || !stages.wrap;
    $("fStage").disabled = busy || !stages.wrap;
    $("fStage").options[1].disabled = !stages.low;
  };
  const run = (stage, payload) => {
    busy = true;
    controls();
    $("fStatus").textContent =
      stage === "wrap" ? "Building offset wrap…" : "Remeshing…";
    const finish = (error, raw) => {
      busy = false;
      if (error) {
        $("fStatus").textContent = error;
        controls();
        return;
      }
      if (stage === "wrap") delete stages.low;
      delete stages.panels;
      stages[stage] = { ...raw, target: payload.target };
      $("fOriginalCount").textContent =
        "Original wrap: " +
        (stages.wrap.indices.length / 3).toLocaleString() +
        " triangles";
      controls();
      $("fStage").value = stage;
      display();
      if (stage === "wrap") fit();
    };
    try {
      worker ??= new Worker(new URL("./facade-worker.js", import.meta.url), {
        type: "module",
      });
      worker.onmessage = ({ data }) => finish(data.error, data.mesh);
      worker.onerror = () => {
        worker.terminate();
        worker = undefined;
        finish(
          "The façade worker stopped. Rebuild the offset wrap to continue.",
        );
        $("fRemesh").disabled = true;
      };
      worker.postMessage(payload);
    } catch (error) {
      finish(error.message);
    }
  };
  window.addEventListener("keydown", (event) => {
    if (pane.hidden || event.key !== "Escape" || !busy || !worker) return;
    event.preventDefault();
    worker.terminate();
    worker = undefined;
    busy = false;
    controls();
    $("fStatus").textContent = "Façade command cancelled.";
  });
  $("fBuild").onclick = () => {
    if (!$("fOffset").reportValidity() || !$("fResolution").reportValidity())
      return;
    let floors;
    try {
      floors = readFloors();
    } catch (error) {
      $("fStatus").textContent = error.message;
      return;
    }
    if (!floors.length) {
      $("fStatus").textContent =
        "Import floor curves in Voronoi Balloons first.";
      return;
    }
    run("wrap", {
      floors,
      offset: $("fOffset").valueAsNumber,
      resolution: $("fResolution").valueAsNumber,
    });
  };
  $("fRemesh").onclick = () => {
    if ($("fTarget").reportValidity())
      run("low", { target: $("fTarget").valueAsNumber });
  };
  $("fPlanar").onclick = () => {
    if (busy || !stages.low) return;
    const { positions, indices } = stages.low;
    // Independent vertices keep each panel's normal separate across joints.
    const panelPositions = new Float32Array(indices.length * 3);
    indices.forEach((vertex, i) => {
      panelPositions.set(positions.subarray(vertex * 3, vertex * 3 + 3), i * 3);
    });
    stages.panels = {
      positions: panelPositions,
      indices: Uint32Array.from(indices, (_, i) => i),
    };
    controls();
    $("fStage").value = "panels";
    display();
  };
  $("fStage").onchange = display;
  $("fFinish").onchange = display;
  $("fFit").onclick = fit;
  $("fWire").onclick = () => {
    if (!edges) return;
    const stage = $("fStage").value;
    showEdges[stage] = !showEdges[stage];
    edges.visible = showEdges[stage];
    $("fWire").setAttribute("aria-pressed", edges.visible);
    render();
  };
  $("fExport").onclick = async () => {
    const stage = $("fStage").value;
    const raw = stages[stage];
    if (!raw) return;
    try {
      const r = await rhino();
      const doc = new r.File3dm();
      const output = new r.Mesh();
      const attributes = new r.ObjectAttributes();
      try {
        doc.settings().modelUnitSystem = r.UnitSystem.Feet;
        const vertices = output.vertices();
        vertices.useDoublePrecisionVertices = true;
        for (let i = 0; i < raw.positions.length; i += 3)
          vertices.addPoint3d(
            raw.positions[i],
            raw.positions[i + 1],
            raw.positions[i + 2],
          );
        const faces = output.faces();
        for (let i = 0; i < raw.indices.length; i += 3)
          faces.addTriFace(
            raw.indices[i],
            raw.indices[i + 1],
            raw.indices[i + 2],
          );
        output.normals().computeNormals();
        attributes.name = {
          wrap: "Offset wrap",
          low: "Low-poly façade",
          panels: "Planar façade panels",
        }[stage];
        doc.objects().addMesh(output, attributes);
        const url = URL.createObjectURL(new Blob([doc.toByteArray()]));
        const link = document.createElement("a");
        link.href = url;
        link.download = {
          wrap: "facade-offset-wrap.3dm",
          low: "facade-low-poly.3dm",
          panels: "facade-planar-panels.3dm",
        }[stage];
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } finally {
        attributes.delete();
        output.delete();
        doc.delete();
      }
    } catch (error) {
      $("fStatus").textContent = error.message;
    }
  };
  return () => {
    if (!renderer) {
      renderer = new T.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      const room = new RoomEnvironment();
      const pmrem = new T.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(room, 0.01).texture;
      room.dispose();
      pmrem.dispose();
      $("fCanvas").append(renderer.domElement);
      orbit = new OrbitControls(camera, renderer.domElement);
      orbit.addEventListener("change", render);
      new ResizeObserver(resize).observe($("fCanvas"));
    }
    resize();
  };
}
