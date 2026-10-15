"""Execute validated design nodes through explicit build123d operations."""
from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import json
import math
import os
from pathlib import Path

from design_language import DesignError, fail, normalize
from design_roles import requirement_role, recipe_role


def build_geometry(ir, *, geometry_values=None):
    import build123d as b
    import cad_helpers as checked

    values, evidence, observations = {}, {}, {}

    def value(reference):
        target, _, port = reference[1:].partition(":")
        return deepcopy(values[target][port or "result"])

    def plane(reference):
        frame = value(reference)
        return b.Plane(origin=frame["origin"], x_dir=frame["u"], z_dir=frame["normal"])

    def axis(spec):
        return b.Axis(spec["origin"], spec["direction"])

    def transform(shape, name, args):
        if name == "translate":
            return shape.translate(args["offset"])
        if name == "rotate":
            return shape.rotate(axis(args["axis"]), args["angle"])
        return b.mirror(shape, about=plane(args["frame"]))

    def inherited_requirements(arguments, owner):
        result = {}
        def visit(item):
            if isinstance(item, str) and item.startswith("@"):
                target, _, port = item[1:].partition(":")
                for key, observation in values[target].get("requirements", {}).get(port or "result", {}).items():
                    if observation["owner"] != owner:
                        continue  # Copies across owners need their own requirement IDs.
                    if key in result and result[key]["placement"] != observation["placement"]:
                        fail("OWNERSHIP", "one requirement appears at multiple placements; use distinct requirement IDs")
                    result[key] = deepcopy(observation)
            elif isinstance(item, dict):
                for child in item.values():
                    visit(child)
            elif isinstance(item, list):
                for child in item:
                    visit(child)
        visit(arguments)
        return result

    def stats(shape):
        bounds = shape.bounding_box()
        return {"solidCount": len(shape.solids()), "volume": float(shape.volume),
                "bounds": {"min": list(bounds.min), "max": list(bounds.max)}}

    def solid(shape, node):
        actual = stats(shape)
        if not shape.is_valid or actual["solidCount"] != 1 or not math.isfinite(actual["volume"]) or actual["volume"] <= 0:
            fail("DISCONNECTED" if actual["solidCount"] > 1 else "POSTCONDITION_FAILED",
                 "operation must return one valid positive-volume solid", node["field"], actual=actual)
        return actual

    def tools(args):
        return b.Compound(children=[solid for reference in args["tools"] for solid in value(reference).solids()])

    def cut_tool(profile, frame, direction, depth, body):
        normal = b.Vector(frame["normal"])
        direction = normal if direction == "+normal" else -normal
        face = b.Plane(origin=frame["origin"], x_dir=frame["u"], z_dir=frame["normal"]) * profile
        overshoot = 0.0001
        if depth["mode"] == "blind":
            face = face.translate(-direction * overshoot)
            length = depth["length"] + overshoot
        else:
            bounds = body.bounding_box()
            projections = [(b.Vector(x, y, z) - b.Vector(frame["origin"])).dot(direction)
                           for x in (bounds.min.X, bounds.max.X) for y in (bounds.min.Y, bounds.max.Y)
                           for z in (bounds.min.Z, bounds.max.Z)]
            face = face.translate(direction * (min(projections) - overshoot))
            length = max(projections) - min(projections) + 2 * overshoot
        return b.extrude(face, amount=length, dir=direction)

    def selection(body, query, node):
        where, candidates = query["where"], list(body.edges())
        if "curve" in where:
            candidates = [edge for edge in candidates if edge.geom_type.name.lower() == where["curve"]]
        if "parallel" in where:
            direction = b.Vector(where["parallel"]).normalized()
            candidates = [edge for edge in candidates if edge.geom_type == b.GeomType.LINE
                          and abs(abs(edge.tangent_at(0).normalized().dot(direction)) - 1) <= 1e-6]
        if "center" in where:
            candidates = [edge for edge in candidates if all(low - 1e-6 <= getattr(edge.center(), key.upper()) <= high + 1e-6
                          for key, (low, high) in where["center"].items())]
        for attribute in ("length", "radius"):
            if attribute in where:
                low, high = where[attribute]
                candidates = [edge for edge in candidates if (attribute != "radius" or edge.geom_type == b.GeomType.CIRCLE)
                              and low - 1e-6 <= getattr(edge, attribute) <= high + 1e-6]
        if "extreme" in where and candidates:
            direction = b.Vector(where["extreme"]["axis"]).normalized()
            coordinates = [edge.center().dot(direction) for edge in candidates]
            boundary = (min if where["extreme"]["end"] == "min" else max)(coordinates)
            candidates = [edge for edge, coordinate in zip(candidates, coordinates) if abs(coordinate - boundary) <= 1e-6]
        evidence[node["id"]] = {"candidateCount": len(candidates), "centers": [list(edge.center()) for edge in candidates]}
        if len(candidates) != query["expect"]["count"]:
            fail("SELECTION_EMPTY" if not candidates else "SELECTION_COUNT", "edge selection did not match the expected count",
                 node["field"] + "/edges", expected=query["expect"], actual={"count": len(candidates)})
        return candidates

    for node in ir["nodes"]:
        name, args, shape, tool = node["op"], node["args"], None, None
        operation_id = "construction/" + node["id"]
        try:
            inherited = inherited_requirements(args, node["owner"])
            align = tuple(getattr(b.Align, item.upper()) for item in args.get("align", ["center"] * 3))
            if name == "frame":
                values[node["id"]] = {"result": args}
                continue
            if node["type"] == "Connection":
                from design_connections import geometry
                shapes, record = geometry(node, value(args["frame"]))
                evidence[node["id"]] = {port: solid(shape, node) for port, shape in shapes.items()}
                values[node["id"]] = {**shapes, "scene": record, "requirements": {}}
                continue
            if node["type"] == "Installation":
                evidence[node["id"]] = {key: solid(value(args[key]), node) for key in ("envelope", "insertion", "passage") if key in args}
                values[node["id"]] = {"requirements": {}}
                continue
            if name == "box":
                shape = b.Box(*args["size"], align=align)
            elif name == "cylinder":
                shape = b.Cylinder(args["radius"], args["height"], align=align)
            elif name == "cone":
                shape = b.Cone(args["bottomRadius"], args["topRadius"], args["height"], align=align)
            elif name == "sphere":
                shape = b.Sphere(args["radius"])
            elif name == "torus":
                shape = b.Torus(args["majorRadius"], args["minorRadius"])
            elif name == "rectangle":
                shape = b.Rectangle(*args["size"])
            elif name == "rounded_rectangle":
                if "radius" in args:
                    shape = b.RectangleRounded(*args["size"], args["radius"])
                else:
                    width, height = args["size"]
                    shape = b.Rectangle(width, height)
                    for (x, y), radius in zip(((-width/2,-height/2), (width/2,-height/2), (width/2,height/2), (-width/2,height/2)), args["radii"]):
                        if radius == 0:
                            continue
                        vertices = [v for v in shape.vertices() if (v.center() - b.Vector(x,y,0)).length < 1e-7]
                        if len(vertices) != 1:
                            fail("SELECTION_COUNT", "rounded rectangle corner must remain a unique vertex", node["field"] + "/radii")
                        shape = b.fillet(vertices, radius)
            elif name == "circle":
                shape = b.Circle(args["radius"])
            elif name == "ellipse":
                shape = b.Ellipse(*args["radii"])
            elif name == "polygon":
                shape = b.Polygon(*(tuple(point) + (0,) for point in args["points"]))
            elif name == "regular_polygon":
                shape = b.RegularPolygon(args["radius"], args["count"])
            elif name == "slot":
                shape = b.SlotOverall(*args["size"])
            elif name in {"line", "polyline"}:
                shape = b.Polyline(*(tuple(point) for point in args["points"]), close=args.get("closed", False))
            elif name == "arc":
                shape = b.ThreePointArc(*(tuple(point) for point in args["points"]))
            elif name == "face_from_path":
                path = value(args["path"])
                wire = b.Wire(path.edges())
                if not wire.is_closed:
                    fail("POSTCONDITION_FAILED", "face_from_path requires a closed path", node["field"])
                shape = b.Face(wire)
            elif name == "extrude":
                frame = value(args["frame"])
                direction = b.Vector(frame["normal"]) * (-1 if args.get("direction", "+normal") == "-normal" else 1)
                shape = b.extrude(plane(args["frame"]) * value(args["profile"]), amount=args["length"], dir=direction)
            elif name == "revolve":
                shape = b.revolve(plane(args["frame"]) * value(args["profile"]), axis=axis(args["axis"]), revolution_arc=args["angle"])
            elif name == "loft":
                sections = [plane(item["frame"]) * value(item["profile"]) for item in args["sections"]]
                if any(len(section.faces()) != 1 or len(section.faces()[0].inner_wires()) for section in sections):
                    fail("UNSUPPORTED", "loft currently requires one outer loop per section and no holes", node["field"])
                shape = b.loft(sections, ruled=args.get("ruled", False))
            elif name in {"union", "cut", "intersect"}:
                body, tool = value(args["body"]), tools(args)
                if name == "union":
                    shape = checked.checked_union(body, tool, operation_id, part_name=node["owner"])
                elif name == "cut":
                    shape = checked.checked_cut(body, tool, operation_id, part_name=node["owner"])
                else:
                    shape = body & tool
                    if float(body.volume) - float(shape.volume) < 0.001:
                        fail("NO_MATERIAL_EFFECT", "intersection must remove material", node["field"])
            elif name in {"translate", "rotate", "mirror"}:
                shape = transform(value(args["input"]), name, args)
                for observation in inherited.values():
                    observation["shape"] = transform(observation["shape"], name, args)
                    observation["placement"].append(node["id"])
            elif name in {"linear_pattern", "polar_pattern", "placements"}:
                original = value(args["input"])
                if name == "linear_pattern":
                    shapes = [deepcopy(original).translate([x * i for x in args["step"]]) for i in range(args["count"])]
                elif name == "polar_pattern":
                    shapes = [deepcopy(original).rotate(axis(args["axis"]), args.get("angle", 360) * i / args["count"]) for i in range(args["count"])]
                else:
                    shapes = [deepcopy(original).translate(offset) for offset in args["offsets"]]
                shape = b.Compound(children=shapes)
                evidence[node["id"]] = {"instances": [f"{node['id']}-i{i}" for i in range(len(shapes))]}
                if inherited and len(shapes) > 1:
                    fail("UNSUPPORTED", "repeated geometry needs requirements on the pattern/consumer or distinct instance IDs", node["field"])
                if name == "placements" and len(shapes) == 1:
                    for observation in inherited.values():
                        observation["shape"] = observation["shape"].translate(args["offsets"][0])
                        observation["placement"].append(node["id"])
            elif name in {"fillet", "chamfer"}:
                body = value(args["body"])
                edges = selection(body, args["edges"], node)
                shape = (checked.checked_fillet if name == "fillet" else checked.checked_chamfer)(
                    body, edges, args["radius" if name == "fillet" else "length"], operation_id,
                    allow_reduce=False, part_name=node["owner"])
            elif name in {"pocket", "hole"}:
                body = value(args["body"])
                profile = value(args["profile"]) if name == "pocket" else b.Circle(args["radius"])
                tool = cut_tool(profile, value(args["frame"]), args["direction"], args["depth"], body)
                shape = checked.checked_cut(body, tool, operation_id, part_name=node["owner"])
            elif name == "open_box":
                width, depth, height = args["size"]
                body = b.Box(width, depth, height, align=(b.Align.CENTER, b.Align.CENTER, b.Align.MIN))
                tool = cut_tool(b.Rectangle(width - 2 * args["wall"], depth - 2 * args["wall"]),
                                {"origin": [0, 0, height], "u": [1, 0, 0], "normal": [0, 0, 1]},
                                "-normal", {"mode": "blind", "length": height - args["floor"]}, body)
                shape = checked.checked_cut(body, tool, operation_id, part_name=node["owner"])
            else:
                raise RuntimeError("operation has no adapter: " + name)
            checked._raise_deferred_source_issues()
            if node["type"] == "Solid":
                evidence.setdefault(node["id"], {}).update(solid(shape, node))
            elif node["type"] == "Profile":
                bounds = shape.bounding_box()
                if not shape.is_valid or len(shape.faces()) != 1 or max(abs(bounds.min.Z), abs(bounds.max.Z)) > 1e-6:
                    fail("POSTCONDITION_FAILED", "profile must be one valid closed region in local XY; use a frame to place it", node["field"])
            elif node["type"] == "Path" and (not shape.is_valid or not shape.edges()):
                fail("POSTCONDITION_FAILED", "path must contain valid connected edges", node["field"])
            elif node["type"] == "SolidSet" and (not shape.is_valid or not shape.solids()):
                fail("POSTCONDITION_FAILED", "pattern must contain valid solids", node["field"])
            tool_requirements = inherited_requirements(args.get("tools", []), node["owner"])
            if "requirement" in node:
                feature_id = node["requirement"]
                role = requirement_role(name)
                observed = tool if role == "cutter" or name == "union" else shape
                observation = {"shape": observed, "owner": node["owner"], "role": role, "placement": []}
                observations[feature_id] = observation
                inherited[feature_id] = observation
                if role == "cutter":
                    tool_requirements[feature_id] = observation
            values[node["id"]] = {"result": shape,
                                  "requirements": {"result": inherited, "tool": tool_requirements},
                                  **({"tool": tool} if tool is not None and "tool" in node["ports"] else {})}
        except Exception as error:
            if not isinstance(error, DesignError):
                error = DesignError("POSTCONDITION_FAILED" if isinstance(error, checked.BuildInvariantError) else "KERNEL_FAILED",
                                    str(error), node["field"])
            error.issue.update(node=node["id"], op=name)
            error.issue.setdefault("nodeId", node["id"])
            error.issue.setdefault("causeId", node["id"] + ":" + error.issue["field"][len(node["field"]):])
            error.evidence = evidence
            raise error
    for reference in ir["parts"].values():
        target, _, port = reference[1:].partition(":")
        observations.update(values[target]["requirements"][port or "result"])
    if geometry_values is not None:
        geometry_values.update(values)
    return {owner: value(reference) for owner, reference in ir["parts"].items()}, observations, evidence


