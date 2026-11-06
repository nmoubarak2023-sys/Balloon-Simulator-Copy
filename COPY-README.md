# Independent Balloon Build copy

This directory contains a separate copy of the current local website, including the unpublished trumpet-shaped column update. Edit files here for the copy. The original directory is `../balloon-build`.

Double-click **Start-Website-Copy.cmd**, then open http://127.0.0.1:5180 . Keep its server window open while using the local copy.

The copy uses its own Git history and has no Git remote. The original publisher is disabled here. No public copy has been published.

The different port gives the copy separate browser storage. Saved geometries from the original website do not appear automatically; export a project JSON from the original and open it in the copy to transfer one.

Build: `node scripts/prepare-vendor.js` then `node node_modules/vite/bin/vite.js build --base=./`.
Standalone package: `node scripts/standalone.js` (writes inside this directory only).
Optional native precision engine: double-click `Start-Balloon-Precision.cmd`; this copy uses port 8789.
