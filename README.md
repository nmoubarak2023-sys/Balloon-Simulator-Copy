# Balloon Build

A browser-based geometric balloon design studio inspired by a supplied Grasshopper definition. Built with Three.js, Rhino3dm, and Manifold WebAssembly. Black / #21E0ED styling, Helvetica Neue LT Pro where installed, perspective and plan views.

## Use

1. Import one closed, oriented, manifold mesh from Rhino (.3dm), STL, or OBJ. Convert Breps to meshes in Rhino before exporting. Select a mesh if your .3dm contains several.
2. Set interior point count and seed, radius minimum/maximum and seed, resolution, and contact gap. Generate balloons.
3. Choose **CURVE POINTS** to enable pressure and expose control points in both canvases. Drag a point directly in the camera-facing plane (XY in plan), or use its X/Y/Z arrow gizmo in the 3D view. Pressure recalculates on release. Curve drags replace individual balloon edits. Numeric XYZ and Apply Pressure remain available. One Rhino curve can also be imported; it is sampled into editable points.
4. Choose **MOVE BALLOON**, click any balloon, then drag the balloon itself or an axis handle. **SCALE BALLOON** offers uniform scale handles. On release, the active balloon takes priority and unfrozen neighbors are dented to make space. Walls and frozen geometry remain constraints. A move is limited if it would reduce a neighbor below 2% of its current volume or split it into disconnected pieces. Numeric Apply and Reset remain available. Drag empty space or choose **ORBIT** to move the camera.
5. Build a shell assembly (separate nested shells, no welding/union/subtraction) or Boolean subtraction. Export .3dm, OBJ, or STL. Save/open JSON projects to preserve the last generated settings, boundary, pressure curve, and accepted edits.

**ROTATE BOUNDARY** exposes X/Y/Z axis selection, an exact degree field, −90° / +90° / 180° presets, and rotation rings around the imported mesh's center. Values are incremental rotations about the selected world axis; for example, two +90° actions rotate 180° in total. Rings snap to 90° by default; 15°, 45°, and free rotation are also available. This changes actual mesh coordinates, including the exported and saved boundary. Rotation regenerates the balloon field in the rotated volume and resets individual balloon edits. The pressure curve stays in world coordinates. This is separate from camera orbit and auto rotate.

The interface uses a black background and responsive double-line cyan frames with tabbed upper edges and diagonal corners, following the supplied graphic reference. Introductory marketing copy has been removed.

## Pop!, Freeze, and Merge

**UNDO / Ctrl+Z** reverses the latest modeling or control action, with a 20-step shared history. It covers moves/scales (including every deformed neighbor), Pop, Freeze, Merge, pressure changes, generation, boundary rotations/imports, project loads, curve edits/imports, control changes, and output preview changes. Geometry snapshots retain native kernel precision. Selection, camera navigation, downloads, and help dialogs are not undo steps. Text/number inputs retain their native Ctrl+Z text editing; the application shortcut applies when focus is on the canvas, a button, or other non-text controls. Undo history is kept in memory for the current page session, not stored in project JSON. A canceled worker can recover older undo states from the display/session backup.

Manual movement pressure uses Boolean subtraction of the active balloon from each contacted unfrozen neighbor, preserving the moving shape and removing overlap. Deformation is committed on release and remains until Undo or regeneration; moving away does not automatically restore earlier dents. One Undo restores the moving balloon and all affected neighbors together. Frozen balloons are neither moved nor deformed by this process.

- **Pop!** removes the active balloon. The pressure slider runs from 0–100% and defaults to 25%. It applies a local inward dent to unfrozen neighboring shapes, using the removed balloon as the influence shape. Zero removes only the selected balloon. Frozen neighbors are unchanged. The slider can adjust the most recent pop without accumulating successive deformation; another edit, freeze, merge, regeneration, cancellation, or project reload ends that live adjustment. If a requested pressure would eliminate a neighbor or split a merged volume, the operation is rejected and the preceding field is preserved.
- **Freeze / Unfreeze** locks the active shape and world position. Direct move, scale, reset, pop, and merge are disabled until it is unfrozen. Frozen geometry survives curve changes and field regeneration, acting as an obstacle for newly generated unfrozen shapes. A boundary change that would exclude frozen geometry is rejected; the geometry is never silently moved or trimmed. Frozen balloons are tinted blue-gray.
- **Merge** uses Shift/Ctrl-click or sidebar checkboxes to choose at least two unfrozen balloons. It forms a true solid Boolean union. Small contact gaps are bridged from nearby contact patches, clipped to the boundary, and trimmed against non-selected balloons. The resulting shape must be one connected component. Distant selections are rejected rather than connected by an arbitrary large hull. Merged shapes can subsequently be selected, moved, scaled, frozen, or popped as one entity. Regeneration retains group membership; if a new arrangement cannot connect a group, the previous field is preserved and an error explains the conflict.

