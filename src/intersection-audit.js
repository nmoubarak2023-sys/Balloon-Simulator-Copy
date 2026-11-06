import * as T from "three";
import { MeshBVH } from "three-mesh-bvh";

// A bounded geometric audit supplements edge connectivity. It detects proper
// interior crossings, not coplanar overlap or all tolerance-scale contacts.
export function auditCrossings(raw, tolerance, maxPairs = 2000000) {
  const g = new T.BufferGeometry();
  g.setAttribute(
    "position",
    new T.BufferAttribute(new Float64Array(raw.positions), 3),
  );
  g.setIndex(new T.BufferAttribute(new Uint32Array(raw.indices), 1));
  const tree = new MeshBVH(g),
    line = new T.Line3(),
    mid = new T.Vector3(),
    aBary = new T.Vector3(),
    bBary = new T.Vector3(),
    planeA = new T.Plane(),
    planeB = new T.Plane();
  let pairsTested = 0,
    properCrossings = 0,
    toleranceContacts = 0,
    truncated = false;
  try {
    tree.bvhcast(tree, new T.Matrix4(), {
      intersectsTriangles: (a, b, i, j) => {
        if (i >= j) return false;
        const ai = Array.from(g.index.array.slice(i * 3, i * 3 + 3)),
          bi = Array.from(g.index.array.slice(j * 3, j * 3 + 3));
        if (ai.some((v) => bi.includes(v))) return false;
        pairsTested++;
        if (pairsTested > maxPairs) {
          truncated = true;
          return true;
        }
        if (
          a.intersectsTriangle(b, line, true) &&
          line.distance() > tolerance * 2
        ) {
          line.getCenter(mid);
          a.getBarycoord(mid, aBary);
          b.getBarycoord(mid, bBary);
          // Boundary-only meetings are permitted; interiors crossing are not.
          if (Math.min(...aBary.toArray(), ...bBary.toArray()) > 1e-5) {
            a.getPlane(planeA);
            b.getPlane(planeB);
            const da = [a.a, a.b, a.c].map((v) => planeB.distanceToPoint(v));
            const db = [b.a, b.b, b.c].map((v) => planeA.distanceToPoint(v));
            if (
              Math.min(...da) < -tolerance &&
              Math.max(...da) > tolerance &&
              Math.min(...db) < -tolerance &&
              Math.max(...db) > tolerance
            )
              properCrossings++;
            else toleranceContacts++;
          }
        }
        if (properCrossings >= 1000) {
          truncated = true;
          return true;
        }
        return false;
      },
    });
    return {
      properCrossings,
      toleranceContacts,
      pairsTested,
      truncated,
      coplanarOverlapChecked: false,
      scope:
        "Nonadjacent triangle interiors; coplanar overlaps and contacts below tolerance are not certified.",
    };
  } finally {
    g.dispose();
  }
}
