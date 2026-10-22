#!/usr/bin/env node
/**
 * Minimal MCP client for the text-only bridge.
 *
 *   node test-client.mjs                 # handshake + tools/list
 *   node test-client.mjs --ask           # one real dsh_think call
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(HERE, 'bridge.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
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
  clientInfo: { name: 'variant-a-test', version: '0.0.0' },
});
console.log('initialize →', JSON.stringify(init.result.serverInfo));

notify('notifications/initialized', {});
const tools = await request('tools/list', {});
console.log('tools →', tools.result.tools.map((t) => t.name).join(', '));

if (process.argv.includes('--ask')) {
  const started = Date.now();
  const call = await request('tools/call', {
    name: 'dsh_think',
    arguments: {
      instruction: '用一个自然段说明这段代码在做什么，并指出一个潜在问题。',
      material: [
        'def read_config(path):',
        '    with open(path) as f:',
        '        return json.load(f)',
        '',
        'cfg = read_config("config.json")',
        'timeout = cfg.get("timeout", 30)',
      ].join('\n'),
    },
  });
  console.log(`\n===== dsh_think (${((Date.now() - started) / 1000).toFixed(1)}s) =====`);
  console.log('isError:', call.result?.isError ?? false);
  console.log(call.result?.content?.[0]?.text ?? '');
}

child.stdin.end();
child.kill('SIGTERM');
