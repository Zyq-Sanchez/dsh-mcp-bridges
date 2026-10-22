#!/usr/bin/env node
/**
 * Fake ACP agent for tests. No model, no DSH, no network.
 *
 *   --scenario normal|slow|weird|death
 *   --record <path>   writes received reverse-request answers as JSON
 */

import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const scenario = argv.includes('--scenario') ? argv[argv.indexOf('--scenario') + 1] : 'normal';
const recordPath = argv.includes('--record') ? argv[argv.indexOf('--record') + 1] : null;

const record = { scenario, permission: null, weird: null, prompts: [] };
const pendingReverse = new Map();
let reverseSeq = 900;
let wrote = false;

function flush() {
  if (!recordPath || wrote) return;
  wrote = true;
  try {
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
  } catch {
    /* ignore */
  }
}
process.on('exit', flush);
process.on('SIGTERM', () => {
  flush();
  process.exit(0);
});
process.on('SIGINT', () => {
  flush();
  process.exit(0);
});

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function update(sessionId, payload) {
  write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: payload } });
}

function askReverse(method, params) {
  const id = ++reverseSeq;
  write({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => pendingReverse.set(id, resolve));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handlePrompt(message) {
  const sessionId = message.params?.sessionId;
  record.prompts.push(message.params?.prompt);

  for (const chunk of ['hel', 'lo', '!']) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
    await sleep(5);
  }
  update(sessionId, { sessionUpdate: 'tool_call', title: 'write' });
  update(sessionId, { sessionUpdate: 'usage_update', used: 42, size: 1000 });

  if (scenario === 'weird') {
    record.weird = await askReverse('session/weird_request', {});
  } else {
    record.permission = await askReverse('session/request_permission', {
      sessionId,
      toolCall: { title: 'write demo.txt' },
      options: [
        { optionId: 'allow-1', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject-1', kind: 'reject_once', name: 'Reject' },
      ],
    });
  }

  if (scenario === 'slow') await sleep(500);
  if (scenario === 'death') {
    flush();
    process.exit(1);
  }

  flush();
  write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
}

function handle(message) {
  const hasMethod = typeof message.method === 'string';
  const isResponse = !hasMethod && message.id !== undefined;

  if (isResponse) {
    const resolve = pendingReverse.get(message.id);
    if (resolve) {
      pendingReverse.delete(message.id);
      resolve(message.error ? { error: message.error } : message.result);
    }
    return;
  }

  switch (message.method) {
    case 'initialize':
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'fake-acp', version: '1.0.0' },
          agentCapabilities: {},
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
      });
      return;
    case 'session/new':
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          sessionId: 'fake-session-1',
          configOptions: [
            { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fake-model' },
          ],
        },
      });
      return;
    case 'session/prompt':
      void handlePrompt(message);
      return;
    case 'session/close':
      write({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    default:
      write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* ignore malformed */
    }
  }
});
process.stdin.on('end', () => {
  flush();
  process.exit(0);
});
