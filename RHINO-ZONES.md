# Rhino floor perimeter and population zones

This feature is in the independent Balloon-Simulator-Copy project.

1. In Rhino, draw one closed outer perimeter on a horizontal plane.
2. Add connected divider curves, closed inner zone outlines, or a mixture. Divider endpoints must meet another divider or the perimeter. Crossing dividers are split automatically.
3. Export the selected curves as a `.3dm` file with defined model units.
4. In Voronoi Balloons choose **Import Floor Curves .3DM**. The largest closed curve is the outer perimeter; the enclosed regions become zones.
5. Select **Population zone** and set that zone's point count/seed, nearest-cluster anchor/count, radius range and radius seed. Choose **Generate Enclosure** after editing.
6. Floor Z, mesh spacing and smoothing are shared. Balloon geometry is clipped to its own zone. Touching zone volumes are combined for the final enclosure; disconnected results are reported.

The plan view highlights the selected zone in pink. Construction steps show the imported boundaries, points, clipped Voronoi territories, balloons, footprint and final enclosure. Pop and Freeze retain stable per-zone IDs. Saving a project or saved geometry keeps the imported boundary and every zone's settings.

Supported input: up to 200 horizontal planar curves, 6,000 sampled segments and 20 zones. Up to 150 candidate points per zone and 200 selected balloons in total. Polylines retain their vertices; NURBS curves are sampled adaptively. Millimeters, centimeters, decimeters, meters, kilometers, inches, feet, yards and miles are converted to feet. Unitless or tilted curves produce an explicit import message rather than being silently rescaled/projected.

Existing rectangular projects remain loadable for compatibility. The new workflow starts with a zoned example and imports Rhino curves instead of choosing a rectangle size.
