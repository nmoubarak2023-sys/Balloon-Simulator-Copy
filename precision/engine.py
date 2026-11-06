"""Isolated native Boolean job. Geometry coordinates are normalized by the client."""
import json
import sys
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for folder in (ROOT / '.precision-python', ROOT.parents[1] / 'work' / 'geometry-python'):
    if folder.exists():
        sys.path.insert(0, str(folder))
import numpy as np
import pymeshlab as ml


def run(data):
    scale = float(data['transform']['scale'])
    center = np.asarray(data['transform']['center'], dtype=np.float64)
    tolerance = float(data['tolerance'])
    if not np.isfinite(scale) or scale <= 0 or not np.isfinite(tolerance) or tolerance <= 0:
        raise ValueError('Invalid scale or tolerance')
    meshes = data['meshes']
    if not 2 <= len(meshes) <= 501:
        raise ValueError('Provide a boundary and 1–500 cutters')
    converted = []
    total = 0
    for raw in meshes:
        p = np.asarray(raw['positions'], dtype=np.float64).reshape(-1, 3)
        t = np.asarray(raw['indices'], dtype=np.int64).reshape(-1, 3)
        total += len(t)
        if total > 2000000 or not np.isfinite(p).all() or not len(t) or t.min() < 0 or t.max() >= len(p):
            raise ValueError('Invalid or excessive input geometry')
        converted.append((p, t))
    vertices, faces, offset = [], [], 0
    for p, t in converted[1:]:
        c = (p.max(axis=0) + p.min(axis=0)) / 2
        radius = np.linalg.norm(p-c, axis=1).max()
        if radius <= 0:
            raise ValueError('Empty cutter')
        # Resolve coincident contact caps. Each cutter vertex moves <= tolerance;
        # never increase the contact-gap setting or voxelize thin walls.
        p = c + (p-c) * (1 + tolerance / scale / radius)
        vertices.append(p)
        faces.append(t + offset)
        offset += len(p)
    ms = ml.MeshSet()
    ms.add_mesh(ml.Mesh(vertex_matrix=converted[0][0], face_matrix=converted[0][1].astype(np.int32)), 'boundary')
    ms.add_mesh(ml.Mesh(vertex_matrix=np.concatenate(vertices), face_matrix=np.concatenate(faces).astype(np.int32)), 'cutters')
    ms.apply_filter('generate_boolean_difference', first_mesh=0, second_mesh=1)
    result = ms.current_mesh()
    world = ml.MeshSet()
    world.add_mesh(ml.Mesh(vertex_matrix=result.vertex_matrix()*scale+center, face_matrix=result.face_matrix()))
    target = scale / 120
    target = round(target, 1-int(math.floor(math.log10(target))))
    world.apply_filter('meshing_isotropic_explicit_remeshing', iterations=5, adaptive=True,
        targetlen=ml.PureValue(target), featuredeg=30.0, checksurfdist=True,
        maxsurfdist=ml.PureValue(tolerance), splitflag=True, collapseflag=True,
        swapflag=True, smoothflag=False, reprojectflag=True)
    result = world.current_mesh()
    if result.face_number() > 3000000:
        raise ValueError('Result exceeds precision-engine face limit')
    return {'positions': result.vertex_matrix().reshape(-1).tolist(),
            'indices': result.face_matrix().reshape(-1).tolist(),
            'nativeEngine': 'PyMeshLab 2025.7.post1 / libigl mesh arrangements',
            'cutterOutsetMaximum': tolerance, 'remeshSurfaceDistance': tolerance}


if __name__ == '__main__':
    data = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    result = run(data)
    Path(sys.argv[2]).write_text(json.dumps(result, allow_nan=False), encoding='utf-8')
