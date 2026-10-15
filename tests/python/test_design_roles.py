"""Pure subtractive bodies have a structural binding without extra geometry."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "skills/a3d-public"))
from design_language import normalize
from design_roles import requirement_role, structural_issues
from tests.python.test_design_language import box_design, geometry


class DesignRoleTests(unittest.TestCase):
    def test_cutter_only_result_is_diagnosed_and_identity_binding_keeps_geometry(self):
        document = box_design()
        document["parts"]["body"]["features"][1]["requirement"] = "body-envelope"
        before = geometry(document)[0]["body"]
        issues = structural_issues(normalize(document), {"body"}, revision="revision-a")
        self.assertEqual(issues[0]["code"], "DESIGN.STRUCTURAL_BINDING_MISSING")
        self.assertEqual(issues[0]["actual"][0]["role"], "cutter")
        self.assertEqual(issues[0]["designRevision"], "revision-a")
        fixed = deepcopy(document)
        del fixed["parts"]["body"]["features"][1]["requirement"]
        fixed["parts"]["body"]["features"].append({"id": "envelope", "op": "translate", "input": "@body.cavity",
                                                  "offset": [0, 0, 0], "requirement": "body-envelope"})
        fixed["parts"]["body"]["result"] = "@body.envelope"
        self.assertEqual(structural_issues(normalize(fixed), {"body"}), [])
        after = geometry(fixed)[0]["body"]
        self.assertAlmostEqual(before.volume, after.volume, places=8)
        self.assertEqual(list(before.bounding_box().min), list(after.bounding_box().min))
        self.assertEqual(list(before.bounding_box().max), list(after.bounding_box().max))

    def test_unrelated_solid_and_cutting_tools_do_not_supply_result_material(self):
        document = box_design()
        document["parts"]["body"]["features"].append({"id": "unused", "op": "box", "size": [2, 2, 2], "requirement": "fake-solid"})
        self.assertTrue(structural_issues(normalize(document), {"body"}))
        document["parts"]["body"]["features"].append({"id": "cut", "op": "cut", "body": "@body.cavity", "tools": ["@body.unused"]})
        document["parts"]["body"]["result"] = "@body.cut"
        self.assertTrue(structural_issues(normalize(document), {"body"}))
        self.assertEqual(requirement_role("cut"), "cutter")
        self.assertEqual(requirement_role("translate"), "separate")
