#!/usr/bin/env node
/**
 * Variant A — text-only bridge.
 *
 * Codex keeps every local capability (reading files, running commands, browsing).
 * DSH is used strictly as a text-processing engine: Codex pastes material in,
 * DSH analyses it and returns a short answer. DSH runs with every file, shell,
 * web and agent tool disabled by profile.patch.yml, so it *cannot* touch the
 * machine and therefore never asks for permission.
 *
 * MCP stdio server, newline-delimited JSON-RPC 2.0, zero dependencies.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_PATCH = path.join(HERE, 'profile.patch.yml');
const CLI_CANDIDATES = [
  process.env.DSH_CLI,
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
  '/usr/local/bin/dsh',
  '/opt/homebrew/bin/dsh',
].filter(Boolean);

const DEFAULT_TIMEOUT_SEC = Number(process.env.DSH_THINK_TIMEOUT_SEC || 300);
const MAX_TIMEOUT_SEC = 1800;
const ANSWER_BUDGET = Number(process.env.DSH_THINK_BUDGET_CHARS || 6000);

const SERVER_INFO = { name: 'dsh-text-only', version: '1.0.0' };
const INSTRUCTIONS = [
  'Optional DSH text analysis for substantial reviews, summaries or writing tasks.',
  'Answer trivial questions directly; delegation adds a model round trip. This engine has no file,',
  'shell, web or agent tools. Supply only the relevant excerpts in material and request a concise',
  'answer. Retry once only for a recoverable failure; otherwise answer directly or report the blocker.',
].join(' ');

/* ------------------------------------------------------------------ plumbing */

const children = new Set();

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
  process.stderr.write(`[dsh-text-only] ${parts.join(' ')}\n`);
}

/* --------------------------------------------------------------- tool schema */

const TOOL = {
  name: 'dsh_think',
  description:
    'Ask DeepSeek Harness to analyse supplied text. The engine has NO tools: it cannot read files, run commands or browse — you must paste everything it needs into `material`. Returns a compact, structured answer. Use it for review, explanation, summarisation, design critique and writing; use your own tools for anything that changes the repository.',
  inputSchema: {
    type: 'object',
    properties: {
      instruction: {
        type: 'string',
        description: 'What to do with the material. Be specific about the output you want.',
      },
      material: {
        type: 'string',
        description:
          'The text to analyse: excerpts, diffs, logs, specs. Everything the engine may use must be here.',
      },
      timeout_sec: {
        type: 'integer',
        description: `Wall-clock limit in seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}).`,
      },
    },
    required: ['instruction', 'material'],
    additionalProperties: false,
  },
};

/* ------------------------------------------------------------------ execution */

function findCli() {
  for (const candidate of CLI_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `cannot locate the dsh CLI. Set DSH_CLI (looked at: ${CLI_CANDIDATES.join(', ')}).`,
  );
}

function clampTimeout(value) {
  const seconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_SEC;
  return Math.min(seconds, MAX_TIMEOUT_SEC);
}

function buildPrompt(instruction, material) {
  return [
    'You are a text-only analysis engine.',
    'You have no tools: no file access, no shell, no web, no subagents.',
    'Everything you may use is inside MATERIAL. Never claim you will read a file or run a command.',
    '',
    'Answer format:',
    '结论: <one sentence>',
    '依据: <2-4 bullets grounded in MATERIAL>',
    '风险: <gaps, uncertainties, or "none">',
    '',
    'INSTRUCTION:',
    instruction,
    '',
    'MATERIAL:',
    '"""',
    material,
    '"""',
  ].join('\n');
}

function parseEvents(stdout) {
  let sessionId;
  let finalText;
  let failure;
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
  }
  return { sessionId, finalText, failure };
}

function tail(text, lines = 12, bytes = 2000) {
  const sliced = text.split('\n').slice(-lines).join('\n').trim();
  return sliced.length > bytes ? `…${sliced.slice(-bytes)}` : sliced;
}

async function runThink({ instruction, material, timeout_sec }) {
  const cli = findCli();
  const args = [];
  if (existsSync(PROFILE_PATCH)) args.push('--patch', PROFILE_PATCH);
  args.push('--profile', 'headless', '--json');

  const child = spawn(cli, args, {
    cwd: process.env.DSH_THINK_CWD || HERE,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, DSH_TEXT_ONLY: '1' },
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
  child.stdin.on('error', () => {});
  child.stdin.end(buildPrompt(instruction, material));

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
  }, clampTimeout(timeout_sec) * 1000);

  const exit = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, spawnError: error }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  children.delete(child);

  const parsed = parseEvents(stdout);
  const ok = exit.code === 0 && !parsed.failure && !timedOut;
  return { ok, ...parsed, ...exit, stderr, timedOut };
}

function render(result) {
  if (result.ok) {
    const answer = (result.finalText || '(empty answer)').trim();
    return answer.length > ANSWER_BUDGET
      ? `${answer.slice(0, ANSWER_BUDGET)}\n\n[truncated at ${ANSWER_BUDGET} chars]`
      : answer;
  }
  const parts = ['dsh_think: FAILED'];
  if (result.timedOut) parts.push('reason: timed out and was killed');
  if (result.spawnError) parts.push(`reason: ${result.spawnError.message}`);
  if (!result.timedOut && result.code != null) parts.push(`exit code: ${result.code}`);
  if (result.failure) parts.push(`error: ${result.failure}`);
  const err = tail(result.stderr);
  if (err) parts.push('--- stderr tail ---', err);
  parts.push('NEXT: retry once only if a changed request can resolve the failure; otherwise answer directly or report the blocker.');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ dispatch */

async function handleToolCall(id, params) {
  if (params?.name !== 'dsh_think') {
    replyError(id, -32602, `unknown tool: ${params?.name}`);
    return;
  }
  const args = params?.arguments || {};
  if (typeof args.instruction !== 'string' || !args.instruction.trim()) {
    replyError(id, -32602, '`instruction` must be a non-empty string');
    return;
  }
  if (typeof args.material !== 'string' || !args.material.trim()) {
    replyError(id, -32602, '`material` must be a non-empty string');
    return;
  }

  try {
    const result = await runThink(args);
    reply(id, { content: [{ type: 'text', text: render(result) }], isError: !result.ok });
  } catch (error) {
    log('execution failed:', error?.message || String(error));
    reply(id, {
      content: [{ type: 'text', text: `dsh_think: could not start: ${error?.message || error}` }],
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
      reply(id, { tools: [TOOL] });
      return;
    case 'tools/call':
      await handleToolCall(id, params);
      return;
    case 'notifications/cancelled':
      for (const child of children) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
      return;
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
