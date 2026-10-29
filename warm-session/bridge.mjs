#!/usr/bin/env node
/**
 * ACP-backed Codex <-> DSH bridge (warm-session, primary entry point).
 *
 * MCP outside, ACP inside:
 *
 *   Codex --MCP--> bridge.mjs --ACP--> dsh --profile acp (persistent)
 *                      |
 *                      +-- state/tasks.json     task_id -> session binding
 *                      +-- results/<handle>.md  complete streamed output
 *                      +-- logs/calls.jsonl     per-call timing record
 *
 * Revision 2026-10-27:
 * - sessions are bound to an explicit task_id, never auto-reused by cwd;
 * - bindings persist, so a bridge restart can `session/resume` a task;
 * - a single deadline covers startup, session create/resume, queueing, prompt;
 * - queued requests can be cancelled without cancelling the running prompt;
 * - the full answer is streamed to disk (no lost tail after the summary buffer);
 * - ACP updates become MCP progress notifications when the host supplies a token;
 * - every delegated call writes a JSONL timing record (bridge-side vs caller-side
 *   comparison is done by test/compare-latency.mjs).
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio, zero dependencies.
 */

import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AcpClient,
  AcpError,
  AcpProcessError,
  AcpProtocolError,
  AcpRpcError,
  AcpTimeoutError,
} from './lib/acp.mjs';
import {
  BridgeCancelledError,
  BridgeTimeoutError,
  BridgeUsageError,
  Deadline,
  withTimeout,
} from './lib/deadline.mjs';
import { createReverseHandler } from './lib/policy.mjs';
import { TaskRegistry } from './lib/registry.mjs';
import { ResultStore } from './lib/results.mjs';
import { SessionPool } from './lib/session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CWD = path.resolve(process.env.DSH_BRIDGE_CWD || process.cwd());
const CLI_CANDIDATES = [
  process.env.DSH_CLI,
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
  '/usr/local/bin/dsh',
  '/opt/homebrew/bin/dsh',
].filter(Boolean);

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
function ratio(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
}
function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(Math.floor(n), min), max);
}

const DEFAULT_TIMEOUT_SEC = positiveInt(process.env.DSH_BRIDGE_TIMEOUT_SEC, 900);
// Keep the bridge budget below the host's tool_timeout_sec (3600 in the current
// Codex config) so the bridge can return a clean classified error first.
const MAX_TIMEOUT_SEC = Math.min(positiveInt(process.env.DSH_BRIDGE_MAX_TIMEOUT_SEC, 3300), 7200);
const SUMMARY_CHARS = positiveInt(process.env.DSH_BRIDGE_SUMMARY_CHARS, 1500);
const STARTUP_TIMEOUT_MS = positiveInt(process.env.DSH_BRIDGE_STARTUP_TIMEOUT_MS, 30_000);
// Context usage ratio (used/size from ACP usage_update) that triggers a new
// session plus a short handoff summary for the same task.
const HANDOFF_RATIO = ratio(process.env.DSH_BRIDGE_HANDOFF_RATIO, 0.7);
const RESULTS_DIR = path.resolve(process.env.DSH_BRIDGE_RESULTS_DIR || path.join(HERE, 'results'));
const STATE_DIR = path.resolve(process.env.DSH_BRIDGE_STATE_DIR || path.join(HERE, 'state'));
const LOG_DIR = path.resolve(process.env.DSH_BRIDGE_LOG_DIR || path.join(HERE, 'logs'));
const TASK_LIST_LIMIT = 3;
const TASK_LIST_MAX = 5;
const DEFAULT_READ_CHARS = 4000;
const MAX_READ_CHARS = 8000;

const SERVER_INFO = { name: 'dsh-warm-session', version: '2.0.0' };

