# Parametric design

Use a typed `.a3d.json` design for supported operations. The backend maintains
the complete document; submit related edits together and build at useful
geometry checkpoints. Source Python remains available for unsupported geometry.
Design and source are mutually exclusive build inputs.

## Read and edit

Requirement roles follow operations: `cut`, `pocket`, `hole` and `open_box`
describe cutters; primitive solids and `union` are solid; other solid-producing
observations/transforms are separate. Connection recipe endpoints retain their
declared cutter/boss roles. Capability results expose these rules and coupled
parameter constraints, including collar radius/wall/short-side relations.

Each physical part needs a solid/separate binding that contributes material to
its selected result. A detached solid witness or a cutting tool cannot provide
that structural coverage. Existing fastener observations remain independent
geometric evidence, with the full compile still checking actual placement.

A pure subtractive part can bind an existing final-body intent feature without
adding shape. Move that feature's `requirement` from its cutter to a zero-offset
observation of the final result, and select the observation:

```json
{
  "action": "apply",
  "design": "model.a3d.json",
  "baseRevision": "CURRENT_REVISION",
  "changes": [
    {"kind":"update","target":"cap.final_cut","set":{},"unset":["requirement"]},
    {"kind":"add","target":"cap.envelope","value":{"op":"translate","input":"@cap.final_cut","offset":[0,0,0],"requirement":"cap-envelope"}},
    {"kind":"update","target":"parts.cap","set":{"result":"@cap.envelope"}}
  ]
}
```

Use the actual existing feature whose independent intent describes the finished
body. Preserve cutter bindings for apertures and pockets and all targets. The
identity operation changes binding semantics only. `validate` reports missing
structural coverage with part, result, contributing nodes, actual roles and
revision before expensive compile. Use the revision returned by apply for build;
each transaction is limited to 64 edits and must have valid dependencies.

```bash
a3d agent capabilities '{"designOps":["open_box","hole","fillet"]}'
a3d agent design '{"action":"read","design":"model.a3d.json"}'
a3d agent design --args-file edits.json
```

Create a model with `baseRevision: null`. Every edit addresses a stable ID.
A batch may use forward references; its final graph must be valid, each part
must have a Solid result, and each target may occur once. This creates a
configurable cube; use `$AMAGINE3D_SKILL_DIR/examples/open_box.a3d.json` for
independent width, depth, height, wall and floor controls:

```json
{
  "action": "apply",
  "design": "model.a3d.json",
  "baseRevision": null,
  "changes": [
    {"kind": "add", "target": "params.size", "value": {"type": "length", "value": 80, "range": [50, 100], "label": {"en": "Overall size", "zh": "整体尺寸"}}},
    {"kind": "add", "target": "params.wall", "value": {"type": "length", "value": 2, "range": [1, 4], "label": {"en": "Wall thickness", "zh": "壁厚"}}},
    {"kind": "add", "target": "parts.body", "value": {"result": "@body.shell"}},
    {"kind": "add", "target": "body.shell", "value": {"op": "open_box", "size": ["=size", "=size", "=size"], "wall": "=wall", "floor": "=wall"}}
  ]
}
```

Use the returned complete revision hash in later requests. An update sends only
changed top-level fields; `set` replaces each supplied field, including whole
objects/arrays, and leaves other fields untouched. `unset` removes optional
fields. IDs, operation names and parameter types require a new definition.
Remove never cascades; explicitly remove/reconnect dependencies in the batch.

```json
{
  "action": "apply",
  "design": "model.a3d.json",
  "baseRevision": "REVISION",
  "changes": [
    {"kind": "update", "target": "params.wall", "set": {"value": 2.4}}
  ]
}
```

Any edit/static validation failure leaves the complete file unchanged. Stale
revisions reject the request: read the affected nodes before resubmitting. A
lost response also requires a read before retrying. A no-op keeps the revision.

Read only the needed definitions and direct dependency IDs:

```json
{
  "action": "read", "design": "model.a3d.json", "revision": "REVISION",
  "view": "nodes", "ids": ["params.wall", "body.shell"],
  "include": ["directDependencies", "directDependents"]
}
```

Summary reads report the current revision, part results, counts and build
status. Large results use the existing report/field pagination through
`a3d agent inspect`. Read pages from one saved response; do not mix revisions.
`context` recovers the active design and operation contracts actually returned
at the current capability version. Query the needed operation contracts together;
capabilities has no name-count limit and pages results by output size. Design
reads still accept at most 20 definition IDs, with 64 edits per batch, 256
definitions per document and a 64 KiB request. These are limits, not recommended
batch sizes.

## Values and references

The saved schema is `a3d-design/v1`; units are mm and deg. The current language
contract is version 4. Numeric parameter types are length, angle, scalar and
integer; boolean parameters use literals. A parameter may include optional
display metadata with both language labels:

