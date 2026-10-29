# warm-session — MCP outside, ACP inside (primary bridge)

Codex keeps the decision-making; DSH executes. The transport is **MCP on the
outside, ACP on the inside**:

- one persistent `dsh --profile acp` process instead of a cold start per call;
- sessions are bound to an explicit `task_id` (never auto-reused by working
  directory), so the same objective continues the same session while a different
  objective starts clean;
- bindings are persisted locally and survive a bridge restart via
  `session/resume`;
- a single deadline covers startup, session create/resume, queueing and the
  prompt; queued requests can be cancelled without cancelling the running one;
- the complete answer is streamed to disk (the summary buffer can no longer lose
  the tail);
- ACP updates are forwarded to the host as MCP progress notifications when the
  host sends a progress token;
- every delegated call writes a JSONL timing record.

This is the **main entry point** in the 2026-10-27 revision. `../one-shot` is
kept as the fallback variant.

## Architecture

```
Codex ──MCP──▶ bridge.mjs ──ACP──▶ dsh --profile acp (persistent)
                   │                        │
                   │                        └── one session per task_id
                   ├── state/tasks.json     task_id -> session/cwd/status/summary
                   ├── results/<handle>.md complete streamed output (+ .partial)
                   └── logs/calls.jsonl    per-call bridge-side timing
```

## Session semantics

| Situation | Behaviour |
|---|---|
| `dsh_run` **without** `task_id` | New task_id + new session. Same cwd does **not** reuse anything. |
| `dsh_run` with an existing `task_id` | Continues the bound session (`[reused]`, or `[resumed]` after a bridge restart). |
| `dsh_continue(task_id)` | Preferred follow-up: implementation, tests, fixes of the **same** objective. |
| `dsh_continue(session_id)` | Attach an explicit session id (for example one shown in the DSH sidebar). |
| Different objective | Call `dsh_run` without `task_id`; do not reuse an old task_id across projects (the bridge rejects a cwd mismatch). |
| `fresh: true` | Deliberately replaces the session for the same task. |
| History long (`usage_update` used/size ≥ `DSH_BRIDGE_HANDOFF_RATIO`, default 0.7) | New session is created automatically and the prompt starts with a short `[handoff]` block: goal, previous session id, known progress summary, project. |

`dsh_tasks` returns at most a few compact bindings (`task_id`, goal, status,
summary) and never transcripts. Use it only when old context is genuinely needed.

## Tools

| Tool | Behaviour |
|---|---|
| `dsh_run(task, task_id?, goal?, cwd?, timeout_sec?, fresh?)` | New objective, or continue an existing bound task. Returns `task=`, `session=`, a bounded summary and a `full output` handle. |
| `dsh_continue(task_id?, session_id?, task, cwd?, timeout_sec?, fresh?)` | Continue a bound session (task_id preferred). |
| `dsh_read(handle, offset?, max_chars?)` | Page through the stored complete output. Not a model call. |
| `dsh_tasks(query?, project?, limit?)` | Up to 5 (default 3) compact task bindings for old-background lookups. |

Every summary is capped at `DSH_BRIDGE_SUMMARY_CHARS` (default **1500**); the
complete answer is stored under the handle. The default was raised from 900
because one avoided `dsh_read` round trip (7–10 s caller-observed in the
2026-10-27 review) outweighs a few hundred summary characters. A real-DSH A/B
remains pending (see `docs/REVISION-2026-10-27.md`).

## Execution control

- **Deadline**: `timeout_sec` (default 900, max 3300 — below the host's 3600 s
  `tool_timeout_sec`) is one budget for ACP startup + `initialize` +
  `session/new`/`session/resume` + queue wait + `session/prompt`.
- **Cancellation**: a queued request is removed from its session queue and
  rejected without touching the running prompt; only a running prompt gets
  `session/cancel`.
- **Retry**: exactly one automatic retry for recoverable transport failures
  (process/protocol error) that happen **before** the prompt starts. Timeouts and
  prompt-execution failures are never auto-retried.
- **Permissions**: still fail-closed (`lib/policy.mjs`).

## Progress and observability

- If `tools/call` carries `_meta.progressToken`, the bridge emits
  `notifications/progress` (throttled to ~1/700 ms) with tool titles and output
  size. Hosts that do not send a token simply get no progress events.
- `logs/calls.jsonl` records one line per `dsh_run`/`dsh_continue`:
  `task_id, session_id, tool, status, bridge_ms, received_at, phases
  {ensure_ms, resume_ms, session_new_ms, queue_ms, prompt_ms, retry},
  summary_chars, full_chars, progress_sent/seen, deadline`. The caller measures
  its own round trip; `bridge_ms` is the bridge-side portion. See
  `test/compare-latency.mjs` for the offline join.

## Files

