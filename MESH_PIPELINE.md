# Boolean pipeline investigation

The application uses Manifold 3.5.4 in WebAssembly, running in a Web Worker.
The starting spheres use Manifold's triangular sphere tessellation. Curve
pressure warps those vertices; contact half-spaces flatten neighboring balloons,
and intersections clip them to the imported container. Pop and manual contact
pressure add further Boolean cuts. Merge unions bodies and contact bridges.

## Reproduced causes

The supplied project reproduced real geometric defects, not only shading:

* Before final subtraction, the displayed balloon meshes already contained five
  degenerate triangles and 2,259 triangles with inverse mean-ratio quality >20.
* The previous sequential difference produced 33 degenerate and 3,426 stretched
  triangles. All edges still had paired, consistently oriented incidences.
  This shows why checking only closed/manifold connectivity missed the problem.
* Exact clipping creates coincident balloon/container patches. Independent
  Float32 serialization can collapse distinct intersection vertices, or place
  formerly coincident facets on slightly different surfaces. The result includes
  microscopic wall skins and zero-width pinches.
* CSG triangulation can legally produce long fans on planar cut patches. A valid
  solid-kernel status does not guarantee suitable triangle aspect ratios.
* Raw extraction and Rhino's previous vertex-list add/get methods reduced
  coordinates to single precision. Triangle connectivity and face offsets were
  correct; this was not a missing-index-offset or Rhino quad reconstruction bug.

The imported boundary had no degenerate faces in this sample, but did already
contain 324 stretched triangles. No new algorithm can recover an original smooth
CAD surface from a tessellated OBJ without introducing an approximation.

## Implemented changes

1. Normalize native solids near the origin for final computation and Float32
   extraction; reconstruct output coordinates in Float64 in original model units.
2. Compute one collective difference of the container and all cutters, handling
   overlaps together. Preserve all editable input solids and shell export.
3. Repair zero-length edges and zero-width pinches using directed halfedge pairing
   and separate corner fans. Split only oversubscribed edges to preserve separate
   surface sheets. Apply guarded tolerance-scale edge collapses; never fill
   arbitrary holes or silently delete arbitrary damaged faces.
4. Validate candidate connectivity and solid-kernel acceptance, and bound its net
   volume change. Do not use the kernel's reconstructed tessellation as the
   export: experiments showed that reconstruction could remove thin sheets.
   The volume bound supplements local operation guards; it is not a Hausdorff
   distance certificate or a proof that self-intersections are absent.
5. Improve convex coplanar triangulations using edge flips. Nearly planar patches
   must also satisfy distance and normal guards. Sharp creases stay locked.
   Selective long-edge refinement has a 400,000-triangle budget and is rejected
   when it worsens skinny-face counts or maximum aspect ratio. No smoothing,
   primitive replacement, broad welding or uncontrolled subdivision is used.
6. Add Preview (repair) and Final (repair, conditioning and geometric audit)
   choices, progress updates, downloadable quality reports, and unchanged-output
   caching in the Worker. Cancel still terminates costly work.
7. Preserve double-precision coordinates in OBJ and Rhino exports; use Rhino's
   addPoint3d/point3dAt APIs. Center the displayed output mesh before conversion to
   GPU floats. Binary STL remains a Float32 format and cannot represent every
   double-precision detail.

Manifold remains the solid kernel because its robust topology is useful here.
An experimental offset and an external simplifier did not preserve adequate
quality/topology on this project and were not retained. A uniform SDF replacement
would add a grid-error budget and risk losing narrow gaps and sharp features;
it is not silently substituted for the user's explicit geometry.

## Verification and limits

Tests cover a single sphere, overlapping spheres, complex overlaps, warped and
creased balloons, wall intersections, near tangencies/coplanar cuts, and
high-resolution meshes. They compare solid-minus-void volumes and symmetric
differences, verify orientation/connectivity, and round-trip the resulting Rhino
coordinates and indices. Existing Pop, Freeze, Merge, Undo, containment, project
restore and interaction tests remain in the suite.

`node scripts/inspect-project.mjs <project.json> [output-directory]` reproduces
the previous sequential result and writes the revised Rhino/OBJ files plus a
before/after report. No user project is included in the source repository.

The supplied project now has zero degenerate faces, duplicate faces, naked edges,
or non-manifold edges, including after Rhino serialization. **It is still not a
fully regular, certified fabrication mesh.** Its current report retains stretched
triangles and suspected triangle crossings. These warnings are shown in the app;
export remains allowed as previously requested. A BVH audit checks proper
nonadjacent triangle-interior crossings above tolerance, with an explicit pair
budget. It does not certify coplanar overlaps or sub-tolerance contacts.

Do not interpret a passing edge-topology check, small net volume change, or a
zero audit count as a general geometric-validity guarantee. Do not label this
sample fully fixed or watertight for fabrication without resolving its residual
geometric warnings and inspecting the exported solid.

## Optional volume reconstruction

The separate **Rebuild surface / approximate** option bypasses the old CSG
tessellation. It classifies the original container minus the union of all balloon
volumes using grouped, oriented scanline intersections. A nearest-surface signed
field is evaluated in active cells. Consistently split tetrahedral cells extract
a new conforming mesh with shared intersection vertices; no original long fan
triangles are reused. This is a sampled field, not a claim of an exact Euclidean
signed distance field or an adaptive octree.

The method retains the input geometry as editable source data. It exposes grid
resolution, model-unit cell size, and explicit warnings about small walls/gaps.
The extraction regularizes field magnitudes by 1% of a cell to prevent vanishing
triangles at grid vertices. No smoothing pass follows extraction. Individual
triangles lie within one grid cell, bounding their longest edge by sqrt(3) times
the cell size. Grid memory and output triangle count are limited; work remains
in the cancellable Worker. Rebuilding unchanged output uses the existing cache.

On the supplied project at resolution 160, a 0.7506-unit cell yields 385,000
triangles, zero degenerate/duplicate/non-manifold faces, and zero proper crossings
in a completed 8.9-million-pair audit. The maximum inverse mean-ratio aspect is
105.6 instead of tens of millions, and the longest edge is 1.279 model units.
Rhino serialization retains identical reconstructed coordinates/connectivity.
These checks do not certify coplanar overlap or universal fabrication readiness.

**This option changes the geometry.** Sample volume is approximately 1.426% below
the exact solid reference. Thin walls can be lost, perforated, or aliased when
under-resolved. The project's 0.08321-unit contact gap is much smaller than this
grid; increasing resolution from 160 to 256 still cannot reliably preserve that
gap. Surface creases and corners are also limited by the grid scale. Do not use
this reconstruction as an exact replacement when those details must remain.
Preserving such walls calls for a substantially larger resolution/error budget,
thicker intentional walls, or another geometry backend. The original Boolean
options remain available and are not silently replaced.

`node scripts/rebuild-project.mjs <project.json> [resolution] [output-directory]`
writes a reconstructed Rhino file and explicit approximation/validation report.
