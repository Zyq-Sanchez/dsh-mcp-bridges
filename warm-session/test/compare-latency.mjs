#!/usr/bin/env node
/**
 * Offline control test for caller-side vs bridge-side latency.
 *
 *   node test/compare-latency.mjs
 *
 * Runs the bridge against the fake ACP agent (no model, no DSH, no tokens) and
 * joins the caller's measured duration with the bridge's own JSONL timing
 * record (logs/calls.jsonl) by task_id. This isolates the measurement method and
 * verifies that:
 *   - the bridge logs its own phases (startup/session/queue/prompt);
 *   - the bridge_ms value is consistent with what the caller observes;
 *   - host-dispatch overhead can be derived as caller_ms - bridge_ms.
 *
 * It does NOT claim a speed-up. The same join will be used for the real-DSH
 * comparison once starting DSH is explicitly allowed.
 */

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, '..', 'bridge.mjs');
const FAKE = path.join(HERE, 'fake-acp.mjs');

if (process.env.DSH_REAL === '1') {
  console.log(
    'Real-DSH comparison is intentionally not wired into this script yet:\n' +
      'the current round keeps all DSH calls paused. Once DSH execution is\n' +
      'allowed, use the installed CLI directly and join the same calls.jsonl\n' +
      'record (bridge_ms) with externally measured caller_ms.',
  );
  process.exit(0);
}

const temp = mkdtempSync(path.join(tmpdir(), 'compare-latency-'));
const project = path.join(temp, 'project');
mkdirSync(project, { recursive: true });
const launcher = path.join(temp, 'fake-dsh');
writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, 'utf8');
chmodSync(launcher, 0o755);

const env = {
  ...process.env,
  DSH_CLI: launcher,
  DSH_BRIDGE_CWD: project,
  DSH_BRIDGE_STATE_DIR: path.join(temp, 'state'),
  DSH_BRIDGE_RESULTS_DIR: path.join(temp, 'results'),
  DSH_BRIDGE_LOG_DIR: path.join(temp, 'logs'),
  DSH_BRIDGE_STARTUP_TIMEOUT_MS: '5000',
  FAKE_ACP_SCENARIO: 'normal',
  FAKE_ACP_RECORD: path.join(temp, 'record.json'),
  FAKE_ACP_STATE: path.join(temp, 'fake-state.json'),
};

const child = spawn(process.execPath, [BRIDGE], {
  cwd: project,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

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
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve) => pending.set(id, resolve));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return promise;
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

await new Promise((resolve) => setTimeout(resolve, 300));
await request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
notify('notifications/initialized', {});

async function callTool(name, args) {
  const started = process.hrtime.bigint();
  const message = await request('tools/call', { name, arguments: args });
  const callerMs = Number(process.hrtime.bigint() - started) / 1e6;
  const text = message.result?.content?.[0]?.text ?? '';
  return {
    callerMs,
    isError: message.result?.isError === true,
    text,
    taskId: /task=(\S+)/.exec(text)?.[1] ?? null,
  };
}

const scenarios = [
  { label: 'fast-1', args: { task: 'fast one [[noperm]]', goal: 'latency fast 1' } },
  { label: 'fast-2', args: { task: 'fast two [[noperm]]', goal: 'latency fast 2' } },
  { label: 'fast-3', args: { task: 'fast three [[noperm]]', goal: 'latency fast 3' } },
  { label: 'slow-1', args: { task: '[[slow:200]][[noperm]]', goal: 'latency slow 1' } },
  { label: 'slow-2', args: { task: '[[slow:400]][[noperm]]', goal: 'latency slow 2' } },
];

const rows = [];
for (const scenario of scenarios) {
  const result = await callTool('dsh_run', scenario.args);
  rows.push({ label: scenario.label, ...result });
}

const logFile = path.join(env.DSH_BRIDGE_LOG_DIR, 'calls.jsonl');
const logs = existsSync(logFile)
  ? readFileSync(logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : [];
const byTask = new Map(logs.map((entry) => [entry.task_id, entry]));

console.log('\ncaller-side vs bridge-side latency (fake ACP, offline)');
console.log(
  'scenario   caller_ms   bridge_ms   gap_ms   prompt_ms   status   task',
);
for (const row of rows) {
  const log = byTask.get(row.taskId);
  if (!log) {
    console.log(`${row.label.padEnd(10)} ${row.callerMs.toFixed(1).padStart(9)}  (no log record)  ${row.taskId ?? '-'}`);
    continue;
  }
  const gap = row.callerMs - log.bridge_ms;
  console.log(
    `${row.label.padEnd(10)} ${row.callerMs.toFixed(1).padStart(9)} ${log.bridge_ms.toFixed(1).padStart(10)} ` +
      `${gap.toFixed(1).padStart(8)} ${String(log.phases?.prompt_ms ?? '-').padStart(10)} ` +
      `${String(log.status).padEnd(8)} ${row.taskId}`,
  );
}

const known = rows
  .map((row) => ({ row, log: byTask.get(row.taskId) }))
  .filter((entry) => entry.log);
const gaps = known.map((entry) => entry.row.callerMs - entry.log.bridge_ms);
const bridgeTimes = known.map((entry) => entry.log.bridge_ms);

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

console.log('\nsummary');
console.log(`  matched calls: ${known.length}/${rows.length}`);
console.log(`  bridge_ms median: ${median(bridgeTimes)?.toFixed(1) ?? '-'} ms`);
console.log(`  caller-side median: ${median(known.map((entry) => entry.row.callerMs))?.toFixed(1) ?? '-'} ms`);
console.log(`  host-gap median: ${median(gaps)?.toFixed(1) ?? '-'} ms (caller_ms - bridge_ms)`);
console.log(
  '\nNote: fake-agent timings cannot establish real speed; this only validates the\n' +
    'measurement join and the bridge-side phase log. Real-DSH comparison stays\n' +
    'pending until DSH execution is explicitly allowed.',
);

let failures = 0;
if (known.length !== rows.length) {
  console.error('FAIL: missing bridge log records');
  failures += 1;
}
for (const entry of known) {
  if (!(entry.log.bridge_ms > 0)) {
    console.error(`FAIL: bridge_ms missing for ${entry.row.taskId}`);
    failures += 1;
  }
  if (!entry.log.phases || typeof entry.log.phases.prompt_ms !== 'number') {
    console.error(`FAIL: phases.prompt_ms missing for ${entry.row.taskId}`);
    failures += 1;
  }
  if (entry.row.callerMs + 50 < entry.log.bridge_ms) {
    console.error(`FAIL: caller_ms < bridge_ms for ${entry.row.taskId} (clock?)`);
    failures += 1;
  }
}

child.kill('SIGTERM');
await new Promise((resolve) => setTimeout(resolve, 300));
if (failures > 0) {
  console.error(`\n${failures} failure(s)\nbridge stderr:\n${stderr.slice(-2000)}`);
  process.exit(1);
}
console.log('\ncompare-latency: ok');
process.exit(0);
