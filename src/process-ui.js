import { captureVp8, encodeWebM, frameCount } from "./process-video.js";
import { createProcessCodec, validateBuildScript } from "./process-codec.js";
import {
  captureCamera,
  captureProcessView,
  createProcessViewer,
  applyCamera,
} from "./process-view.js";

export function initProcess(workspace) {
  const panel = document.createElement("details");
  panel.className = "process-panel";
  panel.dataset.processUi = "true";
  panel.innerHTML =
    '<summary>BUILD SCRIPT</summary><div class="process-tools"><label>PROJECT NAME<input id="prName" type="text" value="MY BUILDING"></label><button id="prRecord">START RECORDING</button><label>MILESTONE NAME<input id="prLabel" type="text" placeholder="E.G. ATRIUM VOIDS"></label><button id="prMilestone">ADD MILESTONE</button><button id="prDownload">DOWNLOAD BUILD SCRIPT</button><label class="button" for="prImport">OPEN BUILD SCRIPT</label><input id="prImport" type="file" accept=".json,.gz" hidden><button id="prOpen">OPEN REPLAY / EDIT PRESENTATION</button><output id="prStatus" role="status">RECORD FROM YOUR CURRENT BUILDING.</output></div>';
  document.querySelector(".simulation-tabs").after(panel);
  const dialog = document.createElement("dialog");
  dialog.className = "process-replay";
  dialog.dataset.processUi = "true";
  dialog.innerHTML =
    '<div class="process-replay-head"><strong>PROCESS REPLAY</strong><button id="prClose">CLOSE</button></div><div class="process-playback"><label>REPLAY MODE<select id="prMode"><option value="exact">EXACT REPLAY</option><option value="presentation">PRESENTATION REPLAY</option></select></label><button id="prPlay">PLAY</button><button id="prStop">STOP</button><button id="prPrevious">PREVIOUS</button><button id="prNext">NEXT</button><label>SPEED<select id="prSpeed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option></select></label><label>VIDEO RESOLUTION<select id="prResolution"><option value="1920">FULL HD · 1920 × 1080</option><option value="3840">4K UHD · 3840 × 2160</option></select></label><label>VIDEO FRAMING<select id="prFraming"><option value="saved">RECORDED / SAVED CAMERAS</option><option value="fit">FIT BUILDING · PRESENTATION</option></select></label><button id="prFit">FIT BUILDING</button><button id="prVideo">EXPORT ALL RECORDED STEPS · WEBM</button></div><div id="prCanvas" class="process-canvas"></div><div id="prCaption" class="process-caption"></div><div class="process-step-editor"><label>STEP<select id="prStep"></select></label><label>CAPTION<input id="prStepLabel" type="text"></label><label class="check"><input id="prInclude" type="checkbox"> INCLUDE IN PRESENTATION</label><label>SECONDS<input id="prDuration" type="number" min="0.2" max="120" step="0.2" value="3"></label><label>CAMERA<select id="prCameraMode"><option value="recorded">RECORDED VIEW</option><option value="saved">SAVED VIEW</option><option value="previous">KEEP PREVIOUS VIEW</option></select></label><label>SAVED CAMERA<select id="prCamera"></select></label><label>VIEW NAME<input id="prViewName" type="text" placeholder="E.G. ATRIUM SECTION"></label><button id="prSaveCamera">SAVE CAMERA VIEW</button><button id="prRestore">RESTORE STEP AS WORKING PROJECT</button><output id="prReplayStatus" role="status"></output></div>';
  document.body.append(dialog);
  const $ = (id) =>
    panel.querySelector("#" + id) ?? dialog.querySelector("#" + id);
  let codec = createProcessCodec(),
    steps = [],
    views = [],
    recording = false,
    capturing = false,
    pendingLabel,
    timer;
  let actionLog = [];
  let origin = Date.now(),
    selected = 0,
    viewer,
    playing = false,
    paused = false,
    cancelled = false;
  let restoring = false;
  const videoCanvas = document.createElement("canvas");
  videoCanvas.width = 1920;
  videoCanvas.height = 1080;
  videoCanvas.style.cssText =
    "position:fixed;left:-2000px;top:0;width:1280px;height:720px;pointer-events:none;";
  videoCanvas.setAttribute("aria-hidden", "true");
  document.body.append(videoCanvas);
  const videoContext = videoCanvas.getContext("2d");
  let videoActive = false,
    videoFrames = [],
    videoTime = 0,
    videoLast = 0;
  const progress = (message) => {
    $("prStatus").textContent = message;
  };
  const notify = () =>
    window.dispatchEvent(new Event("process-history-change"));
  const excluded = (target) =>
    target instanceof Element && !!target.closest("[data-process-ui]");
  function currentSource() {
    return workspace.processView();
  }
  function report() {
    progress(
      (recording ? "RECORDING" : "RECORDING PAUSED") +
        " · " +
        steps.length +
        " STEPS",
    );
  }
  function cameraNow() {
    const source = currentSource();
    return captureCamera(source.camera, source.orbit);
  }
  function refreshList() {
    $("prStep").replaceChildren(
      ...steps.map((step, i) => new Option(i + 1 + ". " + step.label, i)),
    );
    $("prCamera").replaceChildren(
      ...views.map((view, i) => new Option(view.name, i)),
    );
    $("prStep").value = selected;
  }
  async function capture(label, kind = "operation") {
    if (capturing) {
      pendingLabel = label;
      return;
    }
    if (workspace.isBusy()) {
      pendingLabel = label;
      progress("WAITING FOR GEOMETRY TO FINISH…");
      clearTimeout(timer);
      timer = setTimeout(flush, 500);
      return;
    }
    capturing = true;
    const capturedTime = steps.length ? Date.now() - origin : 0;
    try {
      // Capture one settled result, then retain the full project state for
      // restoring a step and the viewport geometry for processing-free replay.
      const state = structuredClone(workspace.save());
      const visual = captureProcessView(currentSource());
      const [encodedState, view] = await Promise.all([
        codec.encode(state),
        codec.encode(visual),
      ]);
      steps.push({
        label: label.toUpperCase(),
        kind,
        time: capturedTime,
        state: encodedState,
        view,
        cameraFrames: [],
        include: true,
        duration: 3,
        cameraMode: "recorded",
      });
      selected = steps.length - 1;
      refreshList();
      report();
      notify();
    } catch (error) {
      progress("RECORDING ERROR · " + error.message);
    } finally {
      capturing = false;
      if (pendingLabel) {
        clearTimeout(timer);
        timer = setTimeout(flush, 500);
      }
    }
  }
  async function flush() {
    clearTimeout(timer);
    if (!pendingLabel) return;
    const label = pendingLabel;
    pendingLabel = undefined;
    await capture(label);
  }
  function queue(label) {
    if (!recording || restoring) return;
    if (label) actionLog.push({ time: Date.now() - origin, operation: label });
    pendingLabel = label || pendingLabel || "GEOMETRY UPDATED";
    clearTimeout(timer);
    if (!capturing && !workspace.isBusy()) void flush();
    else timer = setTimeout(flush, 500);
  }
  document.addEventListener("change", (event) => {
    if (excluded(event.target)) return;
    const input = event.target;
    const label =
      input.labels?.[0]?.textContent?.trim() ||
      input.getAttribute?.("aria-label") ||
      input.id ||
      "SETTING";
    queue(
      label +
        " → " +
        (input.type === "checkbox"
          ? input.checked
            ? "ON"
            : "OFF"
          : input.value),
    );
  });
  document.addEventListener("click", (event) => {
    if (excluded(event.target)) return;
    const button = event.target.closest?.("button");
    if (
      !button ||
      (/EXPORT|SAVE SETTINGS|REPAIR|DOWNLOAD|HELP/.test(button.textContent) &&
        !/REPAIR/.test(button.textContent))
    )
      return;
    queue(button.textContent.trim());
  });
  window.addEventListener("project-change", () => queue());
  let interacting = false,
    lastCameraTime = 0,
    lastCamera;
  window.addEventListener("pointerdown", (event) => {
    if (!excluded(event.target)) interacting = true;
  });
  window.addEventListener("pointerup", () => {
    interacting = false;
  });
  window.addEventListener("pointercancel", () => {
    interacting = false;
  });
  window.addEventListener(
    "wheel",
    (event) => {
      if (!excluded(event.target)) lastCameraTime = performance.now() + 500;
    },
    { passive: true },
  );
  setInterval(() => {
    if (
      !recording ||
      !steps.length ||
      dialog.open ||
      capturing ||
      restoring ||
      (!interacting && performance.now() > lastCameraTime)
    )
      return;
    try {
      const source = currentSource(),
        camera = cameraNow(),
        signature = JSON.stringify(camera);
      if (signature === lastCamera) return;
      lastCamera = signature;
      steps.at(-1).cameraFrames.push({
        time: Date.now() - origin,
        camera,
        workspace: source.workspace,
      });
    } catch {}
  }, 100);
  $("prRecord").onclick = async () => {
    if (recording) {
      recording = false;
      await flush();
    } else {
      recording = true;
      if (!steps.length) {
        origin = Date.now();
        await capture("STARTING STATE · CURRENT BUILDING", "baseline");
      } else origin = Date.now() - (steps.at(-1).time + 100);
    }
    $("prRecord").textContent = recording
      ? "PAUSE RECORDING"
      : "RESUME RECORDING";
    report();
    notify();
  };
  $("prMilestone").onclick = async () => {
    await flush();
    await capture($("prLabel").value.trim() || "DESIGN MILESTONE", "milestone");
  };
  $("prName").onchange = notify;
  async function download() {
    await flush();
    if (capturing) {
      progress("WAIT FOR THE CURRENT STEP TO FINISH SAVING.");
      return;
    }
    if (!steps.length) {
      progress("START RECORDING OR ADD A MILESTONE FIRST.");
      return;
    }
    const data = {
      format: "balloon-build-script",
      version: 1,
      engine: "balloon-build-process-1",
      title: $("prName").value,
      createdAt: new Date().toISOString(),
      actionLog,
      steps,
      views,
      assets: codec.assets(),
    };
    let blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    let extension = ".buildscript.json";
    if (typeof CompressionStream !== "undefined") {
      blob = await new Response(
        blob.stream().pipeThrough(new CompressionStream("gzip")),
      ).blob();
      extension += ".gz";
    }
    downloadBlob(
      blob,
      ($("prName")
        .value.trim()
        .replace(/[^a-z0-9_-]+/gi, "-") || "building") + extension,
    );
    progress("BUILD SCRIPT DOWNLOADED · " + steps.length + " RECORDED STEPS.");
  }
  $("prDownload").onclick = () =>
    download().catch((error) => progress(error.message));
  $("prImport").onchange = async () => {
    const file = $("prImport").files[0];
    if (!file) return;
    try {
      let blob = file;
      const header = new Uint8Array(await file.slice(0, 2).arrayBuffer());
      if (header[0] === 31 && header[1] === 139) {
        if (typeof DecompressionStream === "undefined")
          throw Error("This browser cannot open compressed scripts.");
        blob = await new Response(
          file.stream().pipeThrough(new DecompressionStream("gzip")),
        ).blob();
      }
      const data = validateBuildScript(JSON.parse(await blob.text()));
      const nextCodec = createProcessCodec(data.assets);
      // Decode the first frame before replacing an existing recording.
      nextCodec.decode(data.steps[0].view);
      recording = false;
      clearTimeout(timer);
      pendingLabel = undefined;
      codec = nextCodec;
      steps = data.steps;
      views = data.views ?? [];
      actionLog = data.actionLog ?? [];
      selected = 0;
      $("prName").value = data.title || "IMPORTED BUILDING";
      $("prRecord").textContent = "RESUME RECORDING";
      refreshList();
      report();
      notify();
      openReplay();
    } catch (error) {
      progress("COULD NOT OPEN SCRIPT · " + error.message);
    }
    $("prImport").value = "";
  };
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function openReplay() {
    if (!steps.length) {
      progress("RECORD A STEP OR ADD A MILESTONE FIRST.");
      return;
    }
    if (!viewer) viewer = createProcessViewer($("prCanvas"));
    dialog.showModal();
    viewer.setActive(true);
    refreshList();
    showStep(selected);
    $("prReplayStatus").textContent = steps.length + " RECORDED STEPS. ONLY RECORDED OPERATIONS CAN BE REPLAYED. SAVE CAMERA VIEWS TO CONTROL PRESENTATION FRAMING.";
  }
  $("prOpen").onclick = openReplay;
  function showStep(index, preserveCamera = false) {
    if (!steps[index]) return;
    selected = index;
    const step = steps[index];
    viewer.show(codec.decode(step.view), preserveCamera);
    if (
      $("prMode").value === "presentation" &&
      step.cameraMode === "saved" &&
      views[step.cameraIndex]
    )
      viewer.setCamera(views[step.cameraIndex].camera);
    $("prStep").value = index;
    $("prStepLabel").value = step.label;
    $("prInclude").checked = step.include !== false;
    $("prDuration").value = step.duration ?? 3;
    $("prCameraMode").value = step.cameraMode ?? "recorded";
    $("prCamera").value = step.cameraIndex ?? 0;
    $("prCaption").textContent =
      index + 1 + " / " + steps.length + " · " + step.label;
  }
  function stop() {
    cancelled = true;
    playing = false;
    paused = false;
    viewer?.orbit && (viewer.orbit.enabled = true);
    $("prPlay").textContent = "PLAY";
    if (videoActive) finishVideo();
  }
  $("prClose").onclick = () => {
    stop();
    viewer?.setActive(false);
    dialog.close();
  };
  dialog.addEventListener("cancel", () => {
    stop();
    viewer?.setActive(false);
  });
  $("prStop").onclick = stop;
  $("prStep").onchange = () => {
    stop();
    showStep(Number($("prStep").value));
  };
  $("prPrevious").onclick = () => {
    stop();
    showStep(Math.max(0, selected - 1));
  };
  $("prNext").onclick = () => {
    stop();
    showStep(Math.min(steps.length - 1, selected + 1));
  };
  $("prMode").onchange = () => {
    stop();
    showStep(selected);
  };
  for (const [id, property] of [
    ["prStepLabel", "label"],
    ["prInclude", "include"],
    ["prDuration", "duration"],
    ["prCameraMode", "cameraMode"],
    ["prCamera", "cameraIndex"],
  ])
    $(id).onchange = () => {
      const step = steps[selected];
      if (!step) return;
      step[property] =
        $(id).type === "checkbox"
          ? $(id).checked
          : property === "duration" || property === "cameraIndex"
            ? Number($(id).value)
            : $(id).value;
      if (property === "duration")
        step.duration = Math.max(0.2, Math.min(120, step.duration || 3));
      refreshList();
      $("prCaption").textContent =
        selected + 1 + " / " + steps.length + " · " + step.label;
      notify();
    };
  $("prSaveCamera").onclick = () => {
    const name = $("prViewName").value.trim() || "CAMERA " + (views.length + 1);
    views.push({ name: name.toUpperCase(), camera: viewer.getCamera() });
    steps[selected].cameraMode = "saved";
    steps[selected].cameraIndex = views.length - 1;
    refreshList();
    $("prCameraMode").value = "saved";
    $("prCamera").value = views.length - 1;
    notify();
    $("prReplayStatus").textContent = "CAMERA VIEW SAVED FOR THIS STEP.";
  };
  $("prRestore").onclick = async () => {
    if (workspace.isBusy()) {
      $("prReplayStatus").textContent = "WAIT FOR GEOMETRY TO FINISH.";
      return;
    }
    stop();
    recording = false;
    $("prRecord").textContent = "RESUME RECORDING";
    restoring = true;
    const previous = workspace.save();
    try {
      await workspace.load(codec.decode(steps[selected].state));
      const source = currentSource();
      applyCamera(
        source.camera,
        source.orbit,
        codec.decode(steps[selected].view).camera,
      );
      $("prReplayStatus").textContent = "STEP RESTORED TO THE WORKING PROJECT.";
      notify();
    } catch (error) {
      await workspace.load(previous);
      $("prReplayStatus").textContent = "RESTORE FAILED · " + error.message;
    } finally {
      restoring = false;
    }
  };
  function wait(ms, onFrame) {
    if (videoActive) return (async () => {
      const count = frameCount(ms);
      for (let index = 0; index < count; index++) {
        if (cancelled) return false;
        onFrame?.(count === 1 ? 1 : index / (count - 1));
        drawVideo();
        videoTime += 1000 / 30;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return true;
    })();
    return new Promise((resolve) => {
      let last = performance.now(),
        elapsed = 0;
      function frame(now) {
        if (cancelled) {
          resolve(false);
          return;
        }
        if (!paused) elapsed += now - last;
        last = now;
        onFrame?.(Math.min(1, elapsed / ms));
        drawVideo();
        if (elapsed >= ms) {
          resolve(true);
          return;
        }
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }
  function drawVideo() {
    if (!videoActive) return;
    viewer.render();
    const canvas = viewer.canvas;
    const width = videoCanvas.width, height = videoCanvas.height;
    videoContext.fillStyle = "#000";
    videoContext.fillRect(0, 0, width, height);
    videoContext.drawImage(canvas, 0, 0);
    const unit = width / 1920;
    videoContext.fillStyle = "#a5e8ef";
    videoContext.font = (28 * unit) + "px sans-serif";
    videoContext.fillText($("prCaption").textContent, 36 * unit, height - 32 * unit, width - 72 * unit);
    videoFrames.push({ time: videoTime, data: captureVp8(videoCanvas) });
  }
  function finishVideo() {
    videoActive = false;
    try {
      const movie = encodeWebM(videoFrames, videoCanvas.width, videoCanvas.height, videoTime);
      downloadBlob(movie, "building-process.webm");
      $("prReplayStatus").textContent =
        "VIDEO DOWNLOADED · " + videoFrames.length + " FRAMES.";
    } catch (error) {
      $("prReplayStatus").textContent =
        "VIDEO EXPORT FAILED · " + error.message;
    }
    videoFrames = [];
    viewer.setExportSize();
  }
  async function play(from = selected) {
    if (playing) {
      if (videoActive) return;
      paused = !paused;
      $("prPlay").textContent = paused ? "RESUME" : "PAUSE";
      videoLast = performance.now();
      return;
    }
    const presentation = $("prMode").value === "presentation";
    const order = steps
      .map((_, i) => i)
      .filter(
        (i) => i >= from && (!presentation || steps[i].include !== false),
      );
    if (!order.length) {
      $("prReplayStatus").textContent =
        "SELECT AT LEAST ONE PRESENTATION STEP.";
      return;
    }
    cancelled = false;
    playing = true;
    paused = false;
    viewer.orbit.enabled = false;
    $("prPlay").textContent = "PAUSE";
    const speed = Number($("prSpeed").value);
    try {
      for (const i of order) {
        if (cancelled) break;
        const previous = viewer.getCamera(),
          step = steps[i],
          view = codec.decode(step.view);
        showStep(i, presentation && step.cameraMode === "previous");
        if (videoActive && presentation && $("prFraming").value === "fit") viewer.fit();
        const destination = viewer.getCamera();
        if (presentation) {
          if (step.cameraMode !== "previous") {
            viewer.setCamera(previous);
            if (
              !(await wait(600 / speed, (t) =>
                viewer.transition(previous, destination, t),
              ))
            )
              break;
          }
          if (!(await wait(((step.duration ?? 3) * 1000) / speed))) break;
        } else {
          viewer.setCamera(view.camera);
          const end = steps[i + 1]?.time ?? Math.max(step.time + 2000,
            ...(step.cameraFrames ?? []).map(frame => frame.time + 1000));
          let prior = { time: step.time, camera: view.camera };
          for (const frame of step.cameraFrames ?? []) {
            if (frame.workspace !== view.workspace || frame.time > end)
              continue;
            const start = prior.camera;
            if (
              !(await wait(Math.max(1, frame.time - prior.time) / speed, (t) =>
                viewer.transition(start, frame.camera, t),
              ))
            )
              break;
            prior = frame;
          }
          if (cancelled) break;
          if (!(await wait(Math.max(1, end - prior.time) / speed))) break;
        }
      }
    } catch (error) {
      $("prReplayStatus").textContent = "REPLAY FAILED · " + error.message;
    } finally {
      playing = false;
      paused = false;
      viewer.orbit.enabled = true;
      $("prPlay").textContent = "PLAY";
      if (videoActive) finishVideo();
    }
  }
  $("prFit").onclick = () => viewer?.fit();
  $("prPlay").onclick = () => play();
  $("prVideo").onclick = async () => {
    if (playing) {
      $("prReplayStatus").textContent = "STOP PLAYBACK BEFORE EXPORTING VIDEO.";
      return;
    }
    await flush();
    if (capturing || workspace.isBusy()) {
      $("prReplayStatus").textContent = "WAIT FOR THE CURRENT RECORDED STEP TO FINISH SAVING.";
      return;
    }
    const included = steps.filter(step => $("prMode").value !== "presentation" || step.include !== false);
    if (!included.length) {
      $("prReplayStatus").textContent = "NO INCLUDED STEPS TO EXPORT.";
      return;
    }
    const width = Number($("prResolution").value), height = width * 9 / 16;
    videoCanvas.width = width;
    videoCanvas.height = height;
    viewer.setExportSize(width, height - Math.round(80 * width / 1920));
    videoFrames = [];
    videoTime = 0;
    videoLast = performance.now();
    videoActive = true;
    $("prReplayStatus").textContent = included.length + " STEPS · " + width + " × " + height + " · 30 FPS · STOP SAVES A PARTIAL VIDEO.";
    selected = 0;
    void play(0);
  };

  return {
    save: () => ({
      format: "balloon-build-script",
      version: 1,
      title: $("prName").value,
      steps,
      views,
      assets: codec.assets(),
      recording,
      actionLog,
      origin,
    }),
    load(data) {
      if (!data?.steps?.length) return;
      validateBuildScript(data);
      codec = createProcessCodec(data.assets);
      steps = data.steps;
      views = data.views ?? [];
      actionLog = data.actionLog ?? [];
      recording = !!data.recording;
      origin = data.origin ?? Date.now();
      selected = steps.length - 1;
      $("prName").value = data.title ?? "MY BUILDING";
      $("prRecord").textContent = recording
        ? "PAUSE RECORDING"
        : "RESUME RECORDING";
      refreshList();
      report();
    },
  };
}
