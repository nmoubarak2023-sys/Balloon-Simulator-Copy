import { initColumns } from "./column-ui.js";
import { mountGeometryLibrary, canvasThumbnail } from "./geometry-library.js";
import { quadObj, quadMesh } from "./quad-mesh.js";
import { addTechnicalFrames } from "./frames.js";
import { createVoronoiEditing } from "./voronoi-editing.js";
import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { geometry, rawGeometry, quadWire } from "./view.js";
import { addRhinoQuadMesh } from "./rhino-io.js";
export function initVoronoi(workerFactory, rhino, useAsBoundary, party) {
  const existing = document.querySelector("main"),
    pane = document.createElement("main");
  pane.id = "voronoiWorkspace";
  pane.hidden = true;
  const nav = document.createElement("nav");
  nav.className = "simulation-tabs";
  nav.setAttribute("aria-label", "Simulation workspaces");
  nav.innerHTML =
    '<button aria-pressed="true">VORONOI BALLOONS</button><button aria-pressed="false">COLUMN POPulate</button><button aria-pressed="false">BALLOON BUILD</button><button aria-pressed="false">BALLOON PARTY</button>';
  existing.before(nav);
  existing.after(pane);
  const fields = [
    ["count", "Seed point count", 40, 1, 150, 1],
    ["seed", "Point seed", 42, 0, 9999, 1],
    ["index", "Anchor point index (0 based)", 0, 0, 39, 1],
    ["selected", "Nearest points selected", 17, 1, 40, 1],
    ["radiusMin", "Radius min (ft)", 15, 1, 60, 0.5],
    ["radiusMax", "Radius max (ft)", 25, 1, 80, 0.5],
    ["radiusSeed", "Radius seed", 17, 0, 9999, 1],
    ["floor", "Floor plane Z (ft)", 0, -20, 20, 0.5],
    ["spacing", "Mesh spacing (ft)", 2, 0.5, 10, 0.5],
    ["smoothing", "Valley smoothing passes", 4, 0, 20, 1],
  ];
  pane.innerHTML = `<div class="voro-layout"><section class="panel"><div class="panel-heading"><span>PERSPECTIVE <small>01 / VORONOI BALLOONS</small></span><button id="vFit">FIT ↗</button></div><div class="canvas-tools"><button id="vRoof" aria-pressed="true">ENCLOSURE</button><button id="vSpheres" aria-pressed="false">BALLOONS</button><button id="vPickAnchor" aria-pressed="false">PICK ANCHOR CENTER</button><button id="vWire" aria-pressed="false">WIRE</button></div><div id="vPerspective" class="voro-canvas"></div><div class="viewer-footer">ROOF / FLAT FLOOR / PERIMETER ONLY</div></section><aside><section class="panel"><div class="panel-heading">PLAN VIEW <small>02 / CELLS & SELECTED SEEDS</small></div><div id="vPlan" class="voro-plan"></div></section><section class="panel"><div class="panel-heading">CONTROL PANEL <small>03 / INDEPENDENT SIMULATION</small></div><div class="voro-controls"><label>Boundary rectangle (ft)<select id="vSize"><option value="160">160 × 100</option><option value="80" selected>80 × 50</option><option value="40">40 × 25</option></select></label>${fields.map(([id, label, value, min, max, step]) => `<div class="control"><label for="v_${id}">${label}</label><input id="vn_${id}" type="number" value="${value}" min="${min}" max="${max}" step="${step}" aria-label="${label}"><input id="v_${id}" type="range" value="${value}" min="${min}" max="${max}" step="${step}"></div>`).join("")}<button id="vGenerate" class="primary">GENERATE ENCLOSURE ↗</button><p class="note">Nearest-point selection retains original Voronoi cells. The roof uses the highest edited balloon surface; smoothing changes interior heights only. Disconnected footprints remain separate and are reported.</p><div class="pair"><button id="vObj">EXPORT .OBJ</button><button id="v3dm">EXPORT .3DM</button></div><button id="vUseBoundary" class="primary">USE AS BALLOON BUILD CONTAINER ↗</button><p class="note">Copies the current closed enclosure into Balloon Build and generates a new balloon field inside it. Voronoi settings stay independent. Use Balloon Build Undo to return to its previous model. Dimensions remain in feet.</p><button id="vSave">SAVE SETTINGS & DATA</button><label class="button" for="vLoad">OPEN VORONOI PROJECT</label><input hidden id="vLoad" type="file" accept=".json"><pre id="vReport" class="iteration-report">Generate an enclosure to check its mesh.</pre></div></section></aside></div><div class="status-bar" id="vStatus" role="status">Ready to generate.</div>`;
  const stages = [
    "Boundary",
    "Seed points",
    "Voronoi cells",
    "Nearest cluster",
    "Rectangle-clipped balloons",
    "Floor-clipped balloons",
    "United floor footprint",
    "Smooth enclosure",
  ];
  const stepbar = document.createElement("div");
  stepbar.className = "voro-steps";
  stepbar.innerHTML =
    '<button id="vPrevious">← BACK</button><select id="vStage" aria-label="Construction step">' +
    stages
      .map(
        (name, i) =>
          '<option value="' + i + '">' + (i + 1) + ". " + name + "</option>",
      )
      .join("") +
    '</select><button id="vNext">NEXT →</button><button id="vPlay">PLAY STEPS</button><p id="vStepDescription" class="note"></p>';
  pane.querySelector(".canvas-tools").after(stepbar);
  let anchorDown;
  let stage = 0,
    timer;
  const $ = (id) => pane.querySelector("#" + id);
  let editing;
  let worker,
    result,
    pending = false,
    mode = "roof",
    wire = false,
    fitNext = true;
  const scene = new T.Scene(),
    group = new T.Group();
  scene.add(group, new T.AmbientLight(0xaff6ff, 2));
  const light = new T.DirectionalLight(0xaff6ff, 3);
  light.position.set(80, -80, 140);
  scene.add(light);
  const camera = new T.PerspectiveCamera(38, 1, 0.01, 10000);
  camera.up.set(0, 0, 1);
  const plan = new T.OrthographicCamera(-50, 50, 35, -35, 0.01, 10000);
  plan.up.set(0, 1, 0);
  const renderers = ["vPerspective", "vPlan"].map((id) => {
    const r = new T.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setClearColor(0, 0);
    $(id).append(r.domElement);
    return r;
  });
  const orbit = new OrbitControls(camera, renderers[0].domElement);
  orbit.enableDamping = true;
  const diagram = new T.Scene();
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
      } else if (result) {
        const width = result.params.width,
          height = result.params.height,
          aspect = w / h;
        plan.left = -Math.max(width, height * aspect) * 0.58;
        plan.right = -plan.left;
        plan.top = plan.right / aspect;
        plan.bottom = -plan.top;
        plan.updateProjectionMatrix();
      }
    });
  }
  renderers.forEach((r) =>
    new ResizeObserver(resize).observe(r.domElement.parentElement),
  );
  function clear(g) {
    for (const child of [...g.children]) {
      g.remove(child);
      child.traverse((o) => {
        o.geometry?.dispose();
        if (o.material) o.material.dispose();
      });
    }
  }
  function fit() {
    if (!result) return;
    const { width: w, height: h } = result.params;
    orbit.target.set(w / 2, h / 2, 0);
    camera.position.set(w * 1.1, -w * 0.9, w * 0.9);
    camera.lookAt(orbit.target);
    plan.position.set(w / 2, h / 2, w * 3);
    plan.lookAt(w / 2, h / 2, 0);
    resize();
  }
  function draw() {
    clear(group);
    clear(diagram);
    if (!result) return;
    $("vPickAnchor").setAttribute("aria-pressed", stage >= 1 && stage <= 3);
    $("vRoof").setAttribute("aria-pressed", stage === 7);
    $("vSpheres").setAttribute("aria-pressed", stage === 4 || stage === 5);
    const balloonMeshes = [];
    if (stage === 7 || stage === 6) {
      const mat = new T.MeshPhysicalMaterial({
        color: 0x4e9fa9,
        roughness: 0.3,
        metalness: 0.2,
        side: T.DoubleSide,
        wireframe: false,
      });
      let raw = result.raw;
      if (stage === 6)
        raw = {
          positions: raw.positions,
          indices: Uint32Array.from(
            Array.from({ length: raw.indices.length / 3 }, (_, i) =>
              Array.from(raw.indices.slice(i * 3, i * 3 + 3)),
            )
              .filter((t) =>
                t.every(
                  (j) =>
                    Math.abs(raw.positions[j * 3 + 2] - result.params.floor) <
                    1e-8,
                ),
              )
              .flat(),
          ),
        };
      const g = geometry(raw),
        smooth = toCreasedNormals(g, Math.PI / 4);
      if (smooth !== g) g.dispose();
      const mesh = new T.Mesh(smooth, mat),
        lines = quadWire(raw);
      lines.visible = wire;
      mesh.add(lines);
      group.add(mesh);
    } else if (stage === 4 || stage === 5) {
      const { width: w, height: h, floor } = result.params;
      const planes = [
        new T.Plane(new T.Vector3(1, 0, 0), 0),
        new T.Plane(new T.Vector3(-1, 0, 0), w),
        new T.Plane(new T.Vector3(0, 1, 0), 0),
        new T.Plane(new T.Vector3(0, -1, 0), h),
        new T.Plane(new T.Vector3(0, 0, 1), -floor),
      ];
      renderers[0].localClippingEnabled = true;
      for (const s of result.spheres) {
        const mesh = new T.Mesh(
          s.raw ? geometry(s.raw) : new T.SphereGeometry(s.radius, 64, 40),
          new T.MeshPhysicalMaterial({
            color: 0x4e9fa9,
            roughness: 0.3,
            metalness: 0.2,
            transparent: true,
            opacity: 0.7,
            side: T.DoubleSide,
            wireframe: false,
            clippingPlanes: stage === 4 ? planes.slice(0, 4) : planes,
          }),
        );
        if (!s.raw) {
          mesh.position.set(...s.center);
          mesh.scale.fromArray(s.axisScale || [1, 1, 1]);
        }
        const lines = quadWire(s.raw || rawGeometry(mesh.geometry));
        lines.material.clippingPlanes =
          stage === 4 ? planes.slice(0, 4) : planes;
        lines.visible = wire;
        mesh.add(lines);
        mesh.userData.balloonId = s.id;
        balloonMeshes.push(mesh);
        group.add(mesh);
      }
    }
    const descriptions = [
      "Rectangle boundary on XY.",
      "Deterministic candidate centers inside the rectangle.",
      "Original Voronoi territories for every seed.",
      "Click a Voronoi center to set the anchor index and rebuild its nearest cluster. Drag empty space to orbit.",
      "One sphere per selected seed, clipped to the rectangle.",
      "Sphere preview split at the horizontal floor plane.",
      "Union of original sphere sections, filled as one floor footprint.",
      "Upper envelope of edited balloons, relaxed interior heights, flat bottom and perimeter closure.",
    ];
    $("vStage").value = stage;
    $("vStepDescription").textContent = descriptions[stage];
    $("vPrevious").disabled = stage === 0;
    $("vNext").disabled = stage === 7;
    const { width: w, height: h } = result.params;
    diagram.add(
      new T.LineLoop(
        new T.BufferGeometry().setFromPoints(
          [
            [0, 0],
            [w, 0],
            [w, h],
            [0, h],
          ].map((p) => new T.Vector3(...p, 0)),
        ),
        new T.LineBasicMaterial({ color: 0x21e0ed }),
      ),
    );
    const chosen = new Set(stage >= 3 ? result.ids : []);
    result.cells.forEach((cell, i) => {
      if (!cell.length) return;
      const line = new T.LineLoop(
        new T.BufferGeometry().setFromPoints(
          cell.map((p) => new T.Vector3(...p, 0)),
        ),
        new T.LineBasicMaterial({
          color: chosen.has(i) ? 0xdc24f4 : 0x21e0ed,
          transparent: true,
          opacity: chosen.has(i) ? 1 : 0.45,
        }),
      );
      if (stage >= 2) diagram.add(line);
      else {
        line.geometry.dispose();
        line.material.dispose();
      }
      const dot = new T.Mesh(
        new T.CircleGeometry(
          result.params.width * (i === result.params.index ? 0.01 : 0.006),
          16,
        ),
        new T.MeshBasicMaterial({
          side: T.DoubleSide,
          color:
            i === result.params.index
              ? 0xffffff
              : chosen.has(i)
                ? 0xdc24f4
                : 0x21e0ed,
        }),
      );
      dot.position.set(...result.points[i], 0.1);
      if (stage >= 1) diagram.add(dot);
      else {
        dot.geometry.dispose();
        dot.material.dispose();
      }
    });
    for (const loop of stage >= 6 ? result.loops : []) {
      const outline = new T.LineLoop(
        new T.BufferGeometry().setFromPoints(
          loop.map((p) => new T.Vector3(...p, 0.2)),
        ),
        new T.LineBasicMaterial({ color: 0xffffff }),
      );
      diagram.add(outline);
    }
    if (stage <= 3) {
      const overlay = diagram.clone(true);
      overlay.traverse((o) => {
        if (o.geometry) o.geometry = o.geometry.clone();
        if (o.material) o.material = o.material.clone();
      });
      group.add(overlay);
    }
    if (fitNext) {
      fit();
      fitNext = false;
    }
    editing?.update(balloonMeshes, pending);
  }
  function parameters() {
    const width = Number($("vSize").value);
    return {
      width,
      height: width * 0.625,
      ...Object.fromEntries(
        fields.map(([id]) => [id, Number($("vn_" + id).value)]),
      ),
      ...(editing?.settings() || {}),
    };
  }
  function generate() {
    if (pending) return;
    pending = true;
    editing?.setBusy(true);
    $("vStatus").textContent = "Building footprint, roof and flat floor…";
    $("vGenerate").disabled = true;
    worker ??= workerFactory();
    worker.onmessage = ({ data }) => {
      pending = false;
      $("vGenerate").disabled = false;
      if (data.error) {
        editing?.setBusy(false);
        $("vStatus").textContent = data.error;
        return;
      }
      result = data.result;
      draw();
      const q = result.quality;
      $("vReport").textContent = JSON.stringify(
        {
          connectedComponents: result.components,
          closed: result.closed,
          nakedEdges: q.boundaryEdges,
          nonManifoldEdges: q.nonManifoldEdges,
          degenerateFaces: q.degenerateFaces,
          quadFaces: quadMesh(result.raw).quads.length / 4,
          volumeCubicFeet: result.volume,
          selectedOriginalIndices: result.ids,
        },
        null,
        2,
      );
      $("vStatus").textContent =
        result.closed && result.components === 1
          ? "One connected closed enclosure · 0 naked edges · 0 non-manifold edges"
          : `${result.components} component(s) · ${q.boundaryEdges} naked edges · ${q.nonManifoldEdges} non-manifold edges. Review the mesh report.`;
      if (JSON.stringify(parameters()) !== JSON.stringify(result.params))
        generate();
    };
    worker.onerror = (e) => {
      editing?.setBusy(false);
      pending = false;
      $("vGenerate").disabled = false;
      $("vStatus").textContent = e.message;
    };
    worker.postMessage({ id: 1, action: "voronoi", params: parameters() });
  }
  // Capture center clicks before balloon/curve editing, while leaving orbit drags alone.
  const anchorCanvas = renderers[0].domElement;
  function centerAt(e) {
    if (!result || pending || stage < 1 || stage > 3) return null;
    const rect = anchorCanvas.getBoundingClientRect();
    camera.updateMatrixWorld();
    let nearest = null,
      distance = 16;
    result.points.forEach(([x, y], index) => {
      const p = new T.Vector3(x, y, 0.1).project(camera);
      if (p.z < -1 || p.z > 1) return;
      const d = Math.hypot(
        e.clientX - rect.left - ((p.x + 1) * rect.width) / 2,
        e.clientY - rect.top - ((1 - p.y) * rect.height) / 2,
      );
      if (d < distance) {
        nearest = index;
        distance = d;
      }
    });
    return nearest;
  }
  anchorCanvas.addEventListener(
    "pointerdown",
    (e) => {
      anchorDown = null;
      if (e.button !== 0) return;
      const index = centerAt(e);
      if (index === null) return;
      anchorDown = { index, x: e.clientX, y: e.clientY };
      e.stopImmediatePropagation();
    },
    true,
  );
  anchorCanvas.addEventListener(
    "pointerup",
    (e) => {
      const down = anchorDown;
      anchorDown = null;
      if (!down) return;
      e.stopImmediatePropagation();
      if (
        pending ||
        Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 ||
        centerAt(e) !== down.index
      )
        return;
      $("v_index").value = $("vn_index").value = down.index;
      stage = 3;
      draw();
      generate();
    },
    true,
  );
  anchorCanvas.addEventListener(
    "pointercancel",
    () => {
      anchorDown = null;
    },
    true,
  );
  $("vPickAnchor").onclick = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
      $("vPlay").textContent = "PLAY STEPS";
    }
    stage = 3;
    draw();
    $("vStatus").textContent =
      "Click a Voronoi center in the perspective view to set its anchor index. The white center is the current anchor.";
  };
  fields.forEach(([id]) => {
    const range = $("v_" + id),
      number = $("vn_" + id);
    range.oninput = () => {
      number.value = range.value;
    };
    number.oninput = () => {
      range.value = number.value;
    };
    for (const input of [range, number])
      input.onchange = () => {
        if (id === "count") {
          const n = Number(number.value);
          for (const name of ["index", "selected"])
            for (const prefix of ["v_", "vn_"]) {
              const el = $(prefix + name);
              el.max = name === "index" ? n - 1 : n;
              el.value = Math.min(Number(el.value), Number(el.max));
            }
        }
        generate();
      };
  });
  $("vSize").onchange = () => {
    fitNext = true;
    generate();
  };
  $("vGenerate").onclick = generate;
  $("vFit").onclick = fit;
  $("vRoof").onclick = () => {
    stage = 7;
    mode = "roof";
    $("vRoof").setAttribute("aria-pressed", true);
    $("vSpheres").setAttribute("aria-pressed", false);
    draw();
  };
  $("vSpheres").onclick = () => {
    stage = 4;
    mode = "spheres";
    $("vRoof").setAttribute("aria-pressed", false);
    $("vSpheres").setAttribute("aria-pressed", true);
    draw();
  };
  $("vStage").onchange = () => {
    stage = Number($("vStage").value);
    draw();
  };
  $("vPrevious").onclick = () => {
    stage = Math.max(0, stage - 1);
    draw();
  };
  $("vNext").onclick = () => {
    stage = Math.min(7, stage + 1);
    draw();
  };
  $("vPlay").onclick = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
      $("vPlay").textContent = "PLAY STEPS";
      return;
    }
    stage = 0;
    draw();
    $("vPlay").textContent = "PAUSE";
    timer = setInterval(() => {
      if (pane.hidden) return;
      if (stage === 7) {
        clearInterval(timer);
        timer = null;
        $("vPlay").textContent = "PLAY STEPS";
        return;
      }
      stage++;
      draw();
    }, 1800);
  };
  $("vWire").onclick = () => {
    wire = !wire;
    $("vWire").setAttribute("aria-pressed", wire);
    draw();
  };
  const download = (data, name) => {
    const url = URL.createObjectURL(new Blob([data]));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  function accepted() {
    if (!result) throw Error("Generate an enclosure first.");
    const signature = (p) => {
      const q = { ...p };
      if (!q.pressureEnabled) {
        delete q.curves;
        delete q.strength;
        delete q.influence;
      }
      return JSON.stringify(q);
    };
    if (signature(parameters()) !== signature(result.params))
      throw Error("Controls changed. Generate again before exporting.");
    return result;
  }
  const guarded = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      $("vStatus").textContent = e.message;
    }
  };
  $("vObj").onclick = guarded(() => {
    const { raw } = accepted();
    const text = quadObj(raw, "VoronoiBalloons").text;
    download(text, "voronoi-balloons.obj");
  });
  $("v3dm").onclick = guarded(async () => {
    const r = await rhino(),
      doc = new r.File3dm();
    try {
      doc.settings().modelUnitSystem = r.UnitSystem.Feet;
      addRhinoQuadMesh(r, doc, accepted().raw, "Voronoi Balloons / enclosure");
      download(doc.toByteArray(), "voronoi-balloons.3dm");
    } finally {
      doc.delete();
    }
  });
  $("vUseBoundary").onclick = guarded(async () => {
    if (pending)
      throw Error("Wait for the Voronoi enclosure to finish building.");
    const enclosure = accepted();
    if (!enclosure.closed)
      throw Error(
        "The Voronoi enclosure must be closed before it can be used as a container. Review the mesh report.",
      );
    const button = $("vUseBoundary");
    button.disabled = true;
    try {
      // Copy rather than sharing geometry with either workspace's mutable state.
      const raw = {
        positions: new Float64Array(enclosure.raw.positions),
        indices: new Uint32Array(enclosure.raw.indices),
      };
      await useAsBoundary(raw, () => nav.children[2].click());
      $("vStatus").textContent =
        "Enclosure copied to Balloon Build. This Voronoi project is unchanged.";
    } finally {
      button.disabled = false;
    }
  });
  $("vSave").onclick = guarded(() =>
    download(
      JSON.stringify(
        {
          format: "voronoi-balloons",
          version: 2,
          ...accepted(),
          editing: editing?.save(),
        },
        (_, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v),
      ),
      "voronoi-balloons.json",
    ),
  );
  $("vLoad").onchange = guarded(async () => {
    const file = $("vLoad").files[0];
    if (!file) return;
    const data = JSON.parse(await file.text());
    if (data.format !== "voronoi-balloons")
      throw Error("Open a Voronoi Balloons project.");
    editing?.load(data.editing);
    $("vSize").value = data.params.width;
    for (const [id] of fields) {
      $("vn_" + id).value = data.params[id];
      $("v_" + id).value = data.params[id];
    }
    fitNext = true;
    generate();
  });
  mountGeometryLibrary({
    workspace: "voronoi",
    container: pane.querySelector(".voro-controls"),
    save: () => {
      if (pending) throw Error("Wait for generation to finish before saving.");
      return {
        format: "saved-voronoi-geometry",
        result: accepted(),
        editing: editing.save(),
        stage,
        wire,
        report: $("vReport").textContent,
      };
    },
    load: (data) => {
      if (pending) throw Error("Wait for generation to finish before loading.");
      if (data.format !== "saved-voronoi-geometry" || !data.result?.raw)
        throw Error("Invalid saved Voronoi geometry.");
      if (timer) {
        clearInterval(timer);
        timer = null;
        $("vPlay").textContent = "PLAY STEPS";
      }
      result = structuredClone(data.result);
      $("vSize").value = result.params.width;
      for (const prefix of ["v_", "vn_"]) {
        $(prefix + "index").max = result.params.count - 1;
        $(prefix + "selected").max = result.params.count;
      }
      for (const [id] of fields) {
        $("vn_" + id).value = result.params[id];
        $("v_" + id).value = result.params[id];
      }
      stage = Math.max(0, Math.min(7, data.stage ?? 7));
      wire = !!data.wire;
      $("vWire").setAttribute("aria-pressed", wire);
      editing.load(data.editing);
      fitNext = true;
      draw();
      $("vReport").textContent = data.report;
      $("vStatus").textContent =
        "Saved Voronoi geometry restored without regenerating.";
    },
    thumbnail: () => canvasThumbnail(renderers[0], scene, camera),
  });
  const columns = initColumns(rhino, accepted);
  [...nav.children].forEach(
    (button, i) =>
      (button.onclick = () => {
        existing.hidden = i !== 2;
        pane.hidden = i !== 0;
        party.pane.hidden = i !== 3;
        columns.pane.hidden = i !== 1;
        document.querySelector(".header-actions").hidden = i !== 2;
        [...nav.children].forEach((b, j) =>
          b.setAttribute("aria-pressed", i === j),
        );
        if (i === 3) party.show();
        if (i === 1) columns.show();
        if (i === 0) {
          resize();
          if (!result && !pending) generate();
        }
      }),
  );
  pane
    .querySelectorAll(".panel")
    .forEach((panel, i) => (panel.dataset.frameCount = i + 1));
  addTechnicalFrames(pane);
  editing = createVoronoiEditing({
    pane,
    existing,
    scene,
    camera,
    plan,
    renderers,
    orbit,
    getResult: () => result,
    rebuild: generate,
    showBalloons: () => {
      stage = 5;
      draw();
    },
    rhino,
  });
  function frame() {
    requestAnimationFrame(frame);
    if (pane.hidden) return;
    orbit.update();
    renderers[0].render(scene, camera);
    editing?.renderPerspective(renderers[0]);
    editing?.beforePlan();
    if (stage >= 4) {
      renderers[1].localClippingEnabled = true;
      renderers[1].render(scene, plan);
      renderers[1].autoClear = false;
      renderers[1].clearDepth();
    }
    renderers[1].render(diagram, plan);
    renderers[1].autoClear = true;
    editing?.renderPlan(renderers[1], plan);
    editing?.afterPlan();
  }
  frame();
  nav.children[0].click();
  return { showParty: () => nav.children[3].click() };
}