const INSTRUCTIONS = [
  'DSH executes while Codex decides. Use direct tools for simple reads, small edits, single commands',
  'and routine checks; delegate only substantial, well-scoped work.',
  'TASK BINDING: call dsh_run WITHOUT task_id for a new objective; the reply returns task=<id>.',
  'Reuse that task_id with dsh_continue for later implementation, tests and fixes of the SAME objective;',
  'never reuse a task_id for a different objective. dsh_run with an existing task_id continues that',
  'objective; fresh:true deliberately starts a new session for it (a short handoff is attached when',
  'history is long).',
  'Write tasks as reviewable increments and prefer artifacts on disk. In the final answer use',
  '## 改动 / ## 验证 / ## 未解决 / ## 下一步 and keep it concise: the bridge returns the first',
  `${SUMMARY_CHARS} chars and stores the complete text under a handle.`,
  'Use dsh_read only for evidence the summary is missing. Use dsh_tasks only when you explicitly need',
  'background from an old task; it returns at most a few compact candidates and never transcripts.',
  'Retry once only for recoverable transport failures; do not blindly retry a timeout. Permissions are',
  'answered fail-closed.',
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
function isoNow() {
  return new Date().toISOString();
}
function truncate(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
function oneLine(text, limit = 120) {
  return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), limit);
}
function firstLine(text, limit = 120) {
  const line = String(text ?? '')
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  return oneLine(line || '', limit);
}
function fmtSeconds(ms) {
  return (Math.max(0, ms) / 1000).toFixed(1);
}

/* ------------------------------------------------------------------- stores */

const registry = new TaskRegistry({ dir: STATE_DIR });
if (registry.loadError) {
  log(`registry unreadable, starting empty: ${registry.loadError.message}`);
}
const resultStore = new ResultStore({
  dir: RESULTS_DIR,
  defaultReadChars: DEFAULT_READ_CHARS,
  maxReadChars: MAX_READ_CHARS,
});

function appendCallLog(record) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(path.join(LOG_DIR, 'calls.jsonl'), `${JSON.stringify(record)}\n`);
  } catch (error) {
    log('call log write failed:', error?.message || String(error));
  }
}

/* ------------------------------------------------------------------ runtime */

class Runtime {
  constructor() {
    this.client = null;
    this.pool = null;
    this.starting = null;
  }

  async ensure(deadline) {
    if (this.client && this.pool && !this.client.terminalError) return this.pool;
    if (!this.starting) {
      this.starting = this.start(deadline).catch((error) => {
        this.starting = null;
        throw error;
      });
    }
    return this.starting;
  }

  async start(deadline) {
    const cli = findCli();
    const startupBudget = Math.min(STARTUP_TIMEOUT_MS, Math.max(1, deadline.remaining()));
    const client = new AcpClient({
      command: cli,
      args: ['--profile', 'acp'],
      cwd: DEFAULT_CWD,
      startupTimeoutMs: startupBudget,
      requestTimeoutMs: 60_000,
    });
    client.onReverseRequest(createReverseHandler({ allowPermission: false }));
    await withTimeout(client.start(), deadline.remaining(), 'startup', deadline);
    const info = await client.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      },
      { timeoutMs: Math.max(1, deadline.remaining()) },
    );
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
    if (client) await client.close().catch(() => {});
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
  throw new BridgeUsageError(
    `cannot locate the dsh CLI. Set DSH_CLI (looked at: ${CLI_CANDIDATES.join(', ')}).`,
  );
}

function clampTimeout(value) {
  const seconds = Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : DEFAULT_TIMEOUT_SEC;
  return Math.min(seconds, MAX_TIMEOUT_SEC);
}

function phaseBudget(deadline, phase) {
  const remaining = deadline.remaining();
  if (remaining <= 0) throw new BridgeTimeoutError(phase, deadline);
  return Math.max(1, Math.floor(remaining));
}

function throwIfAborted(call) {
  if (call.controller.signal.aborted) throw new BridgeCancelledError('host cancelled');
}

function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function usageRatio(usage) {
  if (!usage || !Number.isFinite(usage.used) || !Number.isFinite(usage.size) || usage.size <= 0) {
    return null;
  }
  return usage.used / usage.size;
}

/* --------------------------------------------------------------- binding */

