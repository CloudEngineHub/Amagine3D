"""Paired DSL geometry, atomic edits and installation evidence through real QA."""
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from unittest import mock

from tests.python.test_design_language import DesignWorkspace, ROOT, RUNTIME, geometry
from agent_protocol import binding
from design_api import apply, read
from design_language import DesignError, normalize
import agent_api

EXAMPLES = ROOT / "skills/a3d-text/examples"


class DesignConnectionTests(DesignWorkspace):
    def test_standalone_json_contract_matches_the_installed_dsl_example(self):
        profile = "bambu-a1-mini-0.4-standard.example.json"
        for name in ("installed_module_intent.json", profile):
            shutil.copyfile(EXAMPLES / name, self.root / name)
        self.path.write_text(json.dumps(self.document()))
        result = agent_api.dispatch(self.root, "validate", {
            "design": self.path.name, "intent": "installed_module_intent.json"})
        self.assertTrue(result["pass"], result)

    def test_contract_errors_expose_field_types_and_survive_build_preflight(self):
        import cad_compile
        path = self.intent()
        document = json.loads(path.read_text())
        document["features"] = []
        document["printability"].pop("print_package_mode")
        path.write_text(json.dumps(document))
        self.path.write_text(json.dumps(self.document()))
        args = {"design": self.path.name, "revision": binding(self.path)["sha256"], "intent": path.name}
        validation = agent_api.dispatch(self.root, "validate", args)
        report = json.loads(Path(validation["report"]["path"]).read_text())
        fields = {issue.get("field"): issue for issue in report["issues"]}
        self.assertEqual(fields["/features"]["expected"]["minItems"], 1)
        self.assertEqual(fields["/printability/print_package_mode"]["expected"]["choices"], ["separate_parts"])
        self.assertIn("installed_module_intent.json", fields["/features"]["repairHint"])
        with mock.patch.object(cad_compile, "compile_cad", side_effect=AssertionError("CAD must not start")):
            build = agent_api.dispatch(self.root, "build", {"phase": "compile", **args})
        self.assertEqual(build["issues"], report["issues"])

    def test_locator_fit_errors_name_fields_and_legal_value_shapes(self):
        path = self.intent()
        document = json.loads(path.read_text())
        interface = document["manufacturing"]["interfaces"][0]
        interface["connection"] = "collar-socket"
        interface.pop("fastening")
        interface["engagement_mm"] = 0
        path.write_text(json.dumps(document))
        result = agent_api.dispatch(self.root, "validate", {"intent": path.name})
        report = json.loads(Path(result["report"]["path"]).read_text())
        fields = {issue.get("field"): issue for issue in report["issues"]}
        prefix = "/manufacturing/interfaces/0/"
        self.assertEqual(fields[prefix + "clearances_mm"]["expected"]["type"], "object")
        self.assertEqual(fields[prefix + "engagement_mm"]["expected"]["exclusiveMinimum"], 0)
        self.assertEqual(fields[prefix + "engagement_mm"]["actual"], 0)

    def intent(self):
        for name in ("installed_module_intent.py", "installed_module_build.py"):
            shutil.copyfile(EXAMPLES / name, self.root / name)
        shutil.copyfile(EXAMPLES / "bambu-a1-mini-0.4-standard.example.json", self.root / "installed_module_printer-profile.json")
        result = subprocess.run([sys.executable, "-B", "installed_module_intent.py"], cwd=self.root,
            env={**os.environ, "AMAGINE3D_RUNTIME_DIR": str(RUNTIME)}, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return self.root / "installed_module_intent.json"

    def test_validate_and_compile_aggregate_same_static_binding_errors_without_cad(self):
        import cad_compile
        path = self.intent()
        document = self.document()
        for owner in document["parts"].values():
            for node in owner["features"]:
                if node.get("requirement") == "frame-body":
                    del node["requirement"]
                elif node.get("requirement") == "module-retainers":
                    node["requirement"] = "unknown-retainers"
        self.path.write_text(json.dumps(document))
        args = {"design": self.path.name, "revision": binding(self.path)["sha256"], "intent": path.name}
        before = path.read_bytes()
        validation = agent_api.dispatch(self.root, "validate", args)
        self.assertFalse(validation["pass"])
        expected = json.loads(Path(validation["report"]["path"]).read_text())["issues"]
        self.assertEqual({i["code"] for i in expected}, {"DESIGN.OWNERSHIP", "DESIGN.BINDING_MISSING", "DESIGN.STRUCTURAL_BINDING_MISSING"})
        self.assertEqual(len(expected), 4)
        with mock.patch.object(cad_compile, "compile_cad", side_effect=AssertionError("CAD must not start")):
            build = agent_api.dispatch(self.root, "build", {"phase": "compile", **args})
            repeat = agent_api.dispatch(self.root, "build", {"phase": "compile", **args})
        self.assertEqual([i["id"] for i in build["issues"]], [i["id"] for i in expected])
        self.assertEqual(build["status"], "failed")
        self.assertFalse((self.root / ".a3d-agent/designs").exists())
        self.assertEqual(path.read_bytes(), before)
        restored = agent_api.context(self.root, {})
        self.assertEqual(restored["lastFailure"]["repeatedAttempts"], 2)
        self.assertEqual(restored["suggestedPhase"], "contract-repair")
        self.assertEqual(restored["nextValidate"], args)
        self.assertEqual(restored["nextInspect"]["report"], repeat["report"]["path"])
        self.assertEqual(restored["nextInspect"]["sha256"], repeat["report"]["sha256"])
        nodes = agent_api.dispatch(self.root, "design", restored["nextDesignRead"])
        self.assertTrue(nodes["nodes"])
        profile = self.root / "installed_module_printer-profile.json"
        profile.write_text(profile.read_text() + "\n")
        self.assertFalse(agent_api.context(self.root, {})["lastFailure"]["inputsCurrent"])

    def test_preflight_reports_missing_installation_and_unsupported_internal_color(self):
        path = self.intent()
        document = self.document()
        del document["assets"]["module"]
        self.path.write_text(json.dumps(document))
        intent = json.loads(path.read_text())
        extra = deepcopy(intent["color_regions"][0])
        extra["name"] = "internal-detail"
        intent["color_regions"].append(extra)
        path.write_text(json.dumps(intent))
        result = agent_api.dispatch(self.root, "validate", {"design": self.path.name, "intent": path.name})
        errors = json.loads(Path(result["report"]["path"]).read_text())["issues"]
        self.assertEqual({i["code"] for i in errors}, {"DESIGN.INSTALLATION_MISSING", "DESIGN.UNSUPPORTED"})

    def test_connection_target_endpoints_are_checked_before_geometry(self):
        path = self.intent()
        self.path.write_text(json.dumps(self.document()))
        intent = json.loads(path.read_text())
        pair = intent["manufacturing"]["interfaces"][0]["fastening"]["fasteners"][0]
        pair["pilot_feature"], pair["boss_feature"] = pair["boss_feature"], pair["pilot_feature"]
        path.write_text(json.dumps(intent))
        result = agent_api.dispatch(self.root, "validate", {"design": self.path.name, "intent": path.name})
        self.assertFalse(result["pass"])
        errors = json.loads(Path(result["report"]["path"]).read_text())["issues"]
        self.assertTrue(any(i["code"] == "DESIGN.INTERFACE" for i in errors), errors)

    def test_recovery_does_not_present_changed_profile_or_design_as_validated(self):
        path = self.intent()
        self.path.write_text(json.dumps(self.document()))
        args = {"design": self.path.name, "revision": binding(self.path)["sha256"], "intent": path.name}
        validation = agent_api.dispatch(self.root, "validate", args)
        self.assertTrue(validation["pass"], validation)
        restored = agent_api.context(self.root, {})
        self.assertTrue(restored["validation"]["inputsCurrent"])
        profile = self.root / "installed_module_printer-profile.json"
        profile.write_text(profile.read_text() + "\n")
        self.assertFalse(agent_api.context(self.root, {})["validation"]["inputsCurrent"])
        agent_api.dispatch(self.root, "validate", args)
        self.path.write_text(self.path.read_text() + "\n")
        self.assertFalse(agent_api.context(self.root, {})["validation"]["inputsCurrent"])

    def test_intent_bound_draft_can_reserve_parts_before_full_feature_bindings(self):
        from design_api import prepare
        path = self.intent()
        document = {"schema": "a3d-design/v1", "units": {"length": "mm", "angle": "deg"}, "params": {},
            "parts": {owner: {"features": [{"id": "blank", "op": "box", "size": [80, 16, 60]}], "result": f"@{owner}.blank"}
                      for owner in ("frame", "cover")}}
        self.path.write_text(json.dumps(document))
        args = {"design": self.path.name, "revision": binding(self.path)["sha256"], "intent": path.name}
        prepared, _, _ = prepare(self.root, {"phase": "draft", **args})
        self.assertEqual(prepared["phase"], "draft")
        with self.assertRaises(DesignError) as raised:
            prepare(self.root, {"phase": "compile", **args})
        self.assertTrue(any(i["code"] == "DESIGN.BINDING_MISSING" for i in raised.exception.issues))

    def document(self):
        return json.loads((EXAMPLES / "installed_module.a3d.json").read_text())

    def cli(self, operation, args):
        result = subprocess.run(["node", str(ROOT / "bin/a3d.mjs"), "agent", operation, json.dumps(args)],
            cwd=self.root, capture_output=True, text=True, timeout=180)
        self.assertEqual(result.stderr, "", result.stderr)
        return result, json.loads(result.stdout)

    def test_atomic_edits_check_removed_frames_and_connection_owners(self):
        document = self.document()
        changes = [{"kind": "add", "target": space + "." + key, "value": value}
                   for space in ("params", "frames", "connections", "assets") for key, value in document[space].items()]
        for owner, part in document["parts"].items():
            changes.append({"kind": "add", "target": "parts." + owner, "value": {"result": part["result"]}})
            changes.extend({"kind": "add", "target": owner + "." + node["id"],
                            "value": {k: v for k, v in node.items() if k != "id"}} for node in part["features"])
        saved = apply(self.root, {"action": "apply", "design": "module.a3d.json", "baseRevision": None, "changes": changes})
        before = (self.root / "module.a3d.json").read_bytes()
        for change in ({"kind": "remove", "target": "frames.joint"},
                       {"kind": "update", "target": "connections.corner-1", "set": {"receiverPart": "cover"}},
                       {"kind": "update", "target": "params.pilot_diameter", "set": {"value": 3.2}}):
            with self.subTest(change=change), self.assertRaises(DesignError):
                apply(self.root, {"action": "apply", "design": "module.a3d.json", "baseRevision": saved["revision"], "changes": [change]})
            self.assertEqual((self.root / "module.a3d.json").read_bytes(), before)
        page = read(self.root, {"action": "read", "design": "module.a3d.json", "view": "nodes", "ids": ["connections.corner-1", "assets.module"], "include": ["directDependents"]})
        self.assertIn("frame.pilot_1", page["nodes"]["connections.corner-1"]["directDependents"])

    def test_placed_ports_and_requirements_share_real_geometry(self):
        document = self.document()
        parts, observations, evidence = geometry(document)
        self.assertEqual(set(parts), {"frame", "cover"})
        self.assertTrue(all(shape.is_valid and len(shape.solids()) == 1 for shape in parts.values()))
        self.assertEqual(len(observations), 19)
        self.assertAlmostEqual(evidence["connections.corner-1"]["pilot"]["bounds"]["max"][0], -33 + 1.3)
        self.assertEqual(observations["frame-corner-1-boss"]["owner"], "frame")
        for space, key, change in (("connections", "corner-1", {"pilotDiameter": 3.2}),
                                   ("assets", "module", {"freeTravel": 1})):
            invalid = deepcopy(document)
            invalid[space][key].update(change)
            with self.assertRaises(DesignError) as raised:
                normalize(invalid)
            self.assertEqual(raised.exception.issue["nodeId"], space + "." + key)
        document["parts"]["cover"]["result"] = "@cover.body"
        with self.assertRaises(DesignError):
            normalize(document)

    def test_real_compile_keeps_failed_measurements_after_successful_revision(self):
        for name in ("installed_module_build.py", "installed_module_intent.py"):
            shutil.copyfile(EXAMPLES / name, self.root / name)
        shutil.copyfile(EXAMPLES / "bambu-a1-mini-0.4-standard.example.json", self.root / "installed_module_printer-profile.json")
        generated = subprocess.run([sys.executable, "-B", "installed_module_intent.py"], cwd=self.root,
            env={**os.environ, "AMAGINE3D_RUNTIME_DIR": str(RUNTIME)}, capture_output=True, text=True, timeout=30)
        self.assertEqual(generated.returncode, 0, generated.stderr)
        intent_path = self.root / "installed_module_intent.json"
        intent = json.loads(intent_path.read_text())
        for region in intent["color_regions"]:
            region["name"] += "-body-color"
        intent_path.write_text(json.dumps(intent))
        intent_before = intent_path.read_bytes()
        document = self.document()
        optical = next(node for node in document["parts"]["frame"]["features"] if node["id"] == "optical")
        optical["offset"][0] = 100
        self.path.write_text(json.dumps(document))
        draft, preview = self.cli("build", {"phase": "draft", "design": self.path.name, "revision": binding(self.path)["sha256"]})
        self.assertEqual(draft.returncode, 0, preview)
        request = {"phase": "compile", "design": self.path.name, "revision": binding(self.path)["sha256"], "intent": "installed_module_intent.json"}
        failed, page = self.cli("build", request)
        self.assertEqual(failed.returncode, 1, page)
        old_ref = Path(page["report"]["path"])
        old_report = old_ref.read_bytes()
        report = json.loads(old_report)
        installation_errors = [i for i in report["issues"] if i.get("check", "").endswith("reaches-component")]
        self.assertTrue(installation_errors, [{k: i.get(k) for k in ("code", "message", "detail")} for i in report["issues"]])
        issue = installation_errors[0]
        self.assertEqual(issue["featureId"], "module-space")
        self.assertEqual(issue["observed"]["overlapMm3"], 0)
        saved = apply(self.root, {"action": "apply", "design": self.path.name, "baseRevision": request["revision"],
            "changes": [{"kind": "update", "target": "frame.optical", "set": {"offset": [0,-5.5,30]}}]})
        request["revision"] = saved["revision"]
        result, page = self.cli("build", request)
        latest_report = json.loads(Path(page["report"]["path"]).read_text())
        self.assertEqual(result.returncode, 0, [{k: i.get(k) for k in ("code", "message", "observed")} for i in latest_report["issues"]])
        self.assertTrue(page["pass"])
        self.assertTrue(page["visualReviewRequired"])
        build_report = json.loads(Path(latest_report["artifacts"]["buildReport"]["path"]).read_text())
        self.assertEqual({(b["part"], b["sourceId"]) for b in build_report["materialPlan"]["sourceBindings"]},
                         {(r["part"], r["name"]) for r in intent["color_regions"]})
        self.assertEqual(old_report, old_ref.read_bytes())
        self.assertEqual(intent_before, (self.root / "installed_module_intent.json").read_bytes())
        context = agent_api.context(self.root, {})
        self.assertEqual(context["nextInspect"]["report"], context["latest"]["report"]["path"])
        self.assertEqual(context["nextInspect"]["sha256"], context["latest"]["report"]["sha256"])
        _, inspected = self.cli("inspect", {**context["nextInspect"], "field": "/printOrientationEvidence"})
        self.assertTrue(inspected["items"])
