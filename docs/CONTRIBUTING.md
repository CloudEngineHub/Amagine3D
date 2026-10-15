# Contributing to Amagine3D

> **简体中文**：[查看中文版](./CONTRIBUTING.zh-CN.md)

For changes that need design discussion, open an issue using the
[RFC template](../doc/RFC_TEMPLATE.md) (in Chinese). Use `RFC: Proposal title` as
the issue title, copy the template sections into the body, and replace the placeholders.

## Issue status and follow-up

Each open issue has at most one status label. **No status label means the issue
awaits maintainer triage**, even if it already has type labels such as `bug`,
`enhancement`, or `documentation`.

| Label | Meaning |
| --- | --- |
| `status: discussion` | The problem or proposed approach is being discussed. |
| `status: planned` | The work has been accepted and planned, but has not started. |
| `status: in-progress` | Implementation or a fix is in progress. |

The **Issue status** workflow does not add a default status to new or reopened
issues. When a maintainer applies another status, it replaces the previous one.
Removing the last status returns the issue to triage without adding a label.
Running this workflow manually, or merging a change to it into `main`, creates
missing labels and applies the same rules to all open issues; it does not infer
a development commitment from the issue text.

`status: discussion` alone never makes an issue eligible for automatic closure.
After explicitly requesting information from the reporter, a maintainer can add
`needs-info` alongside it. Remove `needs-info` when enough information is available.
Moving out of discussion automatically removes `needs-info` and `stale`.

The daily **Stale issues** workflow only considers issues with **both**
`status: discussion` and `needs-info`. It reminds participants after 30 days of
inactivity, then closes the issue after another 14 days without activity. A comment
or update resets the inactivity timer; the next scan removes an existing stale
label when activity resumes before closure. Issues with `no-stale`, an assignee,
a milestone, or a protected status (planned or in progress) are exempt. Issues
without a status are ineligible, and PRs are excluded.
An inactivity closure is recorded as `not_planned`, not as a completed fix;
reporters can comment with more information and ask a maintainer to reopen the issue.

**The initial rollout is a dry run.** Unless the repository Actions variable
`STALE_ISSUES_ENABLED` is exactly `true`, stale scans only write logs and do not
change issue labels, post comments, or close issues. To enable daily live scans,
set that variable in **Settings → Secrets and variables → Actions → Variables**.
Manual runs default to `dry_run: true`; a live manual run requires both the variable
and `dry_run: false`. Remove the variable or set it to `false` to return to preview
mode. Status labeling remains active independently of this switch.

## Development

For an introduction to the CAD pipeline, read the
[evidence-gated workflow overview](./cad-workflow.md). It explains who chooses
repairs, what the runtime verifies, and how to interpret repair progress.

Use Node.js 22.19.0 or newer, Python 3.10 through 3.13, and npm.

```bash
npm ci
npm run python:setup
npm run typecheck
npm test
npm run test:python
npm run build
```

The PNG evidence renderer is a headless CPU Z-buffer implemented with trimesh,
NumPy, and Pillow. It renders five views sequentially in one process. Use
`npm run benchmark:renderer` to record small, medium, and larger
STL timings, peak memory, and triangle counts. The renderer defaults to 1x;
the five-view output is 640 pixels, and 2x supersampling is opt-in. Its
`pathlib`-based, single-process path is covered
on Ubuntu and Windows in CI and uses the same headless code on macOS.

Keep browser code behind the local API boundary. React must not access model
credentials, Codex state, product session records, uploads, or session
workspaces directly. Server artifact routes must keep every path inside the
selected session's `workspace/sessions/<sessionId>/` directory.
Only `packages/a3d-runtime` may import `@openai/codex` or
`@openai/codex-sdk`; application server code must use the package's public
runtime contracts. The runtime package must not import from `server/` or `src/`.

Submit one focused change with tests and documentation for new public behavior.
Automated tests must not call real model providers. Provider-backed CAD runs are
manual checks and must not commit credentials, private prompts, uploads,
generated workspaces, or unstable golden text. Keep `.env`, `.amagine-state/`,
`workspace/`, and `.venv/` out of commits.

For UI changes, record the browser version, exact route, screenshots or artifact
evidence, and known limitations. Changes to skills or CAD execution should
include focused tests for discovery, path isolation, and generated-artifact
validation. Security issues follow
[`SECURITY.md`](./SECURITY.md), not a public issue.
