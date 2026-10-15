"""Shared requirement roles and structural contribution checks, without CAD imports."""
from __future__ import annotations

CUTTER_OPS = frozenset({"cut", "pocket", "hole", "open_box"})
SOLID_OPS = frozenset({"box", "cylinder", "cone", "sphere", "torus", "union"})


def requirement_role(operation):
    return "cutter" if operation in CUTTER_OPS else "solid" if operation in SOLID_OPS else "separate"


def recipe_role(output):
    return "solid" if output == "receiver-boss" else "cutter"


def result_bindings(ir):
    """Propagate port-specific bindings; cutting tools never provide body material.

    all records mirror the runtime's inherited feature observations. structural
    records additionally follow positive material contributions to the result.
    """
    values = {}
    recipe_roles = {}
    for node in ir["nodes"]:
        if node["op"] == "self_tapping_screw":
            for key, output in (("bossFeature", "receiver-boss"), ("pilotFeature", "pilot"), ("clearanceFeature", "clearance")):
                recipe_roles[node["args"][key]] = recipe_role(output)
    def collect(arguments, owner):
        all_records, structural = {}, set()
        def visit(item):
            if isinstance(item, str) and item.startswith("@"):
                target, _, port = item[1:].partition(":")
                records, positive = values.get(target, {}).get(port or "result", ({}, set()))
                records = {key: node for key, node in records.items() if node["owner"] == owner}
                all_records.update(records)
                structural.update(positive & records.keys())
            elif isinstance(item, dict):
                for child in item.values(): visit(child)
            elif isinstance(item, list):
                for child in item: visit(child)
        visit(arguments)
        return all_records, structural
    for node in ir["nodes"]:
        args, op, owner = node["args"], node["op"], node["owner"]
        if node["type"] in {"Connection", "Installation", "Frame", "Profile", "Path"}:
            values[node["id"]] = {}
            continue
        records, positive = collect(args, owner)
        tools, _ = collect(args.get("tools", []), owner)
        if op in CUTTER_OPS:
            _, positive = collect(args.get("body"), owner)
        if "requirement" in node:
            feature = node["requirement"]
            role = recipe_roles.get(feature, requirement_role(op))
            records[feature] = {"node": node["id"], "owner": owner, "role": role}
            if role == "cutter": tools[feature] = records[feature]
            else: positive.add(feature)
        values[node["id"]] = {"result": (records, positive), "tool": (tools, set())}
    return {owner: collect(reference, owner) for owner, reference in ir["parts"].items()}


def structural_issues(ir, parts, *, revision=None):
    contributions = result_bindings(ir)
    issues = []
    for part in sorted(parts & ir["parts"].keys()):
        records, positive = contributions[part]
        if any(records[name]["role"] in {"solid", "separate"} for name in positive): continue
        nodes = [node for node in ir["nodes"] if node["owner"] == part and "requirement" in node]
        issues.append({"severity": "error", "stage": "preflight", "code": "DESIGN.STRUCTURAL_BINDING_MISSING",
            "message": "physical part needs a solid or separate requirement contributing to its selected result",
            "part": part, "field": "/parts/" + part + "/result", "result": ir["parts"][part],
            "expected": ["solid", "separate"],
            "actual": [{"node": node["id"], "featureId": node["requirement"], "role": requirement_role(node["op"]),
                        "inResult": node["requirement"] in records,
                        "contributesMaterial": node["requirement"] in positive} for node in nodes],
            "relatedNodes": [node["id"] for node in nodes],
            **({"designRevision": revision} if revision else {}),
            "repairHint": "Bind an existing final-body intent feature to translate(input=the current part result, offset=[0,0,0]), then select that result. Preserve cutters and independent targets; no extra geometry is needed."})
    return issues
