# one-shot — fallback MCP bridge in front of `dsh --profile headless`

> **Role (2026-10-27 revision): fallback.** The primary entry is
> [`../warm-session`](../warm-session/). Keep this variant for a fresh process
> per call or when the ACP bridge is unavailable; it has no task binding and no
> resume.

Codex plans and decides; DSH executes with its full toolset (files, shell, web,
subagents) inside its default `workspace-write` sandbox. Failures come back as
MCP tool errors so Codex can re-plan.

The 2026-10-27 revision aligned this fallback with the primary bridge where it
made sense without changing its architecture:

- summary budget default **1500** chars (was 900), with the same
  `## 改动 / ## 验证 / ## 未解决 / ## 下一步` guidance;
- max `timeout_sec` **3300** (was 7200) to stay below the host's 3600 s tool
  timeout; the budget now starts before spawn, so launcher startup is covered;
- cancellation is **targeted**: `notifications/cancelled` kills only the child
  for that request id (previously it killed every in-flight child);
- `logs/calls.jsonl` per delegated call: `tool`, `session_id`, `status`,
  `bridge_ms`, timeout/exit fields, handle, text sizes;
- on failure the stored result keeps a raw stdout tail in addition to the final
  text / stderr tail, so partial output is recoverable with `dsh_read`.

## Tools

| Tool | Purpose |
|---|---|
| `dsh_run(task, cwd?, timeout_sec?)` | New DSH session, bounded summary + handle |
| `dsh_continue(session_id, task, cwd?, timeout_sec?)` | Continue that session |
| `dsh_read(handle, offset?, max_chars?)` | Page through the stored full output |

Every reply is a summary. The full output is written to `results/<handle>.md`
and is only read on demand — the caller's context is the scarce resource.

## Failure path

A failed run returns `isError: true` with the exit code, a classified reason, a
short stderr tail, a raw stdout tail in the stored handle, and the DSH session id.
Codex is instructed to diagnose and retry once before taking over itself.

Known failure signatures are annotated, for example the `EPERM` that appears when
the bridge is launched from inside a sandboxed shell instead of a real MCP
connection (DSH rewrites `~/.dsh/profiles/headless/cordis.yml` on every boot).

## Install

```toml
[mcp_servers.dsh_one_shot]
command = "node"
args = ["/absolute/path/one-shot/bridge.mjs"]
startup_timeout_sec = 60
tool_timeout_sec = 3600
env = { DSH_BRIDGE_CWD = "/your/workspace" }
```

Restart Codex and open a **new** conversation.

## Verify

```bash
node test-client.mjs                          # handshake + tools/list
node test-client.mjs --run "create demo.txt containing ok, then read it back"
```

Offline fake-CLI smoke in the 2026-10-27 round: run / continue / read / error /
cancel / log all behaved. Real-DSH verification remains gated on the round's DSH
permission (calls are currently paused).

## The permission wall

MCP has no reverse channel, so a DSH permission request cannot be forwarded to
Codex. It is answered (or refused) inside the bridge and surfaces as a tool
error. In practice this is rare: every operation inside the workspace is
auto-allowed, which covers nearly all real work.

If you need zero prompts at all costs, use
[`../text-only`](../text-only/) instead — at the cost of DSH losing its tools.

## Limits

- One `dsh` process per call, so each delegation pays a ~2–4 s cold start.
- No task binding and no `session/resume`: continuation uses the CLI session id.
- No streaming progress; cancellation is a targeted process-group termination.
- POSIX process-group cleanup (`detached` + `kill(-pid)`); Windows needs
  `taskkill /T /F`.
- Requires a logged-in DSH; `profile.patch.yml` re-enables the saved credential
  store for the headless profile.