```json
"width": {
  "type": "length", "value": 80, "range": [70, 90],
  "label": {"en": "Overall width", "zh": "整体宽度"}
}
```

Both `en` and `zh` are required when `label` is present; each must be a
nonempty string of at most 48 characters, with no extra label keys. Labels are
display-only: the stable parameter ID remains the expression and API key, and
labels never create geometry references or expression dependencies. Existing
designs without labels continue to display their IDs.

For new designs, expose the independent dimensions a user is likely to adjust,
chosen for the actual geometry: overall length/width/height, wall or floor
thickness, hole diameter and spacing, corner radius, or mating clearance. Give
each a sensible range and bilingual label. Drive all related geometry and
placements from the same parameter ID; use expressions for dependent dimensions
such as inside width, offsets, or matched hole positions. Avoid splitting a
dimension into parameters that provide no useful independent control. A range
defines allowed parameter values, not a guarantee that every combination meets
the frozen intent, manufacturing requirements, or QA checks. Preserve existing
acceptance targets and resolve failed QA against the evidence.

Typed numeric fields accept literal numbers or short expressions such as
`=height - floor` or `=width - 2*wall`. Expressions use arithmetic and
`min/max/abs/sqrt/sin/cos/atan2/mm/deg`; addition requires matching units.
Use `mm(2)` for a length constant in an expression. No Python evaluation,
functions, loops or recursive operation trees are accepted.

Named frames have origin, u and normal; they must be nonzero and orthogonal.
The backend derives v = normal × u. Profiles are local XY closed regions;
place them with a frame when extruding, revolving, lofting or cutting. Shape
transforms consume explicit immutable inputs. Cross-part copies use explicit
translate/rotate/mirror nodes; booleans cannot edit another owner's body.

`@body.blank` references a feature, `@profiles.inner` a profile and
`@frames.top` a frame. Pocket/hole/open_box expose `:tool`; cut exposes a
SolidSet `:tool`. A part result must reference a single Solid, never an
unconsumed pattern. Parts have explicit result references; adding a node does
not silently change the result.

The initial operation set includes primitives, common profiles, line/polyline
and three-point arc, closed-path profiles, extrude/revolve/simple loft,
union/cut/intersect, translate/rotate/mirror, finite linear/polar/placement
patterns, strict fillet/chamfer, pocket/hole, open_box and two connection recipes. Query exact fields
with `designOps`; unsupported requests report unsupported. Loft supports one
outer loop and no holes. Hollow/sweep/imports/text and other connection recipes
are unsupported. Capability results include an exact operation-name index;
`subtract`/`array` are not accepted aliases. Use `cut` and the named pattern operations.

## Connections and installed components

`rounded_rectangle` accepts either one `radius` or `radii: [bottom-left,
bottom-right, top-right, top-left]` in local XY. Individual radii may be zero;
adjacent sums must leave a straight segment on each side. This supports different
front/rear rounding without model-written vertex selectors or automatic radius reduction.

`connections.ID` is a typed recipe definition. Its frame places every port in
one assembly pose; do not independently move mating geometry. Recipe definitions
have no implicit part result. Add the definition and its consuming endpoint nodes
in one apply batch, with distinct existing intent feature IDs when compiling.

```json
{
  "kind": "add", "target": "connections.cover-location",
  "value": {
    "op": "collar_socket", "frame": "@frames.joint", "size": [54, 34],
    "radius": 3, "wall": 1.8, "engagement": 2, "clearance": 0.3,
    "malePart": "cover", "femalePart": "frame",
    "maleFeature": "cover-collar", "femaleFeature": "frame-locator"
  }
}
```

Union `@connections.cover-location:male` into cover with requirement
`cover-collar`; cut `:socket` from frame with requirement `frame-locator`.
Clearance is per side; the backend derives the paired scene's full size delta.
`radius-wall` must be at least 0.05 mm; no hidden profile-radius correction.

`self_tapping_screw` requires frame, interface, coverPart, receiverPart,
clearanceFeature, pilotFeature, bossFeature and coverThickness. Its ports are
`:clearance`, `:pilot`, `:boss`; the first two are cut from their declared parts
with the corresponding requirement IDs. A boss is either unioned into receiver,
or bound as an identity `translate` (offset `[0,0,0]`) with bossFeature to observe
existing receiver material. Material audits still prove its complete wall,
root embed and blind end; observing a boss does not create that material.

Query the exact numeric defaults and controls with `designOps`. M3 defaults
are proposed dimensions, not validated supplier/process specifications. Multiple
screws sharing `interface` become one scene fastening record; `locators` names
declared collar connection IDs. Group members must share owners and locators.

