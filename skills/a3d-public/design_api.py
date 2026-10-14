"""Local reads, atomic edits and immutable build inputs for design documents."""
from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import json
import os
from pathlib import Path

from agent_protocol import binding, encode, scoped
from design_language import DesignError, LIMITS, SCHEMA, definitions, fail, fields, identifier, normalize, references


def contract_issues(ir, contract, *, base_dir, complete=True, revision=None):
    """Check design/intent relationships without constructing geometry."""
    from cad_diagnostics import contract_issue
    from intent_contract import feature_owner_map, physical_part_names, validate, whole_part_color_regions
    if not isinstance(contract, dict):
        return [{"severity": "error", "stage": "preflight", "code": "AUTHORING.INVALID", "message": "intent must be an object", "path": "intent"}]
    errors = validate(contract, base_dir=base_dir)
    if errors:
        return [{"severity": "error", "stage": "preflight", "code": "AUTHORING.INVALID", "message": message,
                 "path": "intent", **(contract_issue(message) or {})} for message in errors]
    issues = []
    def add(code, message, field, **details):
        issues.append({"severity": "error", "stage": "preflight", "code": "DESIGN." + code, "message": message, "field": field, **details})
    parts, owners = physical_part_names(contract), feature_owner_map(contract)
    if set(ir["parts"]) != parts:
        add("OWNERSHIP", "design part IDs must match physical parts in intent", "/parts",
            expected=sorted(parts), observed=sorted(ir["parts"]))
    bound = {}
    installations = {}
    for node in ir["nodes"]:
        if "requirement" in node:
            feature = node["requirement"]
            bound[feature] = node
            if owners.get(feature) != node["owner"]:
                add("OWNERSHIP", "requirement is missing from intent or belongs to another part", node["field"] + "/requirement",
                    node=node["id"], nodeId=node["id"], causeId=node["id"] + ":/requirement", featureId=feature,
                    expected=owners.get(feature), observed=node["owner"])
        if node["type"] == "Installation":
            asset = node["args"]
            installations[asset["feature"]] = node
            if owners.get(asset["feature"]) != asset["part"]:
                add("OWNERSHIP", "installation feature must belong to its intent part", node["field"] + "/feature", node=node["id"])
            if asset.get("displayFeature") in owners:
                add("OWNERSHIP", "display reference must not replace a physical intent feature", node["field"] + "/displayFeature", node=node["id"])
    for index, feature in enumerate(contract["features"]):
        name = feature["id"]
        if complete and name not in bound:
            add("BINDING_MISSING", "intent feature needs a physical geometry binding on its owner", f"/features/{index}",
                path="intent", featureId=name, part=owners[name], causeId=name + ":binding")
        if complete and feature.get("installation_checks") and name not in installations:
            add("INSTALLATION_MISSING", "intent installation checks need an installation asset", f"/features/{index}/installation_checks",
                path="intent", featureId=name, part=owners[name], causeId=name + ":installation")
    from design_connections import intent_issues
    issues.extend(intent_issues(ir, contract, complete=complete))
    for issue in issues:
        issue.setdefault("stage", "preflight")
    if not complete:
        return issues  # Drafts reserve geometry before final bindings/export declarations.
    from design_roles import structural_issues
    issues.extend(structural_issues(ir, parts, revision=revision))
    try:
        regions = whole_part_color_regions(contract, parts)
        if regions is not None:
            expected_mode = "co_print_body" if len(parts) == 1 else "separate_parts"
            if contract["printability"].get("print_package_mode") != expected_mode:
                add("COLOR_EXPORT", "whole-part colors require " + expected_mode, "/printability/print_package_mode", path="intent")
    except ValueError as error:
        add("UNSUPPORTED", str(error), "/color_regions", path="intent")
    return issues


def load(root, name, revision=None):
    path = scoped(root, name)
    raw = path.read_bytes()
    digest = sha256(raw).hexdigest()
    if revision is not None and digest != revision:
        fail("REVISION_CONFLICT", "design changed; read the affected nodes before editing", currentRevision=digest)
    if len(raw) > LIMITS["documentBytes"]:
        fail("RESOURCE_LIMIT", "design document is too large")
    try:
        document = json.loads(raw)
    except (ValueError, RecursionError) as error:
        fail("SCHEMA", f"invalid design JSON: {error}")
    return path, document, digest


