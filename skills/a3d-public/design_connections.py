"""Controlled connection and installation adapters; no generic Python hooks."""
from collections import defaultdict

COUPLED_CONSTRAINTS = {
    "collar_socket": ["radius - wall >= 0.05 mm", "2 * radius < min(size)"],
    "self_tapping_screw": ["pilotDiameter < nominalDiameter < clearanceDiameter", "(bossDiameter - pilotDiameter) / 2 >= minimumWall"],
}

SCREW_FIELDS = {"coverThickness": "cover_thickness_mm", "nominalDiameter": "nominal_diameter_mm",
    "clearanceDiameter": "clearance_diameter_mm", "pilotDiameter": "pilot_diameter_mm",
    "bossDiameter": "boss_outer_diameter_mm", "engagement": "engagement_mm", "tipClearance": "pilot_tip_clearance_mm",
    "closedEnd": "closed_end_mm", "minimumWall": "minimum_boss_wall_mm", "rootEmbed": "minimum_root_embed_mm",
    "overshoot": "cutter_overshoot_mm"}


def endpoints(name, args):
    if name == "collar_socket":
        return {"male": (args["malePart"], args["maleFeature"]), "socket": (args["femalePart"], args["femaleFeature"])}
    return {"clearance": (args["coverPart"], args["clearanceFeature"]),
            "pilot": (args["receiverPart"], args["pilotFeature"]), "boss": (args["receiverPart"], args["bossFeature"])}


def validate_connection(name, args, field):
    from design_language import fail
    ports = endpoints(name, args)
    if len({owner for owner, _ in ports.values()}) != 2 or len({feature for _, feature in ports.values()}) != len(ports):
        fail("OWNERSHIP", "a connection requires two distinct parts and distinct endpoint features", field)
    if name == "collar_socket":
        if args["radius"] - args["wall"] < 0.05 or 2*args["radius"] >= min(args["size"]):
            fail("PARAMETER_DOMAIN", "collar requires " + "; ".join(COUPLED_CONSTRAINTS[name]), field,
                 coupledConstraints=COUPLED_CONSTRAINTS[name])
    elif not (args["pilotDiameter"] < args["nominalDiameter"] < args["clearanceDiameter"]
              and (args["bossDiameter"] - args["pilotDiameter"])/2 >= args["minimumWall"]):
        fail("PARAMETER_DOMAIN", "screw requires " + "; ".join(COUPLED_CONSTRAINTS[name]), field,
             coupledConstraints=COUPLED_CONSTRAINTS[name])
    return {port: owner for port, (owner, _) in ports.items()}


