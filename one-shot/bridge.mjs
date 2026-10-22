#!/usr/bin/env node
/**
 * Variant B (current setup) - Codex -> DSH execution bridge.
 *
 * An MCP (Model Context Protocol) stdio server that exposes the DeepSeek Harness
 * one-shot runner (`dsh --profile headless`) as tools. Codex stays the planner and
 * decision maker; every actual bit of work is delegated to a real DSH agent run.
 * When a run fails, the failure is returned as an MCP tool error so Codex sees it
 * and re-plans.
 *
 * DSH keeps its normal toolset here (files, shell, web, subagents) under its
 * default workspace-write sandbox. That is what makes it useful for real work -
 * and it is also why this variant can hit a permission wall outside the workspace.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 * stdout is protocol-only; all diagnostics go to stderr.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CWD = process.env.DSH_BRIDGE_CWD || process.cwd();
const CLI_CANDIDATES = [
  process.env.DSH_CLI,
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
  '/usr/local/bin/dsh',
  '/opt/homebrew/bin/dsh',
].filter(Boolean);

const DEFAULT_TIMEOUT_SEC = Number(process.env.DSH_BRIDGE_TIMEOUT_SEC || 900);
const MAX_TIMEOUT_SEC = 7200;
const PROFILE_PATCH = path.join(HERE, 'profile.patch.yml');

// Token budget: the caller's context is the scarce resource. Every reply is a
// bounded summary; the full transcript is written to disk and readable on
// demand through dsh_read. Tune with DSH_BRIDGE_SUMMARY_CHARS.
const RESULTS_DIR = path.join(HERE, 'results');
const SUMMARY_CHARS = Number(process.env.DSH_BRIDGE_SUMMARY_CHARS || 900);
const FAILURE_TAIL_LINES = 20;
const MAX_READ_CHARS = 8000;
const DEFAULT_READ_CHARS = 4000;

const SERVER_INFO = { name: 'dsh-one-shot', version: '1.0.0' };
const INSTRUCTIONS = [
  'This server runs DeepSeek Harness (DSH), a full coding agent with file, shell and web tools.',
  'Division of labour: you decide and reason; DSH executes.',
  'For any task that needs to touch files, run commands, or verify behavior, call dsh_run with a',
  'complete, self-contained instruction instead of doing the work with your own tools. DSH has no',
  'memory of this conversation, so repeat the relevant context in `task`.',
  'Reuse the returned session id with dsh_continue for follow-up work in the same context.',
  'Responses are deliberately compact: a bounded summary, never the full transcript. The complete',
  'output is stored under a handle and readable with dsh_read. Treat your context as the scarce',
  'resource: read the full output only when the summary is genuinely insufficient, and prefer a',
  'targeted dsh_continue over paging through a long transcript.',
  'A failed run comes back as a tool error with the exit code, stderr tail and DSH session id.',
  'That error is feedback for you: diagnose it, adjust the instruction, and call dsh_run again, or',
  'fix the problem yourself if DSH cannot. Never report a failure as final without either one retry',
  'through DSH or a clear explanation of why retrying cannot help.',
].join(' ');

/* ------------------------------------------------------------------ plumbing */

const children = new Set();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id, error });
}

function log(...parts) {
  process.stderr.write(`[dsh-one-shot] ${parts.join(' ')}\n`);
}

/* --------------------------------------------------------------- tool schema */

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description:
        'Complete instruction for the DSH agent. It starts cold: state the goal, the paths involved, and how to verify success.',
    },
    cwd: {
      type: 'string',
      description: `Working directory for the run. Defaults to ${DEFAULT_CWD}.`,
    },
    timeout_sec: {
      type: 'integer',
      description: `Wall-clock limit in seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}).`,
    },
  },
  required: ['task'],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'dsh_run',
    description:
      'Execute a task on DeepSeek Harness in a fresh session. Returns a bounded summary (session id + final answer excerpt), not the full transcript. Use this for real work: editing files, running builds/tests, browsing, data processing. Failure is reported as a tool error so you can re-plan.',
    inputSchema: TASK_SCHEMA,
  },
  {
    name: 'dsh_continue',
    description:
      'Continue an existing DSH session (same files, same context) with a new instruction. Returns the same bounded summary as dsh_run. Use for fixes, follow-ups and iteration on work DSH already did.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id returned by a previous dsh_run (the `session ...` field).',
        },
        ...TASK_SCHEMA.properties,
      },
      required: ['session_id', 'task'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_read',
    description:
      'Read the full stored output of an earlier run, one slice at a time. Only call this when the summary is genuinely insufficient — every call spends your context. Prefer asking DSH for a targeted follow-up over re-reading a long transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: 'Handle printed as `full output: <handle>` by dsh_run/dsh_continue.',
        },
        offset: {
          type: 'integer',
          description: 'Character offset to start from (default 0).',
        },
        max_chars: {
          type: 'integer',
          description: `Maximum characters to return (default ${DEFAULT_READ_CHARS}, cap ${MAX_READ_CHARS}).`,
        },
      },
      required: ['handle'],
      additionalProperties: false,
    },
  },
];

