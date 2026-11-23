# Independent Balloon Build copy

This directory contains a separate copy of the current local website, including the unpublished trumpet-shaped column update. Edit files here for the copy. The original directory is `../balloon-build`.

Double-click **Start-Website-Copy.cmd** to start the editable local website and open it in your browser. The first launch uses http://127.0.0.1:5183/. If that port is occupied, the launcher tries another port and remembers the working address. Keep its server window open while using the local copy. The launcher uses the local Node.js runtime in `.local-runtime`, when present, so it can run independently of Codex updates.

Keep this entire project folder, including `node_modules` and `.local-runtime`. Edit the source files in `src` to continue development. The source is also backed up in the GitHub repository below. The local runtime is excluded from Git.

Autosave restores work in the same browser profile and website address. Keep using the same port. Project JSON downloads provide a portable copy of design work across browsers and addresses.

In VORONOI BALLOONS, the optional ZONE LAYOUT section offers EXISTING / CUSTOM (the default) and COLLABORATION OFFICE. Set direction, bay spacing, elongation and height, use PREVIEW LAYOUT, then APPLY ZONE LAYOUT to regenerate only the editing zone with an undo checkpoint. Existing projects are not converted automatically. Individual balloon editing remains available. Native radius controls still work with collaboration; changing Point Count or Point Seed returns that zone to the original custom generator. Review previously placed columns and walls if regenerated ridges move.

The copy uses its own Git history and a separate repository: https://github.com/nmoubarak2023-sys/Balloon-Simulator-Copy . Its publisher checks that exact remote before pushing.

Public website: https://nmoubarak2023-sys.github.io/Balloon-Simulator-Copy/ . The deployment workflow tests, builds, and deploys the copy after pushes to main.

Different ports have separate browser storage. Saved geometries from other local addresses do not appear automatically. Export a project JSON at the old address and open it at the new address to transfer one.

Build: `node scripts/prepare-vendor.js` then `node node_modules/vite/bin/vite.js build --base=./`.
Standalone package: `node scripts/standalone.js` (writes inside this directory only).
Optional native precision engine: double-click `Start-Balloon-Precision.cmd`; this copy uses port 8789.
