# one-shot — MCP in front of `dsh --profile headless`

Codex plans and decides; DSH executes with its full toolset (files, shell, web,
subagents) inside its default `workspace-write` sandbox. Failures come back as
MCP tool errors so Codex can re-plan.

This is the variant that has been exercised end to end: file edits, reads,
timeouts, retries, and a real Codex session driving it.

## Tools

| Tool | Purpose |
|---|---|
| `dsh_run(task, cwd?, timeout_sec?)` | New DSH session, bounded summary + handle |
| `dsh_continue(session_id, task, cwd?, timeout_sec?)` | Continue that session |
| `dsh_read(handle, offset?, max_chars?)` | Page through the stored full output |

Every reply is a summary. The full transcript is written to
`results/<handle>.md` and is only read on demand — the caller's context is the
scarce resource.

## Failure path

A failed run returns `isError: true` with the exit code, a classified reason, a
short stderr tail and the DSH session id. Codex is instructed to diagnose and
retry once before taking over itself.

Known failure signatures are annotated, for example the `EPERM` that appears when
the bridge is launched from inside a sandboxed shell instead of a real MCP
connection (DSH rewrites `~/.dsh/profiles/headless/cordis.yml` on every boot).

## Install

```toml
[mcp_servers.dsh-one-shot]
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

Measured 2026-10-22 on macOS:

| Check | Result |
|---|---|
| Write inside workspace | ✅ created and read back |
| Summary budget | ✅ ≤ 900 chars, handle returned |
| `dsh_read` paging | ✅ `[0..200/523] — truncated, pass offset to continue` |
| Timeout → retry | ✅ `timeout_sec=1` failed, Codex re-planned, retry succeeded |

## The permission wall

MCP has no reverse channel, so a DSH permission request cannot be forwarded to
Codex. It is answered (or refused) inside the bridge and surfaces as a tool
error. In practice this is rare: every operation inside the workspace is
auto-allowed, which covers nearly all real work.

If you need zero prompts at all costs, use
[`../text-only`](../text-only/) instead — at the cost of DSH
losing its tools.

## Limits

- One `dsh` process per call, so each delegation pays a ~2–4 s cold start.
- No streaming and no mid-run cancellation beyond killing the process group.
- POSIX process-group cleanup (`detached` + `kill(-pid)`); Windows needs
  `taskkill /T /F`.
- Requires a logged-in DSH; `profile.patch.yml` re-enables the saved credential
  store for the headless profile.
