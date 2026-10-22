# text-only — DSH as a pure text engine

Codex keeps every local capability. DSH is used as a **pure text-processing
engine**: Codex pastes material in, DSH analyses it and returns an answer.

DSH runs with all file, shell, web, subagent and skill tools **disabled**
(`profile.patch.yml`), so it cannot touch the machine and therefore can never
raise a permission request.

## Why this exists

In the MCP model there is no reverse channel: a server cannot ask the host a
question mid-call. Rather than build an approval relay, this variant removes the
need for one — a tool-less engine has nothing to ask permission for.

## Trade-off

| Win | Cost |
|---|---|
| Zero permission prompts, by construction | DSH cannot read files, run tests, or browse |
| Small prompt surface (one tool) | Codex must paste every input, and that input is charged to Codex's context |
| Fully predictable: no side effects | No automatic verification loop |

This is the right tool for review, explanation, summarisation and design
critique. For anything that edits a repository, use
[`../one-shot`](../one-shot/).

## Tool

`dsh_think(instruction, material, timeout_sec?)`

- `instruction` — what to do with the material.
- `material` — everything the engine may use. It has no other source of truth.
- Returns a structured answer (`结论 / 依据 / 风险`), capped at 6000 characters.

## Install

```toml
[mcp_servers.dsh-text-only]
command = "node"
args = ["/absolute/path/text-only/bridge.mjs"]
```

Restart Codex and open a **new** conversation; MCP tool surfaces are bound per
thread.

## Verify

```bash
node test-client.mjs        # handshake + tools/list
node test-client.mjs --ask  # one real analysis
```

Confirm the engine really is inert:

```bash
dsh --patch "$(pwd)/profile.patch.yml" --profile headless \
  "write hello to /tmp/should-not-exist.txt"
ls /tmp/should-not-exist.txt   # must not exist
```

Measured 2026-10-22 on macOS: the run reported "no execution tools", exit code 0,
file not created.

## Limits

- No URL fetching — Codex has to bring the content.
- Long material still costs Codex context; send excerpts, not whole repositories.
- The patch disables plugin ids by name. A future DSH release that renames a tool
  plugin would need the patch updated; the verification command above is the
  regression check.
