from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import trimesh
from trimesh.visual.material import PBRMaterial


ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "skills" / "a3d-public"
if str(SKILL) not in sys.path:
    sys.path.insert(0, str(SKILL))

import render_preview  # noqa: E402


class RenderPreviewMaterialTests(unittest.TestCase):
    def test_step_object_materials_survive_the_visual_evidence_render(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            from build123d import Box, Pos
            from display_step import export_display_step
            model = root / "colored-display.step"
            export_display_step([
                ("body/red-region", Box(4, 4, 4), {"baseColor": "#FF0000"}),
                ("body/green-region", Pos(5, 0, 0) * Box(4, 4, 4), {"baseColor": "#00FF00"}),
            ], model)

            inputs = render_preview._render_inputs(model, (1, 2, 3))
            self.assertEqual(
                {item.color for item in inputs},
                {(255, 0, 0), (0, 255, 0)},
            )

            report = root / "render.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SKILL / "render_preview.py"),
                    str(model),
                    "--out",
                    str(root / "views.png"),
                    "--report",
                    str(report),
                    "--size",
                    "320",
                ],
                capture_output=True,
                check=False,
                text=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            payload = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(
                {tuple(item["preview_color_rgb"]) for item in payload["meshes"]},
                {(255, 0, 0), (0, 255, 0)},
            )


if __name__ == "__main__":
    unittest.main()