def status_path(path):
    return ".a3d-agent/design-builds/" + sha256(str(path).encode()).hexdigest() + ".json"


def build_status(root, path, revision):
    record = scoped(root, status_path(path), exists=False)
    if not record.exists():
        return {"status": "not-built", "current": False}
    value = json.loads(record.read_text(encoding="utf-8"))
    latest = value["latest"]
    if latest["status"] == "running":
        try:
            os.kill(latest["pid"], 0)
        except OSError:
            latest["status"] = "interrupted"
    if "lastSuccessful" in value:
        from agent_api import _paths_current
        success = value["lastSuccessful"]
        success["artifactsAvailable"] = _paths_current(root, success.get("outputs", {}))
    return {**value, "status": latest["status"] if latest["revision"] == revision else "outdated",
            "current": latest["revision"] == revision}


def record_build(root, info, outcome):
    from agent_api import save
    path = scoped(root, status_path(Path(info["path"])), exists=False)
    value = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    value["latest"] = {"revision": info["revision"], **outcome}
    if outcome["status"] in {"draft", "awaiting-visual-review"} and outcome.get("pass", outcome["status"] == "draft"):
        value["lastSuccessful"] = value["latest"]
    save(root, str(path), value)


def read(root, args):
    fields(args, {"action", "design"}, {"revision", "view", "ids", "include"})
    path, document, revision = load(root, args["design"], args.get("revision"))
    ir = normalize(document)
    response = {"schema": SCHEMA, "design": str(path), "revision": revision, "staticValid": True}
    view = args.get("view", "summary")
    if view == "summary":
        if "ids" in args or "include" in args:
            fail("SCHEMA", "ids/include require view=nodes")
        response.update(parts=ir["parts"], parameterCount=len(ir["params"]), nodeCount=len(ir["nodes"]),
                        parameterIds=["params." + name for name in ir["params"]],
                        nodeIds=[node["id"] for node in ir["nodes"]],
                        requirementNodes={node["requirement"]: node["id"] for node in ir["nodes"] if "requirement" in node},
                        languageVersion=ir["version"], operationsUsed=sorted({node["op"] for node in ir["nodes"] if node["op"] != "frame"}),
                        build=build_status(root, path, revision))
    elif view == "nodes":
        ids, include = args.get("ids"), args.get("include", [])
        if (not isinstance(ids, list) or not 1 <= len(ids) <= 20 or any(not isinstance(x, str) for x in ids)
                or not isinstance(include, list) or any(x not in {"directDependencies", "directDependents"} for x in include)):
            fail("SCHEMA", "nodes view needs 1..20 IDs and optional directDependencies/directDependents")
        entries = definitions(document)
        links = {name: set(references({"result": value["result"]} if name.startswith("parts.") else value)) for name, (value, _) in entries.items()}
        # Parameter expressions have no @ prefix; include their symbol dependencies.
        import ast
        for name, (value, _) in entries.items():
            if name.startswith("parts."):
                continue
            def expressions(item):
                if isinstance(item, str) and item.startswith("="):
                    tree = ast.parse(item[1:], mode="eval")
                    functions = {node.func for node in ast.walk(tree) if isinstance(node, ast.Call)}
                    yield from ("params." + node.id for node in ast.walk(tree)
                                if isinstance(node, ast.Name) and node not in functions and node.id in document["params"])
                elif isinstance(item, dict):
                    for child in item.values():
                        yield from expressions(child)
                elif isinstance(item, list):
                    for child in item:
                        yield from expressions(child)
            links[name].update(expressions(value))
        response["nodes"] = {}
        for name in ids:
            if name not in entries:
                fail("TARGET_MISSING", f"unknown design address: {name}", target=name)
            value = deepcopy(entries[name][0])
            if name.startswith("parts."):
                value["features"] = [feature["id"] for feature in value["features"]]
            item = {"definition": value, "field": entries[name][1]}
            if "directDependencies" in include:
                item["directDependencies"] = sorted(links[name])
            if "directDependents" in include:
                item["directDependents"] = sorted(key for key, dependencies in links.items() if name in dependencies)
            response["nodes"][name] = item
    else:
        fail("SCHEMA", "view must be summary or nodes")
    # Save query results as immutable evidence before generic pagination can refer to them.
    from agent_api import save
    report = save(root, f".a3d-agent/design-reads/{sha256(encode(response).encode()).hexdigest()}.json", response)
    response["report"] = binding(report)
    return response