Popped source members remain removed through regeneration. Count describes the source seed field, so the active balloon count may be smaller after popping or merging. **RESET POP / FREEZE / MERGE** clears these states and generates a fresh field using the current container and controls. Importing a different boundary or using the demonstration reset also clears them. If all balloons are popped, the unchanged boundary remains exportable.

Version 2 project JSON saves actual current and baseline geometry, merged membership, frozen flags, popped members, and pop influence history. Version 1 files remain readable. Mesh exports use the active shapes, including merged bodies and excluding popped balloons. Pop pressure is geometric form finding, not a physical transient-pressure calculation; maximum strength expands the removed influence shape by 25% before subtracting its overlap from unfrozen neighbors.

Internal Pop/Freeze/Merge transactions copy native solids directly instead of rebuilding from Float32 display meshes. Frozen solids are also copied natively during regeneration. Saved-file validation accounts for a small coordinate-rounding skin, with the extra permitted intersection volume capped at one part per million of balloon volume; meaningful boundary crossings and overlaps still fail. Merge contact patches include projected points on both surfaces, so different mesh tessellations do not produce a connector on only one side.

Canvas tests exercise real raycasting and pointer handlers through a small DOM adapter, plus the geometric solver. Live browser QA could not be completed for this update because the browser connection is unavailable.

All modeling happens locally in the browser. Uploaded models are not sent to a server. Imports are limited to 50 MB and 300,000 boundary triangles; counts to 40 balloons. High quality uses 80 circular segments, with 128 available. Model coordinates are preserved; Rhino exports should be imported using the original model units.

## Geometry method and differences from Grasshopper

This is a browser reimplementation, not execution of the original .gh/.ghx file. It uses deterministic Mulberry32 instead of Python's random generator, so seeds reproduce results within this app, not exact Grasshopper arrangements. Rejection sampling selects points in the boundary volume. A short center relaxation spreads crowded seeds. Weighted contact planes partition overlapping spheres into disjoint regions. Pressure compresses radial distances with quintic falloff and a 25% retained core, then contact planes and solid intersection with the original boundary are reapplied. Unlike the source's vertex projection, solid intersections handle complete faces crossing concave walls. Very crowded cells can collapse; these fail with an explicit balloon index rather than being silently dropped. This is form finding, not physical gas/material simulation.

Individual edits enforce wall and frozen-object containment, dent contacted unfrozen neighbors, and clamp destructive requests. Boolean subtraction uses Manifold's tolerance setting (default 0.0001 model units) and checks valid triangles, paired oriented edges, closure, and manifold topology. Failed output checks are advisory: a produced Boolean mesh remains downloadable as Rhino, OBJ, or STL, with explicit warnings and per-check results. Export does not repair the mesh. An empty result or a kernel failure still cannot produce a cavity export; separate input shells remain available. These are numerical/topological checks, not a certification of manufacturing suitability. Self-intersecting or overlapping input boundary shells should be repaired in Rhino first; not every geometric pathology is caught by the import topology check.

The pressure tool deliberately uses inward radial compression without the source's tangential guidance. Exact RhinoCommon output is not promised. One editable attractor curve is supported in this version. .3dm import supports mesh objects, not Breps, block instances, or Rhino layers as boundaries.

## Develop

Node 22.12+ recommended.

```sh
npm ci
npm run dev
npm test
npm run build
```

`predev` and `prebuild` copy the pinned Rhino runtime from node_modules into public/vendor. Dist is fully static and uses relative asset paths, suitable for a GitHub Pages project subdirectory. WASM and the geometry worker are bundled locally, not fetched from a third-party CDN.

## GitHub Pages

In repository Settings → Pages → Build and deployment → Source, select **GitHub Actions**. The included workflow tests, builds, and publishes on pushes to main. If the initial workflow failed before Pages was enabled, rerun it from Actions → Publish Balloon Build.

Expected project URL after successful deployment: https://nmoubarak2023-sys.github.io/Balloon-Simulator/

## Typography

Helvetica Neue LT Pro is referenced through local font names only. No proprietary font file is redistributed. Provide licensed WOFF2 files to guarantee the requested typeface on other devices. Current fallbacks: Helvetica Neue, Helvetica, Arial.

## Tests

Tests cover deterministic interior sampling, rejection of open boundaries, smooth closed mesh generation, full containment and nonoverlap, pressure deformation, constrained editing/reset, concave walls, shell assembly counts, Boolean topology and volume conservation, and Rhino mesh round trip.

## Third-party licenses

Three.js and three-mesh-bvh: MIT. Manifold: Apache-2.0. Rhino3dm/OpenNURBS: McNeel's open-source licenses. See THIRD_PARTY_NOTICES.md and the respective installed package notices. Helvetica Neue LT Pro is a separate commercial font.
