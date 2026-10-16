"""Design contracts, atomic edits, real geometry and existing CLI integration."""
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "skills" / "a3d-public"
sys.path.insert(0, str(RUNTIME))

import agent_api
from agent_protocol import binding, MAX_WIRE_BYTES, wire_size
from design_api import apply, load, read
from design_build import build_geometry
from design_language import DesignError, capabilities, normalize, SCHEMA, VERSION


def box_design():
    return {"schema": SCHEMA, "units": {"length": "mm", "angle": "deg"},
            "params": {key: {"type": "length", "value": value} for key, value in
                       {"width": 100, "depth": 70, "height": 30, "wall": 2, "floor": 2}.items()},
            "frames": {"top": {"origin": [0, 0, "=height"], "u": [1, 0, 0], "normal": [0, 0, 1]}},
            "profiles": {"inner": {"op": "rectangle", "size": ["=width - 2*wall", "=depth - 2*wall"]}},
            "parts": {"body": {"features": [
                {"id": "blank", "op": "box", "size": ["=width", "=depth", "=height"], "align": ["center", "center", "min"]},
                {"id": "cavity", "op": "pocket", "body": "@body.blank", "profile": "@profiles.inner",
                 "frame": "@frames.top", "direction": "-normal", "depth": {"mode": "blind", "length": "=height - floor"}}],
                "result": "@body.cavity"}}}


def geometry(document):
    import cad_helpers
    with cad_helpers._evidence_scope(cad_helpers._EvidenceState()):
        return build_geometry(normalize(document))