def edit(document, change, index):
    field = f"/changes/{index}"
    fields(change, {"kind", "target"}, {"value", "set", "unset"}, field=field)
    target = change["target"]
    if not isinstance(target, str) or len(target.split(".")) != 2:
        fail("SCHEMA", "target must be namespace.ID or part.ID", field + "/target")
    space, name = target.split(".")
    identifier(space, field + "/target")
    identifier(name, field + "/target")
    collection = space in {"params", "frames", "profiles", "paths", "parts", "connections", "assets"}
    if collection:
        destination = document.setdefault(space, {})
        current = destination.get(name)
    else:
        if space not in document["parts"]:
            fail("TARGET_MISSING", f"unknown part: {space}", field)
        destination = document["parts"][space]["features"]
        current = next((node for node in destination if node["id"] == name), None)
    kind = change["kind"]
    if kind == "add":
        fields(change, {"kind", "target", "value"}, field=field)
        if current is not None:
            fail("TARGET_EXISTS", f"definition already exists: {target}", field)
        if not isinstance(change["value"], dict):
            fail("TYPE", "value must be an object", field + "/value")
        value = deepcopy(change["value"])
        if "id" in value or space == "parts" and "features" in value:
            fail("SCHEMA", "IDs and feature collections are managed by the editor", field)
        if space == "parts":
            value["features"] = []
        if collection:
            destination[name] = value
        else:
            destination.append({"id": name, **value})
    elif kind == "update":
        fields(change, {"kind", "target", "set"}, {"unset"}, field=field)
        if current is None:
            fail("TARGET_MISSING", f"definition does not exist: {target}", field)
        updates, unset = change["set"], change.get("unset", [])
        if not isinstance(updates, dict) or not isinstance(unset, list) or any(not isinstance(x, str) for x in unset):
            fail("TYPE", "set must be an object and unset an array of field names", field)
        blocked = {"id", "op", "type"} | ({"features"} if space == "parts" else set())
        if set(updates) & set(unset) or (set(updates) | set(unset)) & blocked:
            fail("BATCH_CONFLICT", "cannot change identity/type/op, replace features, or set and unset the same field", field)
        for key in unset:
            if key not in current:
                fail("SCHEMA", f"field does not exist: {key}", field)
            del current[key]
        current.update(deepcopy(updates))
    elif kind == "remove":
        fields(change, {"kind", "target"}, field=field)
        if current is None:
            fail("TARGET_MISSING", f"definition does not exist: {target}", field)
        if space == "parts" and current["features"]:
            fail("BATCH_CONFLICT", "remove a part's features explicitly before removing its header", field)
        if collection:
            del destination[name]
        else:
            destination.remove(current)
    else:
        fail("SCHEMA", "kind must be add, update or remove", field)


def apply(root, args):
    from agent_api import _activate_inputs, mutation_lock, save, state
    fields(args, {"action", "design", "baseRevision", "changes"})
    changes = args["changes"]
    if not isinstance(changes, list) or not 1 <= len(changes) <= LIMITS["changes"]:
        fail("RESOURCE_LIMIT", "changes must contain 1..64 edits")
    if any(not isinstance(change, dict) for change in changes):
        fail("TYPE", "each change must be an object")
    targets = [change.get("target") for change in changes if isinstance(change, dict)]
    if any(not isinstance(target, str) for target in targets) or len(set(targets)) != len(targets):
        fail("BATCH_CONFLICT", "each target must occur at most once")
    path = scoped(root, args["design"], exists=False)
    if not path.name.endswith(".a3d.json"):
        fail("SCHEMA", "design file must end in .a3d.json")
    with mutation_lock(root, name=".a3d-agent/design.lock"):
        if args["baseRevision"] is None:
            if path.exists():
                fail("REVISION_CONFLICT", "creation requires a nonexistent design file", currentRevision=binding(path)["sha256"])
            document = {"schema": SCHEMA, "units": {"length": "mm", "angle": "deg"}, "params": {}, "parts": {}}
            revision = None
        else:
            if not isinstance(args["baseRevision"], str):
                fail("TYPE", "baseRevision must be a revision string or null")
            _, document, revision = load(root, str(path), args["baseRevision"])
        original = deepcopy(document)
        # Headers are created first and removed last; forward references use the final graph.
        ordered = sorted(enumerate(changes), key=lambda pair: 0 if pair[1].get("kind") == "add" and str(pair[1].get("target", "")).startswith("parts.") else 2 if pair[1].get("kind") == "remove" and str(pair[1].get("target", "")).startswith("parts.") else 1)
        for index, change in ordered:
            try:
                edit(document, change, index)
            except DesignError as error:
                error.issue.update(change=index, target=change.get("target") if isinstance(change, dict) else None)
                error.issue["revision"] = revision
                error.issue.setdefault("causeId", change.get("target", "") + ":" + error.issue["field"][len(f"/changes/{index}"):])
                raise
        try:
            normalize(document)
        except DesignError as error:
            entries = definitions(document)
            target = error.issue.get("node") or next((name for name, (_, field) in entries.items()
                      if error.issue.get("field", "").startswith(field + "/")), None)
            if target in targets:
                error.issue.update(change=targets.index(target), target=target)
            error.issue["revision"] = revision
            raise
        changed = revision is None or original != document
        if changed:
            if revision is not None and binding(path)["sha256"] != revision:
                fail("REVISION_CONFLICT", "design changed during validation", currentRevision=binding(path)["sha256"])
            save(root, str(path), document)
            revision = binding(path)["sha256"]
        save(root, ".a3d-agent/design.json", {"path": str(path)})
        current = state(root)
        _activate_inputs(root, current, {"design": {"path": str(path), "sha256": revision}})
        save(root, ".a3d-agent/state.json", current)
    return {"schema": SCHEMA, "status": "saved" if changed else "unchanged", "design": str(path),
            "revision": revision, "changed": changed, "staticValid": True, "changedNodes": targets,
            "geometryValidated": False}


