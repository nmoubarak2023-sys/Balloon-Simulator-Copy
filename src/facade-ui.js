import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { planarPanels, panelParts } from "./planar-panels.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MeshBVH } from "three-mesh-bvh";
import { geometry } from "./view.js";
import { addTechnicalFrames } from "./frames.js";

const controls = [
  ["resolution", "Membrane mesh resolution", 96, 24, 192],
  ["tension", "Membrane tension", 65, 0, 100],
  ["compression", "Local compression", 65, 0, 100],
  ["bending", "Bending resistance", 35, 0, 100],
  ["anchorPhase", "Anchor position around perimeter", 0, 0, 360],
  ["anchorHeight", "Anchor height in span", 50, 5, 95],
  ["anchorStrength", "Anchor strength", 85, 0, 100],
  ["wrinkles", "Wrinkle intensity", 50, 0, 100],
  ["fold", "Fold depth (ft)", 8, 0, 20],
  ["anchors", "Anchor count", 8, 2, 24],
  ["distribution", "Anchor clustering", 40, 0, 100],
  ["offset", "Envelope offset (ft)", 3, 0, 30],
];

function perimeterRadius(loop, center, x, y) {
  let radius = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i],
      b = loop[(i + 1) % loop.length];
    const ax = a[0] - center.x,
      ay = a[1] - center.y;
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const cross = x * dy - y * dx;
    if (Math.abs(cross) < 1e-10) continue;
    const t = (ax * y - ay * x) / cross;
    if (t >= 0 && t <= 1)
      radius = Math.max(radius, (ax * dy - ay * dx) / cross);
  }
  return radius;
}

