"""Typed, bounded design documents. This module never imports the CAD kernel."""
from __future__ import annotations

import ast
from copy import deepcopy
from dataclasses import dataclass
import math
import json
import re

SCHEMA = "a3d-design/v1"
VERSION = 4
LIMITS = {"documentBytes": 262_144, "nodes": 256, "changes": 64,
          "expressionNodes": 64, "expressionDepth": 16, "parameterDepth": 32,
          "dependencyDepth": 64, "points": 128, "instances": 64}
ID = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
TYPES = {"length": (1, 0), "angle": (0, 1), "scalar": (0, 0), "integer": (0, 0)}


class DesignError(ValueError):
    def __init__(self, code: str, message: str, field: str = "", *, issues=None, **details):
        super().__init__(message)
        self.issue = {"severity": "error", "code": "DESIGN." + code,
                      "message": message, "field": field, **details}
        self.issues = issues if issues is not None else [self.issue]


def fail(code, message, field="", **details):
    raise DesignError(code, message, field, **details)


def fields(value, required, optional=(), *, field=""):
    if not isinstance(value, dict):
        fail("TYPE", "expected an object", field)
    unknown, missing = set(value) - set(required) - set(optional), set(required) - set(value)
    if unknown or missing:
        fail("SCHEMA", "unexpected or missing fields", field,
             unknown=sorted(unknown), missing=sorted(missing))


def identifier(value, field=""):
    if not isinstance(value, str) or not ID.fullmatch(value):
        fail("SCHEMA", "ID must start with a lowercase letter and contain letters, digits, _ or -", field)
    return value


@dataclass(frozen=True)
class Quantity:
    value: float
    unit: tuple[int, int]