class DesignContractTests(unittest.TestCase):
    def test_capability_examples_are_usable_without_reading_implementation(self):
        contract = capabilities(["rotate", "fillet", "hole", "loft", "self_tapping_screw"])
        self.assertEqual(contract["version"], VERSION)
        self.assertEqual(contract["parameterDefinition"]["optional"]["label"],
                         {"en": "nonempty English display string, 1..48 characters",
                          "zh": "nonempty Chinese display string, 1..48 characters"})
        types = contract["fieldTypes"]
        document = box_design()
        document["parts"]["body"]["features"].extend([
            {"id": "spin", "op": "rotate", "input": "@body.cavity", "axis": types["axis"]["example"], "angle": 90},
            {"id": "round", "op": "fillet", "body": "@body.blank", "edges": types["selector"]["example"], "radius": 1},
        ])
        normalize(document)
        self.assertEqual(types["depth"]["choices"][1], {"mode": "through_all"})
        self.assertEqual(types["sections"]["item"], {"profile": "ref:Profile", "frame": "ref:Frame"})
        self.assertEqual(types["Frame"]["required"]["normal"], "direction")
        self.assertIn("locator_pairs", contract["operations"]["self_tapping_screw"]["intent"]["fastening"])
        self.assertNotIn("selector", capabilities(["box"])["fieldTypes"])

    def test_bilingual_parameter_labels_validate_and_do_not_change_geometry(self):
        document = box_design()
        before_ir = normalize(document)
        before_shape = geometry(document)[0]["body"]
        document["params"]["width"]["label"] = {"en": "@frames.missing", "zh": "=height + wall"}
        after_ir = normalize(document)
        after_shape = geometry(document)[0]["body"]
        self.assertEqual(after_ir["params"], before_ir["params"])
        self.assertEqual(after_ir["nodes"], before_ir["nodes"])
        self.assertAlmostEqual(after_shape.volume, before_shape.volume, places=8)
        self.assertEqual(list(after_shape.bounding_box().min), list(before_shape.bounding_box().min))
        self.assertEqual(list(after_shape.bounding_box().max), list(before_shape.bounding_box().max))

        invalid_labels = (
            ({"en": "Width"}, "DESIGN.SCHEMA"),
            ({"en": "Width", "zh": "宽", "fr": "Largeur"}, "DESIGN.SCHEMA"),
            ({"en": "", "zh": "宽"}, "DESIGN.SCHEMA"),
            ({"en": "Width", "zh": 7}, "DESIGN.SCHEMA"),
            ({"en": "x" * 49, "zh": "宽"}, "DESIGN.SCHEMA"),
            (["Width", "宽"], "DESIGN.TYPE"),
        )
        for label, code in invalid_labels:
            with self.subTest(label=label):
                invalid = box_design()
                invalid["params"]["width"]["label"] = label
                with self.assertRaises(DesignError) as raised:
                    normalize(invalid)
                self.assertEqual(raised.exception.issue["code"], code)

    def test_parameters_are_dimensional_and_dependency_sorted(self):
        document = box_design()
        document["params"]["width"]["value"] = "=depth + mm(30)"
        ir = normalize(document)
        self.assertEqual(ir["params"]["width"], 100)
        self.assertEqual(ir["nodes"][-1]["args"]["depth"]["length"], 28)
        document["params"]["width"]["value"] = "=depth + 30"
        with self.assertRaises(DesignError) as raised:
            normalize(document)
        self.assertEqual(raised.exception.issue["code"], "DESIGN.UNIT")

    def test_bad_expressions_cycles_and_domains_are_rejected(self):
        for value in ('=__import__("os")', '=depth.real', '=depth / 0', '=width', '=sqrt(-1)'):
            with self.subTest(value=value):
                document = box_design()
                document["params"]["width"]["value"] = value
                with self.assertRaises(DesignError):
                    normalize(document)
        document = box_design()
        document["params"]["wall"]["range"] = [0.5, 1.5]
        with self.assertRaises(DesignError):
            normalize(document)

    def test_reference_types_cycles_and_selector_versions(self):
        for change, code in (({"body": "@profiles.inner"}, "TYPE"), ({"body": "@body.cavity"}, "CYCLE"),
                             ({"frame": "@frames.missing"}, "REFERENCE")):
            document = box_design()
            document["parts"]["body"]["features"][1].update(change)
            with self.assertRaises(DesignError) as raised:
                normalize(document)
            self.assertEqual(raised.exception.issue["code"], "DESIGN." + code)
        document = box_design()
        document["parts"]["body"]["features"].append({"id": "round", "op": "fillet", "body": "@body.cavity",
                    "edges": {"of": "@body.blank", "where": {}, "expect": {"count": 4}}, "radius": 1})
        with self.assertRaises(DesignError):
            normalize(document)

    def test_frames_ownership_arrays_and_unsupported_operations(self):
        document = box_design()
        document["frames"]["top"]["u"] = [0, 0, 1]
        with self.assertRaises(DesignError):
            normalize(document)
        document = box_design()
        document["parts"]["other"] = {"features": [{"id": "cut", "op": "cut", "body": "@body.blank", "tools": ["@body.cavity"]}], "result": "@other.cut"}
        with self.assertRaises(DesignError) as raised:
            normalize(document)
        self.assertEqual(raised.exception.issue["code"], "DESIGN.OWNERSHIP")
        for invalid in ({"op": "call", "function": "eval"}, {"op": []}, {"op": "box", "size": [True, 2, 3]}):
            document = box_design()
            document["parts"]["body"]["features"][0] = {"id": "blank", **invalid}
            with self.assertRaises(DesignError):
                normalize(document)

    def test_issue_identity_survives_feature_reordering(self):
        document = box_design()
        document["parts"]["body"]["features"][1]["frame"] = "@frames.missing"
        identities = []
        for _ in range(2):
            with self.assertRaises(DesignError) as raised:
                normalize(document)
            from cad_compile import _issue_identity
            identities.append(_issue_identity(raised.exception.issue))
            document["parts"]["body"]["features"].reverse()
        self.assertEqual(identities[0], identities[1])

    def test_requirement_uniqueness_and_placement_limit_are_static_checks(self):
        document = box_design()
        for node in document["parts"]["body"]["features"]:
            node["requirement"] = "duplicate"
        with self.assertRaises(DesignError):
            normalize(document)
        document = box_design()
        document["parts"]["body"]["features"].append({"id": "array", "op": "placements", "input": "@body.blank", "offsets": [[i,0,0] for i in range(65)]})
        with self.assertRaises(DesignError) as raised:
            normalize(document)
        self.assertEqual(raised.exception.issue["code"], "DESIGN.RESOURCE_LIMIT")