export function foilMesh(floors, options, obstacles) {
  const bounds = new T.Box3();
  for (const floor of floors) {
    for (const [x, y] of floor.loop)
      bounds.expandByPoint(new T.Vector3(x, y, floor.z));
  }
  const center = bounds.getCenter(new T.Vector3());
  const reach =
    bounds.getSize(new T.Vector3()).length() +
    obstacles.reduce(
      (max, mesh) =>
        Math.max(
          max,
          mesh.boundingBox.getSize(new T.Vector3()).length() +
            mesh.boundingBox.getCenter(new T.Vector3()).distanceTo(center),
        ),
      0,
    ) +
    1;
  const columns = options.resolution;
  const bottom = Math.min(
    bounds.min.z,
    ...obstacles.map((g) => g.boundingBox.min.z),
  );
  const top = Math.max(
    bounds.max.z + (floors.length === 1 ? 20 : 0),
    ...obstacles.map((g) => g.boundingBox.max.z),
  );
  const rows = [
    ...new Set([
      ...Array.from({ length: Math.ceil(columns / 2) + 1 }, (_, i) =>
        T.MathUtils.lerp(bottom, top, i / Math.ceil(columns / 2)),
      ),
      ...floors.map((floor) => floor.z),
    ]),
  ].sort((a, b) => a - b);
  const size = rows.length * columns;
  const target = new Float64Array(size);
  const minimum = new Float64Array(size);
  const pins = new Float64Array(size);
  const pinTarget = new Float64Array(size);
  const anchors = [];
  const ray = new T.Ray();
  const phase = T.MathUtils.degToRad(options.anchorPhase);
  const anchorAngles = Array.from({ length: options.anchors }, (_, i) => {
    const angle = (i * Math.PI * 2) / options.anchors;
    return angle + phase + (Math.sin(angle) * options.distribution) / 125;
  });

  rows.forEach((z, row) => {
    const upper = floors.findIndex((floor) => floor.z >= z);
    const a = floors[upper < 0 ? floors.length - 1 : Math.max(0, upper - 1)];
    const b = floors[upper < 0 ? floors.length - 1 : upper];
    const mix = a === b ? 0 : (z - a.z) / (b.z - a.z);
    const span = Math.max(1e-6, b.z - a.z || top - bottom);
    const v = a === b ? (z - bottom) / (top - bottom) : (z - a.z) / span;
    for (let column = 0; column < columns; column++) {
      const angle = (column * Math.PI * 2) / columns;
      const x = Math.cos(angle),
        y = Math.sin(angle);
      const id = row * columns + column;
      const plate =
        T.MathUtils.lerp(
          perimeterRadius(a.loop, center, x, y),
          perimeterRadius(b.loop, center, x, y),
          mix,
        ) + options.offset;
      const boundary = row === 0 || row === rows.length - 1;
      ray.origin.set(center.x + reach * x, center.y + reach * y, z);
      ray.direction.set(-x, -y, 0);
      let obstacle = 0;
      for (const mesh of obstacles) {
        if (z < mesh.boundingBox.min.z || z > mesh.boundingBox.max.z) continue;
        const hit = mesh.boundsTree.raycastFirst(ray, T.DoubleSide);
        if (hit) obstacle = Math.max(obstacle, reach - hit.distance + 0.2);
      }
      const nearest = Math.min(
        ...anchorAngles.map((anchor) =>
          Math.abs(
            Math.atan2(Math.sin(angle - anchor), Math.cos(angle - anchor)),
          ),
        ),
      );
      const height = (z - bottom) / (top - bottom);
      const angleFromPhase = angle - phase;
      const edgeFade = Math.min(1, 8 * height, 8 * (1 - height));
      let compressed = 0;
      // Straight ridge centerlines in the unrolled membrane coordinates.
      for (const [azimuth, level, lean, width] of [
        [0.3, 0.28, 1.55, 0.42],
        [2.45, 0.66, -1.1, 0.55],
        [4.75, 0.46, 0.8, 0.36],
      ]) {
        const dz = height - level;
        const direction = angleFromPhase - azimuth - lean * dz;
        const across = Math.atan2(Math.sin(direction), Math.cos(direction));
        const lengthFade = Math.min(
          1,
          Math.max(0, (0.26 - Math.abs(dz)) / 0.1),
        );
        const ridge = Math.max(0, 1 - Math.abs(across) / width);
        const valley = Math.max(
          0,
          1 - Math.abs(across + width * 0.48) / (width * 0.65),
        );
        const wrinkle = Math.max(
          0,
          1 - Math.abs(across - width * 0.62) / (width * 0.2),
        );
        compressed +=
          lengthFade *
          (1.1 * ridge -
            0.65 * valley +
            ((0.3 * options.wrinkles) / 100) * wrinkle);
      }
      // A trapezoidal section gives each story a broad face and two sloping returns.
      const bay = Math.max(0, upper - 1);
      const bayHeight = T.MathUtils.clamp(v, 0, 1);
      const shoulderShift = 0.12 * Math.cos(angleFromPhase + bay * 1.7);
      const shoulder = Math.max(
        0,
        Math.min(
          1,
          bayHeight / (0.3 + shoulderShift),
          (1 - bayHeight) / (0.23 - shoulderShift),
        ),
      );
      const lobe = 0.65 + 0.35 * Math.cos(2 * angleFromPhase - bay * 1.45);
      const storyProfile = a === b && floors.length > 1 ? 0 : shoulder * lobe;
      const folds =
        edgeFade *
        options.fold *
        (storyProfile + ((1.8 * options.compression) / 100) * compressed);
      const atPlate = floors.some((floor) => floor.z === z);
      minimum[id] = Math.max(0.05, obstacle, atPlate ? plate : 0);
      target[id] = Math.max(minimum[id], plate + folds);
      const atAnchor =
        nearest <= Math.PI / columns &&
        Math.abs(v - options.anchorHeight / 100) <=
          ((0.5 / (rows.length - 1)) * (top - bottom)) / span;
      pins[id] = boundary ? 1 : atAnchor ? options.anchorStrength / 100 : 0;
      pinTarget[id] = Math.max(minimum[id], plate);
      if (atAnchor) anchors.push(id);
    }
  });

  // Radial spring relaxation, with a wider stencil for bending resistance.
  let radius = target.slice(),
    next = target.slice();
  const spring = options.tension / 160;
  const bend = options.bending / 350;
  for (let pass = 0; pass < 32; pass++) {
    for (let row = 0; row < rows.length; row++) {
      for (let column = 0; column < columns; column++) {
        const id = row * columns + column;
        const at = (dr, dc) =>
          radius[
            Math.max(0, Math.min(rows.length - 1, row + dr)) * columns +
              ((column + dc + columns) % columns)
          ];
        const average = (at(0, -1) + at(0, 1) + at(-1, 0) + at(1, 0)) / 4;
        const wide = (at(0, -2) + at(0, 2) + at(-2, 0) + at(2, 0)) / 4;
        next[id] = Math.max(
          minimum[id],
          T.MathUtils.lerp(
            (1 - spring - bend) * target[id] + spring * average + bend * wide,
            pinTarget[id],
            pins[id],
          ),
        );
      }
    }
    [radius, next] = [next, radius];
  }
  const positions = new Float64Array(size * 3);
  const indices = [];
  rows.forEach((z, row) => {
    for (let column = 0; column < columns; column++) {
      const angle = (column * Math.PI * 2) / columns;
      const id = row * columns + column;
      positions.set(
        [
          center.x + radius[id] * Math.cos(angle),
          center.y + radius[id] * Math.sin(angle),
          z,
        ],
        id * 3,
      );
      if (row === rows.length - 1) continue;
      const right = row * columns + ((column + 1) % columns);
      indices.push(
        id,
        right,
        id + columns,
        right,
        right + columns,
        id + columns,
      );
    }
  });
  return {
    positions,
    center: [center.x, center.y],
    indices: Uint32Array.from(indices),
    columns,
    rows: rows.length,
    anchors,
  };
}

