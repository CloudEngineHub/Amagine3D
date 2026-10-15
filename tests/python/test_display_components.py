from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import numpy as np
import trimesh
from build123d import Box, Rectangle


ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "skills" / "a3d-public"
if str(SKILL) not in sys.path:
    sys.path.insert(0, str(SKILL))

from display_step import DisplayStepError, export_display_step, load_display_components
from geometry_binding import GeometryBindingError, bind_display_component


def surface() -> trimesh.Trimesh:
    return trimesh.Trimesh(
        vertices=[[1, 2, 3], [5, 2, 3], [5, 4, 3], [1, 4, 3]],
        faces=[[0, 1, 2], [0, 2, 3]],
        process=False,
    )


class DisplayComponentTests(unittest.TestCase):
    def bind(self, root: Path, shape, suffix: str = ".step") -> dict:
        return bind_display_component(
            node_id="installed-component",
            feature_id="reference/installed-component",
            physical_feature_ref="component-support",
            shape=shape,
            path=root / f"component-source{suffix}",
            appearance={"baseColor": "#aabbcc", "roughness": 0.2},
        )

    def test_triangle_mesh_cannot_be_relabelled_as_step(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            with self.assertRaisesRegex(GeometryBindingError, "requires BRep"):
                self.bind(Path(directory), surface())

    def test_brep_solid_and_face_sources_are_supported(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            for shape, suffix in [(Box(2, 3, 4), ".step"), (Rectangle(2, 3).face(), ".stp")]:
                with self.subTest(suffix=suffix):
                    node = self.bind(root, shape, suffix)
                    items = load_display_components({"nodes": [node]}, root / "scene.json")
                    self.assertGreater(len(items[0][1].faces()), 0)
                    self.assertEqual(node["recipe"]["kind"], "displayComponent")

    def test_bound_source_change_is_rejected(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            node = self.bind(root, Rectangle(2, 3).face())
            Path(node["recipe"]["parameters"]["sourceStep"]["path"]).write_bytes(b"changed")
            with self.assertRaisesRegex(DisplayStepError, "sha256 does not match"):
                load_display_components({"nodes": [node]}, root / "scene.json")

    def test_non_step_destination_is_rejected_before_writing(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            with self.assertRaisesRegex(GeometryBindingError, "requires BRep"):
                self.bind(root, Box(2, 3, 4), ".stl")
            self.assertFalse(list(root.iterdir()))

    def test_step_roundtrip_encodes_roles_and_support_without_name_heuristics(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            node = self.bind(root, Rectangle(2, 3).face())
            display = load_display_components({"nodes": [node]}, root / "scene.json")
            physical = Box(2, 3, 4)
            physical._a3d_metadata = {"role": "display-only", "physicalFeatureRef": "stale"}
            path = root / "assembly-display.step"
            report = export_display_step(
                [("screen-lens", physical, {"baseColor": "#AABBCC"})],
                path,
                display_items=display,
            )
            self.assertEqual(report["physicalNodeNames"], ["screen-lens"])
            self.assertEqual(report["displayOnlyNodeNames"], ["installed-component"])
            from display_step import step_meshes
            items, _ = step_meshes(path)
            extras = {name: mesh.metadata["amagine3d"] for name, mesh, _ in items}
            self.assertEqual(extras, {
                "screen-lens": {"role": "manufactured"},
                "installed-component": {
                    "role": "display-only", "physicalFeatureRef": "component-support"
                },
            })
            self.assertEqual(physical._a3d_metadata["role"], "display-only")

    def test_step_allows_an_entirely_manufactured_preview(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            root = Path(directory)
            result = export_display_step(
                [("housing", Box(2, 3, 4), {"baseColor": "#123456"})],
                root / "housing-display.step",
            )
            self.assertEqual(result["displayOnlyNodeNames"], [])
            self.assertEqual(result["physicalNodeNames"], ["housing"])
            self.assertTrue(result["verified"])


if __name__ == "__main__":
    unittest.main()
