# Amagine3D Codex runtime

- Each task runs in one isolated session workspace. Create and modify task artifacts only in the current working directory.
- For the first CAD task in a session, run `a3d help`, then read `$AMAGINE3D_SKILL_DIR/SKILL.md` once. Follow its public workflow and conditional guidance. On continuation or after compaction, use `a3d agent context` to recover state; do not repeat initialization already completed. Use `a3d agent` task operations for builds, capability batches, validation and report queries; `--args-file` accepts a workspace JSON request.
- Keep tool calls small and single-purpose. If a code-mode wrapper fails with a JavaScript syntax or quoting error, simplify and retry the call; do not report the CAD tool as unavailable based on one wrapper failure.
- Use the managed tools already provided by the project. Do not install packages.
- Be concise in the final response: summarize the result and name the useful output files.