const panelFields = [
  ["minWidth", "Minimum width (ft)", 9, 0.1, 100],
  ["maxWidth", "Maximum width (ft)", 80, 0.1, 200],
  ["minHeight", "Minimum height (ft)", 7, 0.1, 100],
  ["maxHeight", "Maximum height (ft)", 60, 0.1, 200],
  ["deviation", "Maximum membrane deviation (in)", 16, 0.01, 60],
  ["curvature", "Maximum source curvature (degrees)", 42, 1, 90],
  ["pinchAngle", "Pinch sensitivity threshold (degrees)", 12, 1, 90],
  ["calmFit", "Broad fold fit allowance (×)", 4, 1, 12],
  ["span", "Panel subdivision (maximum mesh cells)", 192, 1, 192],
  ["gap", "Panel gap (in)", 0.5, 0, 6],
  ["thickness", "Panel thickness (in)", 0.08, 0.01, 3],
  ["returns", "Folded return depth (in)", 1.5, 0, 24],
];

export function addFacadeGeometry(r, doc, raw, panels, settings) {
  function addMesh(name, populate) {
    const mesh = new r.Mesh();
    const attributes = new r.ObjectAttributes();
    try {
      attributes.name = name;
      mesh.vertices().useDoublePrecisionVertices = true;
      populate(mesh.vertices(), mesh.faces());
      mesh.normals().computeNormals();
      doc.objects().addMesh(mesh, attributes);
    } finally {
      attributes.delete();
      mesh.delete();
    }
  }

  if (!panels) {
    addMesh("Membrane", (vertices, faces) => {
      const { rows, columns } = raw;
      for (let i = 0; i < raw.positions.length; i += 3)
        vertices.addPoint3d(...raw.positions.subarray(i, i + 3));
      for (let row = 0; row < rows - 1; row++)
        for (let col = 0; col < columns; col++) {
          const a = row * columns + col;
          const b = row * columns + ((col + 1) % columns);
          faces.addQuadFace(a, b, b + columns, a + columns);
        }
    });
    return;
  }

  function addFaces(name, polygons) {
    if (!polygons.length) return;
    addMesh(name, (vertices, faces) => {
      const ids = new Map();
      for (const polygon of polygons) {
        const face = polygon.map((point) => {
          const key = point.toArray().join(",");
          if (!ids.has(key))
            ids.set(key, vertices.addPoint3d(point.x, point.y, point.z));
          return ids.get(key);
        });
        if (face.length === 4) faces.addQuadFace(...face);
        else faces.addTriFace(...face);
      }
    });
  }

  function addPolyline(name, points) {
    const attributes = new r.ObjectAttributes();
    try {
      attributes.name = name;
      doc.objects().addPolyline(
        points.map((point) => point.toArray()),
        attributes,
      );
    } finally {
      attributes.delete();
    }
  }

  for (const panel of panels) {
    const { faces, flanges, rail } = panelParts(
      panel,
      settings.thickness,
      settings.returns,
    );
    addFaces(panel.id, faces);
    addFaces(panel.id + "_returns", flanges);
    addPolyline(panel.id + "_boundary", [...panel.vertices, panel.vertices[0]]);
    addPolyline(panel.id + "_support_rail", [...rail, rail[0]]);
    if (settings.attachments)
      rail.forEach((point, i) =>
        addPolyline(panel.id + "_attachment_" + (i + 1), [
          point,
          panel.vertices[i],
        ]),
      );
  }
}