def validate_bindings(nodes, part_results):
    from design_language import fail, references
    bound = {node["requirement"]: node for node in nodes if "requirement" in node}
    by_id = {node["id"]: node for node in nodes}
    selected = {}
    for owner, result in part_results.items():
        pending, reached = list(references(result)), set()
        while pending:
            key = pending.pop()
            if key not in reached:
                reached.add(key)
                pending.extend(references(by_id[key]["args"]))
        selected[owner] = reached
    locator_ids = {node["id"].split(".", 1)[1] for node in nodes if node["op"] == "collar_socket"}
    groups, installed = {}, set()
    for node in nodes:
        a, field = node["args"], node["field"]
        def reject(code, message, suffix=""):
            fail(code, message, field + suffix, node=node["id"], nodeId=node["id"], causeId=node["id"] + ":" + suffix)
        if node["type"] == "Connection":
            for port, (owner, feature) in endpoints(node["op"], a).items():
                consumer = bound.get(feature)
                reference = "@" + node["id"] + ":" + port
                expected_op = "union" if port == "male" else "cut" if port in {"socket", "clearance", "pilot"} else "union"
                consumes = consumer and consumer["op"] == expected_op and reference in consumer["args"].get("tools", [])
                if port == "boss" and consumer and consumer["op"] == "translate":
                    consumes = consumer["args"]["input"] == reference and consumer["args"]["offset"] == [0, 0, 0]
                if not consumes or consumer["owner"] != owner:
                    reject("OWNERSHIP", f"{feature} must bind the {port} port on {owner} with {expected_op} (boss may be an identity observation)")
                if consumer["op"] != "translate" and consumer["id"] not in selected[owner]:
                    reject("OWNERSHIP", f"{feature} must contribute to the selected result of {owner}")
            if node["op"] == "self_tapping_screw":
                if not set(a["locators"]) <= locator_ids:
                    reject("REFERENCE", "unknown collar locator interface", "/locators")
                pair = (a["coverPart"], a["receiverPart"], a["locators"])
                if a["interface"] in groups and groups[a["interface"]] != pair:
                    reject("OWNERSHIP", "screws in one interface must share owners and locators")
                groups[a["interface"]] = pair
        elif node["type"] == "Installation":
            if a["feature"] in installed:
                reject("SCHEMA", "one installation declaration per physical feature")
            installed.add(a["feature"])
            if a["feature"] not in bound or bound[a["feature"]]["owner"] != a["part"]:
                reject("OWNERSHIP", "installation must reference a bound physical feature on its part", "/feature")
            if bool(a.get("passage")) != bool(a["passageParts"]):
                reject("SCHEMA", "passage and passageParts are required together")
            if a["supports"] and "supportDirection" not in a:
                reject("SCHEMA", "supports need supportDirection")
            if a["retainers"] and not (0 <= a.get("freeTravel", -1) < a.get("stopTravel", -1)):
                reject("PARAMETER_DOMAIN", "retainers need 0 <= freeTravel < stopTravel")


def intent_issues(ir, intent, *, complete=True):
    """Compare connection identities/endpoints with independently authored targets."""
    nodes = {node["id"].split(".", 1)[1]: node for node in ir["nodes"] if node["type"] == "Connection"}
    targets = {item["id"]: item for item in intent["manufacturing"].get("interfaces", [])}
    locators = {item["id"]: item for target in targets.values()
                for item in target.get("fastening", {}).get("locator_pairs", [])}
    groups = defaultdict(list)
    for node in nodes.values():
        if node["op"] == "self_tapping_screw":
            groups[node["args"]["interface"]].append(node)
    actual_ids = {name for name, node in nodes.items() if node["op"] == "collar_socket"} | set(groups)
    expected_ids = set(targets) | set(locators)
    issues = []
    def add(message, subject, **details):
        issues.append({"severity": "error", "code": "DESIGN.INTERFACE", "message": message,
                       "interfaceId": subject, "causeId": subject + ":intent", **details})
    if actual_ids - expected_ids or complete and actual_ids != expected_ids:
        add("connection IDs must match intent interfaces and locator pairs", "interfaces",
            expected=sorted(expected_ids), observed=sorted(actual_ids))
    for name, node in nodes.items():
        a = node["args"]
        target = targets.get(name) if node["op"] == "collar_socket" else targets.get(a["interface"])
        if node["op"] == "collar_socket":
            locator = locators.get(name)
            if locator:
                expected = [locator["male_feature"], locator["female_feature"]]
                observed = [a["maleFeature"], a["femaleFeature"]]
            elif target:
                expected = sorted(target["features"])
                observed = sorted([a["maleFeature"], a["femaleFeature"]])
                if target["connection"] != "collar-socket":
                    add("connection kind must match intent", name, node=node["id"])
            else:
                continue
            if observed != expected:
                add("locator endpoints must match intent features", name, node=node["id"], expected=expected, observed=observed)
        elif target:
            if target["connection"] != "self-tapping-screw":
                add("connection kind must match intent", a["interface"], node=node["id"])
                continue
            fastening = target["fastening"]
            expected = {f["id"]: [f["clearance_feature"], f["pilot_feature"], f["boss_feature"]] for f in fastening["fasteners"]}
            observed = {n["id"].split(".", 1)[1]: [n["args"][k] for k in ("clearanceFeature", "pilotFeature", "bossFeature")]
                        for n in groups[a["interface"]]}
            # Group-level comparisons are emitted once, not once per screw.
            if node is groups[a["interface"]][0]:
                if any(expected.get(k) != v for k, v in observed.items()) or complete and expected.keys() != observed.keys():
                    add("screw IDs and endpoint features must match intent fasteners", a["interface"], expected=expected, observed=observed)
                locator_ids = {f["id"] for f in fastening["locator_pairs"]}
                if set(a["locators"]) - locator_ids or complete and set(a["locators"]) != locator_ids:
                    add("screw locator IDs must match intent locator_pairs", a["interface"], node=node["id"])
    return issues