def run(design_path, *, source_path, expected_hash):
    """Public launcher entry; uses the existing draft/compile export and QA path."""
    import cad_helpers
    from authoring import write_scene
    from geometry_binding import bind_brep_feature
    from intent_contract import feature_owner_map, physical_part_names

    source_path, design_path = Path(source_path).resolve(), Path(design_path).resolve()
    diagnostics = source_path.with_name("design-diagnostics.json")
    diagnostics.unlink(missing_ok=True)
    try:
        raw = design_path.read_bytes()
        if sha256(raw).hexdigest() != expected_hash:
            fail("REVISION_CONFLICT", "immutable design snapshot changed")
        ir = normalize(json.loads(raw))
        geometry_values = {}
        parts, observations, evidence = build_geometry(ir, geometry_values=geometry_values)
        def value(reference):
            target, _, port = reference[1:].partition(":")
            return deepcopy(geometry_values[target][port or "result"])
        source_path.with_name("node-evidence.json").write_text(json.dumps(evidence, allow_nan=False))
        if os.environ.get("AMAGINE3D_SOURCE_PHASE") == "draft":
            from cad_draft import export_draft
            references = {"component-" + node["id"].split(".", 1)[1]: value(node["args"]["envelope"])
                          for node in ir["nodes"] if node["type"] == "Installation"}
            return export_draft(parts, references=references,
                construction_features={key: {"owner": item["owner"], "role": item["role"]} for key, item in observations.items()})
        intent_path = Path(os.environ["AMAGINE3D_INTENT_PATH"])
        scene_path = Path(os.environ["AMAGINE3D_SCENE_PATH"])
        output = Path(os.environ["AMAGINE3D_OUTPUT_DIR"])
        output.mkdir(parents=True, exist_ok=True)
        intent = json.loads(intent_path.read_text(encoding="utf-8"))
        if set(parts) != physical_part_names(intent):
            fail("OWNERSHIP", "design parts do not match intent")
        owners = feature_owner_map(intent)
        scene_parts = {owner: {"representationMaster": "brep", "nodes": []} for owner in parts}
        from design_connections import scene_bindings
        from build_session import BuildSession
        paired, interfaces, installations, displays = scene_bindings(ir, value, output)
        recipes = BuildSession._interface_recipes(interfaces)
        for key, item in observations.items():
            if owners.get(key) != item["owner"]:
                fail("OWNERSHIP", f"requirement {key} is missing from intent or belongs to another part")
            role = item["role"]
            if key in recipes:
                role = recipe_role(recipes[key]["parameters"]["output"])
            cad_helpers.observe(item["shape"], key, role=role, part_name=item["owner"])
            token = sha256(key.encode()).hexdigest()[:24]
            if key in recipes:
                scene_parts[item["owner"]]["nodes"].append({"id": "feature-" + token, "featureId": key,
                    "role": role, "recipe": recipes[key]})
                continue
            scene_parts[item["owner"]]["nodes"].append(bind_brep_feature(
                node_id="feature-" + token, feature_id=key, role=item["role"], shape=item["shape"], path=output / ("feature-" + token + ".stl")))
        for owner, nodes in displays.items():
            scene_parts[owner]["nodes"].extend(nodes)
        write_scene(scene_path, intent_path=intent_path, parts=scene_parts,
            paired_interfaces=paired, interfaces=interfaces, installation_checks=installations)
        for owner, shape in parts.items():
            cad_helpers.observe(shape, "manufactured-part/" + sha256(owner.encode()).hexdigest()[:24], role="separate", part_name=owner)
        paths = {"out_dir": str(output), "intent_path": str(intent_path), "scene_path": str(scene_path), "source_path": str(source_path)}
        if intent["manufacturing"]["mode"] == "single-part":
            return cad_helpers.export_part(parts[intent["part"]], intent["part"], **paths)
        return cad_helpers.export_assembly(parts, intent["part"], **paths)
    except DesignError as error:
        diagnostics.write_text(json.dumps({"issues": [error.issue], "evidence": getattr(error, "evidence", {})}, allow_nan=False))
        raise