export function initFacade(pane, readFloors, rhino) {
  pane.innerHTML = `<div class="voro-layout"><section class="panel" data-frame-count="1">
    <div class="panel-heading">PERSPECTIVE <small>01 / FOIL MEMBRANE</small></div>
    <div class="canvas-tools"><button id="fFit">FIT</button><button id="fWire" aria-pressed="false">WIRE</button><button id="fAnchors" aria-pressed="false">ANCHORS</button></div>
    <div class="canvas-tools"><label>View<select id="fPanelView"><option value="membrane">Mesh only</option><option value="foil" selected>Rendered foil</option><option value="panels">Panels only</option><option value="foil-panels">Rendered foil panels</option><option value="wire">Panel wireframe</option><option value="exploded">Exploded view</option><option value="construction">Construction view</option></select></label></div>
    <div id="fCanvas" class="voro-canvas"></div></section><aside>
    <section class="panel" data-frame-count="2"><div class="panel-heading">FACADE DESIGN</div>
    <div class="voro-controls">
    <button id="fBuild" class="primary">BUILD FROM VORONOI FLOORS</button>${controls
      .map(
        ([id, label, value, min, max]) =>
          `<label>${label} <output id="fo_${id}">${value}</output><input id="f_${id}" type="range" value="${value}" min="${min}" max="${max}"></label>`,
      )
      .join("")}
    <details><summary>PANELIZATION</summary>
    <label>Panel mode<select id="fPanelMode"><option value="quad">Quadrilateral</option><option value="tri">Triangular</option><option value="hybrid" selected>Hybrid</option></select></label>
    <label>Resolution preset<select id="fPanelPreset"><option value="60">Low resolution</option><option value="100">Medium resolution</option><option value="170">High resolution</option><option value="custom">Custom</option></select></label>
    <label>Panel density<input id="fPanelDensity" type="range" min="50" max="200" value="60"></label>
    ${panelFields.map(([id, label, value, min, max]) => `<label>${label}<input id="fp_${id}" type="number" value="${value}" min="${min}" max="${max}" step="${id === "span" ? "1" : "any"}" required></label>`).join("")}
    <label class="check"><input id="fAdaptive" type="checkbox" checked> Adaptive sizing</label>
    <label class="check"><input id="fPanelEdges" type="checkbox" checked> Show panel boundaries</label>
    <label class="check"><input id="fAttachments" type="checkbox"> Concealed attachments</label>
    <button id="fGeneratePanels" disabled>GENERATE PANELS</button>
    <p id="fPanelStatus" class="note" role="status"></p></details>
    <button id="fExport" disabled>EXPORT RHINO .3DM</button></div></section></aside></div>
    <div id="fStatus" class="status-bar" role="status">Import floor curves in Voronoi Balloons to begin.</div>`;
  addTechnicalFrames(pane);
  const $ = (id) => pane.querySelector("#" + id);
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(42, 1, 0.1, 100000);
  camera.up.set(0, 0, 1);
  let renderer,
    orbit,
    raw,
    mesh,
    markers,
    timer,
    obstacles = [],
    floors = [];
  let wire = false;
  const material = new T.MeshPhysicalMaterial({
    color: 0xc0c8d5,
    metalness: 0.76,
    roughness: 0.24,
    side: T.DoubleSide,
    clearcoat: 0.45,
  });
  scene.add(new T.HemisphereLight(0xe7f2ff, 0x607185, 2.2));
  for (const [x, y, z, intensity] of [
    [2, -4, 6, 5],
    [-4, 2, 3, 3],
    [1, 5, 2, 4],
  ]) {
    const light = new T.DirectionalLight(0xf3f7ff, intensity);
    light.position.set(x, y, z);
    scene.add(light);
  }
  const foilMaterial = new T.MeshPhysicalMaterial({
    color: 0xe1e1e1,
    metalness: 1,
    roughness: 0.16,
    envMapIntensity: 1.6,
    side: T.DoubleSide,
  });
  scene.background = new T.Color(0x000000);
  const isMembraneView = () =>
    ["membrane", "foil"].includes($("fPanelView").value);
  const panelGroup = new T.Group();
  scene.add(panelGroup);
  const edgeMaterial = new T.LineBasicMaterial({ color: 0x647381 });
  const railMaterial = new T.LineBasicMaterial({ color: 0xe3b66c });
  let panelResult, panelSettings;
  function refreshPanelView() {
    const view = $("fPanelView").value;
    const foil = view === "foil" || view === "foil-panels";
    $("fWire").disabled = foil;
    $("fAnchors").disabled = foil;
    if (mesh) {
      mesh.visible = isMembraneView() || !panelResult;
      mesh.material = foil ? foilMaterial : material;
    }
    if (markers)
      markers.visible =
        !foil &&
        mesh?.visible &&
        $("fAnchors").getAttribute("aria-pressed") === "true";
    for (const child of [...panelGroup.children]) {
      child.geometry.dispose();
      panelGroup.remove(child);
    }
    if (!panelResult || isMembraneView()) {
      render();
      return;
    }
    const triangles = [],
      edges = [],
      supports = [];
    const segment = (buffer, a, b, offset) =>
      buffer.push(
        ...a.clone().add(offset).toArray(),
        ...b.clone().add(offset).toArray(),
      );
    for (const panel of panelResult.panels) {
      const offset = panel.normal
        .clone()
        .multiplyScalar(view === "exploded" ? 1.5 : 0);
      const { faces, flanges, rail } = panelParts(
        panel,
        panelSettings.thickness,
        panelSettings.returns,
      );
      if (view !== "wire") {
        for (const face of [
          ...faces,
          ...(view === "construction" || view === "exploded" ? flanges : []),
        ])
          for (let i = 1; i < face.length - 1; i++)
            for (const p of [face[0], face[i], face[i + 1]])
              triangles.push(...p.clone().add(offset).toArray());
      }
      panel.vertices.forEach((point, i) => {
        const next = (i + 1) % panel.vertices.length;
        if (view === "wire" || $("fPanelEdges").checked)
          segment(edges, point, panel.vertices[next], offset);
        if (view === "construction") {
          segment(supports, rail[i], rail[next], offset);
          if (panelSettings.attachments)
            segment(supports, rail[i], point, offset);
        }
      });
    }
    for (const [vertices, style, isSurface] of [
      [triangles, foil ? foilMaterial : material, true],
      [edges, edgeMaterial, false],
      [supports, railMaterial, false],
    ]) {
      if (!vertices.length) continue;
      const g = new T.BufferGeometry().setAttribute(
        "position",
        new T.Float32BufferAttribute(vertices, 3),
      );
      if (isSurface) g.computeVertexNormals();
      panelGroup.add(
        isSurface ? new T.Mesh(g, style) : new T.LineSegments(g, style),
      );
    }
    render();
  }
  function generatePanels() {
    if (!raw) return;
    for (const [id] of panelFields) if (!$("fp_" + id).reportValidity()) return;
    const values = Object.fromEntries(
      panelFields.map(([id]) => [id, Number($("fp_" + id).value)]),
    );
    if (
      values.minWidth > values.maxWidth ||
      values.minHeight > values.maxHeight
    ) {
      $("fPanelStatus").textContent =
        "Minimum dimensions must be at or below the maximum dimensions.";
      return;
    }
    panelSettings = {
      ...values,
      mode: $("fPanelMode").value,
      adaptive: $("fAdaptive").checked,
      pinchAngle: T.MathUtils.degToRad(values.pinchAngle),
      calmFit: values.calmFit,
      attachments: $("fAttachments").checked,
      density: Number($("fPanelDensity").value) / 100,
      curvature: T.MathUtils.degToRad(values.curvature),
      deviation: values.deviation / 12,
      gap: values.gap / 12,
      thickness: values.thickness / 12,
      returns: values.returns / 12,
    };
    panelResult = planarPanels(raw, panelSettings);
    $("fGeneratePanels").textContent = "REGENERATE PANELS";
    const { panels, exceptions, omitted, deviation } = panelResult;
    $("fPanelStatus").textContent =
      panels.length +
      " planar panels · " +
      (deviation * 12).toFixed(2) +
      " in maximum sampled fit deviation · " +
      exceptions +
      " outside targets · " +
      omitted +
      " unresolved";
    refreshPanelView();
  }
  $("fGeneratePanels").onclick = () => {
    if (isMembraneView()) $("fPanelView").value = "panels";
    generatePanels();
  };
  $("fPanelView").onchange = () => {
    if (!panelResult && !isMembraneView()) generatePanels();
    else refreshPanelView();
  };
  $("fPanelEdges").onchange = refreshPanelView;
  $("fPanelPreset").onchange = () => {
    const preset = $("fPanelPreset").value;
    if (preset === "custom") return;
    $("fPanelDensity").value = preset;
    if (panelResult) generatePanels();
  };
  $("fPanelDensity").onchange = () => {
    const density = $("fPanelDensity").value;
    $("fPanelPreset").value = ["60", "100", "170"].includes(density)
      ? density
      : "custom";
    if (panelResult) generatePanels();
  };
  for (const id of [
    "fPanelMode",
    "fAdaptive",
    "fAttachments",
    ...panelFields.map(([id]) => "fp_" + id),
  ])
    $(id).onchange = () => {
      if (panelResult) generatePanels();
    };
  function render() {
    if (pane.hidden || !renderer) return;
    renderer.render(scene, camera);
  }
  function resize() {
    if (pane.hidden || !renderer) return;
    const canvas = $("fCanvas");
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    camera.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    camera.updateProjectionMatrix();
    render();
  }
  function fit() {
    if (!mesh) return;
    const bounds = new T.Box3().setFromObject(mesh);
    const span = bounds.getSize(new T.Vector3()).length();
    bounds.getCenter(orbit.target);
    camera.position
      .copy(orbit.target)
      .add(new T.Vector3(0.9, -1.2, 0.55).multiplyScalar(span));
    orbit.update();
    render();
  }
  function rebuild(resetView = false) {
    const settings = Object.fromEntries(
      controls.map(([id]) => [id, Number($("f_" + id).value)]),
    );
    raw = foilMesh(floors, settings, obstacles);
    if (mesh) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    if (markers) {
      markers.removeFromParent();
      markers.geometry.dispose();
      markers.material.dispose();
    }
    const surface = geometry(raw);
    const shaded = toCreasedNormals(
      surface,
      T.MathUtils.degToRad(28 + settings.bending * 0.45),
    );
    if (shaded !== surface) surface.dispose();
    mesh = new T.Mesh(shaded, material);
    const points = raw.anchors.flatMap((id) =>
      Array.from(raw.positions.subarray(id * 3, id * 3 + 3)),
    );
    markers = new T.Points(
      new T.BufferGeometry().setAttribute(
        "position",
        new T.Float32BufferAttribute(points, 3),
      ),
      new T.PointsMaterial({
        color: 0xdc24f4,
        size: 7,
        sizeAttenuation: false,
        depthTest: false,
      }),
    );
    markers.visible = $("fAnchors").getAttribute("aria-pressed") === "true";
    scene.add(mesh, markers);
    $("fGeneratePanels").disabled = false;
    if (panelResult) generatePanels();
    else refreshPanelView();
    if (resetView) fit();
    render();
    $("fExport").disabled = false;
    $("fStatus").textContent =
      floors.length +
      " floor(s) · " +
      raw.columns * (raw.rows - 1) +
      " membrane quads";
  }
  $("fBuild").onclick = () => {
    try {
      const source = readFloors();
      if (!source.length)
        throw Error("Import floor curves in Voronoi Balloons first.");
      floors = source;
      obstacles.forEach((g) => g.dispose());
      obstacles = source.flatMap(({ raw }) => {
        if (!raw?.indices.length) return [];
        const g = geometry(raw);
        g.computeBoundingBox();
        g.boundsTree = new MeshBVH(g, { indirect: true });
        return [g];
      });
      rebuild(true);
    } catch (error) {
      $("fStatus").textContent = error.message;
    }
  };
  for (const [id] of controls) {
    $("f_" + id).oninput = (event) => {
      $("fo_" + id).value = event.target.value;
    };
    $("f_" + id).onchange = () => {
      if (!floors.length) return;
      clearTimeout(timer);
      timer = setTimeout(() => rebuild(), 0);
    };
  }
  $("fFit").onclick = fit;
  $("fWire").onclick = () => {
    wire = !wire;
    material.wireframe = wire;
    $("fWire").setAttribute("aria-pressed", wire);
    render();
  };
  $("fAnchors").onclick = () => {
    const visible = $("fAnchors").getAttribute("aria-pressed") !== "true";
    $("fAnchors").setAttribute("aria-pressed", visible);
    if (markers) markers.visible = visible;
    render();
  };
  $("fExport").onclick = async () => {
    if (!raw) return;
    const membrane = raw;
    const panels = !isMembraneView() ? panelResult?.panels : null;
    const settings = panelSettings;
    try {
      const r = await rhino();
      const doc = new r.File3dm();
      try {
        doc.settings().modelUnitSystem = r.UnitSystem.Feet;
        addFacadeGeometry(r, doc, membrane, panels, settings);
        const url = URL.createObjectURL(new Blob([doc.toByteArray()]));
        const link = document.createElement("a");
        link.href = url;
        link.download = "foil-facade.3dm";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } finally {
        doc.delete();
      }
    } catch (error) {
      $("fStatus").textContent = error.message;
    }
  };
  return () => {
    if (!renderer) {
      renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      const room = new RoomEnvironment();
      const pmrem = new T.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(room, 0.04).texture;
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
