# Precision output

Double-click `Start-Balloon-Precision.cmd` and leave its window open. In Balloon Build choose **Boolean subtraction**, then **Precision / thin walls (local engine)**, and build output. The regular browser output modes do not require this service.

This optional service runs PyMeshLab/libigl mesh arrangements in an isolated process on your computer, followed by constrained native remeshing and double-precision cleanup in the website worker. It binds only to 127.0.0.1:8788; geometry is not uploaded to another computer. It accepts the local preview and the Balloon Simulator GitHub Pages origin. Browsers may request permission to access a local service.

The contact-gap parameter is retained. Coincident cutter caps receive an outward displacement of at most the supplied tolerance, and native remeshing checks surface distance against that tolerance with smoothing disabled. Cleanup can collapse sub-tolerance edges and remove closed, disconnected numerical sheets entirely confined to a sub-tolerance slab. These are separate tolerance-limited stages, not a guarantee of a single cumulative Hausdorff bound. No voxel grid or global smoothing is used. Sharp design edges remain sharp.

The quality report includes remaining thin triangles, topology and a bounded proper-crossing audit. Coplanar overlaps and all forms of self-contact are not certified. Warnings do not prevent export. Preserve the project JSON and original shells for review.

GitHub Pages hosts static files and cannot run this Python engine. Other visitors must run their own local engine to use Precision output; the existing public browser modes remain available. A shared cloud precision engine would require separate hosting.

Python dependencies are pinned in `requirements.txt`. Native dependencies and temporary geometry are excluded from Git. Only one calculation runs at a time, with a five-minute timeout and Cancel support.