function resolveBinding({ mode, args, requestedCwd, call }) {
  const goal = truncate(oneLine(args.goal || firstLine(args.task || ''), 200), 200);
  const taskIdArg = typeof args.task_id === 'string' ? args.task_id.trim() : '';
  const sessionIdArg = typeof args.session_id === 'string' ? args.session_id.trim() : '';

  if (mode === 'continue' && !taskIdArg && !sessionIdArg) {
    throw new BridgeUsageError('`dsh_continue` 需要 task_id 或 session_id');
  }
  if (mode === 'run' && sessionIdArg) {
    throw new BridgeUsageError('`dsh_run` 不接受 session_id；请用 dsh_continue 续接已有会话');
  }

  let binding = taskIdArg ? registry.get(taskIdArg) : null;
  if (!binding && sessionIdArg) binding = registry.findBySession(sessionIdArg);
  if (binding && sessionIdArg && binding.session_id && binding.session_id !== sessionIdArg) {
    throw new BridgeUsageError(
      `session_id 与 task_id 的绑定不一致：${binding.session_id} != ${sessionIdArg}`,
    );
  }

  const cwd = requestedCwd || (binding?.project ? path.resolve(binding.project) : DEFAULT_CWD);
  if (binding?.project && requestedCwd && path.resolve(binding.project) !== requestedCwd) {
    throw new BridgeUsageError(
      `task_id ${binding.task_id} 已绑定项目 ${binding.project}，与本次 cwd ${requestedCwd} 不一致。` +
        '不同目标请新建 task_id；同一目标请沿用原 cwd。',
    );
  }

  if (!binding) {
    const taskId = taskIdArg || registry.newTaskId(goal);
    binding = registry.upsert({
      task_id: taskId,
      goal,
      project: cwd,
      session_id: mode === 'continue' && sessionIdArg ? sessionIdArg : null,
      status: 'active',
      summary: '',
      turns: 0,
    });
  } else {
    let changed = false;
    if (goal && !binding.goal) {
      binding.goal = goal;
      changed = true;
    }
    if (mode === 'continue' && sessionIdArg && binding.session_id !== sessionIdArg) {
      binding.session_id = sessionIdArg;
      changed = true;
    }
    if (changed) binding = registry.upsert(binding);
  }

  call.taskId = binding.task_id;
  call.binding = binding;
  return { taskId: binding.task_id, binding, workingDir: cwd };
}

function updateBindingSuccess(binding, { sessionId, text, usage, cancelled, elapsedMs }) {
  const answer = String(text || '').trim();
  binding.session_id = sessionId;
  binding.status = 'active';
  binding.turns = (binding.turns || 0) + 1;
  binding.usage = usage ?? binding.usage ?? null;
  binding.summary = summarizeForBinding(answer);
  binding.last_elapsed_ms = Math.round(elapsedMs);
  binding.last_run_at = isoNow();
  binding.last_error = null;
  if (cancelled) binding.last_cancelled_at = isoNow();
  return registry.upsert(binding);
}

function updateBindingFailure(binding, error) {
  if (!binding) return null;
  const isUsage = error instanceof BridgeUsageError;
  binding.status = isUsage ? binding.status : 'failed';
  binding.failed_turns = (binding.failed_turns || 0) + 1;
  binding.last_error = {
    class: error?.name || 'Error',
    code: error?.code || null,
    phase: error?.phase || null,
    message: truncate(String(error?.message || error), 300),
    at: isoNow(),
  };
  if (!binding.summary) {
    binding.summary = `(上次调用失败: ${error?.code || error?.name || 'error'})`;
  }
  return registry.upsert(binding);
}

