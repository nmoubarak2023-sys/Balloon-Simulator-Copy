import { studioLayout, lobbyZone } from "./studio-layout.js";

export function collaborationZone(loops, settings) {
  if (!Number.isFinite(settings.studioHeight) || settings.studioHeight < 1)
    throw Error("ENTER A HEIGHT LIMIT OF AT LEAST 1 FT.");
  const points = studioLayout(loops, settings);
  return {
    ...settings,
    spatialType: "studio",
    count: points.length,
    selected: points.length,
    index: 0,
    radiusMin: settings.studioBay * 0.65,
    radiusMax: settings.studioBay * 0.65,
  };
}

// Native point controls keep their original behavior: explicitly changing
// count/seed leaves the generated grid instead of failing or ignoring input.
export function releaseCollaborationPoints(config, field) {
  if (
    ["studio", "lobby"].includes(config?.spatialType) &&
    ["count", "seed"].includes(field)
  ) {
    config.spatialType = "custom";
    return true;
  }
  return false;
}

export function mountCollaborationLayout({ anchor, getState, apply }) {
  const root = document.createElement("details");
  root.className = "collaboration-layout";
  root.open = true;
  root.innerHTML = `<summary>ZONE LAYOUT</summary><label>LAYOUT<select data-layout><option value="custom">EXISTING / CUSTOM</option><option value="studio">COLLABORATION OFFICE</option><option value="lobby">LOBBY</option></select></label><div data-fields><label>MAIN DIRECTION (DEGREES)<input data-field="studioAngle" type="number" value="0"></label><label>BAY SPACING (FT)<input data-field="studioBay" type="number" min="2" value="20"></label><label>VAULT ELONGATION<input data-field="studioElongation" type="number" min="1" max="4" step=".1" value="2"></label><label>GENERATED HEIGHT LIMIT (FT)<input data-field="studioHeight" type="number" min="1" value="12"></label></div><button type="button" data-preview>PREVIEW LAYOUT</button><button type="button" data-apply>APPLY ZONE LAYOUT</button><svg viewBox="0 0 240 240" aria-label="COLLABORATION LAYOUT PREVIEW" hidden></svg><output role="status"></output>`;
  anchor.after(root);
  const q = (selector) => root.querySelector(selector),
    type = q("[data-layout]"),
    output = q("output"),
    svg = q("svg");
  const defaults = {
    studioAngle: 0,
    studioBay: 20,
    studioElongation: 2,
    studioHeight: 12,
  };
  const settings = () =>
    Object.fromEntries(
      Object.keys(defaults).map((k) => [
        k,
        Number(q(`[data-field="${k}"]`).value),
      ]),
    );
  function visibility() {
    q("[data-fields]").hidden = !["studio", "lobby"].includes(type.value);
    q("[data-preview]").disabled = !["studio", "lobby"].includes(type.value);
    for (const key of ["studioAngle", "studioBay", "studioElongation"])
      q(`[data-field="${key}"]`).closest("label").hidden =
        type.value === "lobby";
    svg.setAttribute("hidden", "");
    svg.replaceChildren();
    output.textContent = "";
  }
  function refresh() {
    const state = getState(),
      cfg = state.config ?? {};
    type.value = ["studio", "lobby"].includes(cfg.spatialType)
      ? cfg.spatialType
      : "custom";
    for (const [k, v] of Object.entries(defaults))
      q(`[data-field="${k}"]`).value = cfg[k] ?? v;
    root.hidden = !state.loops;
    visibility();
  }
  type.onchange = () => {
    if (type.value === "studio")
      for (const [k, v] of Object.entries(defaults))
        q(`[data-field="${k}"]`).value = v;
    visibility();
  };
  function preview() {
    const state = getState();
    if (!state.loops) throw Error("IMPORT A ZONED FLOOR FIRST.");
    const cfg =
        type.value === "lobby"
          ? lobbyZone(state.loops, settings().studioHeight)
          : collaborationZone(state.loops, settings()),
      points =
        type.value === "lobby"
          ? [[cfg.lobbyX, cfg.lobbyY]]
          : studioLayout(state.loops, cfg);
    const all = state.loops.flat(),
      xs = all.map((p) => p[0]),
      ys = all.map((p) => p[1]),
      x = Math.min(...xs),
      y = Math.min(...ys),
      span = Math.max(Math.max(...xs) - x, Math.max(...ys) - y);
    const project = (p) => [
      20 + ((p[0] - x) * 200) / span,
      220 - ((p[1] - y) * 200) / span,
    ];
    svg.replaceChildren();
    svg.removeAttribute("hidden");
    const polygon = (points, fill, stroke) => {
      const el = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "polygon",
      );
      el.setAttribute(
        "points",
        points.map((p) => project(p).join(",")).join(" "),
      );
      el.setAttribute("fill", fill);
      el.setAttribute("stroke", stroke);
      el.setAttribute("stroke-width", "1");
      svg.append(el);
    };
    for (const loop of state.loops) polygon(loop, "none", "#355c62");
    const angle = ((cfg.studioAngle ?? 0) * Math.PI) / 180,
      c = Math.cos(angle),
      s = Math.sin(angle),
      r = cfg.radiusMin;
    for (const center of points)
      polygon(
        Array.from({ length: 64 }, (_, i) => {
          const a = (i * Math.PI) / 32,
            dx =
              Math.cos(a) *
              r *
              (cfg.spatialType === "lobby"
                ? cfg.lobbyRX / cfg.lobbyRY
                : cfg.studioElongation),
            dy = Math.sin(a) * r;
          return [center[0] + dx * c - dy * s, center[1] + dx * s + dy * c];
        }),
        "#80dce714",
        "#80dce7",
      );
    output.textContent = points.length + " BAYS · PREVIEW ONLY";
    return cfg;
  }
  q("[data-preview]").onclick = () => {
    try {
      preview();
    } catch (e) {
      output.textContent = e.message;
    }
  };
  q("[data-apply]").onclick = () => {
    try {
      if (getState().busy)
        throw Error("WAIT FOR THE CURRENT OPERATION TO FINISH.");
      const cfg = ["studio", "lobby"].includes(type.value)
        ? preview()
        : { spatialType: "custom" };
      if (
        !confirm(
          "REGENERATE THIS ZONE? AN UNDO CHECKPOINT WILL BE SAVED. REVIEW EXISTING COLUMNS AND WALLS IF RIDGES MOVE.",
        )
      )
        return;
      apply(cfg);
    } catch (e) {
      output.textContent = e.message;
    }
  };
  return { refresh };
}
