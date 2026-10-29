#!/usr/bin/env node
/**
 * Smoke test against the real DSH ACP server (`dsh --profile acp`).
 * Costs one small model call (two with --resume).
 *
 *   node test/real-smoke.mjs            # initialize + one prompt
 *   node test/real-smoke.mjs --resume   # + close/list/resume/prompt
 *
 * The 2026-10-27 revision keeps DSH calls paused by default; set
 * DSH_ALLOW_REAL=1 only when real DSH execution is explicitly allowed.
 */

import { AcpClient } from '../lib/acp.mjs';
import { createReverseHandler } from '../lib/policy.mjs';
import { SessionPool } from '../lib/session.mjs';

if (process.env.DSH_ALLOW_REAL !== '1') {
  console.log('Real DSH calls are paused for this round; set DSH_ALLOW_REAL=1 to run.');
  process.exit(0);
}

const CLI =
  process.env.DSH_CLI ??
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';

const client = new AcpClient({
  command: CLI,
  args: ['--profile', 'acp'],
  cwd: process.cwd(),
  startupTimeoutMs: 30_000,
  requestTimeoutMs: 120_000,
});
client.onReverseRequest(createReverseHandler());

const started = Date.now();
await client.start();

const info = await client.request('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
console.log('agent:', info.agentInfo?.name, '| protocol:', info.protocolVersion);
console.log('capabilities:', Object.keys(info.agentCapabilities ?? {}).join(', '));
console.log(
  'sessions:',
  Object.keys(info.agentCapabilities?.sessionCapabilities ?? info.sessionCapabilities ?? {}).join(', '),
);

const pool = new SessionPool({ client });
const session = await pool.open(process.cwd());
console.log('session:', session.id);
console.log('model options:', session.configOptions.map((o) => `${o.id}=${o.currentValue}`).join(', '));

const result = await pool.prompt(session.id, '只回复四个字符：ACP_OK。不要调用任何工具。');
console.log('\nreply:', JSON.stringify(result.text));
console.log('stopReason:', result.stopReason, '| tools:', result.tools.join(',') || 'none');
console.log('usage:', JSON.stringify(result.usage));
console.log('elapsed:', ((Date.now() - started) / 1000).toFixed(1), 's');

if (process.argv.includes('--resume')) {
  const sessionId = session.id;
  const cwd = process.cwd();
  await pool.close(sessionId);

  const listed = await pool.list({ cwd });
  console.log('\nlist after close:', listed.sessions.length, 'session(s); contains ours:', listed.sessions.some((entry) => entry.sessionId === sessionId));

  const resumed = await pool.resume(sessionId, cwd);
  console.log('resumed session:', resumed.id);
  const second = await pool.prompt(resumed.id, '只回复四个字符：TWO。不要调用任何工具。');
  console.log('resumed reply:', JSON.stringify(second.text), '| stopReason:', second.stopReason);
  await pool.close(resumed.id);
}

await client.close();
process.exit(0);
