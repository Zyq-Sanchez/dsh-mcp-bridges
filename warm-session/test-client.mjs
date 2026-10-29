#!/usr/bin/env node
/**
 * Minimal MCP client for the ACP-backed bridge.
 *
 *   node test-client.mjs                          # handshake + tools/list
 *   node test-client.mjs --run "create demo.txt"  # task binding + continue + read
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(HERE, 'bridge.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env },
});
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
  clientInfo: { name: 'warm-session-test', version: '0.0.0' },
});
console.log('server:', JSON.stringify(init.result.serverInfo));

notify('notifications/initialized', {});
const tools = await request('tools/list', {});
console.log('tools:', tools.result.tools.map((t) => t.name).join(', '));

const task = process.argv.includes('--run') ? process.argv[process.argv.indexOf('--run') + 1] : null;

if (task) {
  const first = await request('tools/call', { name: 'dsh_run', arguments: { task } });
  console.log('\n===== dsh_run (new objective) =====');
  console.log(first.result.content[0].text);

  const taskId = /task=(\S+)/.exec(first.result.content[0].text)?.[1];
  const handle = /full output: (run-[a-z0-9]+-\d+)/.exec(first.result.content[0].text)?.[1];

  if (taskId) {
    const second = await request('tools/call', {
      name: 'dsh_continue',
      arguments: { task_id: taskId, task: '只回复一个字：收到。不要调用任何工具。' },
    });
    console.log('\n===== dsh_continue (same task_id) =====');
    console.log(second.result.content[0].text);

    const lookup = await request('tools/call', {
      name: 'dsh_tasks',
      arguments: { query: taskId, limit: 1 },
    });
    console.log('\n===== dsh_tasks =====');
    console.log(lookup.result.content[0].text);

    if (handle) {
      const read = await request('tools/call', {
        name: 'dsh_read',
        arguments: { handle, max_chars: 260 },
      });
      console.log('\n===== dsh_read =====');
      console.log(read.result.content[0].text);
    }
  }
}

child.stdin.end();
setTimeout(() => child.kill('SIGTERM'), 500);
