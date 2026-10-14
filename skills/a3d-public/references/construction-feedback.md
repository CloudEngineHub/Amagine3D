# Construction decisions and feedback

Read the relevant section when construction depends on assembly, finishing or
measured feedback. Ordinary drafts need no additional reference pass.

## Functional construction

Assembly-critical means manufactured parts, installed components, closures,
locators, retention, fasteners, motion, mating fits or through openings can
change the envelope. Decorative seams and colors alone do not qualify.

Reserve a functional skeleton: owners, component cavity, openings,
insertion/service/driver paths, support, locator, retention and fastener volumes.
Use simple named volumes before detailed recipes and final declarations.
Share fastener datums; allow removable-part clearance and blind receiver pilots.
Boss diameter covers the pilot, twice the minimum radial wall and a named margin;
keep axes clear of ports and edges. Appearance-led solids start with envelope,
silhouette and major layout. Keep unspecified dimensions reversible.

For Python use BuildSession(..., part_names=(...)) before intent. Its add, cut
and observe require owners. Register provisional IDs/owners/roles in
constructionFeatures; this index does not establish accepted requirements.
Explore and finalize in one source, preserving model IDs and existing targets.

## Assembly and finishing

Compare actual previews with the brief: silhouette, proportions, placement,
access and functional relationships. Fix owning parameters and shared datums.
Verify openings connect and interfaces fit material before detailed finishing.
Use `$AMAGINE3D_RUNTIME_DIR/references/design-review.md` for assembly decisions,
`$AMAGINE3D_RUNTIME_DIR/references/multipart-connections.md` for fastening and
`$AMAGINE3D_RUNTIME_DIR/references/installation-checks.md` for purchased modules.
Python final construction can consult
`$AMAGINE3D_SKILL_DIR/examples/installed_module_build.py` after the skeleton.

Build body, cavity and openings from shared datums; complete support, retention
and access first. Python BuildSession.finish uses checked_fillet/checked_chamfer;
unchanged geometry after failed finishing is not success. Inspect
SelfTappingScrewPair.bind semantics before choosing boss_mode. Public recipes
construct matching geometry from a single datum.

## Repair evidence

Same-cause part/plate findings may share a repair, but retain their frames and
measurements. Candidate feature bounds are not proven causes. Progress means
resolved/newly-unblocked findings, later passed stages or measurements moving
toward expected without regression. If measurements do not improve, inspect
the owning construction or choose a different strategy.

Use `a3d measure MODEL.step --section-z HEIGHT` for numeric sections; request
--preview only when the image resolves uncertainty. Finite sections do not
prove global walls. `a3d compare BEFORE.step AFTER.step --view front` compares
shape changes. Stop adjustments within accepted ranges.

Report visual review incomplete when images cannot be interpreted. A preview
path or image statistics do not count as visual review. Print orientation
evidence and mesh warnings support bridge/support claims: rotated_xy_90deg=false
does not cancel rotateDegreesXYZ. Thin-wall sampling minima/p05 alone do not
establish a false alarm; verify the actual risk location in BRep/sections.
