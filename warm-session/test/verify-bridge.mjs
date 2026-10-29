#!/usr/bin/env node
/**
 * End-to-end verification of the ACP-backed bridge over MCP.
 * Requires a real DSH installation and costs a few small model calls.
 *
 *   node test/verify-bridge.mjs
 *
 * The 2026-10-27 revision keeps all DSH calls paused by default. Run this only
 * when DSH execution has been explicitly allowed for the round.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, '..', 'bridge.mjs');

if (process.env.DSH_ALLOW_REAL !== '1') {
  console.log('Real DSH calls are paused for this round; set DSH_ALLOW_REAL=1 to run.');
  process.exit(0);
}

const child = spawn(process.execPath, [BRIDGE], {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: path.join(HERE, '..'),
});
child.stdout.setEncoding('utf8');

let buffer = '';
let nextId = 1;
const pending = new Map();

child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      entry(message);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'verify', version: '0' },
});
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

async function call(name, args) {
  const at = Date.now();
  const res = await request('tools/call', { name, arguments: args });
  return {
    text: res.result.content[0].text,
    isError: res.result.isError === true,
    seconds: (Date.now() - at) / 1000,
  };
}

const taskIdOf = (text) => /task=(\S+)/.exec(text)?.[1];
const sessionOf = (text) => /session=(\S+)/.exec(text)?.[1];

const rows = [];

const first = await call('dsh_run', { task: '只回复：ONE。不要调用任何工具。' });
rows.push(['run #1 (new task)', first.seconds, first.isError, taskIdOf(first.text), sessionOf(first.text)]);

const second = await call('dsh_run', { task: '只回复：TWO。不要调用任何工具。' });
rows.push(['run #2 (new task, same cwd)', second.seconds, second.isError, taskIdOf(second.text), sessionOf(second.text)]);

const continued = await call('dsh_continue', {
  task_id: taskIdOf(first.text),
  task: '只回复：THREE。不要调用任何工具。',
});
rows.push(['continue same task_id', continued.seconds, continued.isError, taskIdOf(continued.text), sessionOf(continued.text)]);

const timedOut = await call('dsh_run', { task: '先 sleep 20，再回复 DONE。', timeout_sec: 1 });
rows.push(['run #3 (timeout 1s)', timedOut.seconds, timedOut.isError, taskIdOf(timedOut.text), sessionOf(timedOut.text)]);

const recovered = await call('dsh_continue', {
  task_id: taskIdOf(first.text),
  task: '只回复：FOUR。不要调用任何工具。',
});
rows.push(['continue after timeout', recovered.seconds, recovered.isError, taskIdOf(recovered.text), sessionOf(recovered.text)]);

console.log('\nscenario                    seconds  isError  task / session');
for (const [name, seconds, isError, taskId, session] of rows) {
  console.log(
    `${name.padEnd(28)} ${seconds.toFixed(1).padStart(7)}  ${String(isError).padEnd(7)}  ${taskId ?? '-'} / ${session ?? '-'}`,
  );
}

assert.equal(first.isError, false, 'run #1 should succeed');
assert.equal(second.isError, false, 'run #2 should succeed');
assert.notEqual(taskIdOf(first.text), taskIdOf(second.text), 'new objectives must not share a task_id');
assert.notEqual(sessionOf(first.text), sessionOf(second.text), 'new objectives must not share a session');
assert.equal(continued.isError, false, 'continue should succeed');
assert.equal(taskIdOf(continued.text), taskIdOf(first.text), 'continue should keep the task_id');
assert.equal(sessionOf(continued.text), sessionOf(first.text), 'continue should reuse the bound session');
assert.equal(timedOut.isError, true, 'run #3 should time out');
assert.match(timedOut.text, /超时/, 'run #3 should report a timeout');
assert.equal(recovered.isError, false, 'continue after timeout should recover');

console.log('\nall assertions passed');
child.stdin.end();
await new Promise((resolve) => child.once('close', resolve));
process.exit(0);