/** Compact summary persisted for handoff / retrieval. Never the transcript. */
function summarizeForBinding(answer) {
  const text = String(answer || '').trim();
  if (!text) return '';
  const headings = ['## 未解决', '## 改动', '## 验证', '## 下一步'];
  for (const heading of headings) {
    const index = text.indexOf(heading);
    if (index >= 0) {
      const block = text.slice(index, index + 1200).split(/\n## /)[0];
      return truncate(block.replace(/\s+/g, ' ').trim(), 500);
    }
  }
  return truncate(text.replace(/\s+/g, ' ').trim(), 500);
}

/* --------------------------------------------------------------- sessions */

async function ensureSession(binding, { fresh, deadline, call }) {
  const ensureStart = Date.now();
  const pool = await runtime.ensure(deadline);
  call.timings.ensure_ms = Date.now() - ensureStart;

  if (!fresh && binding.session_id) {
    const inMemory = pool.get(binding.session_id);
    if (inMemory && !inMemory.tainted) {
      return { session: inMemory, kind: 'reused', previousSession: binding.session_id };
    }
    if (inMemory?.tainted) {
      // Quarantined after a timeout; close it and try resume/new below.
      await pool.close(inMemory.id).catch(() => {});
    }
    const resumeStart = Date.now();
    try {
      const resumed = await pool.resume(binding.session_id, binding.project, {
        timeoutMs: phaseBudget(deadline, 'session-resume'),
      });
      call.timings.resume_ms = Date.now() - resumeStart;
      call.resumeError = null;
      return { session: resumed, kind: 'resumed', previousSession: binding.session_id };
    } catch (error) {
      call.timings.resume_ms = Date.now() - resumeStart;
      if (error instanceof AcpRpcError) {
        // Not resumable (cwd mismatch / already active / archived): fall back to
        // a new session rather than failing the user's task outright.
        call.resumeError = error.message;
        log(`resume failed (${error.code}): ${error.message}; opening a new session`);
      } else {
        throw error;
      }
    }
  }

  const previousSession = binding.session_id;
  if (previousSession) {
    await pool.close(previousSession).catch(() => {});
    binding.last_session_ids = [...(binding.last_session_ids || []), previousSession].slice(-5);
    binding.session_id = null;
    registry.upsert(binding);
  }
  const newStart = Date.now();
  const session = await pool.open(binding.project, {
    timeoutMs: phaseBudget(deadline, 'session-new'),
  });
  call.timings.session_new_ms = Date.now() - newStart;
  binding.session_id = session.id;
  registry.upsert(binding);
  return { session, kind: 'new', previousSession };
}

function buildHandoffPrompt(binding, task, previousSession) {
  return [
    '[handoff] 同一目标的会话交接。',
    `- task_id: ${binding.task_id}`,
    `- 目标: ${binding.goal || '(未记录)'}`,
    `- 上一个会话因上下文过长已封存: ${previousSession || '(unknown)'}`,
    `- 已知进展摘要: ${truncate((binding.summary || '(无)').replace(/\s+/g, ' '), 600)}`,
    `- 项目目录: ${binding.project}`,
    '请先核对工作区当前实际状态（不要相信摘要代替文件），再继续执行下面的任务：',
    '-----',
    String(task),
  ].join('\n');
}

/* ---------------------------------------------------------------- progress */

function makeProgressReporter(token, call) {
  let lastAt = 0;
  let seq = 0;
  return (info) => {
    call.progressSeen = (call.progressSeen || 0) + 1;
    if (token === undefined || token === null) return;
    const now = Date.now();
    if (now - lastAt < 700) return;
    lastAt = now;
    const message =
      info.type === 'tool'
        ? `DSH tool: ${truncate(info.name, 80)}`
        : `DSH output: ${info.totalChars ?? 0} chars`;
    try {
      send({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: token, progress: ++seq, message },
      });
      call.progressSent = (call.progressSent || 0) + 1;
    } catch {
      /* progress is best-effort; never break the call */
    }
  };
}

/* --------------------------------------------------------------- execution */

function isRecoverableTransportError(error) {
  return error instanceof AcpProcessError || error instanceof AcpProtocolError;
}