class DesignWorkspace(unittest.TestCase):
    def setUp(self):
        directory = ROOT / "workspace" / "skill-validation"
        directory.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=directory)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.path = self.root / "box.a3d.json"
        self.path.write_text(json.dumps(box_design()))
        self.revision = binding(self.path)["sha256"]

    def apply(self, changes, revision=None):
        return apply(self.root, {"action": "apply", "design": self.path.name,
                                "baseRevision": revision or self.revision, "changes": changes})


class DesignEditTests(DesignWorkspace):
    def test_local_edit_keeps_other_definitions_and_noop_keeps_revision(self):
        original = json.loads(self.path.read_text())
        changes = [{"kind": "update", "target": "params.wall", "set": {"value": 2.4}}]
        response = self.apply(changes)
        updated = json.loads(self.path.read_text())
        self.assertEqual(updated["parts"], original["parts"])
        self.assertEqual(updated["profiles"], original["profiles"])
        self.assertNotEqual(response["revision"], self.revision)
        before = self.path.read_bytes()
        repeated = self.apply(changes, response["revision"])
        self.assertFalse(repeated["changed"])
        self.assertEqual(self.path.read_bytes(), before)

    def test_batch_failure_is_atomic_and_identifies_the_change(self):
        before = self.path.read_bytes()
        changes = [{"kind": "update", "target": "params.wall", "set": {"value": 2.4}},
                   {"kind": "update", "target": "params.height", "set": {"value": "=width + 2"}}]
        with self.assertRaises(DesignError) as raised:
            self.apply(changes)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(raised.exception.issue["target"], "params.height")
        self.assertEqual(raised.exception.issue["change"], 1)

    def test_stale_revision_and_external_edit_do_not_overwrite(self):
        self.apply([{"kind": "update", "target": "params.wall", "set": {"value": 3}}])
        before = self.path.read_bytes()
        with self.assertRaises(DesignError):
            self.apply([{"kind": "update", "target": "params.height", "set": {"value": 32}}])
        self.assertEqual(self.path.read_bytes(), before)
        self.path.write_bytes(before + b"\n")
        with self.assertRaises(DesignError):
            load(self.root, self.path.name, binding(self.path)["sha256"][:-1] + "0")

    def test_nested_field_is_replaced_and_deletions_have_no_cascade(self):
        result = self.apply([{"kind": "update", "target": "body.cavity", "set": {"depth": {"mode": "through_all"}}}])
        self.assertEqual(json.loads(self.path.read_text())["parts"]["body"]["features"][1]["depth"], {"mode": "through_all"})
        for change in ({"kind": "remove", "target": "body.blank"}, {"kind": "remove", "target": "parts.body"},
                       {"kind": "update", "target": "parts.body", "set": {"features": []}}):
            with self.assertRaises(DesignError):
                self.apply([change], result["revision"])

    def test_create_batch_forward_references_and_explicit_result(self):
        self.path.unlink()
        result = apply(self.root, {"action": "apply", "design": self.path.name, "baseRevision": None, "changes": [
            {"kind": "add", "target": "body.box", "value": {"op": "box", "size": [10, 12, 14]}},
            {"kind": "add", "target": "parts.body", "value": {"result": "@body.box"}}]})
        self.assertTrue(result["staticValid"])
        with self.assertRaises(DesignError):
            apply(self.root, {"action": "apply", "design": self.path.name, "baseRevision": None, "changes": [
                {"kind": "add", "target": "params.x", "value": {"type": "length", "value": 10}}]})

    def test_read_has_local_dependencies_and_context_recovers_active_design(self):
        self.apply([{"kind": "update", "target": "params.wall", "set": {"value": 3}}])
        response = read(self.root, {"action": "read", "design": self.path.name, "view": "nodes", "ids": ["profiles.inner"],
                                   "include": ["directDependencies", "directDependents"]})
        item = response["nodes"]["profiles.inner"]
        self.assertIn("params.wall", item["directDependencies"])
        self.assertEqual(item["directDependents"], ["body.cavity"])
        self.assertNotIn("parts", response)
        self.assertEqual(agent_api.context(self.root, {})["design"]["revision"], response["revision"])
        invalid = agent_api.dispatch(self.root, "design", {"action": "apply", "design": self.path.name,
                        "baseRevision": response["revision"], "changes": [{"kind": "remove", "target": "body.blank"}]})
        self.assertEqual(invalid["status"], "failed")

    def test_parameter_labels_are_preserved_but_never_read_as_references_or_expressions(self):
        self.apply([{"kind": "update", "target": "params.wall", "set": {
            "label": {"en": "@frames.missing", "zh": "=width + height"},
        }}])
        response = read(self.root, {"action": "read", "design": self.path.name, "view": "nodes",
                                   "ids": ["params.wall", "params.width"],
                                   "include": ["directDependencies", "directDependents"]})
        wall = response["nodes"]["params.wall"]
        width = response["nodes"]["params.width"]
        self.assertEqual(wall["definition"]["label"], {"en": "@frames.missing", "zh": "=width + height"})
        self.assertEqual(wall["directDependencies"], [])
        self.assertNotIn("params.wall", width["directDependents"])

    def test_large_query_is_budgeted_and_full_fields_are_recoverable(self):
        document = box_design()
        for i in range(20):
            document["profiles"][f"shape-{i}"] = {"op": "polygon", "points": [[j, (j % 2) * 10] for j in range(120)]}
        self.path.write_text(json.dumps(document))
        result = agent_api.dispatch(self.root, "design", {"action": "read", "design": self.path.name,
                         "view": "nodes", "ids": [f"profiles.shape-{i}" for i in range(20)]})
        self.assertLessEqual(wire_size(result), MAX_WIRE_BYTES)
        full = json.loads(Path(result["report"]["path"]).read_text())
        self.assertEqual(full["nodes"]["profiles.shape-0"]["definition"]["points"], document["profiles"]["shape-0"]["points"])

    def test_context_remembers_only_delivered_supported_operation_contracts(self):
        page = agent_api.dispatch(self.root, "capabilities", {"designOps": ["box", "hole", "unavailable"]})
        self.assertLessEqual(wire_size(page), MAX_WIRE_BYTES)
        self.assertIn("parameterDefinition", page)
        self.assertEqual(page["parameterDefinition"]["optional"]["label"],
                         {"en": "nonempty English display string, 1..48 characters",
                          "zh": "nonempty Chinese display string, 1..48 characters"})
        context = agent_api.context(self.root, {})
        self.assertEqual(context["previouslyProvidedDesignOps"], ["box", "hole"])
        agent_api.dispatch(self.root, "capabilities", {"symbols": ["BuildSession.cut"]})
        self.assertEqual(agent_api.context(self.root, {})["previouslyProvidedDesignOps"], ["box", "hole"])

    def test_capability_pages_can_resume_with_inspect_and_remember_the_delivered_contracts(self):
        from design_language import OPS
        names = ["box", *list(OPS)[-19:]]
        page = agent_api.dispatch(self.root, "capabilities", {"designOps": names})
        pages = 1
        while page["page"]["nextRequest"]:
            page = agent_api.dispatch(self.root, "inspect", page["page"]["nextRequest"])
            pages += 1
        self.assertGreater(pages, 1)
        restored = agent_api.context(self.root, {})
        self.assertEqual(restored["previouslyProvidedDesignOps"], sorted(names))
        reports = agent_api.state(self.root)["capabilityReports"]["designOps"]
        request = reports["box"]
        payload = agent_api.dispatch(self.root, "inspect", request)
        self.assertTrue(any(item["field"].endswith("/required") for item in payload["items"]))


    def test_expression_dependencies_distinguish_functions_from_parameters(self):
        document = box_design()
        document["params"]["min"] = {"type": "length", "value": 1}
        document["profiles"]["inner"]["size"][0] = "=min(width, depth)"
        self.path.write_text(json.dumps(document))
        response = read(self.root, {"action": "read", "design": self.path.name, "view": "nodes",
                                   "ids": ["profiles.inner"], "include": ["directDependencies"]})
        self.assertNotIn("params.min", response["nodes"]["profiles.inner"]["directDependencies"])


