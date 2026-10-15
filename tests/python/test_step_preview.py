from pathlib import Path
from hashlib import sha256
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
from build123d import Box, Compound, Pos, Rot, Sphere, export_step, import_step

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'skills/a3d-public'))
from display_step import DisplayStepError, export_display_step, preview_payload, scene_path, step_meshes


class StepPreviewTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(dir=ROOT / 'workspace/skill-validation')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def export(self):
        path = self.root / 'display.step'
        export_display_step([('body', Box(10, 20, 30), {'baseColor': '#123456'})], path,
                            display_items=[('module', Pos(25, 0, 0) * Sphere(3), {'baseColor': '#FFA500'})])
        return path

    def test_payload_is_bound_to_cad_and_keeps_roles_colors_and_transforms(self):
        path = self.export()
        with patch('trimesh.Scene.export', side_effect=AssertionError('GLB exporter must not run')):
            payload = preview_payload(path)
        self.assertEqual(payload['inputs']['step']['sha256'], sha256(path.read_bytes()).hexdigest())
        self.assertEqual(len(import_step(path).solids()), 2)
        objects = {obj['id']: obj for obj in payload['objects']}
        self.assertEqual(objects['body']['metadata']['role'], 'manufactured')
        self.assertEqual(objects['module']['metadata']['role'], 'display-only')
        self.assertEqual(objects['body']['appearance']['baseColor'], '#123456')
        positions = np.asarray(objects['module']['positions']).reshape(-1, 3)
        self.assertAlmostEqual((positions[:, 0].min() + positions[:, 0].max()) / 2, 25, places=2)
        for obj in objects.values():
            normals = np.asarray(obj['normals']).reshape(-1, 3)
            np.testing.assert_allclose(np.linalg.norm(normals, axis=1), 1, atol=1e-6)
        self.assertFalse(list(self.root.rglob('*.glb')))

    def test_stale_step_and_stale_object_are_rejected(self):
        path = self.export()
        descriptor = json.loads(scene_path(path).read_text())
        object_path = Path(descriptor['objects'][0]['step']['path'])
        object_path.write_bytes(object_path.read_bytes() + b'changed')
        with self.assertRaisesRegex(DisplayStepError, 'changed'):
            preview_payload(path)
        export_step(Box(1, 1, 1), path)
        with self.assertRaisesRegex(DisplayStepError, 'stale'):
            preview_payload(path)

    def test_external_object_path_is_rejected(self):
        path = self.export()
        descriptor = json.loads(scene_path(path).read_text())
        descriptor['objects'][0]['step']['path'] = str(ROOT / 'AGENTS.md')
        scene_path(path).write_text(json.dumps(descriptor))
        with self.assertRaisesRegex(DisplayStepError, 'outside'):
            preview_payload(path)

    def test_plain_step_does_not_guess_manufacturing_roles(self):
        path = self.root / 'standalone.step'
        export_step(Box(8, 9, 10), path)
        payload = preview_payload(path)
        self.assertEqual(payload['objects'][0]['metadata']['role'], 'unclassified')

    def test_nested_repeated_instances_preserve_world_placement_and_unique_ids(self):
        left, right = Pos(-5, 0, 0) * Box(2, 4, 6), Pos(5, 0, 0) * Box(2, 4, 6)
        left.label = right.label = 'repeat'
        group = Pos(30, 20, 10) * Rot(0, 0, 90) * Compound(children=[left, right])
        path = self.root / 'nested.step'
        export_step(Compound(children=[group]), path)
        payload = preview_payload(path)
        self.assertEqual(len(payload['objects']), 2)
        self.assertEqual(len({obj['id'] for obj in payload['objects']}), 2)
        positions = np.concatenate([np.asarray(obj['positions']).reshape(-1, 3) for obj in payload['objects']])
        np.testing.assert_allclose(positions.min(axis=0), [28, 14, 7], atol=1e-5)
        np.testing.assert_allclose(positions.max(axis=0), [32, 26, 13], atol=1e-5)

    def test_display_tessellation_does_not_change_step_bytes(self):
        path = self.export()
        before = path.read_bytes()
        first, _ = step_meshes(path)
        second, _ = step_meshes(path)
        self.assertEqual(path.read_bytes(), before)
        np.testing.assert_array_equal(first[0][1].vertices, second[0][1].vertices)

    def test_exact_geometry_reuse_preserves_per_instance_colors_and_positions(self):
        import geometry_binding
        path = self.root / 'repeated.step'
        export_display_step([
            ('left', Pos(-10, 0, 0) * Box(2, 4, 6), {'baseColor': '#FF0000'}),
            ('right', Pos(10, 0, 0) * Box(2, 4, 6), {'baseColor': '#00FF00'}),
            ('different', Pos(30, 0, 0) * Box(3, 4, 6), {'baseColor': '#0000FF'}),
        ], path)
        with patch('geometry_binding.shape_to_mesh', wraps=geometry_binding.shape_to_mesh) as tessellate:
            payload = preview_payload(path)
        self.assertEqual(tessellate.call_count, 2, 'only byte-identical local BRep can reuse tessellation')
        objects = {obj['id']: obj for obj in payload['objects']}
        for name, x, color in [('left', -10, '#FF0000'), ('right', 10, '#00FF00'), ('different', 30, '#0000FF')]:
            positions = np.asarray(objects[name]['positions']).reshape(-1, 3)
            self.assertAlmostEqual((positions[:, 0].min() + positions[:, 0].max()) / 2, x)
            self.assertEqual(objects[name]['appearance']['baseColor'], color)

    def test_instancing_preserves_authored_normals_instead_of_recomputing_them(self):
        path = self.root / 'authored-normal.step'
        export_display_step([('body', Pos(20, 0, 0) * Box(2, 4, 6), {'baseColor': '#FFFFFF'})], path)
        authored = np.asarray([1, 1, 0]) / np.sqrt(2)
        def normalizer(mesh):
            mesh.vertex_normals = np.tile(authored, (len(mesh.vertices), 1))
            return mesh
        with patch('display_step.mesh_with_display_normals', side_effect=normalizer):
            payload = preview_payload(path)
        observed = np.asarray(payload['objects'][0]['normals']).reshape(-1, 3)
        np.testing.assert_allclose(observed, np.tile(authored, (len(observed), 1)), atol=1e-6)

    def test_duplicate_ids_are_rejected_before_cad_export(self):
        path = self.root / 'invalid.step'
        with self.assertRaisesRegex(DisplayStepError, 'unique'):
            export_display_step([('same', Box(1, 1, 1), {'baseColor': '#FFFFFF'}),
                                 ('same', Box(2, 2, 2), {'baseColor': '#FFFFFF'})], path)
        self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main()
