import test from "node:test";
import assert from "node:assert/strict";
import Module from "manifold-3d";
import { structuredSphere, smoothContactBand } from "../src/balloon-surface.js";
import { BalloonEngine, topology } from "../src/engine.js";

test("structured balloon has welded quad patches, outward winding and spherical vertices", () => {
  const s = structuredSphere(10, 48, [5, 7, 9]);
  assert.equal(s.quads.length / 4, 6 * 12 * 12);
  assert.equal(s.indices.length / 3, s.quads.length / 2);
  assert.deepEqual(topology(s), { valid: true, closed: true, manifold: true });
  for (let i = 0; i < s.positions.length; i += 3)
    assert.ok(
      Math.abs(
        Math.hypot(
          s.positions[i] - 5,
          s.positions[i + 1] - 7,
          s.positions[i + 2] - 9,
        ) - 10,
      ) < 2e-6,
    );
});
test("0.23 neighbor smoothing affects only the first ring beside contact vertices", () => {
  const raw = structuredSphere(10, 24),
    before = raw.positions.slice();
  const one = smoothContactBand(raw, (p) => p[2] > 9.5, 0.23, 1),
    eight = smoothContactBand(raw, (p) => p[2] > 9.5, 0.23, 8);
  assert.ok(one.eligible.some(Boolean));
  assert.ok(one.contact.some(Boolean));
  let changed = 0;
  for (let i = 0; i < one.eligible.length; i++) {
    if (!one.eligible[i])
      assert.deepEqual(
        Array.from(eight.positions.slice(i * 3, i * 3 + 3)),
        Array.from(before.slice(i * 3, i * 3 + 3)),
      );
    else {
      const neighbors = new Set();
      for (let j = 0; j < raw.indices.length; j += 3) {
        const f = Array.from(raw.indices.slice(j, j + 3));
        if (f.includes(i))
          f.forEach((v) => {
            if (v !== i) neighbors.add(v);
          });
      }
      for (let k = 0; k < 3; k++) {
        const avg =
          [...neighbors].reduce((n, j) => n + before[j * 3 + k], 0) /
          neighbors.size;
        assert.ok(
          Math.abs(
            one.positions[i * 3 + k] -
              (before[i * 3 + k] + (avg - before[i * 3 + k]) * 0.23),
          ) < 1e-12,
        );
        if (eight.positions[i * 3 + k] !== before[i * 3 + k]) changed++;
      }
    }
  }
  assert.ok(changed > 0);
  assert.deepEqual(raw.positions, before);
});
test("softened cutter remains within original allowed volume and closed after confinement", async () => {
  const m = await Module();
  m.setup();
  const e = new BalloonEngine(m),
    sphere = e.toSolid(structuredSphere(10, 48));
  const clipped = sphere.trimByPlane([-1, 0, 0], -6);
  sphere.delete();
  const softened = e.softenContacts(clipped, [
    { normal: [1, 0, 0], offset: 6 },
  ]);
  const outside = softened.subtract(clipped);
  assert.equal(softened.status(), "NoError");
  assert.ok(outside.volume() < 1e-8);
  assert.ok(softened.volume() < clipped.volume());
  assert.ok(softened.volume() > clipped.volume() * 0.85);
  assert.equal(topology(e.raw(softened)).closed, true);
  outside.delete();
  softened.delete();
  clipped.delete();
  e.clear();
});