`assets.ID` with `op: "installation"` declares part, feature and a Solid envelope
reference. It may refer to insertion/passage Solids and name final obstacles,
supports, retainers and passageParts. Supports require supportDirection;
retainers require `0 <= freeTravel < stopTravel`. withdrawalAxis defaults to
`[0,0,1]`, contactProbe to 0.05 mm; the overlap threshold remains 0.01 mm³.
The physical feature must be bound on that part. `displayFeature` optionally
adds a purchased-component visual reference, with `color: "#RRGGBB"`; it must
not replace a physical intent feature. No imported Python, arbitrary assets or
manufactured component dummy is accepted.

All volumes come from actual geometry nodes. A valid BRep does not prove that
the insertion route is clear or that passage reaches the component; final QA
performs those checks and preserves their measured errors. Do not shrink/drop
witnesses to silence a failure. Independent intent still declares required behavior.

For a front-facing component frame use `u=[1,0,0]`, `normal=[0,-1,0]`;
local v is world +Z and +normal cuts toward the front. Place profiles by this
explicit origin/u/normal instead of composing ambiguous Plane transforms.

After the first small functional draft and image feedback, see the complete editable [installed module example](../../a3d-text/examples/installed_module.a3d.json):
two printed parts, four screws, a collar and a non-manufactured display reference.
Use local edits and returned revision hashes when adapting it; it uses the existing
the paired [JSON intent example](../../a3d-text/examples/installed_module_intent.json)'s
independently specified requirements. Copy its referenced printer profile to the
workspace and bind the selected profile path/hash before validation. DSL needs
no Python intent writer. Installation envelopes reference Solid nodes, while
asset feature IDs name an owned physical cut/support requirement; the envelope
alone does not replace that physical binding.

Pocket/hole depth is `{"mode":"blind","length":...}` or
`{"mode":"through_all"}` with explicit `direction: "+normal"/"-normal"`.
Blind cuts preserve the requested endpoint; through_all spans the entire
body along that axis and can pierce both walls. A missed cut fails.

Fillet/chamfer select edges on the exact body input, with an expected count:

```json
{
  "id": "round", "op": "fillet", "body": "@body.blank", "radius": 2,
  "edges": {
    "of": "@body.blank",
    "where": {"curve": "line", "parallel": [0, 0, 1]},
    "expect": {"count": 4}
  }
}
```

Selectors also accept center x/y/z ranges, length/radius ranges and extreme
groups (`axis`, `end: min/max`). Ties are retained. A wrong count fails;
finishing never reduces the requested radius/length automatically.

Rigid transforms carry the bound evidence of their input geometry into the
same placement. A cross-part copy needs its own requirement IDs. In this first
version, repeated instances bind requirements on the pattern or its consuming
cut/union; a single input requirement cannot silently represent multiple
placements. Independent observation geometry remains explicitly positioned.

## Build and acceptance

```bash
a3d agent build '{"phase":"draft","design":"model.a3d.json","revision":"REVISION"}'
a3d agent build '{"phase":"compile","design":"model.a3d.json","revision":"REVISION","intent":"intent.json"}'
```

Applying changes performs static validation and saves a draft. Build runs the
whole graph from a frozen snapshot; it does not implement incremental BRep
caching. A failed build retains the editable draft and its failure, and keeps
previous successful outputs bound to their original revision. Final outputs
use visible `design-builds/<input-key>/attempts/<attempt-id>/` directories for artifact discovery;
snapshots and internal launchers stay under `.a3d-agent`. Success reuse requires complete input/output
bindings. Design changes during a build make that result outdated.

Final compile retains the existing immutable intent, manufacturing QA and
visual review. Design part IDs must match intent's physical part names.
Use a feature's optional `requirement` to bind an existing intent feature;
geometry/scene evidence is generated from actual executed shapes. Cut features
bind their actual tools, finishing binds the resulting shape, and primitives
bind their solids. Missing requirements fail existing QA; no intent targets
are invented or relaxed. Controlled connection/installation declarations generate
the existing scene contracts; other unsupported recipes still use Python mode.

`validate` accepts design (and optional revision) for manually edited/imported
documents. Successful apply already performs that static check. With `intent`,
validate also checks part/feature owners, all physical requirement bindings,
connection IDs/endpoints, installation declarations and supported color export;
build uses the same preflight. Related errors are returned together without CAD.
Whole-part color regions can have independent names: exactly one region per
physical part is mapped by its `part`, retaining the original region name and
color provenance. Internal multiple regions require a separate supported exporter.
DSL intent can be declared directly as v5 JSON; no Python writer is required.
Compiler
reports include the design revision, input bindings and per-node evidence;
design errors include stable node IDs and source fields. Inspect their saved
reports for complete evidence. A static-valid document can still fail the
geometry kernel, manufacturing checks or visual review.
