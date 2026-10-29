#!/usr/bin/env node
/**
 * Zero-model MCP stdio benchmark. No tools/call is ever sent, so this does not
 * start DSH, make model requests, or spend model tokens.
 *
 *   node test/benchmark-transport.mjs
 *
 * Timings cover this local child-process connection only, not the Codex host,
 * approval/dispatch overhead, a network connection, or model inference.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_FRAME_CHARS = 1_000_000;
const REQUEST_METHODS = new Set(['initialize', 'ping', 'tools/list']);
const VARIANTS = [
  { name: 'text-only', tools: ['dsh_think'] },
  { name: 'one-shot', tools: ['dsh_run', 'dsh_continue', 'dsh_read'] },
  { name: 'warm-session', tools: ['dsh_run', 'dsh_continue', 'dsh_read', 'dsh_tasks'] },
];

const roundMs = (value) => Number(value.toFixed(3));

async function benchmark({ name, tools: expectedTools }) {
  const started = performance.now();
  const child = spawn(process.execPath, [path.join(ROOT, name, 'bridge.mjs')], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  let terminalError = null;
  let closed = false;
  let resolveClose;
  const closePromise = new Promise((resolve) => { resolveClose = resolve; });

  function fail(error) {
    terminalError ??= error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }

  child.on('error', () => fail(new Error(`${name}: bridge failed to start`)));
  child.on('close', () => {
    closed = true;
    fail(new Error(`${name}: bridge exited before a response`));
    resolveClose();
  });
  child.stdin.on('error', () => fail(new Error(`${name}: bridge stdin closed`)));
  // Drain diagnostics without printing inherited environment or stderr values.
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      if (newline > MAX_FRAME_CHARS) {
        fail(new Error(`${name}: oversized MCP response`));
        child.kill('SIGTERM');
        return;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
        assert.equal(message.jsonrpc, '2.0');
      } catch {
        fail(new Error(`${name}: invalid JSON-RPC response`));
        return;
      }
      const item = pending.get(message.id);
      if (!item) continue;
      clearTimeout(item.timer);
      pending.delete(message.id);
      if (message.error) {
        item.reject(new Error(`${name}: ${item.method} failed with RPC code ${message.error.code}`));
      } else {
        item.resolve({ result: message.result, elapsedMs: performance.now() - item.started });
      }
    }
    if (buffer.length > MAX_FRAME_CHARS) {
      fail(new Error(`${name}: oversized MCP response`));
      child.kill('SIGTERM');
    }
  });

  function request(method, params = {}) {
    assert.ok(REQUEST_METHODS.has(method), 'Only non-model protocol methods are allowed');
    if (terminalError) return Promise.reject(terminalError);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const item = { method, started: performance.now(), resolve, reject };
      item.timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${name}: ${method} timed out after ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, item);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async function cleanup() {
    if (closed) return;
    child.stdin.end();
    const terminate = setTimeout(() => child.kill('SIGTERM'), 500);
    const force = setTimeout(() => child.kill('SIGKILL'), 1_500);
    try {
      await closePromise;
    } finally {
      clearTimeout(terminate);
      clearTimeout(force);
    }
  }

  try {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-transport-benchmark', version: '1.0.0' },
    });
    const initializeMs = performance.now() - started;
    assert.ok(init.result?.serverInfo?.name, `${name}: missing server info`);
    const instructions = init.result.instructions ?? '';
    assert.equal(typeof instructions, 'string');
    for (const forced of ['For any task that needs', 'instead of doing the work with your own tools']) {
      assert.ok(!instructions.includes(forced), `${name}: instructions still force delegation`);
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const pingMs = [];
    for (let i = 0; i < 3; i++) {
      const ping = await request('ping');
      assert.deepEqual(ping.result, {}, `${name}: unexpected ping result`);
      pingMs.push(ping.elapsedMs);
    }
    const listed = await request('tools/list');
    const tools = listed.result?.tools?.map((tool) => tool.name);
    assert.deepEqual(tools?.slice().sort(), expectedTools.slice().sort(), `${name}: unexpected tools`);
    return {
      variant: name,
      server: init.result.serverInfo,
      initializeIncludingSpawnMs: roundMs(initializeMs),
      pingMs: pingMs.map(roundMs),
      pingMedianMs: roundMs(pingMs.slice().sort((a, b) => a - b)[1]),
      toolsListMs: roundMs(listed.elapsedMs),
      instructionsChars: instructions.length,
      tools,
      checks: 'PASS',
    };
  } finally {
    await cleanup();
  }
}

try {
  const results = [];
  // Sequential runs keep startup measurements from competing with each other.
  for (const variant of VARIANTS) results.push(await benchmark(variant));
  console.log(JSON.stringify({ scope: 'local stdio; zero model calls', results }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
