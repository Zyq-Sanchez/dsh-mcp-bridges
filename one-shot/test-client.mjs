#!/usr/bin/env node
/**
 * Minimal MCP client used to verify the bridge without spending Codex quota.
 *
 *   node test-client.mjs              # handshake + tools/list only
 *   node test-client.mjs --run "task" # also exercise dsh_run end to end
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'bridge.mjs');
const args = process.argv.slice(2);
const runIndex = args.indexOf('--run');
const task = runIndex === -1 ? null : args[runIndex + 1];

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
child.stdout.setEncoding('utf8');

let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else {
      console.log('← notification', JSON.stringify(message).slice(0, 200));
    }
  }
});

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'bridge-test', version: '0.0.0' },
});
console.log('initialize →', JSON.stringify(init.result, null, 2));

notify('notifications/initialized', {});
const tools = await request('tools/list', {});
console.log('tools →', JSON.stringify(tools.result, null, 2));

if (task) {
  const started = Date.now();
  const call = await request('tools/call', { name: 'dsh_run', arguments: { task } });
  console.log(`\n===== tools/call dsh_run (${((Date.now() - started) / 1000).toFixed(1)}s) =====`);
  console.log('isError:', call.result?.isError ?? false);
  const replyText = call.result?.content?.[0]?.text ?? '';
  console.log(replyText);
  console.log(`\n[reply size: ${replyText.length} chars]`);

  const handle = /full output: (run-[a-z0-9]+-\d+)/.exec(replyText)?.[1];
  if (handle) {
    const read = await request('tools/call', { name: 'dsh_read', arguments: { handle, max_chars: 400 } });
    console.log('\n===== tools/call dsh_read =====');
    console.log('isError:', read.result?.isError ?? false);
    console.log(read.result?.content?.[0]?.text ?? '');
  }
}

child.stdin.end();
child.kill('SIGTERM');
