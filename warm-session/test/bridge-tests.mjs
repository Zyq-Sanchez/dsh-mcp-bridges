#!/usr/bin/env node
/**
 * End-to-end MCP tests for the warm-session bridge, with a fake ACP agent.
 * No model, no DSH, no network.
 *
 *   node test/bridge-tests.mjs
 *
 * Covers: task binding (no cwd auto-reuse), resume across bridge restart,
 * handoff on long history, summary/long-output recovery, progress
 * notifications, deadline classification, cancellation, logs and dsh_tasks.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, '..', 'bridge.mjs');
const FAKE = path.join(HERE, 'fake-acp.mjs');

const temp = mkdtempSync(path.join(tmpdir(), 'bridge-tests-'));
const project = path.join(temp, 'project');
const otherProject = path.join(temp, 'other-project');
const stateDir = path.join(temp, 'state');
const resultsDir = path.join(temp, 'results');
const logDir = path.join(temp, 'logs');
const recordPath = path.join(temp, 'fake-record.json');
const fakeState = path.join(temp, 'fake-state.json');
mkdirSync(project, { recursive: true });
mkdirSync(otherProject, { recursive: true });

const launcher = path.join(temp, 'fake-dsh');
writeFileSync(
  launcher,
  `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`,
  'utf8',
);
chmodSync(launcher, 0o755);

const bridgeEnv = {
  DSH_CLI: launcher,
  DSH_BRIDGE_CWD: project,
  DSH_BRIDGE_STATE_DIR: stateDir,
  DSH_BRIDGE_RESULTS_DIR: resultsDir,
  DSH_BRIDGE_LOG_DIR: logDir,
  DSH_BRIDGE_STARTUP_TIMEOUT_MS: '5000',
  FAKE_ACP_SCENARIO: 'normal',
  FAKE_ACP_RECORD: recordPath,
  FAKE_ACP_STATE: fakeState,
};

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
function readRecord() {
  return readJson(recordPath);
}
function readLog() {
  const file = path.join(logDir, 'calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

class BridgeClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = '';
    this.nextId = 1;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
  }

  static async start(env = bridgeEnv) {
    const child = spawn(process.execPath, [BRIDGE], {
      cwd: project,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const client = new BridgeClient(child);
    await client.waitReady();
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'bridge-tests', version: '0' },
    });
    client.notify('notifications/initialized', {});
    return client;
  }

  waitReady() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`bridge did not start: ${this.stderr}`)), 8000);
      const check = () => {
        if (this.stderr.includes('[dsh-warm-session] ready')) {
          clearTimeout(timer);
          resolve();
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && message.id !== null && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      } else if (message.method) {
        this.notifications.push(message);
      }
    }
  }

  send(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timed out: ${method}\nstderr:\n${this.stderr}`));
      }, 20_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return { id, promise };
  }

  request(method, params) {
    return this.send(method, params).promise;
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  startCall(name, args, { progressToken } = {}) {
    const params = { name, arguments: args };
    if (progressToken !== undefined) params._meta = { progressToken };
    const { id, promise } = this.send('tools/call', params);
    return { id, promise };
  }

  async call(name, args, { progressToken } = {}) {
    const message = await this.startCall(name, args, { progressToken }).promise;
    assert.ok(message.result, `tool error: ${JSON.stringify(message.error)}`);
    const content = message.result.content?.[0]?.text ?? '';
    return { text: content, isError: message.result.isError === true };
  }

  progressFor(token) {
    return this.notifications.filter(
      (note) => note.method === 'notifications/progress' && note.params?.progressToken === token,
    );
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    const closed = new Promise((resolve) => this.child.once('close', resolve));
    this.child.kill('SIGTERM');
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
}

function taskAndSession(text) {
  return {
    task: /task=(\S+)/.exec(text)?.[1] ?? null,
    session: /session=(\S+)/.exec(text)?.[1] ?? null,
  };
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.stack?.split('\n').slice(0, 6).join('\n       ') ?? error}`);
  }
}

const client = await BridgeClient.start();

try {
  console.log('MCP bridge tests');

  await test('tools/list exposes run/continue/read/tasks', async () => {
    const message = await client.request('tools/list', {});
    const names = message.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['dsh_continue', 'dsh_read', 'dsh_run', 'dsh_tasks']);
  });

  let first = null;
  await test('dsh_run without task_id creates a task + new session', async () => {
    first = await client.call('dsh_run', {
      task: 'say hello [[noperm]]',
      goal: 'hello task',
      cwd: project,
    });
    assert.equal(first.isError, false);
    const ids = taskAndSession(first.text);
    assert.ok(ids.task, `missing task in: ${first.text}`);
    assert.ok(ids.session, `missing session in: ${first.text}`);
    assert.match(first.text, /\[new\]/);
    assert.match(first.text, /hello!/);
    assert.match(first.text, /## |full output: run-/);
  });

  await test('same task_id continues the same session via dsh_run and dsh_continue', async () => {
    const ids = taskAndSession(first.text);
    const viaRun = await client.call('dsh_run', {
      task: 'continue same objective [[noperm]]',
      task_id: ids.task,
    });
    assert.equal(viaRun.isError, false);
    assert.match(viaRun.text, /\[reused\]/);
    assert.equal(taskAndSession(viaRun.text).session, ids.session);

    const viaContinue = await client.call('dsh_continue', {
      task_id: ids.task,
      task: 'test/fix follow-up [[noperm]]',
    });
    assert.equal(viaContinue.isError, false);
    assert.match(viaContinue.text, /\[reused\]/);
    assert.equal(taskAndSession(viaContinue.text).session, ids.session);
  });

  await test('different objective in the same cwd gets a different session', async () => {
    const second = await client.call('dsh_run', {
      task: 'another objective [[noperm]]',
      goal: 'another task',
      cwd: project,
    });
    assert.equal(second.isError, false);
    assert.notEqual(taskAndSession(second.text).task, taskAndSession(first.text).task);
    assert.notEqual(taskAndSession(second.text).session, taskAndSession(first.text).session);
    assert.match(second.text, /\[new\]/);
  });

  await test('dsh_continue accepts an explicit session_id', async () => {
    const second = await client.call('dsh_run', {
      task: 'session-id objective [[noperm]]',
      goal: 'session id task',
    });
    const ids = taskAndSession(second.text);
    const cont = await client.call('dsh_continue', {
      session_id: ids.session,
      task: 'continue by session id [[noperm]]',
    });
    assert.equal(cont.isError, false);
    assert.equal(taskAndSession(cont.text).session, ids.session);
  });

  await test('dsh_tasks finds a binding but never returns transcripts', async () => {
    const ids = taskAndSession(first.text);
    const found = await client.call('dsh_tasks', { query: ids.task, limit: 1 });
    assert.equal(found.isError, false);
    assert.match(found.text, new RegExp(`task=${ids.task}`));
    assert.equal((found.text.match(/^- task=/gm) ?? []).length, 1);
    const missing = await client.call('dsh_tasks', { query: 'no-such-task-xyz' });
    assert.match(missing.text, /no matching/);
  });

  await test('cwd mismatch against a bound task is a clean usage error', async () => {
    const ids = taskAndSession(first.text);
    const mismatch = await client.call('dsh_continue', {
      task_id: ids.task,
      task: 'wrong project [[noperm]]',
      cwd: otherProject,
    });
    assert.equal(mismatch.isError, true);
    assert.match(mismatch.text, /绑定项目|不一致/);
  });

  let longHandle = null;
  await test('long output is fully stored and dsh_read can reach the tail', async () => {
    const long = await client.call('dsh_run', {
      task: '[[long:20000]][[noperm]]',
      goal: 'long output',
    });
    assert.equal(long.isError, false);
    assert.match(long.text, /summary truncated at 1500 chars/);
    longHandle = /full output: (run-[a-z0-9]+-\d+)/.exec(long.text)?.[1] ?? null;
    assert.ok(longHandle, `missing handle in: ${long.text.slice(0, 400)}`);
    const head = await client.call('dsh_read', { handle: longHandle, max_chars: 200 });
    const total = Number(/\[0\.\.\d+\/(\d+)\]/.exec(head.text)?.[1]);
    assert.ok(total > 20000, `stored total too small: ${total}`);
    const tail = await client.call('dsh_read', {
      handle: longHandle,
      offset: total - 40,
      max_chars: 40,
    });
    assert.match(tail.text, /\[\[LONG_END\]\]/);
  });

  await test('progress notifications carry the host progressToken', async () => {
    const call = client.startCall(
      'dsh_run',
      { task: '[[long:6000]][[noperm]]', goal: 'progress' },
      { progressToken: 'token-abc' },
    );
    const message = await call.promise;
    assert.equal(message.result.isError, false);
    const progress = client.progressFor('token-abc');
    assert.ok(progress.length >= 1, 'expected at least one notifications/progress');
    assert.ok(progress[0].params.progress >= 1);
    assert.match(progress[0].params.message, /DSH/);
  });

  await test('long history triggers a new session with a handoff prompt', async () => {
    const seeded = await client.call('dsh_run', {
      task: '[[usage:900:1000]][[noperm]]',
      goal: 'handoff task',
    });
    const ids = taskAndSession(seeded.text);
    const before = readRecord().prompts.length;
    const handoff = await client.call('dsh_continue', {
      task_id: ids.task,
      task: 'continue after long history [[noperm]]',
    });
    assert.equal(handoff.isError, false);
    assert.match(handoff.text, /\[handoff\]/);
    const idsAfter = taskAndSession(handoff.text);
    assert.equal(idsAfter.task, ids.task);
    assert.notEqual(idsAfter.session, ids.session);
    const record = readRecord();
    const prompt = record.prompts[record.prompts.length - 1]?.text ?? '';
    assert.match(prompt, /^\[handoff\]/);
    assert.ok(record.prompts.length > before);
  });

  await test('timeout is classified by phase and stores the partial handle', async () => {
    const started = Date.now();
    const timedOut = await client.call('dsh_run', {
      task: '[[hang]][[noperm]]',
      goal: 'timeout task',
      timeout_sec: 1,
    });
    const callerMs = Date.now() - started;
    assert.equal(timedOut.isError, true);
    assert.match(timedOut.text, /超时/);
    assert.match(timedOut.text, /phase=prompt/);
    assert.ok(callerMs < 5000, `timeout took too long: ${callerMs}ms`);
  });

  await test('bridge-side cancel of a running call settles as cancelled', async () => {
    const running = client.startCall('dsh_run', {
      task: '[[hang]][[noperm]]',
      goal: 'cancel task',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    client.notify('notifications/cancelled', { requestId: running.id });
    const message = await running.promise;
    const text = message.result.content?.[0]?.text ?? '';
    assert.equal(message.result.isError, true);
    assert.match(text, /已取消/);
  });

  await test('task bindings and call logs are persisted', async () => {
    const state = readJson(path.join(stateDir, 'tasks.json'));
    assert.ok(Array.isArray(state.tasks));
    assert.ok(state.tasks.some((task) => task.task_id === taskAndSession(first.text).task));
    const logs = readLog();
    assert.ok(logs.length >= 4, `expected call logs, got ${logs.length}`);
    const timeoutLog = logs.find((entry) => entry.error_class === 'BridgeTimeoutError');
    assert.ok(timeoutLog, 'missing timeout log entry');
    assert.equal(timeoutLog.phase, 'prompt');
    assert.ok(Number.isFinite(timeoutLog.bridge_ms) && timeoutLog.bridge_ms > 0);
    assert.ok(typeof timeoutLog.received_at === 'string');
    assert.ok(timeoutLog.phases && typeof timeoutLog.phases.prompt_ms === 'number');
    const okLog = logs.find((entry) => entry.status === 'ok');
    assert.ok(okLog && okLog.task_id && okLog.session_id);
  });

  await test('bridge restart resumes the bound session instead of reusing cwd', async () => {
    const ids = taskAndSession(first.text);
    await client.stop();
    const restarted = await BridgeClient.start();
    try {
      const resumed = await restarted.call('dsh_continue', {
        task_id: ids.task,
        task: 'after restart [[noperm]]',
      });
      assert.equal(resumed.isError, false);
      assert.match(resumed.text, /\[resumed\]/);
      assert.equal(taskAndSession(resumed.text).session, ids.session);
      const record = readRecord();
      assert.ok(
        record.resumes.some((entry) => entry.sessionId === ids.session && entry.known === true),
        `expected a resume: ${JSON.stringify(record.resumes)}`,
      );
    } finally {
      await restarted.stop();
    }
  });
} finally {
  await client.stop();
}

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log(`\nbridge stderr:\n${client.stderr.slice(-4000)}`);
}
process.exit(failed === 0 ? 0 : 1);
