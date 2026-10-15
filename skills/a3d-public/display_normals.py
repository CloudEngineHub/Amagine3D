"""Display-only corner normals; canonical geometry is never modified."""

from __future__ import annotations

import numpy as np
import trimesh


# Fine tessellation on a curved surface should shade continuously, while real
# corners (including a box's 90 degree edges) remain visibly sharp.
CREASE_ANGLE_DEGREES = 30.0


class DisplayNormalsError(ValueError):
    def __init__(self, message, **details):
        super().__init__(message)
        self.issue = {"code": "DISPLAY.NORMALS_INVALID", "message": message, **details}


def shading_normals(
    mesh: trimesh.Trimesh, *, use_existing: bool = False
) -> tuple[np.ndarray, np.ndarray]:
    """Return unit normals and per-face normal indices without moving vertices.

    Derived display meshes store explicitly authored normals in trimesh's cache.
    Read that cache without invoking vertex_normals, which would silently
    generate normals averaged across every shared edge.
    """

    faces = np.asarray(mesh.faces, dtype=np.int64)
    if use_existing:
        existing = mesh._cache.cache.get("vertex_normals")
        if existing is not None:
            normals = np.asarray(existing, dtype=np.float64)
            lengths = np.linalg.norm(normals, axis=1)
            if (
                normals.shape == mesh.vertices.shape
                and np.isfinite(normals).all()
                and np.all(lengths > 1e-12)
            ):
                return normals / lengths[:, None], faces

    adjacency = mesh.face_adjacency
    smooth = mesh.face_adjacency_angles < np.radians(CREASE_ANGLE_DEGREES)
    adjacent_faces = adjacency[smooth]
    shared_edges = mesh.face_adjacency_edges[smooth]

    # Each graph node is one triangle corner. Connect only corners sharing a
    # smooth edge, so a distant smooth path elsewhere on a part cannot erase a
    # local hard edge. Disconnected shells are never welded for appearance.
    links = []
    for edge_end in range(2):
        vertex_ids = shared_edges[:, edge_end]
        first_corner = np.argmax(faces[adjacent_faces[:, 0]] == vertex_ids[:, None], axis=1)
        second_corner = np.argmax(faces[adjacent_faces[:, 1]] == vertex_ids[:, None], axis=1)
        links.append(
            np.column_stack(
                (adjacent_faces[:, 0] * 3 + first_corner,
                 adjacent_faces[:, 1] * 3 + second_corner)
            )
        )
    labels = trimesh.graph.connected_component_labels(
        np.concatenate(links), node_count=faces.size
    )
    normal_faces = labels.reshape((-1, 3))
    normals = trimesh.geometry.weighted_vertex_normals(
        int(labels.max()) + 1, normal_faces, mesh.face_normals, mesh.face_angles
    )
    lengths = np.linalg.norm(normals, axis=1)
    invalid = ~np.isfinite(normals).all(axis=1) | (lengths <= 1e-12)
    if invalid.any():
        # Almost collinear corner angles can round to zero. Use the largest
        # valid incident triangle in the same crease-connected normal group.
        face_ids = np.repeat(np.arange(len(faces)), 3)
        triangles = np.asarray(mesh.vertices, dtype=np.float64)[faces]
        first_edge, second_edge = triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]
        # trimesh zeroes face normals below its area threshold. Rescale the
        # edges before crossing so nonzero slivers retain their true direction.
        # Exactly collinear/zero-area faces remain invalid.
        scale = np.maximum(np.max(np.abs(first_edge), axis=1), np.max(np.abs(second_edge), axis=1))
        safe_scale = np.where(scale > 0, scale, 1.0)
        face_normals = np.cross(first_edge / safe_scale[:, None], second_edge / safe_scale[:, None])
        face_lengths = np.linalg.norm(face_normals, axis=1)
        valid_faces = np.isfinite(face_normals).all(axis=1) & (face_lengths > 0)
        candidates = np.flatnonzero(valid_faces[face_ids])
        ordered = candidates[np.lexsort((-mesh.area_faces[face_ids[candidates]], labels[candidates]))]
        group_ids, first = np.unique(labels[ordered], return_index=True)
        for group, corner in zip(group_ids, ordered[first]):
            if invalid[group]: normals[group] = face_normals[face_ids[corner]] / face_lengths[face_ids[corner]]
        lengths = np.linalg.norm(normals, axis=1)
        invalid = ~np.isfinite(normals).all(axis=1) | (lengths <= 1e-12)
        if invalid.any():
            bad_faces = np.flatnonzero(invalid[normal_faces].any(axis=1))
            bad_vertices = np.unique(faces[bad_faces])
            points = np.asarray(mesh.vertices)[bad_vertices]
            raise DisplayNormalsError("display corners have no valid incident face normal", faceIndices=bad_faces[:32].tolist(),
                vertexIndices=bad_vertices[:32].tolist(), invalidNormalCount=int(invalid.sum()),
                boundsMm={"min": points.min(axis=0).tolist(), "max": points.max(axis=0).tolist()},
                coordinateFrame="semantic-assembly", transform=np.eye(4).tolist())
    normals = normals / np.linalg.norm(normals, axis=1)[:, None]
    return normals, normal_faces


def mesh_with_display_normals(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """Split display vertices at creases; keep every triangle's exact position."""

    normals, normal_faces = shading_normals(mesh)
    _, first_corner = np.unique(normal_faces, return_index=True)
    vertex_ids = np.asarray(mesh.faces).reshape(-1)[first_corner]
    return trimesh.Trimesh(
        vertices=np.asarray(mesh.vertices)[vertex_ids],
        faces=normal_faces,
        vertex_normals=normals,
        metadata=mesh.metadata.copy(),
        process=False,
    )