def design(root, args):
    if args.get("action") == "read":
        return read(root, args)
    if args.get("action") == "apply":
        return apply(root, args)
    fail("SCHEMA", "design action must be read or apply")


def prepare(root, args):
    """Freeze the design and generate one fixed launcher, never Python fragments."""
    from agent_api import save
    path, document, revision = load(root, args["design"], args.get("revision"))
    if "revision" not in args:
        fail("SCHEMA", "design builds require the revision returned by read/apply")
    ir = normalize(document)
    if not ir["parts"]:
        fail("TYPE", "build requires at least one part")
    save(root, ".a3d-agent/design.json", {"path": str(path)})
    inputs = {"design": {"path": str(path), "sha256": revision}}
    for name in args.get("dependencies", []):
        inputs[name] = binding(scoped(root, name))
    if args.get("intent"):
        intent = scoped(root, args["intent"])
        inputs["intent"] = binding(intent)
        contract = json.loads(intent.read_text(encoding="utf-8"))
        printability = contract.get("printability") if isinstance(contract, dict) else None
        profile = printability.get("profile") if isinstance(printability, dict) else None
        if isinstance(profile, dict) and isinstance(profile.get("path"), str):
            profile_path = scoped(root, str(intent.parent / profile["path"]), exists=False)
            if profile_path.is_file():
                inputs["profile"] = binding(profile_path)
        issues = contract_issues(ir, contract, base_dir=intent.parent, complete=args["phase"] == "compile", revision=revision)
        if issues:
            raise DesignError("CONTRACT", "design/intent preflight failed; repair the reported declarations before building", issues=issues, inputBindings=inputs)
    runtime = {name: sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
               for name in ("design_language.py", "design_api.py", "design_build.py", "design_connections.py")}
    from capability_manifest import build_manifest
    key = sha256(encode({"inputs": inputs, "runtime": runtime, "backend": build_manifest()["fingerprint"]}).encode()).hexdigest()
    directory = f".a3d-agent/designs/{key}"
    snapshot = save(root, directory + "/design.json", document)
    save(root, directory + "/ir.json", ir)
    digest = binding(snapshot)["sha256"]
    source = scoped(root, directory + "/model_build.py", exists=False)
    source.write_text('from pathlib import Path\nfrom design_build import run\n\n'
                      f'run(Path(__file__).with_name("design.json"), source_path=__file__, expected_hash="{digest}")\n')
    output = scoped(root, "design-builds/" + key, exists=False)
    info = {"path": str(path), "revision": revision, "snapshot": binding(snapshot)}
    save(root, ".a3d-agent/design.json", {"path": str(path)})
    return {**args, "source": str(source), "scene": str(output / "scene.json"),
            "dependencies": [*args.get("dependencies", []), str(path), str(snapshot)]}, info, output
