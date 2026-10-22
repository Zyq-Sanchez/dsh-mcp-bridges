# warm-session — MCP outside, ACP inside

Same MCP tool surface as [`../one-shot`](../one-shot/)
(`dsh_run` / `dsh_continue` / `dsh_read`), but the inner transport is **ACP**:

- one persistent `dsh --profile acp` process instead of a cold start per call;
- warm sessions reused per working directory;
- real `session/cancel` instead of killing a process;
- the same bounded-summary budget, so the caller's context stays small.

Codex needs no configuration change: the tool names and result shape are the
same as the headless variant.

## Architecture

```
Codex ──MCP──▶ bridge.mjs ──ACP──▶ dsh --profile acp (persistent)
                   │                        │
                   │                        └── sessions per cwd
                   └── results/<handle>.md (full transcript, read on demand)
```

## Tools

| Tool | Behaviour |
|---|---|
| `dsh_run(task, cwd?, timeout_sec?, fresh?)` | Reuses the warm session for `cwd` unless `fresh: true` |
| `dsh_continue(session_id, task, cwd?, timeout_sec?)` | Continues a specific session |
| `dsh_read(handle, offset?, max_chars?)` | Pages through the stored full output |

Summaries are capped at 900 chars (`DSH_BRIDGE_SUMMARY_CHARS`). Warm reuse shows
up as `[warm]` in the reply header.

## Files

| File | Role |
|---|---|
| `bridge.mjs` | MCP server, session reuse, result store, failure classification |
| `lib/acp.mjs` | stdio transport: framing, envelope validation, timeouts, reverse-request limits |
| `lib/policy.mjs` | permission answers, fail-closed |
| `lib/session.mjs` | session pool, per-session queue, bounded update projection |
| `test/fake-acp.mjs` | scriptable fake agent (normal / slow / weird / death) |
| `test/run-tests.mjs` | 7 offline protocol tests |
| `test/real-smoke.mjs` | one real call against `dsh --profile acp` |
| `test/verify-bridge.mjs` | end-to-end: cold run, warm reuse, timeout, recovery |
| `test-client.mjs` | manual MCP client |

## Run

```bash
node test/run-tests.mjs       # offline, no model, no tokens
node test/real-smoke.mjs      # real DSH, one small call
node test/verify-bridge.mjs   # full bridge behaviour, four small calls
node test-client.mjs --run "create demo.txt containing ok, then read it back"
```

## Install

```toml
[mcp_servers.dsh-warm-session]
command = "node"
args = ["/absolute/path/warm-session/bridge.mjs"]
startup_timeout_sec = 60
tool_timeout_sec = 3600
env = { DSH_BRIDGE_CWD = "/your/workspace" }
```

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

## Limits

- One in-flight prompt per session; calls queue.
- Permission requests are answered fail-closed; there is no interactive relay.
- `session/resume` is exposed by DSH but not wired here yet.
- POSIX process-group cleanup (`detached` + `kill(-pid)`); Windows needs
  `taskkill /T /F`.
- Warm reuse is per working directory; a `fresh: true` call opens a new session.