def geometry(node, frame):
    from build123d import Plane
    from interface_recipes import collar_socket, self_tapping_screw_pair
    a, name = node["args"], node["id"].split(".", 1)[1]
    placement = Plane(origin=frame["origin"], x_dir=frame["u"], z_dir=frame["normal"]).location
    if node["op"] == "collar_socket":
        pair = collar_socket(interface_id=name, width_mm=a["size"][0], depth_mm=a["size"][1], radius_mm=a["radius"],
            engagement_mm=a["engagement"], radial_clearance_mm=a["clearance"], collar_wall_mm=a["wall"], axial_overshoot_mm=a["overshoot"])
        shapes = {"male": pair.male, "socket": pair.female_cutter}
    else:
        pair = self_tapping_screw_pair(interface_id=a["interface"], axis_id=name, **{dest: a[src] for src, dest in SCREW_FIELDS.items()})
        shapes = {"clearance": pair.clearance_cutter, "pilot": pair.pilot_cutter, "boss": pair.receiver_boss}
    record = None if node["op"] == "collar_socket" else pair.record(location=placement,
        cover_part=a["coverPart"], receiver_part=a["receiverPart"], clearance_feature=a["clearanceFeature"],
        pilot_feature=a["pilotFeature"], boss_feature=a["bossFeature"])
    return {port: placement * shape for port, shape in shapes.items()}, record


def scene_bindings(ir, value, output):
    from authoring import paired_interface
    from geometry_binding import bind_display_component
    from installation_check import bind_installation_check

    paired, grouped, installations, displays = [], defaultdict(list), [], defaultdict(list)
    locator_groups = {}
    for node in ir["nodes"]:
        a, name = node["args"], node["id"].split(".", 1)[1]
        if node["op"] == "collar_socket":
            paired.append(paired_interface(id=name, kind="collar-socket", male_feature=a["maleFeature"], female_feature=a["femaleFeature"],
                male_dimensions_mm={"width": a["size"][0], "depth": a["size"][1]},
                clearances_mm={"width": 2*a["clearance"], "depth": 2*a["clearance"]}))
        elif node["op"] == "self_tapping_screw":
            grouped[a["interface"]].append(value("@" + node["id"] + ":scene"))
            locator_groups[a["interface"]] = a["locators"]
        elif node["op"] == "installation":
            record = bind_installation_check(feature_id=a["feature"], envelope=value(a["envelope"]), out_dir=output / "installation-witnesses",
                obstacle_parts=a["obstacles"], support_parts=a["supports"], retainer_parts=a["retainers"], passage_parts=a["passageParts"],
                insertion_envelope=value(a["insertion"]) if "insertion" in a else None,
                passage_envelope=value(a["passage"]) if "passage" in a else None,
                withdrawal_axis=a["withdrawalAxis"], support_direction=a.get("supportDirection"), contact_probe_mm=a["contactProbe"],
                free_travel_mm=a.get("freeTravel"), stop_travel_mm=a.get("stopTravel"))
            installations.append(record)
            if "displayFeature" in a:
                displays[a["part"]].append(bind_display_component(node_id="component-" + name, feature_id=a["displayFeature"],
                    physical_feature_ref=a["feature"], shape=value(a["envelope"]), path=output / ("component-" + name + ".step"),
                    appearance={"baseColor": a["color"]}))
    interfaces = [{"id": key, "kind": "self-tapping-screw", "locatorInterfaceIds": locator_groups[key], "fasteners": records}
                  for key, records in grouped.items()]
    return paired, interfaces, installations, displays
