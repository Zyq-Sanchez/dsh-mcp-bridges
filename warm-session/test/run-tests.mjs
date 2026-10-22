#!/usr/bin/env node
/**
 * Protocol-level tests for the ACP client, run against test/fake-acp.mjs.
 * No model, no DSH, no network, no tokens.
 *
 *   node test/run-tests.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient, AcpProcessError, AcpTimeoutError } from '../lib/acp.mjs';
import { createReverseHandler } from '../lib/policy.mjs';
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

function makeClient({ scenario = 'normal', record, ...options } = {}) {
  const args = [FAKE, '--scenario', scenario];
  if (record) args.push('--record', record);
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
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-test-'));
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
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-test-'));
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
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-test-'));
  const record = path.join(dir, 'record.json');
  await withClient({ scenario: 'weird', record }, async (client) => {
    client.onReverseRequest(createReverseHandler());
    const pool = new SessionPool({ client });
    const session = await pool.open('/tmp');
    await pool.prompt(session.id, 'weird');
  });
  const data = readRecord(record);
  assert.equal(data.weird.error.code, -32601);
});

await test('request timeout surfaces as AcpTimeoutError', async () => {
  await withClient({ scenario: 'slow', requestTimeoutMs: 100 }, async (client) => {
    client.onReverseRequest(createReverseHandler());
    const pool = new SessionPool({ client });
    const session = await pool.open('/tmp');
    await assert.rejects(() => pool.prompt(session.id, 'slow'), AcpTimeoutError);
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
