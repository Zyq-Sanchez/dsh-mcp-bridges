#!/usr/bin/env node
/**
 * ACP-backed Codex <-> DSH bridge.
 *
 * Same MCP tool surface as `../one-shot` (dsh_run / dsh_continue /
 * dsh_read), but the inner transport is ACP: one persistent `dsh --profile acp`
 * process, warm sessions reused per working directory, real cancellation, and
 * the same bounded-summary budget.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio, zero dependencies.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { AcpClient, AcpError, AcpProcessError, AcpRpcError, AcpTimeoutError } from './lib/acp.mjs';
import { createReverseHandler } from './lib/policy.mjs';
import { SessionPool } from './lib/session.mjs';

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
const SUMMARY_CHARS = Number(process.env.DSH_BRIDGE_SUMMARY_CHARS || 900);
const STARTUP_TIMEOUT_MS = Number(process.env.DSH_BRIDGE_STARTUP_TIMEOUT_MS || 30_000);
const RESULTS_DIR = process.env.DSH_BRIDGE_RESULTS_DIR || path.join(HERE, 'results');
const REUSE = process.env.DSH_BRIDGE_REUSE !== '0';
const FAILURE_TAIL_LINES = 20;
const MAX_READ_CHARS = 8000;
const DEFAULT_READ_CHARS = 4000;

const SERVER_INFO = { name: 'dsh-warm-session', version: '1.0.0' };
const INSTRUCTIONS = [
  'This server runs DeepSeek Harness (DSH) over ACP, one persistent process.',
  'Division of labour: you decide and reason; DSH executes.',
  'Call dsh_run for work that needs files, commands or web access; call dsh_continue to keep',
  'working in a session that already has the context. Sessions are reused per working directory,',
  'so repeated work in the same repo is warm and cheap.',
  'Responses are deliberately compact: a bounded summary, never the full transcript. The complete',
  'output is stored under a handle and readable with dsh_read. Treat your context as the scarce',
  'resource: read the full output only when the summary is genuinely insufficient.',
  'A failed run comes back as a tool error with a classified reason and a short stderr tail.',
  'Diagnose it, adjust the instruction, and retry once before taking over yourself.',
].join(' ');

/* ------------------------------------------------------------------ plumbing */

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}
function log(...parts) {
  process.stderr.write(`[dsh-warm-session] ${parts.join(' ')}\n`);
}

/* ------------------------------------------------------------------ results */

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

/* ------------------------------------------------------------------ runtime */

class Runtime {
  constructor() {
    this.client = null;
    this.pool = null;
    this.starting = null;
    this.busy = new Set();
    this.lastByCwd = new Map();
  }

  async ensure() {
    if (this.client && this.pool && !this.client.terminalError) return this.pool;
    if (!this.starting) {
      this.starting = this.start().catch((error) => {
        this.starting = null;
        throw error;
      });
    }
    return this.starting;
  }

  async start() {
    const cli = findCli();
    const client = new AcpClient({
      command: cli,
      args: ['--profile', 'acp'],
      cwd: DEFAULT_CWD,
      startupTimeoutMs: STARTUP_TIMEOUT_MS,
      requestTimeoutMs: 60_000,
    });
    client.onReverseRequest(createReverseHandler({ allowPermission: false }));
    await client.start();

    const info = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    log(`connected: ${info.agentInfo?.name ?? 'unknown'} protocol ${info.protocolVersion}`);

    this.client = client;
    this.pool = new SessionPool({ client });
    this.starting = null;
    return this.pool;
  }

  async reset() {
    const client = this.client;
    this.client = null;
    this.pool = null;
    this.starting = null;
    this.busy.clear();
    this.lastByCwd.clear();
    if (client) await client.close().catch(() => {});
  }