class DesignGeometryTests(unittest.TestCase):
    @staticmethod
    def document(features, result, *, profiles=None, paths=None, frames=None):
        document = box_design()
        document.update(profiles=profiles or {}, paths=paths or {}, frames=frames or {},
                        parts={"body": {"features": features, "result": "@body." + result}})
        return document

    def test_blind_cavity_has_exact_floor_and_original_envelope(self):
        parts, _, evidence = geometry(box_design())
        body = parts["body"]
        self.assertAlmostEqual(body.volume, 100*70*30 - 96*66*28)
        self.assertEqual(list(body.bounding_box().size), [100, 70, 30])
        self.assertEqual(evidence["body.cavity"]["solidCount"], 1)
        from build123d import Plane
        below = body.intersect(Plane(origin=(0, 0, 1.9)))
        above = body.intersect(Plane(origin=(0, 0, 2.1)))
        self.assertAlmostEqual(sum(face.area for face in below.faces()), 100*70)
        self.assertAlmostEqual(sum(face.area for face in above.faces()), 100*70-96*66)

    def test_recipe_matches_general_graph(self):
        explicit, _, _ = geometry(box_design())
        document = box_design()
        document["parts"]["body"] = {"features": [{"id": "box", "op": "open_box", "size": [100,70,30], "wall": 2, "floor": 2}], "result": "@body.box"}
        recipe, _, _ = geometry(document)
        self.assertAlmostEqual(recipe["body"].volume, explicit["body"].volume)

    def test_selector_count_and_kernel_failure_keep_the_requested_radius(self):
        document = box_design()
        node = {"id": "round", "op": "fillet", "body": "@body.cavity", "radius": 1,
                "edges": {"of": "@body.cavity", "where": {"curve": "line", "parallel": [0,0,1]}, "expect": {"count": 4}}}
        document["parts"]["body"]["features"].append(node)
        with self.assertRaises(DesignError) as raised:
            geometry(document)
        self.assertEqual(raised.exception.issue["actual"]["count"], 8)
        self.assertEqual(raised.exception.issue["node"], "body.round")
        node.update(body="@body.blank", radius=100)
        node["edges"]["of"] = "@body.blank"
        with self.assertRaises(DesignError):
            geometry(document)
        self.assertEqual(node["radius"], 100)

    def test_pattern_cut_and_explicit_transform(self):
        document = box_design()
        document["parts"]["body"] = {"features": [
            {"id": "blank", "op": "box", "size": [40,20,10]},
            {"id": "tool", "op": "cylinder", "radius": 2, "height": 20},
            {"id": "pattern", "op": "placements", "input": "@body.tool", "offsets": [[-10,0,0],[10,0,0]]},
            {"id": "holes", "op": "cut", "body": "@body.blank", "tools": ["@body.pattern"]},
            {"id": "moved", "op": "translate", "input": "@body.holes", "offset": [10,20,30]}], "result": "@body.moved"}
        parts, _, evidence = geometry(document)
        self.assertAlmostEqual(parts["body"].volume, 8000 - 2*3.141592653589793*4*10)
        self.assertEqual(list(parts["body"].bounding_box().center()), [10,20,30])
        self.assertEqual(len(evidence["body.pattern"]["instances"]), 2)

    def test_primitives_and_profile_extrusions_match_analytic_volumes(self):
        import math
        primitives = [({"op": "cylinder", "radius": 2, "height": 3}, math.pi*4*3),
                      ({"op": "cone", "bottomRadius": 2, "topRadius": 0, "height": 3}, math.pi*4),
                      ({"op": "sphere", "radius": 2}, 4/3*math.pi*8),
                      ({"op": "torus", "majorRadius": 5, "minorRadius": 1}, 10*math.pi**2)]
        for spec, volume in primitives:
            with self.subTest(spec=spec):
                parts, _, _ = geometry(self.document([{"id": "shape", **spec}], "shape"))
                self.assertAlmostEqual(parts["body"].volume, volume)
        profiles = [({"op": "rectangle", "size": [10,6]}, 60),
                    ({"op": "rounded_rectangle", "size": [10,6], "radius": 1}, 60-4+math.pi),
                    ({"op": "rounded_rectangle", "size": [10,6], "radii": [2,2,1,1]}, 50+2.5*math.pi),
                    ({"op": "circle", "radius": 2}, 4*math.pi),
                    ({"op": "ellipse", "radii": [3,2]}, 6*math.pi),
                    ({"op": "polygon", "points": [[0,0],[10,0],[0,6]]}, 30),
                    ({"op": "regular_polygon", "radius": 2, "count": 6}, 6*math.sqrt(3)),
                    ({"op": "slot", "size": [10,4]}, 24+4*math.pi)]
        for spec, area in profiles:
            with self.subTest(spec=spec):
                document = self.document([{"id": "shape", "op": "extrude", "profile": "@profiles.section",
                                          "frame": "@frames.base", "length": 3}], "shape", profiles={"section": spec},
                                          frames={"base": {"origin": [0,0,7], "u": [1,0,0], "normal": [0,0,1]}})
                parts, _, _ = geometry(document)
                self.assertAlmostEqual(parts["body"].volume, 3*area, delta=1e-6)
                self.assertAlmostEqual(parts["body"].bounding_box().min.Z, 7)

    def test_loft_revolve_and_closed_path_use_explicit_frames(self):
        import math
        frame = {"origin": [0,0,0], "u": [1,0,0], "normal": [0,0,1]}
        loft = self.document([{"id": "shape", "op": "loft", "sections": [
            {"profile": "@profiles.a", "frame": "@frames.a"}, {"profile": "@profiles.b", "frame": "@frames.b"}], "ruled": True}], "shape",
            profiles={"a": {"op": "rectangle", "size": [10,10]}, "b": {"op": "rectangle", "size": [6,6]}},
            frames={"a": frame, "b": {**frame, "origin": [0,0,10]}})
        parts, _, _ = geometry(loft)
        self.assertAlmostEqual(parts["body"].volume, 10/3*(100+36+60))
        revolve = self.document([{"id": "shape", "op": "revolve", "profile": "@profiles.section", "frame": "@frames.base",
                                "axis": {"origin": [0,0,0], "direction": [0,0,1]}, "angle": 360}], "shape",
            profiles={"section": {"op": "polygon", "points": [[2,0],[4,0],[4,5],[2,5]]}},
            frames={"base": {"origin": [0,0,0], "u": [1,0,0], "normal": [0,-1,0]}})
        parts, _, _ = geometry(revolve)
        self.assertAlmostEqual(parts["body"].volume, 60*math.pi)
        path = self.document([{"id": "shape", "op": "extrude", "profile": "@profiles.section", "frame": "@frames.base", "length": 4}], "shape",
            profiles={"section": {"op": "face_from_path", "path": "@paths.outline"}},
            paths={"outline": {"op": "polyline", "points": [[0,0,0],[10,0,0],[10,6,0],[0,6,0]], "closed": True}}, frames={"base": frame})
        parts, _, _ = geometry(path)
        self.assertAlmostEqual(parts["body"].volume, 240)

    def test_boolean_finish_and_rigid_transform_preserve_measured_relationships(self):
        nodes = [{"id": "a", "op": "box", "size": [10,10,10]}, {"id": "b", "op": "box", "size": [10,10,10]},
                 {"id": "shift", "op": "translate", "input": "@body.b", "offset": [5,0,0]},
                 {"id": "fused", "op": "union", "body": "@body.a", "tools": ["@body.shift"]},
                 {"id": "common", "op": "intersect", "body": "@body.a", "tools": ["@body.shift"]}]
        parts, _, evidence = geometry(self.document(nodes, "common"))
        self.assertAlmostEqual(parts["body"].volume, 500)
        self.assertAlmostEqual(evidence["body.fused"]["volume"], 1500)
        nodes.extend([{"id": "bevel", "op": "chamfer", "body": "@body.common", "length": 1,
                       "edges": {"of": "@body.common", "where": {"curve": "line", "parallel": [0,0,1]}, "expect": {"count": 4}}},
                      {"id": "rotate", "op": "rotate", "input": "@body.bevel", "axis": {"origin": [0,0,0], "direction": [0,0,1]}, "angle": 90},
                      {"id": "mirror", "op": "mirror", "input": "@body.rotate", "frame": "@frames.yz"}])
        parts, _, evidence = geometry(self.document(nodes, "mirror", frames={"yz": {"origin": [0,0,0], "u": [0,1,0], "normal": [1,0,0]}}))
        self.assertAlmostEqual(parts["body"].volume, evidence["body.bevel"]["volume"])
        self.assertLess(parts["body"].volume, 500)

    def test_rigid_transform_moves_bound_tool_evidence_with_its_body(self):
        document = box_design()
        document["parts"]["body"]["features"][1]["requirement"] = "cavity"
        nodes = document["parts"]["body"]["features"]
        nodes.extend([{"id": "moved", "op": "translate", "input": "@body.cavity", "offset": [10,20,30]},
                      {"id": "rotated", "op": "rotate", "input": "@body.moved", "axis": {"origin": [0,0,0], "direction": [0,0,1]}, "angle": 90}])
        document["parts"]["body"]["result"] = "@body.rotated"
        parts, observations, _ = geometry(document)
        body, tool = parts["body"], observations["cavity"]["shape"]
        self.assertAlmostEqual(body.bounding_box().center().X, -20)
        self.assertAlmostEqual(tool.bounding_box().center().X, -20)
        self.assertAlmostEqual(tool.bounding_box().center().Y, 10)
        self.assertAlmostEqual(tool.bounding_box().min.Z, 32)
        # An unused transformed branch must not move evidence for the chosen result.
        document["parts"]["body"]["result"] = "@body.cavity"
        _, observations, _ = geometry(document)
        self.assertAlmostEqual(observations["cavity"]["shape"].bounding_box().center().X, 0)