/* ------------------------------------------------------------------ execution */

function findCli() {
  for (const candidate of CLI_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `cannot locate the dsh CLI. Set DSH_CLI to the launcher path (looked at: ${CLI_CANDIDATES.join(', ')}).`,
  );
}

function clampTimeout(value) {
  const seconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_SEC;
  return Math.min(seconds, MAX_TIMEOUT_SEC);
}

function parseEvents(stdout) {
  let sessionId;
  let finalText;
  let failure;
  const toolCalls = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === 'session' && event.sessionId) sessionId = event.sessionId;
    else if (event.type === 'final') finalText = event.text ?? '';
    else if (event.type === 'error') failure = event.message || 'dsh reported an error event';
    else if (event.type === 'tool_call') toolCalls.push(event.name || event.tool || 'tool');
  }
  return { sessionId, finalText, failure, toolCalls };
}

function tail(text, lines = 40, bytes = 6000) {
  const sliced = text.split('\n').slice(-lines).join('\n').trim();
  return sliced.length > bytes ? `…${sliced.slice(-bytes)}` : sliced;
}

async function runDsh({ task, cwd, timeout_sec, sessionId }) {
  const cli = findCli();
  const workingDir = cwd && existsSync(cwd) ? cwd : DEFAULT_CWD;
  const timeoutMs = clampTimeout(timeout_sec) * 1000;

  // Launcher-level flags (`--patch`, `--profile`) come first; app flags
  // (`--json`, `--session-id`) must follow the profile selection.
  const args = [];
  if (existsSync(PROFILE_PATCH) && process.env.DSH_BRIDGE_PATCH !== '0') {
    args.push('--patch', PROFILE_PATCH);
  }
  args.push('--profile', 'headless', '--json');
  if (sessionId) args.push('--session-id', sessionId);

  const startedAt = Date.now();
  const child = spawn(cli, args, {
    cwd: workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, DSH_BRIDGE_CHILD: '1' },
  });
  children.add(child);

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  // A cold DSH run can take a while to boot; the task text goes through stdin so
  // that arbitrary quoting/newlines never hit shell or argv parsing.
  child.stdin.on('error', () => {});
  child.stdin.end(task);

  const killTree = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killTree('SIGTERM');
    setTimeout(() => killTree('SIGKILL'), 5000).unref?.();
  }, timeoutMs);

  const exit = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, signal: null, spawnError: error }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  children.delete(child);

  const elapsedMs = Date.now() - startedAt;
  const parsed = parseEvents(stdout);
  const ok = exit.code === 0 && !parsed.failure && !timedOut;

  return { ok, ...parsed, ...exit, stderr, stdout, elapsedMs, timedOut, workingDir, sessionId: parsed.sessionId || sessionId };
}

function renderFull(result) {
  const seconds = (result.elapsedMs / 1000).toFixed(1);
  const head = result.ok
    ? `dsh: ok in ${seconds}s (${result.workingDir})`
    : `dsh: FAILED after ${seconds}s (${result.workingDir})`;
  const parts = [head];
  if (result.sessionId) parts.push(`session ${result.sessionId}`);
  if (result.toolCalls.length) {
    const unique = [...new Set(result.toolCalls)];
    parts.push(`tools used: ${unique.slice(0, 15).join(', ')}${unique.length > 15 ? ', …' : ''}`);
  }
  parts.push('', result.finalText ? result.finalText : '(no final answer)');

  if (!result.ok) {
    if (result.timedOut) parts.push('', 'run timed out and was killed');
    if (result.spawnError) parts.push('', `spawn error: ${result.spawnError.message}`);
    if (!result.timedOut && result.code !== undefined && result.code !== null) {
      parts.push('', `exit code: ${result.code}`);
    }
    if (result.signal) parts.push('', `signal: ${result.signal}`);
    if (result.failure) parts.push('', `error: ${result.failure}`);
    const err = tail(result.stderr);
    if (err) parts.push('', '--- stderr tail ---', err);
  } else if (result.stderr.trim()) {
    const err = tail(result.stderr, 12, 2000);
    if (err) parts.push('', '--- stderr tail ---', err);
  }
  return parts.join('\n');
}

/* ------------------------------------------------------- result store / read */

let resultSeq = 0;

function storeResult(text) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const handle = `run-${Date.now().toString(36)}-${++resultSeq}`;
  writeFileSync(path.join(RESULTS_DIR, `${handle}.md`), text, 'utf8');
  return handle;
}

const HANDLE_RE = /^run-[a-z0-9]+-\d+$/;

function readResult(handle, offset, maxChars) {
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) {
    throw new Error(`invalid handle: ${String(handle)}`);
  }
  const file = path.join(RESULTS_DIR, `${handle}.md`);
  if (!existsSync(file)) throw new Error(`unknown handle: ${handle}`);
  const text = readFileSync(file, 'utf8');
  const start = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, text.length));
  const size = Math.min(
    Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_READ_CHARS,
    MAX_READ_CHARS,
  );
  const slice = text.slice(start, start + size);
  return { slice, total: text.length, start, end: start + slice.length };
}