async function executeTask({ mode, args, call, deadline, progressToken }) {
  call.handle = resultStore.nextHandle();
  call.writer = resultStore.begin(call.handle);

  const requestedCwd = (() => {
    if (typeof args.cwd !== 'string' || !args.cwd.trim()) return null;
    const abs = path.resolve(args.cwd);
    if (!isDirectory(abs)) throw new BridgeUsageError(`cwd 不存在或不是目录: ${abs}`);
    return abs;
  })();

  let binding = null;
  let taskId = null;
  let retried = 0;

  try {
    ({ taskId, binding } = resolveBinding({ mode, args, requestedCwd, call }));
    if (!isDirectory(binding.project)) {
      throw new BridgeUsageError(`项目目录不存在或不是目录: ${binding.project}`);
    }
    throwIfAborted(call);

    const ratioNow = usageRatio(binding.usage);
    const handoff =
      args.fresh !== true &&
      !!binding.session_id &&
      (binding.turns || 0) > 0 &&
      ratioNow !== null &&
      ratioNow >= HANDOFF_RATIO;
    const fresh = args.fresh === true || handoff;

    for (;;) {
      try {
        const picked = await ensureSession(binding, { fresh, deadline, call });
        call.sessionId = picked.session.id;

        const promptText = handoff
          ? buildHandoffPrompt(binding, args.task, picked.previousSession)
          : String(args.task);

        call.phase = 'prompt';
        throwIfAborted(call);
        call.promptStarted = true;
        call.timings.prompt_started_at = Date.now();
        const result = await runtime.pool.prompt(picked.session.id, promptText, {
          deadline,
          signal: call.controller.signal,
          writer: call.writer,
          onStart: ({ queueWaitMs }) => {
            call.timings.queue_ms = Math.round(queueWaitMs);
          },
          onProgress: makeProgressReporter(progressToken, call),
        });
        call.timings.prompt_ms = Date.now() - call.timings.prompt_started_at;

        const status = result.cancelled ? 'CANCELLED' : 'ok';
        const header =
          `dsh: ${status} in ${fmtSeconds(deadline.elapsed())}s ` +
          `task=${taskId} session=${picked.session.id} ` +
          `(${handoff ? 'handoff' : picked.kind})`;
        const stored = call.writer.finish(header);
        call.stored = stored;
        call.fullChars = stored.bodyChars ?? 0;
        const answer = String(result.text || '').trim();
        call.summaryChars = Math.min(answer.length, SUMMARY_CHARS);

        updateBindingSuccess(binding, {
          sessionId: picked.session.id,
          text: result.text,
          usage: result.usage || picked.session.lastUsage,
          cancelled: result.cancelled,
          elapsedMs: deadline.elapsed(),
        });
        if (handoff) {
          binding.handoff_count = (binding.handoff_count || 0) + 1;
          binding.handoff_from = picked.previousSession;
          registry.upsert(binding);
        }

        call.status = result.cancelled ? 'cancelled' : 'ok';
        return {
          text: renderSuccess({ binding, result, picked, call, deadline, handoff }),
          isError: result.cancelled,
        };
      } catch (error) {
        const promptHadStarted = call.promptStarted === true;
        if (promptHadStarted && call.timings.prompt_started_at) {
          call.timings.prompt_ms = Date.now() - call.timings.prompt_started_at;
        }
        call.promptStarted = false;
        const recoverable =
          isRecoverableTransportError(error) &&
          !promptHadStarted &&
          retried < 1 &&
          deadline.remaining() > 1500;
        if (recoverable) {
          retried += 1;
          call.timings.retry = retried;
          log(`recoverable ${error.name}; resetting ACP and retrying once`);
          await runtime.reset().catch(() => {});
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    call.error = error;
    call.status = error instanceof BridgeCancelledError ? 'cancelled' : 'error';
    if (error instanceof AcpProcessError) {
      log('ACP process lost; resetting for the next call');
      await runtime.reset().catch(() => {});
    }
    updateBindingFailure(binding, error);
    const header =
      `dsh: FAILED in ${fmtSeconds(deadline.elapsed())}s ` +
      `task=${taskId || '(unbound)'}${call.sessionId ? ` session=${call.sessionId}` : ''} ` +
      `phase=${error?.phase || call.phase || 'unknown'}`;
    let stored = null;
    try {
      stored = call.writer?.finish(header) ?? null;
    } catch {
      stored = null;
    }
    call.stored = stored;
    call.fullChars = stored?.bodyChars ?? 0;
    return {
      text: renderFailure(error, { call, binding, handle: stored?.handle ?? null, deadline }),
      isError: true,
    };
  }
}

/* ---------------------------------------------------------------- rendering */

function renderSuccess({ binding, result, picked, call, deadline, handoff }) {
  const answer = String(result.text || '').trim();
  const lines = [
    `dsh: ok ${fmtSeconds(deadline.elapsed())}s task=${binding.task_id} session=${picked.session.id} ` +
      `[${handoff ? 'handoff' : picked.kind}]`,
  ];
  if (binding.goal) lines.push(`goal: ${oneLine(binding.goal, 140)}`);
  if (call.stored?.handle) {
    lines.push(
      `full output: ${call.stored.handle} (${call.stored.total} chars) — read only if the summary is missing evidence`,
    );
  }
  if (handoff) lines.push(`handoff: previous session ${picked.previousSession} was too long`);
  if (result.tools?.length) lines.push(`tools: ${result.tools.slice(0, 10).join(', ')}`);
  if (result.usage?.used != null) {
    partsUsage(lines, result.usage);
  }
  if (call.timings.queue_ms) lines.push(`queue: ${call.timings.queue_ms}ms`);
  if (result.cancelled) lines.push('状态: 已取消（会话保留，可继续）');
  lines.push('', answer ? truncate(answer, SUMMARY_CHARS) : '(no final answer)');
  if (answer.length > SUMMARY_CHARS) {
    lines.push(
      '',
      `[summary truncated at ${SUMMARY_CHARS} chars — full text in ${call.stored?.handle ?? 'the handle above'}]`,
    );
  }
  return lines.join('\n');
}

function partsUsage(lines, usage) {
  const size = Number.isFinite(usage.size) ? `/${usage.size}` : '';
  lines.push(`tokens: ${usage.used}${size}`);
}

function renderFailure(error, { call, binding, handle, deadline }) {
  const phase = error?.phase || call.phase || 'unknown';
  const lines = [
    `dsh: FAILED ${fmtSeconds(deadline.elapsed())}s task=${call.taskId || '(unbound)'}` +
      `${call.sessionId ? ` session=${call.sessionId}` : ''} phase=${phase}`,
  ];
  if (binding?.project) lines.push(`project: ${binding.project}`);
  if (handle) {
    lines.push(
      `partial output: ${handle} (${call.fullChars ?? 0} chars) — recoverable with dsh_read if useful`,
    );
  }
  if (call.timings?.retry) lines.push(`retry: ${call.timings.retry} recoverable transport retry`);

  if (error instanceof BridgeTimeoutError) {
    lines.push('', `原因: 超时（阶段=${error.phase}；预算=${error.budgetMs}ms；已尝试取消该轮）`);
    lines.push(
      '可试: 不要原样重试。把任务拆成更小的可验收步骤，或提高 timeout_sec；若卡在环境/网络操作，先让 DSH 做只读探测。',
    );
  } else if (error instanceof BridgeCancelledError) {
    lines.push('', `原因: 调用被取消（阶段=${error.phase}）`);
    lines.push('可试: 需要时重新发起；同一 task_id 的会话仍然保留。');
  } else if (error instanceof BridgeUsageError) {
    lines.push('', `原因: 参数/绑定错误 — ${error.message}`);
    lines.push('可试: 修正参数后重试；新目标请用新的 task_id（dsh_run 不传 task_id 即可）。');
  } else if (error instanceof AcpProcessError) {
    lines.push('', '原因: ACP 执行进程中断（桥已重置，下一次调用会重启 ACP）');
    lines.push(`证据: ${truncate(String(error.message).split('\n').slice(0, 4).join(' '), 400)}`);
    lines.push('可试: 仅在任务幂等时重试一次；否则先检查 DSH 是否仍在运行。');
  } else if (error instanceof AcpTimeoutError) {
    lines.push('', `原因: ACP 请求超时（阶段=${phase}）`);
    lines.push('可试: 检查 DSH 是否卡住；拆分任务或提高 timeout_sec。');
  } else if (error instanceof AcpRpcError) {
    lines.push('', `原因: 执行器返回错误 ${error.code}`);
    lines.push(`证据: ${truncate(error.message, 500)}`);
    lines.push('可试: 按错误信息调整任务/参数后重试一次；连续失败时用 dsh_tasks 找到旧任务继续或报告阻碍。');
  } else if (error instanceof AcpError) {
    lines.push('', '原因: ACP 协议错误');
    lines.push(`证据: ${truncate(error.message, 500)}`);
    lines.push('可试: 重试一次；连续失败则检查 DSH 版本与 profile。');
  } else {
    lines.push('', '原因: 桥内部错误');
    lines.push(`证据: ${truncate(String(error?.message || error), 500)}`);
  }

  lines.push(
    '',
    'NEXT: 判断故障类别再决定；不要对超时原样重试，不要伪造未验证的完成。',
  );
  return lines.join('\n');
}

/* ---------------------------------------------------------------- logging */

function logDelegatedCall(call, { status, error, resultMeta }) {
  const elapsed = Date.now() - call.startedAt;
  appendCallLog({
    ts: isoNow(),
    ts_ms: Date.now(),
    received_at: call.receivedAt,
    request_id: call.requestId,
    tool: call.tool,
    task_id: call.taskId || null,
    session_id: call.sessionId || null,
    project: call.binding?.project || null,
    status,
    phase: error?.phase || call.phase || null,
    error_class: error?.name || null,
    error_code: error?.code || null,
    error_message: error ? truncate(String(error.message), 500) : null,
    bridge_ms: elapsed,
    phases: {
      ensure_ms: call.timings.ensure_ms ?? null,
      resume_ms: call.timings.resume_ms ?? null,
      session_new_ms: call.timings.session_new_ms ?? null,
      queue_ms: call.timings.queue_ms ?? null,
      prompt_ms: call.timings.prompt_ms ?? null,
      retry: call.timings.retry ?? 0,
    },
    summary_chars: resultMeta?.summaryChars ?? null,
    full_chars: resultMeta?.fullChars ?? null,
    progress_sent: call.progressSent || 0,
    progress_seen: call.progressSeen || 0,
    deadline: call.deadline?.snapshot?.() ?? null,
  });
}

/* ------------------------------------------------------------------ tools */

const TASK_PROP = {
  task: {
    type: 'string',
    description:
      'Complete instruction for the DSH agent. State the goal, the paths involved, the acceptance check, and prefer artifacts on disk.',
  },
  goal: {
    type: 'string',
    description: 'Optional one-line objective stored with the task binding for later retrieval.',
  },
  cwd: {
    type: 'string',
    description: `Project directory. New tasks use it; continuing tasks must match the bound project. Defaults to ${DEFAULT_CWD}.`,
  },
  timeout_sec: {
    type: 'integer',
    description: `Wall-clock budget in seconds covering ACP startup, session create/resume, queueing and the prompt (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}).`,
  },
};

const TOOLS = [
  {
    name: 'dsh_run',
    description:
      'Execute a new objective (or continue an existing task_id) on DeepSeek Harness. The reply returns task=<id> and session=<id>, plus a bounded summary. Use for real work: editing files, running builds/tests, browsing.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TASK_PROP,
        task_id: {
          type: 'string',
          description:
            'Optional existing task binding. Omit for a new objective; reuse the returned task=<id> to continue the SAME objective.',
        },
        fresh: {
          type: 'boolean',
          description:
            'Deliberately start a new session for this task (handoff summary attached only when history is long).',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_continue',
    description:
      'Continue the session bound to a task_id (preferred) or to an existing session_id. Use for implementation, tests and fixes of the same objective; returns the same bounded summary as dsh_run.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'task=<id> returned by a previous dsh_run. Bindings are stored locally and can be resumed after a bridge restart.',
        },
        session_id: {
          type: 'string',
          description: 'Explicit ACP session id (from this bridge or the DSH sidebar). Prefer task_id when available.',
        },
        ...TASK_PROP,
        fresh: {
          type: 'boolean',
          description: 'Deliberately replace the session for this task (handoff attached only when history is long).',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_read',
    description:
      'Read the stored complete output of an earlier run, one slice at a time. Only call this when the summary is genuinely insufficient — every call spends your context.',
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
  {
    name: 'dsh_tasks',
    description:
      'Look up a small number of stored task bindings (task_id, goal, status, summary) only when you explicitly need background from an old task. Never returns transcripts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring matched against task_id, goal, summary and project.',
        },
        project: {
          type: 'string',
          description: 'Optional project directory filter (absolute path).',
        },
        limit: {
          type: 'integer',
          description: `Max candidates (1-${TASK_LIST_MAX}, default ${TASK_LIST_LIMIT}).`,
        },
      },
      additionalProperties: false,
    },
  },
];

/* --------------------------------------------------------------- dispatch */

const inflight = new Map(); // String(requestId) -> call

async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments || {};
  const progressToken = params?._meta?.progressToken ?? params?.progressToken;
  const call = {
    requestId: id,
    tool: name,
    receivedAt: isoNow(),
    startedAt: Date.now(),
    controller: new AbortController(),
    timings: {},
    phase: 'received',
    progressSent: 0,
    progressSeen: 0,
  };
  inflight.set(String(id), call);

  try {
    if (name === 'dsh_read') {
      return handleRead(id, args);
    }
    if (name === 'dsh_tasks') {
      return handleTasks(id, args);
    }
    if (name !== 'dsh_run' && name !== 'dsh_continue') {
      replyError(id, -32602, `unknown tool: ${name}`);
      return;
    }
    if (typeof args.task !== 'string' || !args.task.trim()) {
      replyError(id, -32602, '`task` must be a non-empty string');
      return;
    }
    if (name === 'dsh_continue') {
      const hasBinding =
        (typeof args.task_id === 'string' && args.task_id.trim()) ||
        (typeof args.session_id === 'string' && args.session_id.trim());
      if (!hasBinding) {
        replyError(id, -32602, '`dsh_continue` requires task_id or session_id');
        return;
      }
    }

    const mode = name === 'dsh_run' ? 'run' : 'continue';
    const deadline = new Deadline(clampTimeout(args.timeout_sec) * 1000, 'call');
    call.deadline = deadline;

    let outcome;
    try {
      outcome = await executeTask({ mode, args, call, deadline, progressToken });
    } catch (error) {
      // executeTask normally renders failures itself; this is a guard for
      // programmer errors before the writer exists.
      outcome = {
        text: `dsh: FAILED before execution: ${error?.message || error}`,
        isError: true,
      };
    }
    reply(id, { content: [{ type: 'text', text: outcome.text }], isError: outcome.isError });
    logDelegatedCall(call, {
      status: call.status || (outcome.isError ? 'error' : 'ok'),
      error: call.error ?? null,
      resultMeta: {
        summaryChars: call.summaryChars ?? null,
        fullChars: call.fullChars ?? null,
      },
    });
  } catch (error) {
    log('tool call crashed:', error?.stack || String(error));
    try {
      reply(id, {
        content: [{ type: 'text', text: `dsh: bridge error: ${error?.message || error}` }],
        isError: true,
      });
    } catch {
      /* ignore */
    }
  } finally {
    inflight.delete(String(id));
  }
}

async function handleRead(id, args) {
  try {
    const { slice, total, start, end } = resultStore.read(args.handle, args.offset, args.max_chars);
    const header = `dsh_read ${args.handle} [${start}..${end}/${total}]${
      end < total ? ' — pass offset to continue' : ''
    }`;
    reply(id, { content: [{ type: 'text', text: `${header}\n\n${slice}` }], isError: false });
  } catch (error) {
    reply(id, {
      content: [{ type: 'text', text: `dsh_read failed: ${error?.message || error}` }],
      isError: true,
    });
  }
}

async function handleTasks(id, args) {
  try {
    const limit = clamp(args.limit ?? TASK_LIST_LIMIT, 1, TASK_LIST_MAX);
    const matches = registry.search({ query: args.query, project: args.project, limit });
    const text = matches.length
      ? [
          `task bindings (${matches.length} shown, capped at ${limit}):`,
          ...matches.map(
            (task) =>
              `- task=${task.task_id} status=${task.status} project=${task.project} updated=${task.updated_at}` +
              `${task.goal ? `\n  goal: ${oneLine(task.goal, 160)}` : ''}` +
              `${task.summary ? `\n  summary: ${oneLine(task.summary, 200)}` : ''}`,
          ),
          '',
          'Use dsh_continue with the task_id to continue that session; do not replay transcripts.',
        ].join('\n')
      : 'no matching task bindings';
    reply(id, { content: [{ type: 'text', text }], isError: false });
  } catch (error) {
    reply(id, {
      content: [{ type: 'text', text: `dsh_tasks failed: ${error?.message || error}` }],
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
      const target = inflight.get(String(params?.requestId));
      if (target) {
        target.cancelRequested = true;
        target.controller.abort(new BridgeCancelledError('host cancelled'));
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