class DesignCliTests(DesignWorkspace):
    def cli(self, operation, args):
        result = subprocess.run(["node", str(ROOT / "bin" / "a3d.mjs"), "agent", operation, json.dumps(args)],
                                cwd=self.root, capture_output=True, text=True, timeout=90)
        self.assertEqual(result.stderr, "", result.stderr)
        return result, json.loads(result.stdout)

    def test_bilingual_open_box_public_apply_read_and_draft_loop(self):
        example = ROOT / "skills" / "a3d-text" / "examples" / "open_box.a3d.json"
        self.path.write_bytes(example.read_bytes())
        self.revision = binding(self.path)["sha256"]
        read_result, initial = self.cli("design", {"action": "read", "design": self.path.name,
                                                       "revision": self.revision})
        self.assertEqual(read_result.returncode, 0)
        self.assertEqual(initial["languageVersion"], 4)
        self.assertEqual(initial["parameterCount"], 5)
        _, named = self.cli("design", {"action": "read", "design": self.path.name,
                                         "revision": self.revision, "view": "nodes", "ids": ["params.width"]})
        self.assertEqual(named["nodes"]["params.width"]["definition"]["label"],
                         {"en": "Overall width", "zh": "整体宽度"})
        _, applied = self.cli("design", {"action": "apply", "design": self.path.name,
                                           "baseRevision": self.revision, "changes": [
            {"kind": "update", "target": "params.width", "set": {"value": 85}},
        ]})
        self.assertEqual(applied["status"], "saved")
        _, dependencies = self.cli("design", {"action": "read", "design": self.path.name,
                                                "revision": applied["revision"], "view": "nodes",
                                                "ids": ["body.shell"], "include": ["directDependencies"]})
        self.assertTrue({"params.width", "params.depth", "params.height", "params.wall", "params.floor"}.issubset(
            dependencies["nodes"]["body.shell"]["directDependencies"]))
        changed_shape = geometry(json.loads(self.path.read_text()))[0]["body"]
        self.assertAlmostEqual(changed_shape.bounding_box().size.X, 85, places=6)
        draft_result, draft = self.cli("build", {"phase": "draft", "design": self.path.name,
                                                   "revision": applied["revision"]})
        self.assertEqual(draft_result.returncode, 0, draft)
        self.assertEqual(draft["status"], "draft")
        self.assertEqual(draft["design"]["revision"], applied["revision"])

    def test_real_draft_reuse_and_failed_revision_preserve_successful_artifacts(self):
        args = {"phase": "draft", "design": self.path.name, "revision": self.revision}
        first, page = self.cli("build", args)
        self.assertEqual(first.returncode, 0, page)
        self.assertEqual(page["status"], "draft")
        self.assertLessEqual(wire_size(page), MAX_WIRE_BYTES)
        _, repeat = self.cli("build", args)
        self.assertTrue(repeat["reused"])
        report = json.loads(Path(page["report"]["path"]).read_text())
        self.assertEqual(report["design"]["revision"], self.revision)
        self.assertIn("design", report["taskInputBindings"])
        preview = binding(Path(page["artifacts"]["preview"]["path"]))
        edited = self.apply([{"kind": "add", "target": "body.bad", "value": {
            "op": "hole", "body": "@body.cavity", "radius": 1, "frame": "@frames.top",
            "direction": "-normal", "depth": {"mode": "blind", "length": 1}}}])
        failed, response = self.cli("build", {**args, "revision": edited["revision"]})
        self.assertEqual(failed.returncode, 1, response)
        self.assertEqual(response["status"], "failed")
        self.assertEqual(binding(Path(preview["path"])), preview)
        saved = json.loads(Path(response["report"]["path"]).read_text())
        self.assertTrue(any(issue.get("node") == "body.bad" for issue in saved["issues"]))
        status = read(self.root, {"action": "read", "design": self.path.name})["build"]
        self.assertEqual(status["lastSuccessful"]["revision"], self.revision)
        self.assertTrue(status["lastSuccessful"]["artifactsAvailable"])

    def test_real_compile_uses_existing_qa_and_generated_scene(self):
        examples = ROOT / "skills" / "a3d-text" / "examples"
        shutil.copyfile(examples / "simple_brep_intent.py", self.root / "simple_brep_intent.py")
        shutil.copyfile(examples / "bambu-a1-mini-0.4-standard.example.json", self.root / "simple_brep_printer-profile.json")
        generated = subprocess.run([sys.executable, "-B", "simple_brep_intent.py"], cwd=self.root,
                                   env={**os.environ, "AMAGINE3D_RUNTIME_DIR": str(RUNTIME)}, capture_output=True, text=True, timeout=30)
        self.assertEqual(generated.returncode, 0, generated.stderr)
        document = box_design()
        document["parts"] = {"simple-brep": {"features": [
            {"id": "blank", "op": "box", "size": [40,28,10], "align": ["center","center","min"]},
            {"id": "round", "op": "fillet", "body": "@simple-brep.blank", "radius": 2, "requirement": "body",
             "edges": {"of": "@simple-brep.blank", "where": {"curve": "line", "parallel": [0,0,1]}, "expect": {"count": 4}}},
            {"id": "pocket", "op": "hole", "body": "@simple-brep.round", "radius": 6, "requirement": "pocket",
             "frame": "@frames.top", "direction": "-normal", "depth": {"mode": "blind", "length": 6}}], "result": "@simple-brep.pocket"}}
        document["frames"]["top"]["origin"] = [0,0,10]
        self.path.write_text(json.dumps(document))
        intent_bytes = (self.root / "simple_brep_intent.json").read_bytes()
        result, page = self.cli("build", {"phase": "compile", "design": self.path.name, "revision": binding(self.path)["sha256"], "intent": "simple_brep_intent.json"})
        self.assertEqual(result.returncode, 0, page)
        self.assertTrue(page["pass"], page)
        self.assertTrue(page["visualReviewRequired"])
        self.assertEqual((self.root / "simple_brep_intent.json").read_bytes(), intent_bytes)
        saved = json.loads(Path(page["report"]["path"]).read_text())
        self.assertIn("scene", saved["taskInputBindings"])
        self.assertTrue(saved["designEvidence"])
        script = ('import {scanArtifacts} from "./server/artifacts.ts"; '
                  'import {discoverModelBuilds} from "./server/model-builds.ts"; '
                  'const root = process.argv[1]; '
                  'console.log(JSON.stringify(await discoverModelBuilds(root, await scanArtifacts(root))));')
        discovered = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", script, str(self.root)],
                                    cwd=ROOT, capture_output=True, text=True, timeout=20)
        self.assertEqual(discovered.returncode, 0, discovered.stderr)
        builds = json.loads(discovered.stdout)
        self.assertEqual(len(builds), 1, discovered.stdout)
        self.assertEqual(builds[0]["modelId"], "simple-brep")
        self.assertTrue(builds[0]["displayPreviewPath"].startswith("design-builds/"))


if __name__ == "__main__":
    unittest.main()
