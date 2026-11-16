import { queueAutosave } from "./autosave.js";
import * as T from "three";

export function initMeasure({ pane, renderers, cameras, roots, floorHeight }) {
  const toolbar = pane.querySelector("#vWire").parentElement;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "measure-command";
  button.textContent = "MEASURE";
  button.setAttribute("aria-pressed", "false");
  const readout = document.createElement("output");
  readout.className = "measure-readout";
  readout.setAttribute("aria-live", "polite");
  readout.hidden = true;
  toolbar.append(button, readout);
  const overlay = new T.Scene();
  const lineGeometry = new T.BufferGeometry();
  const coordinates = new Float32Array(6);
  lineGeometry.setAttribute("position", new T.BufferAttribute(coordinates, 3));
  const line = new T.Line(
    lineGeometry,
    new T.LineBasicMaterial({ color: 0xff5284 }),
  );
  line.frustumCulled = false;
  const markerGeometry = new T.BufferGeometry();
  const markerCoordinates = new Float32Array(6);
  markerGeometry.setAttribute(
    "position",
    new T.BufferAttribute(markerCoordinates, 3),
  );
  const markers = new T.Points(
    markerGeometry,
    new T.PointsMaterial({
      color: 0xff5284,
      size: 8,
      sizeAttenuation: false,
    }),
  );
  markers.frustumCulled = false;
  overlay.add(line, markers);

  const ray = new T.Raycaster();
  const projected = new T.Vector3();
  const floor = new T.Plane(new T.Vector3(0, 0, 1), 0);
  const picks = [];
  let active = false,
    start,
    end,
    cursor,
    pendingPointer,
    down;
  function updateReadout() {
    if (!active && !end) return;
    if (!start) readout.textContent = "PICK FIRST POINT";
    else if (!end) readout.textContent = "PICK SECOND POINT";
    else {
      const delta = end.clone().sub(start);
      const format = (value) => value.toFixed(2);
      readout.textContent = `${format(delta.length())} FT · ΔX ${format(delta.x)} · ΔY ${format(delta.y)} · ΔZ ${format(delta.z)}`;
    }
  }
  function toggle(enabled) {
    active = enabled;
    start = end = cursor = pendingPointer = down = undefined;
    readout.hidden = !active;
    button.setAttribute("aria-pressed", active);
    updateReadout();
  }
  button.onclick = () => toggle(!active);
  function snap(event, index) {
    const cam = cameras[index];
    const rect = renderers[index].domElement.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    ray.setFromCamera(
      new T.Vector2((2 * px) / rect.width - 1, 1 - (2 * py) / rect.height),
      cam,
    );
    floor.constant = -floorHeight();
    const freePoint = ray.ray.intersectPlane(floor, new T.Vector3());
    const depth = cam.isOrthographicCamera
      ? (cam.top - cam.bottom) / cam.zoom
      : Math.max(1, freePoint ? freePoint.distanceTo(cam.position) : 30) *
        2 *
        Math.tan(T.MathUtils.degToRad(cam.fov / 2));
    const tolerance = (9 * depth) / rect.height;
    ray.params.Line.threshold = tolerance;
    ray.params.Line2 = { threshold: 4 };
    ray.params.Points.threshold = tolerance;

    picks.length = 0;
    for (const root of roots(index)) {
      root.updateMatrixWorld(true);
      root.traverseVisible((object) => {
        if (object.isMesh || object.isLine || object.isPoints)
          picks.push(object);
      });
    }
    const hits = ray
      .intersectObjects(picks, false)
      .filter(({ object, point }) => {
        const material = object.material;
        return (
          material.visible !== false &&
          !material.clippingPlanes?.some(
            (plane) => plane.distanceToPoint(point) < -1e-6,
          )
        );
      });
    const surface = hits.find(
      (hit) => hit.object.isMesh && !hit.object.isLine2,
    );
    let feature,
      distance = 9,
      priority = 0;
    function consider(point, hit, rank = 2) {
      if (
        !point ||
        (surface && hit.distance > surface.distance + tolerance * 2)
      )
        return;
      if (
        hit.object.material.clippingPlanes?.some(
          (plane) => plane.distanceToPoint(point) < -1e-6,
        )
      )
        return;
      projected.copy(point).project(cam);
      const error = Math.hypot(
        ((projected.x + 1) * rect.width) / 2 - px,
        ((1 - projected.y) * rect.height) / 2 - py,
      );
      if (
        error >= 9 ||
        rank < priority ||
        (rank === priority && error >= distance)
      )
        return;
      priority = rank;
      distance = error;
      feature = point.clone();
    }
    for (const hit of hits) {
      const { object, face, index } = hit;
      const positions = object.geometry.getAttribute("position");
      if (object.isLine || object.isLine2) {
        consider(hit.pointOnLine ?? hit.point, hit, 1);
        if (object.isLine && positions && Number.isInteger(index)) {
          for (const i of [
            index,
            object.isLineLoop ? (index + 1) % positions.count : index + 1,
          ])
            if (i < positions.count)
              consider(
                new T.Vector3()
                  .fromBufferAttribute(positions, i)
                  .applyMatrix4(object.matrixWorld),
                hit,
              );
        }
      } else if (object.isPoints && positions && Number.isInteger(index)) {
        consider(
          new T.Vector3()
            .fromBufferAttribute(positions, index)
            .applyMatrix4(object.matrixWorld),
          hit,
        );
      } else if (hit === surface && face && positions) {
        if (
          object.geometry.type === "SphereGeometry" &&
          object.geometry.parameters.radius <= tolerance
        )
          consider(object.getWorldPosition(new T.Vector3()), hit);
        for (const i of [face.a, face.b, face.c])
          consider(
            new T.Vector3()
              .fromBufferAttribute(positions, i)
              .applyMatrix4(object.matrixWorld),
            hit,
          );
      }
    }
    return feature ?? surface?.point ?? freePoint;
  }

  // Capture measurement clicks before zone picking and the transform gumballs.
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (!active || pane.hidden || event.button !== 0 || event.altKey) return;
      const index = renderers.findIndex((r) => r.domElement === event.target);
      if (index < 0) return;
      down = { index, x: event.clientX, y: event.clientY };
      event.stopPropagation();
    },
    true,
  );
  window.addEventListener(
    "pointerup",
    (event) => {
      if (!down) return;
      const press = down;
      down = undefined;
      if (
        !active ||
        pane.hidden ||
        renderers[press.index].domElement !== event.target ||
        Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5
      )
        return;
      event.stopPropagation();
      const point = snap(event, press.index);
      if (!point) return;
      if (!start || end) {
        start = point;
        end = undefined;
      } else {
        end = point;
        updateReadout();
        active = false;
        button.setAttribute("aria-pressed", "false");
        queueAutosave();
        return;
      }
      updateReadout();
    },
    true,
  );
  window.addEventListener("pointercancel", () => {
    down = undefined;
  });
  window.addEventListener("keydown", (event) => {
    if ((!active && !end) || pane.hidden || event.key !== "Escape") return;
    toggle(false);
  });
  renderers.forEach((renderer, index) => {
    renderer.domElement.addEventListener("pointermove", (event) => {
      if (active && !event.buttons) pendingPointer = { event, index };
    });
    renderer.domElement.addEventListener("pointerleave", () => {
      cursor = pendingPointer = undefined;
    });
  });
  return {
    save: () => end && [start.toArray(), end.toArray()],
    load(points) {
      if (!points) return;
      toggle(false);
      [start, end] = points.map((point) => new T.Vector3(...point));
      readout.hidden = false;
      updateReadout();
    },
    render(index) {
      if (!active && !end) return;
      if (active && pendingPointer) {
        cursor = snap(pendingPointer.event, pendingPointer.index);
        pendingPointer = undefined;
      }
      const first = start ?? cursor;
      if (!first) return;
      const second = start ? (end ?? cursor) : null;
      markers.geometry.setDrawRange(0, second ? 2 : 1);
      first.toArray(markerCoordinates, 0);
      second?.toArray(markerCoordinates, 3);
      markers.geometry.attributes.position.needsUpdate = true;
      line.visible = !!second;
      if (second) {
        first.toArray(coordinates, 0);
        second.toArray(coordinates, 3);
        line.geometry.attributes.position.needsUpdate = true;
      }
      const renderer = renderers[index];
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(overlay, cameras[index]);
      renderer.autoClear = true;
    },
  };
}
