// Pixel-sized SVG borders retain the reference's thin strokes at every panel size.
export function addTechnicalFrames(root = document) {
  const ns = "http://www.w3.org/2000/svg";
  root.querySelectorAll(".panel").forEach((panel) => {
    if (panel.querySelector(":scope > .technical-frame")) return;
    const filledCount =
      Number(panel.dataset.frameCount) ||
      (panel.classList.contains("viewer-panel")
        ? 1
        : panel.classList.contains("plan-panel")
          ? 2
          : 3);
    const svg = document.createElementNS(ns, "svg");
    svg.classList.add("technical-frame");
    svg.setAttribute("aria-hidden", "true");
    const make = (tag, attrs) => {
      const el = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
      return el;
    };
    const outer = make("path", { class: "frame-outer" }),
      inner = make("path", { class: "frame-inner" }),
      trace = make("path", { class: "frame-trace" });
    const bars = Array.from({ length: 5 }, (_, i) =>
      make("rect", {
        class: i < filledCount ? "frame-bar filled" : "frame-bar",
        width: 4,
        height: 7,
      }),
    );
    panel.prepend(svg);
    const draw = () => {
      const w = panel.clientWidth,
        h = panel.clientHeight;
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      outer.setAttribute(
        "d",
        `M1 1 H82 L98 18 H${w - 17} L${w - 1} 34 V${h - 34} L${w - 34} ${h - 1} H1 Z`,
      );
      inner.setAttribute(
        "d",
        `M12 28 H${w - 25} L${w - 12} 41 V${h - 43} L${w - 43} ${h - 16} H12 Z`,
      );
      trace.setAttribute("d", `M1 ${h - 10} H98 L107 ${h - 1}`);
      bars.forEach((bar, i) => {
        bar.setAttribute("x", w - 91 + i * 8);
        bar.setAttribute("y", h - 11);
      });
    };
    new ResizeObserver(draw).observe(panel);
    draw();
  });
}
