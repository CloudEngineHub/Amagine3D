# Amagine3D threat model

> **简体中文**：[查看中文版](./threat-model.zh-CN.md)

Status: Codex runtime, local Tavily search, and HTTP security, 2026-10-16

## Security boundaries

Amagine3D treats model output, generated commands and Python, Web Search
results, imported ZIP files, restored project data, attachments, URLs, and
filenames as untrusted. A native Codex process runs each product session in its
own working and state directories. It uses `workspace-write` with
`approvalPolicy: never`, so commands can write inside the session directory
without UI prompts while writes outside that boundary remain sandboxed.

Model-provider credentials are passed only to the Codex process. Spawned
commands use a non-login, core shell environment with secret-name filtering
enabled. When Tavily search is configured, the account key remains in the
runtime process and each turn receives only an unguessable loopback capability
that accepts validated searches to Tavily's fixed endpoint; the listener and
capability are destroyed when the turn settles. No account credential is stored
in product sessions or export archives. Web research and workspace network are
disabled together when the server sets `CODEX_WEB_SEARCH_ENABLED=false`.

## HTTP security and deployment assumptions

Amagine3D is a local application for trusted users. The API binds to
`127.0.0.1` and has no application-level user authentication. Loopback binding,
browser headers, and per-session directories do not make it a service for
untrusted users or tenants. Remote exposure would require a separate design
for authentication, authorization, TLS, and request-origin/CSRF protection.

`server/app.ts` registers security headers before JSON parsing and routes:

| Control | Purpose |
| --- | --- |
| `X-Content-Type-Options: nosniff` | Prevent browsers from treating downloaded source or other incorrectly typed content as executable scripts or styles. |
| `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'` | Prevent other pages from framing the application. |
| `Referrer-Policy: same-origin` | Omit the referrer when navigating or requesting resources across origins. |
| Disabled `X-Powered-By` | Avoid advertising Express in responses; this is not an access control. |
| `express.json({ limit: '18mb' })` | Bound JSON request bodies, including encoded image attachments; this is not a general rate or execution limit. |

The `Content-Security-Policy` response header permits scripts, fonts, and
connections only from the application's origin. It blocks inline scripts,
`eval`, workers, embedded objects, frames, and base-URL overrides. Images may
also use `data:` for attachments and `blob:` for embedded 3MF textures.
Inline styles remain allowed for React's panel sizing and image previews.
Tightening that exception requires changing those styles; a nonce alone does
not authorize style attributes. Future script changes should preserve the
inline-script restriction, using per-response nonces or build-time hashes if
inline scripts become necessary. Browser CSP does not restrict the native
Codex process or its network access.

Generated `.js` and `.mjs` artifacts are served as `text/plain` with `nosniff`.
They remain readable and downloadable, but cannot become executable scripts
merely because their artifact URLs share the application's origin.

These headers protect the built UI served by Express after `npm run build`
and `npm start`. During `npm run dev`, Vite serves the document and its HMR
scripts separately; the Express CSP on proxied API responses does not apply
to that document. Vite currently has no application-defined CSP. Keep the
development server on loopback; any future development CSP must account for
React Refresh and the HMR WebSocket without relaxing the built UI's policy.

The Express API deliberately sends no CORS allow-origin headers. The built
UI uses same-origin API requests; in development, Vite proxies `/api` and
`/trpc` so those requests are also same-origin from the browser's perspective.
CORS governs browser access to responses, not authentication or CSRF
protection. Supporting a separate frontend origin would require an explicit
origin allowlist and a review of credential and request-origin handling.

Session artifact files, generated ZIP downloads, and generated STEP preview
responses use `Cache-Control: no-store` to avoid retaining mutable project
data in HTTP caches. Bundled Pomodoro file responses use
`public, max-age=31536000, immutable`, assuming the asset bytes remain stable
at their URLs for that lifetime; changed bundled assets need new URLs or an
adjusted cache policy. This distinction does not replace artifact path
validation or protect files after a user downloads them.

## Threats and controls

| Area | Principal threat | Enforced controls | Residual risk / operator action |
| --- | --- | --- | --- |
| Codex execution | Cross-session writes, destructive commands, denial of service | Per-session working directory and `CODEX_HOME`, `workspace-write`, no added writable directories, one active turn per session, cancellation, idle and hard timeouts | The sandbox is a write boundary, not a confidentiality boundary. Run the local app only for trusted users and do not place secrets in readable host files. |
| AI-generated Python | Unsafe imports, dynamic execution, invalid or misleading geometry | Managed Python, existing source validation and allowlists, compiler deadlines, bounded output, artifact readback, geometry and freshness checks | Validation cannot prove a part is safe to manufacture. Review dimensions, clearances, material, and print settings. |
| Web research | Prompt injection, false dimensions/specifications, or search-account key exposure | Server-controlled enablement; local `a3d search` allowlists request/result fields, fixes the Tavily endpoint, disables raw content and images, and delegates only a per-turn loopback capability; network is disabled when Web research is off | Search snippets and destination pages can still be wrong or hostile. The capability is available to model-controlled commands for its turn, and network permission is coarse. Review cited mechanical drawings before fabrication. |
| ZIP import | Traversal, duplicate paths, malformed directory, oversized archive | Stored ZIP32 only, unsafe path rejection, duplicate rejection, CRC/checksum verification, entry and 512 MiB archive limits, preflight before mutation | A valid large archive can use substantial memory. Import only expected project backups. |
| XSS / Markdown | Scriptable links, HTML injection, clickjacking | React rendering, no raw HTML rendering, HTTP(S)-only external links, `noopener noreferrer`; Express responses add CSP, frame denial, and MIME sniffing protection | The built UI permits inline styling. Vite development HTML does not receive the Express policy; see the HTTP security section above. |
| Downloads | Path-like or control-character filename abuse | Artifact schemas, storage-segment validation, safe leaf-name normalization before browser download | Operating systems may still rewrite filenames. Verify extension and content before opening elsewhere. |
| Attachments | MIME spoofing, oversized images, secret leakage | MIME plus magic-byte validation, count/byte/pixel limits, attachment hashes, server-side revalidation | Images are sent to the configured provider. Do not attach confidential material unless its policy permits it. |
| Secrets | Exposure through UI, logs, generated commands, broker requests, or archives | Server-only configuration, model-provider keys removed from shell commands, Tavily key retained by the runtime, explicit `.env`/`.env.local` read denies, per-turn search capabilities, non-login shell, core inheritance, secret-name filtering, no secrets in project schemas | Local `.env` is operator-managed and must not be committed. Any model-controlled command can use its active search capability, though it cannot recover the Tavily account key. Rotate a key after suspected exposure. |

## Reporting

Follow [SECURITY.md](./SECURITY.md). Include the affected revision, browser and
operating-system version, minimal reproduction, impact, and whether a project
archive is safe to share. Remove API keys, prompts, attachments, and proprietary
CAD before attaching evidence.