  async sessionFor(cwd, { fresh, sessionId }) {
    const pool = await this.ensure();
    if (sessionId) {
      const existing = pool.get(sessionId);
      if (!existing) throw new AcpError(`unknown session: ${sessionId}`);
      this.busy.add(existing.id);
      return { session: existing, reused: true };
    }
    if (REUSE && !fresh) {
      const candidate = this.lastByCwd.get(cwd);
      const session = candidate ? pool.get(candidate) : null;
      if (session && !this.busy.has(session.id)) {
        this.busy.add(session.id);
        return { session, reused: true };
      }
    }
    const session = await pool.open(cwd);
    this.lastByCwd.set(cwd, session.id);
    this.busy.add(session.id);
    return { session, reused: false };
  }

  release(session) {
    if (session) this.busy.delete(session.id);
  }

  async shutdown() {
    if (this.pool) await this.pool.closeAll().catch(() => {});
    if (this.client) await this.client.close().catch(() => {});
    this.client = null;
    this.pool = null;
  }
}

const runtime = new Runtime();

function findCli() {
  for (const candidate of CLI_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot locate the dsh CLI. Set DSH_CLI (looked at: ${CLI_CANDIDATES.join(', ')}).`);
}

function clampTimeout(value) {
  const seconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_SEC;
  return Math.min(seconds, MAX_TIMEOUT_SEC);
}

async function runTask({ task, cwd, timeout_sec, sessionId, fresh, requestId }) {
  const workingDir = cwd && existsSync(cwd) ? cwd : DEFAULT_CWD;
  const timeoutMs = clampTimeout(timeout_sec) * 1000;
  const started = Date.now();

  let session = null;
  try {
    const picked = await runtime.sessionFor(workingDir, { fresh, sessionId });
    session = picked.session;
    if (requestId !== undefined) activeCalls.set(requestId, session.id);

    let result;
    try {
      result = await runtime.pool.prompt(session.id, task, { timeoutMs });
    } catch (error) {
      if (error instanceof AcpTimeoutError) {
        await runtime.pool.cancel(session.id).catch(() => {});
        runtime.lastByCwd.delete(workingDir);
      }
      throw error;
    }
    return {
      ok: true,
      sessionId: session.id,
      reused: picked.reused,
      workingDir,
      elapsedMs: Date.now() - started,
      ...result,
    };
  } finally {
    if (requestId !== undefined) activeCalls.delete(requestId);
    runtime.release(session);
  }
}

const activeCalls = new Map();

/* ------------------------------------------------------------------ rendering */

function renderFull(result) {
  const parts = [
    `dsh: ok in ${(result.elapsedMs / 1000).toFixed(1)}s (${result.workingDir})${result.reused ? ' [warm]' : ''}`,
    `session ${result.sessionId}`,
  ];
  if (result.tools?.length) parts.push(`tools used: ${result.tools.join(', ')}`);
  if (result.usage?.used != null) parts.push(`tokens: ${result.usage.used}`);
  parts.push('', result.text || '(no final answer)');
  return parts.join('\n');
}

function renderFailure(error, { workingDir, elapsedMs, sessionId }) {
  const seconds = (elapsedMs / 1000).toFixed(1);
  const parts = [`dsh: FAILED ${seconds}s (${workingDir})`];
  if (sessionId) parts.push(`session ${sessionId}`);

  if (error instanceof AcpTimeoutError) {
    parts.push('', '原因: 超时（已尝试取消该会话）');
    parts.push('可试: 提高 timeout_sec，或把任务拆小后重试');
  } else if (error instanceof AcpProcessError) {
    parts.push('', '原因: ACP 执行进程中断（桥会在下次调用时重启）');
    parts.push(`证据: ${String(error.message).split('\n').slice(0, 6).join(' ')}`);
    parts.push('可试: 直接重试一次；若连续失败，改用更小的任务定位');
  } else if (error instanceof AcpRpcError) {
    parts.push('', `原因: 执行器返回错误 ${error.code}`);
    parts.push(`证据: ${error.message}`);
    parts.push('可试: 按错误信息调整任务描述后重试一次');
  } else if (error instanceof AcpError) {
    parts.push('', `原因: ACP 协议错误`);
    parts.push(`证据: ${error.message}`);
    parts.push('可试: 重试一次；连续失败则检查 DSH 版本');
  } else {
    parts.push('', `原因: 桥内部错误`);
    parts.push(`证据: ${error?.message || String(error)}`);
  }

  parts.push(
    '',
    'NEXT: 先判断原因，改一版任务描述再试一次；仍失败就自己做，或把结论报告给用户。',
  );
  return parts.join('\n');
}

function renderSuccess(result, handle) {
  const parts = [
    `dsh: ok ${(result.elapsedMs / 1000).toFixed(1)}s (${result.workingDir})${result.reused ? ' [warm]' : ''}`,
    `session ${result.sessionId}`,
    `full output: ${handle} (read with dsh_read if needed)`,
  ];
  const answer = (result.text || '').trim();
  if (answer.length > SUMMARY_CHARS) {
    parts.push('', `${answer.slice(0, SUMMARY_CHARS)}…`, `[truncated at ${SUMMARY_CHARS} chars]`);
  } else {
    parts.push('', answer || '(no final answer)');
  }
  if (result.truncated) parts.push('', '[DSH output exceeded the bridge buffer; use dsh_read for the stored copy]');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ tools */

const TASK_PROPS = {
  task: {
    type: 'string',
    description:
      'Complete instruction for the DSH agent. State the goal, the paths involved, and how to verify success.',
  },
  cwd: {
    type: 'string',
    description: `Working directory for the run. Defaults to ${DEFAULT_CWD}.`,
  },
  timeout_sec: {
    type: 'integer',
    description: `Wall-clock limit in seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}).`,
  },
};

const TOOLS = [
  {
    name: 'dsh_run',
    description:
      'Execute a task on DeepSeek Harness and return a bounded summary. Sessions are reused per working directory, so follow-up work in the same repo starts warm. Use for real work: editing files, running builds/tests, browsing.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TASK_PROPS,
        fresh: {
          type: 'boolean',
          description: 'Force a brand-new DSH session instead of reusing the warm one for this directory.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_continue',
    description:
      'Continue an existing DSH session with a new instruction, keeping its files and context. Returns the same bounded summary as dsh_run.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id returned by a previous dsh_run (`session ...`).',
        },
        ...TASK_PROPS,
      },
      required: ['session_id', 'task'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_read',
    description:
      'Read the full stored output of an earlier run, one slice at a time. Only call this when the summary is genuinely insufficient — every call spends your context.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Handle printed as `full output: <handle>`.' },
        offset: { type: 'integer', description: 'Character offset to start from (default 0).' },
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

  const started = Date.now();
  const workingDir = args.cwd && existsSync(args.cwd) ? args.cwd : DEFAULT_CWD;

  try {
    const result = await runTask({
      task: args.task,
      cwd: args.cwd,
      timeout_sec: args.timeout_sec,
      sessionId,
      fresh: args.fresh === true,
      requestId: id,
    });
    const handle = storeResult(renderFull(result));
    reply(id, {
      content: [{ type: 'text', text: renderSuccess(result, handle) }],
      isError: false,
    });
  } catch (error) {
    if (error instanceof AcpProcessError) {
      log('runtime lost, resetting for the next call');
      await runtime.reset().catch(() => {});
    }
    reply(id, {
      content: [{ type: 'text', text: renderFailure(error, { workingDir, elapsedMs: Date.now() - started }) }],
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
      const target = activeCalls.get(params?.requestId);
      if (target) await runtime.pool?.cancel(target).catch(() => {});
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

process.stdin.on('end', async () => {
  await runtime.shutdown();
  process.exit(0);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => log('uncaught:', error?.stack || String(error)));
process.on('unhandledRejection', (error) => log('unhandled rejection:', error?.stack || String(error)));

log('ready');
