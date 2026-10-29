#!/usr/bin/env node
/**
 * Offline tests for the ACP client, the session pool, the result writer and the
 * task registry. Runs against test/fake-acp.mjs — no model, no DSH, no network.
 *
 *   node test/run-tests.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient, AcpProcessError } from '../lib/acp.mjs';
import { BridgeCancelledError, BridgeTimeoutError, Deadline, withTimeout } from '../lib/deadline.mjs';
import { createReverseHandler } from '../lib/policy.mjs';
import { TaskRegistry } from '../lib/registry.mjs';
import { ResultStore } from '../lib/results.mjs';
import { SessionPool } from '../lib/session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fake-acp.mjs');

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
    console.log(`       ${error?.message ?? error}`);
  }
}

function makeClient({ scenario = 'normal', record, state, ...options } = {}) {
  const args = [FAKE, '--scenario', scenario];
  if (record) args.push('--record', record);
  if (state) args.push('--state', state);
  return new AcpClient({
    command: process.execPath,
    args,
    cwd: HERE,
    requestTimeoutMs: 2_000,
    ...options,
  });
}

function readRecord(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function withClient(options, body) {
  const client = makeClient(options);
  await client.start();
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

function tempDir(prefix = 'acp-test-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

console.log('ACP client tests');

await test('initialize returns agent info', async () => {
  await withClient({}, async (client) => {
    const info = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    assert.equal(info.agentInfo.name, 'fake-acp');
    assert.equal(info.protocolVersion, 1);
  });
});

await test('prompt streams chunks into the session buffer', async () => {
  const dir = tempDir();
  const record = path.join(dir, 'record.json');
  await withClient({ record }, async (client) => {
    client.onReverseRequest(createReverseHandler());
    const pool = new SessionPool({ client });
    const session = await pool.open('/tmp');
    const result = await pool.prompt(session.id, 'say hello');
    assert.equal(result.text, 'hello!');
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(result.tools, ['write']);
    assert.deepEqual(result.usage, { used: 42, size: 1000 });
    await pool.close(session.id);
  });
  const data = readRecord(record);
  assert.equal(data.permission.outcome.outcome, 'selected');
  assert.equal(data.permission.outcome.optionId, 'reject-1');
});

await test('permission requests are rejected, never allowed', async () => {
  const dir = tempDir();
  const record = path.join(dir, 'record.json');
  await withClient({ record }, async (client) => {
    client.onReverseRequest(createReverseHandler({ allowPermission: false }));
    const pool = new SessionPool({ client });
    const session = await pool.open('/tmp');
    await pool.prompt(session.id, 'needs permission');
  });
  const data = readRecord(record);
  assert.equal(data.permission.outcome.optionId, 'reject-1');
});

await test('unknown reverse requests are answered with -32601', async () => {
  const dir = tempDir();
  const record = path.join(dir, 'record.json');
  await withClient({ scenario: 'weird', record }, async (client) => {
    client.onReverseRequest(createReverseHandler());
    const pool = new SessionPool({ client });
    const session = await pool.open('/tmp');
    await pool.prompt(session.id, 'weird [[noperm]]');
  });
  const data = readRecord(record);
  assert.equal(data.weird.error.code, -32601);
});

await test('prompt deadline surfaces as BridgeTimeoutError(phase=prompt)', async () => {
  await withClient({ scenario: 'slow', requestTimeoutMs: 5_000 }, async (client) => {
    client.onReverseRequest(createReverseHandler());
    const pool = new SessionPool({ client });
    const session = await pool.open('/tmp');
    const deadline = new Deadline(150, 'test');
    await assert.rejects(
      () => pool.prompt(session.id, '[[slow:1000]][[noperm]]', { deadline }),
      (error) => error instanceof BridgeTimeoutError && error.phase === 'prompt',
    );
    assert.equal(session.tainted, true);
  });
});

await test('process death rejects the in-flight request', async () => {
  const client = makeClient({ scenario: 'death', requestTimeoutMs: 5_000 });
  await client.start();
  client.onReverseRequest(createReverseHandler());
  const pool = new SessionPool({ client });
  const session = await pool.open('/tmp');
  await assert.rejects(() => pool.prompt(session.id, 'die'), AcpProcessError);
  await client.close();
});

await test('transport rejects malformed lines', async () => {
  const client = new AcpClient({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("not json\\n"); setInterval(()=>{}, 1000)'],
    cwd: HERE,
    requestTimeoutMs: 500,
  });
  await client.start();
  await assert.rejects(
    () => client.request('initialize', { protocolVersion: 1 }),
    (error) => error.constructor.name === 'AcpProtocolError',
  );
  await client.close();
});

console.log('\nSession pool tests');

await test('session/resume works across two fake processes', async () => {
  const dir = tempDir();
  const record1 = path.join(dir, 'record1.json');
  const record2 = path.join(dir, 'record2.json');
  const state = path.join(dir, 'state.json');
  let sessionId;
  await withClient({ record: record1, state }, async (client) => {
    client.onReverseRequest(createReverseHandler());
    const pool = new SessionPool({ client });
    const session = await pool.open('/tmp');
    sessionId = session.id;
    await pool.prompt(session.id, 'first [[noperm]]');
    await pool.close(session.id);
  });
  await withClient({ record: record2, state }, async (client) => {
    client.onReverseRequest(createReverseHandler());
    const pool = new SessionPool({ client });
    const session = await pool.resume(sessionId, '/tmp');
    assert.equal(session.id, sessionId);
    const result = await pool.prompt(session.id, 'second [[noperm]]');
    assert.equal(result.text, 'hello!');
  });
  const data = readRecord(record2);
  assert.equal(data.resumes.length, 1);
  assert.equal(data.resumes[0].sessionId, sessionId);
  assert.equal(data.resumes[0].known, true);
});

await test('session/list returns persisted sessions for a cwd', async () => {
  const dir = tempDir();
  const record = path.join(dir, 'record.json');
  const state = path.join(dir, 'state.json');
  await withClient({ record, state }, async (client) => {
    const pool = new SessionPool({ client });
    const session = await pool.open('/tmp');
    const listed = await pool.list({ cwd: '/tmp' });
    assert.equal(listed.sessions.some((entry) => entry.sessionId === session.id), true);
    const other = await pool.list({ cwd: '/definitely-not-this-cwd' });
    assert.equal(other.sessions.length, 0);
  });
});

await test('queued request can be cancelled without touching the running prompt', async () => {
  const dir = tempDir();
  const record = path.join(dir, 'record.json');
  await withClient({ record, requestTimeoutMs: 5_000 }, async (client) => {
    client.onReverseRequest(createReverseHandler());
    const pool = new SessionPool({ client });
    const session = await pool.open('/tmp');
    const first = pool.prompt(session.id, '[[slow:300]][[noperm]]');
    const controller = new AbortController();
    const second = pool.prompt(session.id, '[[slow:10]][[noperm]]', {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(() => second, BridgeCancelledError);
    const result = await first;
    assert.equal(result.text, 'hello!');
    assert.equal(result.cancelled, false);
  });
  const data = readRecord(record);
  assert.deepEqual(data.cancels, [], 'queued cancellation must not cancel the ACP session');
});

await test('cancelling a running prompt sends session/cancel and settles cancelled', async () => {
  const dir = tempDir();
  const record = path.join(dir, 'record.json');
  await withClient({ record, requestTimeoutMs: 5_000 }, async (client) => {
    client.onReverseRequest(createReverseHandler());
    const pool = new SessionPool({ client });
    const session = await pool.open('/tmp');
    const controller = new AbortController();
    const running = pool.prompt(session.id, '[[hang]][[noperm]]', { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await running;
    assert.equal(result.cancelled, true);
    assert.equal(result.stopReason, 'cancelled');
  });
  const data = readRecord(record);
  assert.equal(data.cancels.length, 1);
});

await test('streaming writer recovers the complete long output', async () => {
  const dir = tempDir();
  const record = path.join(dir, 'record.json');
  const results = path.join(dir, 'results');
  const store = new ResultStore({ dir: results });
  await withClient({ record, requestTimeoutMs: 5_000 }, async (client) => {
    client.onReverseRequest(createReverseHandler());
    const pool = new SessionPool({ client });
    const session = await pool.open('/tmp');
    const writer = store.begin(store.nextHandle());
    const result = await pool.prompt(session.id, '[[long:20000]][[noperm]]', { writer });
    assert.equal(result.truncated, true, 'summary buffer should be truncated');
    assert.ok(result.fullChars >= 20000);
    const stored = writer.finish('test header');
    assert.ok(stored.total > 20000);
    const full = readFileSync(path.join(results, `${stored.handle}.md`), 'utf8');
    assert.match(full, /\[\[LONG_END\]\]$/);
    assert.ok(full.length > 20000, 'stored copy must exceed the in-memory buffer');
    const tail = store.read(stored.handle, full.length - 30, 40);
    assert.match(tail.slice, /\[\[LONG_END\]\]/);
  });
});

console.log('\nDeadline / registry tests');

await test('withTimeout rejects with its phase and Deadline tracks remaining', async () => {
  const deadline = new Deadline(500, 'unit');
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 20, 'startup', deadline),
    (error) => error instanceof BridgeTimeoutError && error.phase === 'startup',
  );
  assert.ok(deadline.remaining() < 500);
});

await test('task registry persists, reloads and searches compactly', async () => {
  const dir = tempDir('registry-');
  const registry = new TaskRegistry({ dir });
  const created = registry.upsert({
    task_id: 't-alpha',
    goal: 'add readiness probe',
    project: '/tmp',
    session_id: 's-1',
    status: 'active',
    summary: 'probe file added; tests pending',
    turns: 1,
  });
  assert.equal(created.task_id, 't-alpha');
  const reloaded = new TaskRegistry({ dir });
  assert.equal(reloaded.get('t-alpha').session_id, 's-1');
  assert.equal(reloaded.findBySession('s-1').task_id, 't-alpha');
  const hits = reloaded.search({ query: 'readiness', limit: 3 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].task_id, 't-alpha');
  assert.equal(reloaded.search({ query: 'nothing-matches' }).length, 0);
  const id = reloaded.newTaskId('fix build');
  assert.match(id, /^fix-build-/);
  reloaded.upsert({ task_id: id, goal: 'fix build', project: '/tmp', turns: 0 });
  assert.notEqual(reloaded.newTaskId('fix build'), id);
});

await test('registry recovers from a corrupt file instead of crashing', async () => {
  const dir = tempDir('registry-corrupt-');
  writeFileSync(path.join(dir, 'tasks.json'), '{ this is not json');
  const registry = new TaskRegistry({ dir });
  assert.ok(registry.loadError instanceof Error);
  assert.equal(registry.all().length, 0);
  registry.upsert({ task_id: 't-new', goal: 'x', project: '/tmp' });
  assert.equal(new TaskRegistry({ dir }).get('t-new').task_id, 't-new');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
