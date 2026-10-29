# DSH MCP connection and latency review — 2026-10-23

## Connection status

All three configured MCP servers answered a real minimal model request. The
warm-session continuation also returned a marker from its preceding turn,
confirming session continuity. Both execution bridges successfully read their
stored result handles.

| Probe | Caller-observed elapsed | Bridge-reported execution |
|---|---:|---:|
| text-only, minimal answer | 6.77 s | not exposed |
| one-shot, new session | 15.00 s | 1.2 s |
| warm-session, new session | 10.78 s | 1.5 s |
| warm-session, continuation | 5.68 s | 0.8 s |
| one-shot, continuation in a new process | 3.92 s | 1.5 s |
| one-shot, stored result read, no model call | 10.17 s | not exposed |
| warm-session, stored result read, no model call | 7.43 s | not exposed |

These are individual observations, not a statistically controlled benchmark.
Some independent probes ran concurrently. The measurements do not establish a
fixed overhead, average speed, or a guaranteed speedup.

The zero-model local stdio benchmark was run independently after the guidance
changes. Initialization includes starting the bridge process:

| Bridge | Initialization | Median of 3 pings | tools/list |
|---|---:|---:|---:|
| text-only | 22.44 ms | 0.068 ms | 0.076 ms |
| one-shot | 21.94 ms | 0.090 ms | 0.071 ms |
| warm-session | 21.41 ms | 0.048 ms | 0.073 ms |

This uses the bundled Node runtime directly, not the configured Electron bridge
launcher, and excludes the Codex host's dispatch path. It isolates local protocol
processing rather than reproducing the full application path.

Bridge execution timers include child execution for one-shot, and runtime/session
setup plus queueing and the prompt for warm-session. They exclude the surrounding
host tool dispatch and result delivery. No timer bug was found that explains the
multi-second gap. Slow reads without a model call show that the gap cannot all be
attributed to model inference. The exact host-side component remains unisolated.

## Why delegation can feel slower

Delegation adds a second model turn and a handoff to Codex's own work. Headless
variants also start a process for every request. Warm ACP avoids repeated process
startup but still pays model and host tool-call latency. Reading results or asking
for follow-up work adds further round trips; follow-up work also invokes the model.

The original one-shot server guidance required delegation for *every* file,
command, or verification task. This conflicted with the user's preference for
selective delegation. Both execution bridges also encouraged retries regardless
of whether changing the request could resolve the failure.

## Changes in this review

- Make delegation optional: use direct tools for simple reads, small edits,
  individual commands, and routine checks.
- Prefer warm-session for substantial, related repository work; retain one-shot
  for a fresh process or fallback use.
- Batch related steps and request the outcome, changed paths, test evidence, and
  unresolved issues first so the bounded summary is useful.
- Retry once only for a recoverable failure. Do not start another model turn just
  to retrieve already-stored output.
- Correct the warm-session overflow notice: the session text buffer retains at
  most 8,000 characters, so the stored copy is also truncated after overflow.
  Reading it cannot restore text that was never retained.
- Add a local transport benchmark that invokes no DSH model or executable:

  ```bash
  node test/benchmark-transport.mjs
  node warm-session/test/run-tests.mjs
  ```

These changes reduce avoidable delegation and result-reading round trips. They do
not claim to make the provider's model or the host's tool dispatch faster.

## Remaining work, in priority order

1. **Unified timeout deadline.** The warm bridge's `timeout_sec` budget currently
   starts at the actual prompt request, after runtime startup, session creation,
   and per-session queueing. The configured ACP startup timeout is retained by
   the client but is not applied to initialization. A future fix should cover
   all phases with one deadline and test slow initialization and queueing using
   fake ACP. Lowering Codex's outer timeout alone does not fix this accounting.
2. **Request-specific cancellation.** Canceling a queued continuation currently
   sends cancellation to the shared session. It can cancel a different active
   request while leaving the queued request eligible to run. Track queued and
   active request state separately; verify with two overlapping fake requests.
3. **Session lifecycle.** Automatic reuse is keyed by working directory, without
   an idle TTL or turn limit. Use `fresh: true` for unrelated work when history
   should not be inherited. Larger history is a plausible latency contributor,
   but it was not established as the cause of this incident. Automatic rotation
   needs explicit continuation semantics and tests.
4. **Host-side tracing.** Compare the local transport benchmark with tool-call
   wall time over multiple sequential samples. Diagnose dispatch, queueing, and
   delivery separately before changing proxies, authentication, or providers.

## Activation and configuration

The minimal bridge changes were copied to the three configured source files;
the original files were backed up inside the workspace. Already-running Node
processes retain their loaded instructions. Restart the MCP connections to load
the updates. This review did not change credentials, permissions, provider/model
selection, the Codex configuration, or the remote GitHub repository.

`startup_timeout_sec` and `tool_timeout_sec` are maximum waits, not deliberate
delays or speed controls. Their current values, 60 and 3600 seconds, do not make
every call wait that long. They can allow a genuinely stalled call to linger.
The server-wide `instructions` field is used by Codex for tool-selection guidance.
See the [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Verification

All three bridge modules passed syntax checks, and the existing offline ACP
suite passed 7/7 checks, including denial of permission requests. The source
changes affect routing guidance and diagnostics; the ACP permission handler was
not modified. Live health probes above preceded installation, so they establish
connectivity, not an end-to-end speedup from the changed guidance.
The new local benchmark passed handshake, ping, expected tool-list and guidance
checks for all three bridges. Remaining timeout and cancellation findings are
from code inspection, not reproduced incidents in the user's active workload.