def expression(value, parameters, field):
    """Interpret a numeric AST; functions and dimensional rules are explicit."""
    try:
        tree = ast.parse(value[1:], mode="eval")
    except (SyntaxError, RecursionError) as error:
        fail("SCHEMA", f"invalid expression: {error}", field)
    if sum(1 for _ in ast.walk(tree)) > LIMITS["expressionNodes"]:
        fail("RESOURCE_LIMIT", "expression is too large", field)
    def depth(node):
        return 1 + max((depth(child) for child in ast.iter_child_nodes(node)), default=0)
    if depth(tree) > LIMITS["expressionDepth"]:
        fail("RESOURCE_LIMIT", "expression is too deeply nested", field)

    def evaluate(node):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            result = Quantity(node.value, (0, 0))
        elif isinstance(node, ast.Name):
            result = parameters(node.id)
            if not isinstance(result, Quantity):
                fail("TYPE", "numeric expressions require numeric parameters", field)
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            a = evaluate(node.operand)
            result = Quantity(a.value if isinstance(node.op, ast.UAdd) else -a.value, a.unit)
        elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
            a, b = evaluate(node.left), evaluate(node.right)
            if isinstance(node.op, (ast.Add, ast.Sub)):
                if a.unit != b.unit:
                    fail("UNIT", "addition/subtraction require equal units; use mm() or deg() for constants", field)
                result = Quantity(a.value + b.value if isinstance(node.op, ast.Add) else a.value - b.value, a.unit)
            elif isinstance(node.op, ast.Mult):
                result = Quantity(a.value * b.value, tuple(x + y for x, y in zip(a.unit, b.unit)))
            else:
                if b.value == 0:
                    fail("PARAMETER_DOMAIN", "division by zero", field)
                result = Quantity(a.value / b.value, tuple(x - y for x, y in zip(a.unit, b.unit)))
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            name, args = node.func.id, [evaluate(arg) for arg in node.args]
            if name in {"mm", "deg"} and len(args) == 1 and args[0].unit == (0, 0):
                result = Quantity(args[0].value, TYPES["length" if name == "mm" else "angle"])
            elif name in {"min", "max"} and args and len({arg.unit for arg in args}) == 1:
                result = Quantity((min if name == "min" else max)(arg.value for arg in args), args[0].unit)
            elif name == "abs" and len(args) == 1:
                result = Quantity(abs(args[0].value), args[0].unit)
            elif name == "sqrt" and len(args) == 1 and all(n % 2 == 0 for n in args[0].unit):
                result = Quantity(math.sqrt(args[0].value), tuple(n // 2 for n in args[0].unit))
            elif name in {"sin", "cos"} and len(args) == 1 and args[0].unit == TYPES["angle"]:
                result = Quantity(getattr(math, name)(math.radians(args[0].value)), (0, 0))
            elif name == "atan2" and len(args) == 2 and args[0].unit == args[1].unit:
                result = Quantity(math.degrees(math.atan2(args[0].value, args[1].value)), TYPES["angle"])
            else:
                fail("UNIT", f"unsupported function or incompatible arguments: {name}", field)
        else:
            fail("SCHEMA", "expression supports numeric parameters, arithmetic and listed functions only", field)
        if not math.isfinite(result.value) or abs(result.value) > 1e12:
            fail("PARAMETER_DOMAIN", "expression must have a finite bounded result", field)
        return result

    try:
        return evaluate(tree.body)
    except (OverflowError, ValueError) as error:
        if isinstance(error, DesignError):
            raise
        fail("PARAMETER_DOMAIN", str(error), field)


def number(value, kind, parameters, field):
    unit = TYPES[kind]
    if isinstance(value, str) and value.startswith("="):
        result = expression(value, parameters, field)
        if result.unit != unit:
            fail("UNIT", f"expected {kind}", field, actual=list(result.unit))
        value = result.value
    if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > 1e6:
        fail("TYPE", f"expected a finite {kind} within ±1000000", field)
    if kind == "integer":
        if value != int(value):
            fail("TYPE", "expected an integer", field)
        return int(value)
    return float(value)


def parameters(document):
    definitions, values, visiting = document.get("params", {}), {}, set()

    def resolve(name):
        if name in values:
            return values[name]
        if name not in definitions:
            fail("REFERENCE", f"unknown parameter: {name}", "/params")
        if name in visiting:
            fail("CYCLE", f"parameter dependency cycle at {name}", "/params/" + name)
        if len(visiting) >= LIMITS["parameterDepth"]:
            fail("RESOURCE_LIMIT", "parameter dependency chain is too deep", "/params/" + name)
        visiting.add(name)
        spec, field = definitions[name], "/params/" + name
        identifier(name, field)
        fields(spec, {"type", "value"}, {"range", "label"}, field=field)
        if "label" in spec:
            label = spec["label"]
            fields(label, {"en", "zh"}, field=field + "/label")
            for language, text in label.items():
                if (not isinstance(text, str) or not text.strip() or text != text.strip()
                        or len(text) > 48 or any(ord(char) < 32 for char in text)):
                    fail("SCHEMA", "parameter labels must be short nonempty strings (1..48 characters)",
                         field + "/label/" + language)
        kind = spec["type"]
        if not isinstance(kind, str):
            fail("TYPE", "parameter type must be a string", field + "/type")
        if kind == "boolean":
            if type(spec["value"]) is not bool or "range" in spec:
                fail("TYPE", "boolean parameters need a literal boolean and no range", field)
            result = spec["value"]
        elif kind in TYPES:
            result = Quantity(number(spec["value"], kind, resolve, field + "/value"), TYPES[kind])
            if "range" in spec:
                bounds = spec["range"]
                if not isinstance(bounds, list) or len(bounds) != 2:
                    fail("TYPE", "range must contain two bounds", field + "/range")
                low, high = [number(x, kind, resolve, field + "/range") for x in bounds]
                if not low <= result.value <= high:
                    fail("PARAMETER_DOMAIN", "parameter is outside its range", field, expected=bounds, actual=result.value)
        else:
            fail("TYPE", "parameter type must be length, angle, scalar, integer or boolean", field)
        visiting.remove(name)
        values[name] = result
        return result

    for name in definitions:
        resolve(name)
    return values


def op(output, required, optional=None, ports=None):
    return {"output": output, "required": required, "optional": optional or {}, "ports": ports or {}}


# The same field contracts are returned by capabilities and used by normalize().
OPS = {
    "box": op("Solid", {"size": "size3"}, {"align": "align3"}),
    "cylinder": op("Solid", {"radius": "positive", "height": "positive"}, {"align": "align3"}),
    "cone": op("Solid", {"bottomRadius": "nonnegative", "topRadius": "nonnegative", "height": "positive"}, {"align": "align3"}),
    "sphere": op("Solid", {"radius": "positive"}),
    "torus": op("Solid", {"majorRadius": "positive", "minorRadius": "positive"}),
    "rectangle": op("Profile", {"size": "size2"}),
    "rounded_rectangle": op("Profile", {"size": "size2"}, {"radius": "positive", "radii": "radii4"}),
    "circle": op("Profile", {"radius": "positive"}),
    "ellipse": op("Profile", {"radii": "size2"}),
    "polygon": op("Profile", {"points": "points2"}),
    "regular_polygon": op("Profile", {"radius": "positive", "count": "count"}),
    "slot": op("Profile", {"size": "size2"}),
    "line": op("Path", {"points": "points3"}),
    "polyline": op("Path", {"points": "points3"}, {"closed": "boolean"}),
    "arc": op("Path", {"points": "points3"}),
    "face_from_path": op("Profile", {"path": "ref:Path"}),
    "extrude": op("Solid", {"profile": "ref:Profile", "frame": "ref:Frame", "length": "positive"}, {"direction": "+normal|-normal"}),
    "revolve": op("Solid", {"profile": "ref:Profile", "frame": "ref:Frame", "axis": "axis", "angle": "angle"}),
    "loft": op("Solid", {"sections": "sections"}, {"ruled": "boolean"}),
    "union": op("Solid", {"body": "ref:Solid", "tools": "refs:Solid,SolidSet"}),
    "cut": op("Solid", {"body": "ref:Solid", "tools": "refs:Solid,SolidSet"}, ports={"tool": "SolidSet"}),
    "intersect": op("Solid", {"body": "ref:Solid", "tools": "refs:Solid,SolidSet"}),
    "translate": op("same", {"input": "ref:Solid,Profile,Path,SolidSet", "offset": "vec3"}),
    "rotate": op("same", {"input": "ref:Solid,Profile,Path,SolidSet", "axis": "axis", "angle": "angle"}),
    "mirror": op("same", {"input": "ref:Solid,Profile,Path,SolidSet", "frame": "ref:Frame"}),
    "linear_pattern": op("SolidSet", {"input": "ref:Solid", "step": "vec3", "count": "count"}),
    "polar_pattern": op("SolidSet", {"input": "ref:Solid", "axis": "axis", "count": "count"}, {"angle": "angle"}),
    "placements": op("SolidSet", {"input": "ref:Solid", "offsets": "placements"}),
    "fillet": op("Solid", {"body": "ref:Solid", "edges": "selector", "radius": "positive"}),
    "chamfer": op("Solid", {"body": "ref:Solid", "edges": "selector", "length": "positive"}),
    "pocket": op("Solid", {"body": "ref:Solid", "profile": "ref:Profile", "frame": "ref:Frame", "direction": "+normal|-normal", "depth": "depth"}, ports={"tool": "Solid"}),
    "hole": op("Solid", {"body": "ref:Solid", "radius": "positive", "frame": "ref:Frame", "direction": "+normal|-normal", "depth": "depth"}, ports={"tool": "Solid"}),
    "open_box": op("Solid", {"size": "size3", "wall": "positive", "floor": "positive"}, ports={"tool": "Solid"}),
    "collar_socket": op("Connection", {"frame": "ref:Frame", "size": "size2", "radius": "positive",
        "engagement": "positive", "clearance": "nonnegative", "wall": "positive",
        "malePart": "part", "femalePart": "part", "maleFeature": "feature", "femaleFeature": "feature"},
        {"overshoot": "nonnegative"}, {"male": "Solid", "socket": "Solid"}),
    "self_tapping_screw": op("Connection", {"frame": "ref:Frame", "interface": "feature",
        "coverPart": "part", "receiverPart": "part", "clearanceFeature": "feature", "pilotFeature": "feature", "bossFeature": "feature",
        "coverThickness": "positive"}, {key: "positive" for key in (
        "nominalDiameter", "clearanceDiameter", "pilotDiameter", "bossDiameter", "engagement", "tipClearance",
        "closedEnd", "minimumWall", "rootEmbed", "overshoot") } | {"locators": "features"},
        {"clearance": "Solid", "pilot": "Solid", "boss": "Solid"}),
    "installation": op("Installation", {"part": "part", "feature": "feature", "envelope": "ref:Solid"},
        {"obstacles": "parts", "supports": "parts", "retainers": "parts", "passageParts": "parts",
         "insertion": "ref:Solid", "passage": "ref:Solid", "withdrawalAxis": "direction", "supportDirection": "direction",
         "contactProbe": "positive", "freeTravel": "nonnegative", "stopTravel": "positive", "displayFeature": "feature", "color": "color"}),
}
for name in ("box", "cylinder", "cone"):
    OPS[name]["defaults"] = {"align": ["center", "center", "center"]}
for name, defaults in {"polyline": {"closed": False}, "extrude": {"direction": "+normal"},
                       "loft": {"ruled": False}, "polar_pattern": {"angle": 360}}.items():
    OPS[name]["defaults"] = defaults
OPS["collar_socket"]["defaults"] = {"overshoot": 0.3}
OPS["self_tapping_screw"]["defaults"] = {"nominalDiameter": 3, "clearanceDiameter": 3.4, "pilotDiameter": 2.6,
    "bossDiameter": 7.5, "engagement": 6, "tipClearance": 0.8, "closedEnd": 1.2, "minimumWall": 1.8,
    "rootEmbed": 0.4, "overshoot": 1, "locators": []}
OPS["installation"]["defaults"] = {"obstacles": [], "supports": [], "retainers": [], "passageParts": [],
    "withdrawalAxis": [0, 0, 1], "contactProbe": 0.05, "color": "#1D3B4A"}


def definitions(document):
    """Stable edit addresses and source pointers for all supported definitions."""
    result = {}
    for space in ("params", "frames", "profiles", "paths", "connections", "assets"):
        for name, value in document.get(space, {}).items():
            identifier(name, "/" + space)
            result[f"{space}.{name}"] = (value, f"/{space}/{name}")
    for name, part in document.get("parts", {}).items():
        identifier(name, "/parts")
        if name in {"params", "frames", "profiles", "paths", "parts", "connections", "assets"}:
            fail("SCHEMA", "part ID uses a reserved namespace", "/parts/" + name)
        fields(part, {"features", "result"}, field="/parts/" + name)
        result[f"parts.{name}"] = (part, f"/parts/{name}")
        if not isinstance(part["features"], list):
            fail("TYPE", "features must be an array", f"/parts/{name}/features")
        for index, feature in enumerate(part["features"]):
            field = f"/parts/{name}/features/{index}"
            if not isinstance(feature, dict) or "id" not in feature:
                fail("SCHEMA", "feature needs an ID", field)
            key = name + "." + identifier(feature["id"], field + "/id")
            if key in result:
                fail("SCHEMA", "duplicate feature ID", field)
            result[key] = (feature, field)
    return result


def normalize(document: dict) -> dict:
    fields(document, {"schema", "units", "params", "parts"}, {"frames", "profiles", "paths", "connections", "assets"})
    if document["schema"] != SCHEMA or document["units"] != {"length": "mm", "angle": "deg"}:
        fail("SCHEMA", "design requires a3d-design/v1 and mm/deg units")
    for space in ("params", "parts", "frames", "profiles", "paths", "connections", "assets"):
        if not isinstance(document.get(space, {}), dict):
            fail("TYPE", f"{space} must be an object", "/" + space)
    if len(json.dumps(document, ensure_ascii=False, allow_nan=False).encode()) > LIMITS["documentBytes"]:
        fail("RESOURCE_LIMIT", "design document is too large")
    entries = definitions(document)
    if len(entries) > LIMITS["nodes"]:
        fail("RESOURCE_LIMIT", "design contains too many definitions")
    params = parameters(document)
    nodes, visiting = {}, set()

    def parameter(name):
        if name not in params:
            fail("REFERENCE", f"unknown parameter: {name}", "/params")
        return params[name]

    def ref(value, allowed, field, owner):
        if not isinstance(value, str) or not value.startswith("@"):
            fail("REFERENCE", "expected a named @ reference", field)
        target, _, port = value[1:].partition(":")
        if target not in entries or target.startswith(("params.", "parts.")):
            fail("REFERENCE", f"unknown geometry reference: {value}", field)
        node = resolve(target)
        kind = node["ports"].get(port) if port else node["type"]
        if kind not in allowed:
            fail("TYPE", f"reference requires {', '.join(allowed)}", field, actual=kind)
        reference_owner = node.get("portOwners", {}).get(port, node["owner"])
        if owner and reference_owner and owner != reference_owner:
            fail("OWNERSHIP", "cross-part inputs require an explicit transform/copy node", field)
        return value

    def argument(value, kind, field, owner):
        if kind == "radii4":
            if not isinstance(value, list) or len(value) != 4:
                fail("TYPE", "radii needs four corner lengths: bottom-left, bottom-right, top-right, top-left", field)
            return [argument(item, "nonnegative", field + f"/{i}", owner) for i, item in enumerate(value)]
        if kind == "color":
            if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
                fail("TYPE", "expected a six-digit hex color", field)
            return value
        if kind in {"part", "feature"}:
            if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_/-]*", value):
                fail("TYPE", f"expected a {kind} ID", field)
            if kind == "part" and value not in document["parts"]:
                fail("OWNERSHIP", "unknown physical part", field, actual=value)
            return value
        if kind in {"parts", "features"}:
            if (not isinstance(value, list) or len(value) > LIMITS["instances"]
                    or any(not isinstance(item, str) for item in value) or len(set(value)) != len(value)):
                fail("TYPE", "expected a bounded array of distinct IDs", field)
            return [argument(item, "part" if kind == "parts" else "feature", field + f"/{i}", owner) for i, item in enumerate(value)]
        if kind in {"length", "angle", "scalar", "integer", "positive", "nonnegative", "count"}:
            base = "length" if kind in {"positive", "nonnegative"} else "integer" if kind == "count" else kind
            result = number(value, base, parameter, field)
            if ((kind == "positive" and result <= 0) or (kind == "nonnegative" and result < 0)
                    or (kind == "count" and not 1 <= result <= LIMITS["instances"])):
                fail("PARAMETER_DOMAIN", f"invalid {kind}", field, actual=result)
            return result
        if kind == "boolean":
            if isinstance(value, str) and value.startswith("="):
                value = parameter(value[1:])
            if type(value) is not bool:
                fail("TYPE", "expected a boolean", field)
            return value
        if kind.startswith("ref:"):
            return ref(value, kind[4:].split(","), field, owner)
        if kind.startswith("refs:"):
            if not isinstance(value, list) or not 1 <= len(value) <= LIMITS["instances"]:
                fail("TYPE", "expected a bounded nonempty reference array", field)
            return [ref(item, kind[5:].split(","), field + f"/{i}", owner) for i, item in enumerate(value)]
        if kind in {"vec3", "direction", "size2", "size3", "align3"}:
            count = 2 if kind == "size2" else 3
            if not isinstance(value, list) or len(value) != count:
                fail("TYPE", f"expected {count} values", field)
            subtype = "min|center|max" if kind == "align3" else "scalar" if kind == "direction" else "positive" if kind.startswith("size") else "length"
            result = [argument(item, subtype, field + f"/{i}", owner) for i, item in enumerate(value)]
            if kind == "direction" and math.sqrt(sum(x*x for x in result)) < 1e-9:
                fail("FRAME", "direction cannot be zero", field)
            return result
        if kind in {"points2", "points3", "placements"}:
            low, high = (1, LIMITS["instances"]) if kind == "placements" else (2, LIMITS["points"])
            if not isinstance(value, list) or not low <= len(value) <= high:
                fail("RESOURCE_LIMIT", f"coordinate array requires {low}..{high} points", field)
            count = 3 if kind == "placements" else int(kind[-1])
            result = []
            for i, point in enumerate(value):
                if not isinstance(point, list) or len(point) != count:
                    fail("TYPE", f"point must have {count} coordinates", field + f"/{i}")
                result.append([number(x, "length", parameter, field + f"/{i}/{j}") for j, x in enumerate(point)])
            return result
        if kind == "axis":
            fields(value, {"origin", "direction"}, field=field)
            return {key: argument(value[key], "vec3" if key == "origin" else "direction", field + "/" + key, owner) for key in value}
        if kind == "depth":
            fields(value, {"mode"}, {"length"}, field=field)
            mode = argument(value["mode"], "blind|through_all", field + "/mode", owner)
            if mode == "blind":
                fields(value, {"mode", "length"}, field=field)
                return {"mode": mode, "length": argument(value["length"], "positive", field + "/length", owner)}
            if "length" in value:
                fail("SCHEMA", "through_all has no length field", field)
            return {"mode": mode}
        if kind == "sections":
            if not isinstance(value, list) or not 2 <= len(value) <= 16:
                fail("RESOURCE_LIMIT", "loft requires 2..16 sections", field)
            result = []
            for i, section in enumerate(value):
                fields(section, {"profile", "frame"}, field=field + f"/{i}")
                result.append({key: argument(section[key], "ref:" + ("Profile" if key == "profile" else "Frame"), field + f"/{i}/{key}", owner) for key in section})
            return result
        if kind == "selector":
            fields(value, {"of", "where", "expect"}, field=field)
            result = {"of": ref(value["of"], ["Solid"], field + "/of", owner)}
            fields(value["where"], {}, {"curve", "parallel", "center", "length", "radius", "extreme"}, field=field + "/where")
            where = {}
            for key, item in value["where"].items():
                location = field + "/where/" + key
                if key == "curve":
                    where[key] = argument(item, "line|circle|ellipse|bspline|bezier", location, owner)
                elif key == "parallel":
                    where[key] = argument(item, "direction", location, owner)
                elif key == "center":
                    fields(item, {}, {"x", "y", "z"}, field=location)
                    where[key] = {axis: bounds(pair, location + "/" + axis) for axis, pair in item.items()}
                elif key == "extreme":
                    fields(item, {"axis", "end"}, field=location)
                    where[key] = {"axis": argument(item["axis"], "direction", location + "/axis", owner),
                                  "end": argument(item["end"], "min|max", location + "/end", owner)}
                else:
                    where[key] = bounds(item, location)
            fields(value["expect"], {"count"}, field=field + "/expect")
            result.update(where=where, expect={"count": argument(value["expect"]["count"], "count", field + "/expect/count", owner)})
            return result
        if "|" in kind:
            if value not in kind.split("|"):
                fail("TYPE", "expected one of: " + kind, field)
            return value
        raise RuntimeError("unknown internal field contract: " + kind)

    def bounds(value, field):
        if not isinstance(value, list) or len(value) != 2:
            fail("TYPE", "expected [minimum, maximum]", field)
        result = [number(x, "length", parameter, field) for x in value]
        if result[0] > result[1]:
            fail("PARAMETER_DOMAIN", "minimum exceeds maximum", field)
        return result

    def resolve(target):
        if target in nodes:
            return nodes[target]
        if target in visiting:
            fail("CYCLE", f"geometry dependency cycle at {target}", entries[target][1], node=target)
        if len(visiting) >= LIMITS["dependencyDepth"]:
            fail("RESOURCE_LIMIT", "geometry dependency chain is too deep", entries[target][1], node=target)
        visiting.add(target)
        value, field = entries[target]
        space = target.split(".")[0]
        owner = None if space in {"frames", "profiles", "paths", "connections", "assets"} else space
        try:
            if target.startswith("frames."):
                fields(value, {"origin", "u", "normal"}, field=field)
                args = {key: argument(value[key], "vec3" if key == "origin" else "direction", field + "/" + key, None) for key in value}
                u, n = args["u"], args["normal"]
                u, n = [[x / math.sqrt(sum(y*y for y in vector)) for x in vector] for vector in (u, n)]
                if abs(sum(x*y for x, y in zip(u, n))) > 1e-6:
                    fail("FRAME", "frame u and normal must be orthogonal", field)
                args.update(u=u, normal=n)
                node = {"op": "frame", "args": args, "type": "Frame", "ports": {}}
            else:
                if not isinstance(value, dict) or not isinstance(value.get("op"), str) or value["op"] not in OPS:
                    fail("UNSUPPORTED", "unknown or unsupported design operation", field, requested=value.get("op") if isinstance(value, dict) else None)
                name, spec = value["op"], OPS[value["op"]]
                if (space == "connections") != (spec["output"] == "Connection") or (space == "assets") != (spec["output"] == "Installation"):
                    fail("TYPE", "operation does not match its namespace", field)
                fields(value, {"op", *spec["required"], *({"id"} if owner else set())},
                       {*spec["optional"], "requirement"} if owner else set(spec["optional"]), field=field)
                copy_operation = name in {"translate", "rotate", "mirror"}
                args = {key: argument(item, {**spec["required"], **spec["optional"]}[key], field + "/" + key,
                                      None if copy_operation and key == "input" else owner)
                        for key, item in value.items() if key not in {"op", "id", "requirement"}}
                args = {**deepcopy(spec.get("defaults", {})), **args}
                if spec["output"] == "same":
                    input_target, _, port = args["input"][1:].partition(":")
                    output = nodes[input_target]["ports"][port] if port else nodes[input_target]["type"]
                else:
                    output = spec["output"]
                if target.startswith("profiles.") and output != "Profile" or target.startswith("paths.") and output != "Path":
                    fail("TYPE", "definition does not match its namespace", field)
                if name in {"fillet", "chamfer"} and args["edges"]["of"] != args["body"]:
                    fail("OWNERSHIP", "selector must use the exact body input", field + "/edges/of")
                if name in {"line", "arc", "polygon", "regular_polygon"}:
                    count = len(args["points"]) if "points" in args else args["count"]
                    if (name == "line" and count != 2) or (name == "arc" and count != 3) or (name in {"polygon", "regular_polygon"} and count < 3):
                        fail("PARAMETER_DOMAIN", "wrong point/side count", field)
                if name == "cone" and args["bottomRadius"] == args["topRadius"] == 0:
                    fail("PARAMETER_DOMAIN", "cone requires a positive radius", field)
                if name == "torus" and args["minorRadius"] >= args["majorRadius"]:
                    fail("PARAMETER_DOMAIN", "torus minorRadius must be smaller than majorRadius", field)
                if name == "rounded_rectangle":
                    if ("radius" in args) == ("radii" in args):
                        fail("SCHEMA", "rounded rectangle needs radius or radii, exclusively", field)
                    if "radius" in args and 2 * args["radius"] > min(args["size"]):
                        fail("PARAMETER_DOMAIN", "rounded rectangle radius exceeds half its size", field)
                    if "radii" in args:
                        r, (width, height) = args["radii"], args["size"]
                        if any(total >= side for total, side in ((r[0]+r[1], width), (r[2]+r[3], width), (r[0]+r[3], height), (r[1]+r[2], height))):
                            fail("PARAMETER_DOMAIN", "adjacent corner radii must leave a straight segment on each side", field + "/radii")
                if name == "slot" and args["size"][0] < args["size"][1]:
                    fail("PARAMETER_DOMAIN", "slot overall length must be at least its diameter", field)
                if name == "revolve" and not 0 < abs(args["angle"]) <= 360:
                    fail("PARAMETER_DOMAIN", "revolve angle must be within ±360 and nonzero", field)
                if name == "open_box" and (2 * args["wall"] >= min(args["size"][:2]) or args["floor"] >= args["size"][2]):
                    fail("PARAMETER_DOMAIN", "box wall/floor leaves no cavity", field)
                node = {"op": name, "args": args, "type": output, "ports": spec["ports"]}
                if output == "Connection":
                    from design_connections import validate_connection
                    node["portOwners"] = validate_connection(name, args, field)
                if "requirement" in value:
                    if not isinstance(value["requirement"], str) or not value["requirement"].strip():
                        fail("TYPE", "requirement must be a nonempty ID", field + "/requirement")
                    node["requirement"] = value["requirement"]
            node.update(id=target, owner=owner, field=field)
            nodes[target] = node
        except DesignError as error:
            error.issue.setdefault("node", target)
            error.issue.setdefault("nodeId", target)
            error.issue.setdefault("causeId", target + ":" + error.issue["field"][len(field):])
            raise
        visiting.remove(target)
        return node

    for target in entries:
        if not target.startswith(("params.", "parts.")):
            resolve(target)
    requirements = set()
    for node in nodes.values():
        if "requirement" in node:
            if node["type"] not in {"Solid", "SolidSet"}:
                fail("TYPE", "requirements bind solid geometry", node["field"] + "/requirement", node=node["id"])
            if node["requirement"] in requirements:
                fail("SCHEMA", "requirement is bound more than once", node["field"] + "/requirement", node=node["id"])
            requirements.add(node["requirement"])
    for owner, part in document["parts"].items():
        ref(part["result"], ["Solid"], f"/parts/{owner}/result", owner)
    from design_connections import validate_bindings
    validate_bindings(list(nodes.values()), {name: part["result"] for name, part in document["parts"].items()})
    return {"schema": SCHEMA, "version": VERSION, "params": {key: item.value if isinstance(item, Quantity) else item for key, item in params.items()},
            "nodes": list(nodes.values()), "parts": {name: part["result"] for name, part in document["parts"].items()}}


def references(value):
    if isinstance(value, str) and value.startswith("@"):
        yield value[1:].partition(":")[0]
    elif isinstance(value, dict):
        for item in value.values():
            yield from references(item)
    elif isinstance(value, list):
        for item in value:
            yield from references(item)


def capabilities(names: list[str]) -> dict:
    hints = {"array": ["linear_pattern", "polar_pattern", "placements"], "subtract": ["cut"], "shell": ["open_box"]}
    field_types = {
        "length": "finite length in mm; literal number or typed =expression", "angle": "degrees",
        "scalar": "dimensionless number", "integer": "integer", "boolean": "true/false or =boolean_parameter",
        "positive": "length in mm, >0", "nonnegative": "length in mm, >=0", "count": "integer, 1..64",
        "vec3": "three lengths in mm", "direction": "three dimensionless scalars; nonzero",
        "size2": "two positive lengths", "size3": "three positive lengths",
        "align3": "three choices from min/center/max, in XYZ order",
        "points2": "2..128 local XY length coordinates", "points3": "2..128 XYZ length coordinates",
        "placements": "1..64 XYZ length offsets", "radii4": "four nonnegative lengths: bottom-left, bottom-right, top-right, top-left",
        "part": "existing physical part ID", "parts": "0..64 distinct physical part IDs",
        "feature": "semantic feature/interface ID", "features": "0..64 distinct semantic IDs",
        "color": "#RRGGBB for a non-manufactured display reference",
        "Frame": {"required": {"origin": "vec3", "u": "direction", "normal": "direction"},
                  "rule": "u and normal must be orthogonal; local v = normal cross u"},
        "axis": {"required": {"origin": "vec3", "direction": "direction"},
                 "example": {"origin": [0, 0, 0], "direction": [0, 0, 1]}},
        "depth": {"choices": [{"mode": "blind", "length": "positive"}, {"mode": "through_all"}],
                  "rule": "through_all has no length and spans both walls along the frame normal"},
        "sections": {"count": "2..16", "item": {"profile": "ref:Profile", "frame": "ref:Frame"}},
        "selector": {"required": {"of": "ref:Solid", "where": "edge filters", "expect": {"count": "count"}},
                     "where": {"curve": "line|circle|ellipse|bspline|bezier", "parallel": "direction",
                               "center": {"x/y/z": "[minimum, maximum] lengths"},
                               "length/radius": "[minimum, maximum] lengths",
                               "extreme": {"axis": "direction", "end": "min|max"}},
                     "rules": "All filters combine; bounds are inclusive; of must equal body; ties remain; wrong count fails",
                     "example": {"of": "@body.blank", "where": {"parallel": [0, 0, 1]}, "expect": {"count": 4}}},
    }
    selected = names or list(OPS)
    kinds = {kind for name in selected if name in OPS for key in ("required", "optional") for kind in OPS[name][key].values()}
    # Include structures referenced by complex fields, not the entire handbook.
    if kinds & {"axis", "selector", "sections"} or any("Frame" in kind for kind in kinds):
        kinds.update({"vec3", "direction", "Frame"})
    if "depth" in kinds:
        kinds.add("positive")
    if "selector" in kinds:
        kinds.add("count")
    types = {kind: deepcopy(field_types[kind]) if kind in field_types
             else {"choices": kind.split("|")} if "|" in kind
             else "named @reference of type " + kind.partition(":")[2] if kind.startswith("ref:")
             else "1..64 named @references of type " + kind.partition(":")[2]
             for kind in sorted(kinds)}
    operations = {name: {"status": "supported", **deepcopy(OPS[name])} if name in OPS
                  else {"status": "unsupported", "relatedOperations": hints.get(name, [])} for name in selected}
    for name in selected:
        if name in OPS and name not in {"collar_socket", "self_tapping_screw", "installation"}:
            from design_roles import requirement_role
            operations[name]["requirementRole"] = requirement_role(name)
            operations[name]["bindingRule"] = "For Solid/SolidSet requirements: cutters describe subtraction. Each physical part also needs a solid/separate binding in its result material chain; an identity translate can observe a pure subtractive final body."
        if name == "self_tapping_screw":
            from design_connections import SCREW_FIELDS, COUPLED_CONSTRAINTS
            operations[name]["coupledConstraints"] = COUPLED_CONSTRAINTS[name]
            operations[name]["intent"] = {
                "interface": "manufacturing.interfaces[] with matching id, connection=self-tapping-screw, between and features",
                "fastening": {"screw_family": "independent hardware specification",
                              "locator_pairs": [{"id": "collar connection ID", "male_feature": "maleFeature", "female_feature": "femaleFeature"}],
                              "fasteners": [{"id": "screw connection ID", "clearance_feature": "clearanceFeature", "pilot_feature": "pilotFeature", "boss_feature": "bossFeature"}]},
                "dimensions": {"fastening": [field for field in SCREW_FIELDS.values() if field != "engagement_mm"],
                               "interface.engagement_mm": "independent positive length target"},
                "rule": "All endpoint features need intent owners and requirement bindings; locator_pairs is required; do not derive targets from current geometry",
            }
        elif name == "collar_socket":
            operations[name]["intent"] = "Match an independent collar-socket interface or a screw locator_pair; consume male/socket on their owners with maleFeature/femaleFeature requirements."
            from design_connections import COUPLED_CONSTRAINTS
            operations[name]["coupledConstraints"] = COUPLED_CONSTRAINTS[name]
        elif name == "installation":
            operations[name]["intent"] = "feature must bind a physical intent feature with installation_checks; displayFeature is a separate display ID. Keep component/path volumes faithful to independently specified hardware."
        elif name == "union":
            operations[name]["rule"] = "Checked union requires a connected body. Union additive features into their actual receiving body; pass separate cutters as a tools array or use a SolidSet pattern, not an unrelated union of disconnected bosses."
    return {"schema": SCHEMA, "version": VERSION, "limits": LIMITS,
            "parameterDefinition": {
                "required": {"type": "length|angle|scalar|integer|boolean", "value": "literal or typed expression"},
                "optional": {"range": "two numeric bounds for numeric parameters", "label": {"en": "nonempty English display string, 1..48 characters", "zh": "nonempty Chinese display string, 1..48 characters"}},
                "labelRule": "label requires exactly en and zh, is display-only, and does not affect geometry or dependencies; stable parameter IDs remain expression/API keys",
            },
            "fieldTypes": types, "operations": operations,
            "operationNames": list(OPS)}