/* ------------------------------------------------------------ compact render */

function renderCompact(result, handle) {
  const seconds = (result.elapsedMs / 1000).toFixed(1);
  const parts = [
    result.ok
      ? `dsh: ok ${seconds}s (${result.workingDir})`
      : `dsh: FAILED ${seconds}s (${result.workingDir})`,
  ];
  if (result.sessionId) parts.push(`session ${result.sessionId}`);
  if (handle) parts.push(`full output: ${handle} (read with dsh_read if needed)`);

  const answer = (result.finalText || '').trim();
  if (answer.length > SUMMARY_CHARS) {
    parts.push('', `${answer.slice(0, SUMMARY_CHARS)}…`);
    if (handle) parts.push(`[summary truncated at ${SUMMARY_CHARS} chars — full text in ${handle}]`);
  } else {
    parts.push('', answer || '(no final answer)');
  }

  if (!result.ok) {
    if (result.timedOut) parts.push('', 'run timed out and was killed');
    if (result.spawnError) parts.push('', `spawn error: ${result.spawnError.message}`);
    if (!result.timedOut && result.code !== undefined && result.code !== null) {
      parts.push('', `exit code: ${result.code}`);
    }
    if (result.failure) parts.push('', `error: ${result.failure}`);
    const err = tail(result.stderr, FAILURE_TAIL_LINES, 2500);
    if (err) parts.push('', '--- stderr tail ---', err);

    // The single most common failure: DSH rewrites its composed profile
    // ($DSH_HOME/profiles/headless/cordis.yml) on every boot. If this bridge was
    // started from inside the caller's sandboxed shell, that write is denied and
    // the run dies before the model is called.
    if (/EPERM|EACCES/.test(result.stderr) && /\.dsh[/\\]profiles/.test(result.stderr)) {
      parts.push(
        '',
        'DIAGNOSIS: DSH could not write its own profile state under ~/.dsh. This happens when the bridge',
        'is launched from a sandboxed shell (for example a sandboxed exec_command) instead of being',
        'connected as a real MCP server. DSH rewrites profiles/headless/cordis.yml on every boot.',
        'FIX: call this tool through the MCP connection itself (it runs outside that sandbox), or add',
        '~/.dsh to the sandbox writable roots. Do not keep retrying the same sandboxed spawn.',
      );
    }
    parts.push(
      '',
      'NEXT: this execution did not succeed. Diagnose it, change the instruction, and retry with dsh_run (or dsh_continue on the same session). Only take over yourself if DSH cannot do it.',
    );
  }
  return parts.join('\n');
}

/* ------------------------------------------------------------------ dispatch */

async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments || {};

  if (name === 'dsh_read') {
    try {
      const { slice, total, start, end } = readResult(args.handle, args.offset, args.max_chars);
      const header = `dsh_read ${args.handle} [${start}..${end}/${total}]${end < total ? ' — truncated, pass offset to continue' : ''}`;
      reply(id, { content: [{ type: 'text', text: `${header}\n\n${slice}` }], isError: false });
    } catch (error) {
      reply(id, {
        content: [{ type: 'text', text: `dsh_read failed: ${error?.message || error}` }],
        isError: true,
      });
    }
    return;
  }

  if (name !== 'dsh_run' && name !== 'dsh_continue') {
    replyError(id, -32602, `unknown tool: ${name}`);
    return;
  }
  if (typeof args.task !== 'string' || !args.task.trim()) {
    replyError(id, -32602, '`task` must be a non-empty string');
    return;
  }
  const sessionId = name === 'dsh_continue' ? args.session_id : undefined;
  if (name === 'dsh_continue' && (typeof sessionId !== 'string' || !sessionId.trim())) {
    replyError(id, -32602, '`session_id` must be a non-empty string');
    return;
  }

  try {
    const result = await runDsh({
      task: args.task,
      cwd: args.cwd,
      timeout_sec: args.timeout_sec,
      sessionId,
    });
    const handle = storeResult(renderFull(result));
    reply(id, {
      content: [{ type: 'text', text: renderCompact(result, handle) }],
      isError: !result.ok,
    });
  } catch (error) {
    log('execution failed:', error?.message || String(error));
    reply(id, {
      content: [{ type: 'text', text: `dsh: could not start the execution: ${error?.message || error}` }],
      isError: true,
    });
  }
}

async function onMessage(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      if (isRequest) reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call':
      await handleToolCall(id, params);
      return;
    case 'notifications/cancelled': {
      for (const child of children) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
      return;
    }
    default:
      if (isRequest) replyError(id, -32601, `method not found: ${method}`);
  }
}

/* -------------------------------------------------------------------- stdio */

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log('ignoring malformed JSON line');
      continue;
    }
    void onMessage(message);
  }
});

process.stdin.on('end', () => process.exit(0));

function shutdown() {
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => log('uncaught:', error?.stack || String(error)));
process.on('unhandledRejection', (error) => log('unhandled rejection:', error?.stack || String(error)));

log('ready');
