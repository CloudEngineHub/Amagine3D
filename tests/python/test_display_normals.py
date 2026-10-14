from __future__ import annotations

import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import numpy as np
import trimesh


ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "skills" / "a3d-public"
if str(SKILL) not in sys.path:
    sys.path.insert(0, str(SKILL))

from display_step import export_display_step  # noqa: E402
from display_step import invalid_normal_issue
from display_normals import DisplayNormalsError, mesh_with_display_normals
from render_preview import _render_inputs, _surface_checks  # noqa: E402


class DisplayNormalsTests(unittest.TestCase):
    def test_sliver_triangle_keeps_exact_positions_and_has_unit_corner_normals(self):
        mesh = trimesh.Trimesh(vertices=[[0, 0, 0], [1, 0, 0], [2, 1e-8, 0]], faces=[[0, 1, 2]], process=False)
        displayed = mesh_with_display_normals(mesh)
        np.testing.assert_array_equal(displayed.vertices[displayed.faces], mesh.vertices[mesh.faces])
        np.testing.assert_allclose(np.linalg.norm(displayed._cache.cache["vertex_normals"], axis=1), 1.0)
        mesh.vertices[2, 1] = 0
        with self.assertRaises(DisplayNormalsError): mesh_with_display_normals(mesh)

    def test_failed_readback_reports_three_bad_vertices_and_their_local_bounds(self):
        mesh = trimesh.Trimesh(vertices=[[9.949873924, -33, 36], [9.950095177, -33, 36],
                                       [9.95, -32.99993515, 36]], faces=[[0, 1, 2]], process=False)
        mesh._cache.cache['vertex_normals'] = np.zeros((3, 3))
        issue = invalid_normal_issue(mesh, 'body')
        self.assertEqual(issue['invalidNormalCount'], 3)
        self.assertEqual(issue['vertexIndices'], [0, 1, 2])
        self.assertEqual(issue['faceIndices'], [0])
        self.assertEqual(issue['partId'], 'body')
        self.assertEqual(issue['boundsMm']['min'], [9.949873924, -33.0, 36.0])

    def test_step_recovered_sliver_below_trimesh_area_threshold_keeps_unit_normals(self):
        points = [[9.95009547547785, -32.99993333370332, 36.0],
                  [9.949874371067, -33.0, 36.0], [9.949984923328199, -32.999966667036645, 36.0]]
        mesh = trimesh.Trimesh(vertices=points, faces=[[0, 1, 2]], process=False)
        self.assertTrue(mesh.area_faces[0] > 0)
        self.assertLess(mesh.area_faces[0], 1e-13)
        np.testing.assert_array_equal(mesh.face_normals, [[0, 0, 0]])
        display = mesh_with_display_normals(mesh)
        np.testing.assert_array_equal(display.vertices[display.faces], mesh.vertices[mesh.faces])
        np.testing.assert_allclose(display.vertex_normals, [[0, 0, 1]] * 3)

    def test_sphere_normals_are_smooth_without_changing_triangle_positions(self):
        sphere = trimesh.creation.icosphere(subdivisions=2, radius=4.0)
        displayed = mesh_with_display_normals(sphere)
        radial = displayed.vertices / np.linalg.norm(displayed.vertices, axis=1)[:, None]
        self.assertGreater(float(np.min(np.sum(displayed.vertex_normals * radial, axis=1))), 0.999)
        np.testing.assert_array_equal(displayed.vertices[displayed.faces], sphere.vertices[sphere.faces])

    def test_box_keeps_hard_edges_even_with_cached_global_normals(self):
        box = trimesh.creation.box(extents=[3, 4, 5])
        _ = box.vertex_normals
        displayed = mesh_with_display_normals(box)
        self.assertEqual(len(displayed.vertices), 24)
        expected = np.repeat(box.face_normals[:, None, :], 3, axis=1)
        np.testing.assert_allclose(displayed.vertex_normals[displayed.faces], expected, atol=1e-6)
        np.testing.assert_array_equal(displayed.vertices[displayed.faces], box.vertices[box.faces])

if __name__ == "__main__":
    unittest.main()