| File | Role |
|---|---|
| `bridge.mjs` | MCP server: task binding, deadline, cancellation, rendering, progress, call log |
| `lib/deadline.mjs` | one budget per call, phase-typed timeout/cancel/usage errors |
| `lib/registry.mjs` | persisted task_id → session binding store, compact search |
| `lib/results.mjs` | streaming result writer + paged reader (complete output) |
| `lib/session.mjs` | session create/resume/list, per-session queue with per-request cancel, update projection |
| `lib/acp.mjs` | stdio transport: framing, envelope validation, timeouts, reverse-request limits |
| `lib/policy.mjs` | permission answers, fail-closed |
| `test/fake-acp.mjs` | scriptable fake agent (normal/long/hang/cancel/resume/handoff usage) |
| `test/run-tests.mjs` | offline protocol/pool/registry tests (15) |
| `test/bridge-tests.mjs` | offline MCP end-to-end tests (14) |
| `test/compare-latency.mjs` | caller-side vs bridge-side measurement join (fake ACP) |
| `test/real-smoke.mjs` | real DSH smoke; gated by `DSH_ALLOW_REAL=1` |
| `test/verify-bridge.mjs` | real DSH end-to-end; gated by `DSH_ALLOW_REAL=1` |
| `test-client.mjs` | manual MCP client |

## Run / verify

```bash
node test/run-tests.mjs          # offline, no model, no DSH
node test/bridge-tests.mjs       # offline MCP end-to-end, no model, no DSH
node test/compare-latency.mjs    # offline measurement join, no model, no DSH

# real DSH (only when execution is allowed for the round):
DSH_ALLOW_REAL=1 node test/real-smoke.mjs            # one small call
DSH_ALLOW_REAL=1 node test/real-smoke.mjs --resume   # + close/list/resume
DSH_ALLOW_REAL=1 node test/verify-bridge.mjs         # binding/timeout/recovery
node test-client.mjs --run "create demo.txt containing ok, then read it back"
```

The current round keeps all DSH calls paused; only the offline suites were run.

## Install

```toml
[mcp_servers.dsh_warm_session]
command = "node"
args = ["/absolute/path/warm-session/bridge.mjs"]
startup_timeout_sec = 60
tool_timeout_sec = 3600
env = { DSH_BRIDGE_CWD = "/your/workspace" }
```

Optional env: `DSH_BRIDGE_STATE_DIR` (default `<bridge>/state`),
`DSH_BRIDGE_RESULTS_DIR` (default `<bridge>/results`),
`DSH_BRIDGE_LOG_DIR` (default `<bridge>/logs`). Restart Codex (and open a new
conversation) after upgrading: the old MCP process keeps the old tool surface
until it is reconfigured.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DSH_CLI` | auto-detect | `dsh` launcher path |
| `DSH_BRIDGE_CWD` | process cwd | default project directory |
| `DSH_BRIDGE_TIMEOUT_SEC` | 900 | default call budget |
| `DSH_BRIDGE_MAX_TIMEOUT_SEC` | 3300 | hard cap for `timeout_sec` |
| `DSH_BRIDGE_SUMMARY_CHARS` | 1500 | summary cap (full text always stored) |
| `DSH_BRIDGE_HANDOFF_RATIO` | 0.7 | used/size ratio that triggers a handoff session |
| `DSH_BRIDGE_STARTUP_TIMEOUT_MS` | 30000 | ACP startup budget |
| `DSH_BRIDGE_STATE_DIR` | `<bridge>/state` | `tasks.json` binding store |
| `DSH_BRIDGE_RESULTS_DIR` | `<bridge>/results` | full outputs |
| `DSH_BRIDGE_LOG_DIR` | `<bridge>/logs` | `calls.jsonl` |

## Limits / open items

- Real-DSH verification of `session/resume`, real progress notifications,
  real cancellation and the summary A/B is **pending** (DSH calls paused).
- Permission requests are answered fail-closed; there is no interactive relay.
- One in-flight prompt per session; other calls queue and can be cancelled
  individually.
- `session/resume` requires the same cwd that the session was created with; the
  binding stores the project path for this reason.
- POSIX process-group cleanup (`detached` + `kill(-pid)`); Windows needs
  `taskkill /T /F`.
- `text-only` is intentionally untouched in this revision; whether it is
  disabled by default is a separate decision (see root README).

## Attribution

The transport hardening follows the structure of
[`subagent-mcp`](https://github.com/Thang1710/subagent-mcp) (MIT),
`adapters/acp_stdio.py`. The implementation is independent JavaScript; no code is
copied verbatim.

| Borrowed (structure) | Not borrowed (deliberately) |
|---|---|
| line framing + size cap | Windows DACL/ACE write-scope proof |
| envelope validation order | Windows path folding (`/` → `\`) |
| per-request timeout + pending map | `agent_spawn` / `agent_wait` / `agent_result` lifecycle |
| reverse-request dedupe and limits | multi-harness registry, localhost UI, uvx packaging |
| fail-closed permission answer | flipping the platform gate (silently disables the ACL check) |
