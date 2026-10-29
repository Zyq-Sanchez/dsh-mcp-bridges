#!/usr/bin/env node
/**
 * Fake ACP agent for tests. No model, no DSH, no network.
 *
 * Transport-level env (read by the fake, forwarded by the bridge):
 *   FAKE_ACP_SCENARIO  normal|slow|weird|death|hang   (default normal)
 *   FAKE_ACP_RECORD    JSON file: calls/observations for assertions
 *   FAKE_ACP_STATE     JSON file: persisted tiny session headers, so a new
 *                      fake process can `session/resume` after a bridge restart
 *
 * Prompt markers (only used by the offline tests):
 *   [[noperm]]         skip the reverse permission request
 *   [[long:N]]         stream N characters then `[[LONG_END]]`
 *   [[hang]]           never finish until session/cancel arrives
 *   [[slow:MS]]        wait MS before finishing
 *   [[usage:USED:SIZE]] send a usage_update with these values
 *   [[death]]          exit the process mid-prompt
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
function argValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}
const scenario = argValue('--scenario') || process.env.FAKE_ACP_SCENARIO || 'normal';
const recordPath = argValue('--record') || process.env.FAKE_ACP_RECORD || null;
const statePath = argValue('--state') || process.env.FAKE_ACP_STATE || null;

const record = {
  scenario,
  permission: null,
  weird: null,
  prompts: [],
  newSessions: [],
  resumes: [],
  lists: [],
  cancels: [],
  closes: [],
  configSets: [],
};

function readState() {
  if (!statePath || !existsSync(statePath)) return { sessions: {} };
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return { sessions: parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {} };
  } catch {
    return { sessions: {} };
  }
}
const state = readState();
function saveState() {
  if (!statePath) return;
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {
    /* ignore */
  }
}
function flush() {
  if (!recordPath) return;
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

const sessions = new Map(); // sessionId -> {sessionId, cwd, createdAt, closed, configOptions}
const active = new Map(); // sessionId -> state for the in-flight prompt
const pendingReverse = new Map();
let reverseSeq = 900;
let sessionSeq = 0;

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
const DEFAULT_CONFIG_OPTIONS = [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fake-model' },
];

function nextSessionId() {
  sessionSeq += 1;
  let id = `fake-session-${sessionSeq}`;
  while (sessions.has(id) || state.sessions[id]) {
    sessionSeq += 1;
    id = `fake-session-${sessionSeq}`;
  }
  return id;
}

function loadPersisted(id) {
  const entry = state.sessions[id];
  if (!entry || entry.closed) return null;
  return entry;
}

function respond(message, result) {
  write({ jsonrpc: '2.0', id: message.id, result });
}

async function streamText(sessionId, text, chunk = 500, stateRef = active.get(sessionId)) {
  for (let index = 0; index < text.length; index += chunk) {
    if (stateRef?.cancelled) return false;
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: text.slice(index, index + chunk) },
    });
    await sleep(1);
  }
  return !stateRef?.cancelled;
}

async function handlePrompt(message) {
  const sessionId = message.params?.sessionId;
  const prompt = message.params?.prompt;
  const text = Array.isArray(prompt) && prompt[0]?.type === 'text' ? prompt[0].text : '';
  record.prompts.push({ sessionId, text });

  if (!sessions.has(sessionId)) {
    write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `unknown session: ${sessionId}` } });
    return;
  }

  const stateRef = { message, responded: false, cancelled: false, onCancel: null };
  active.set(sessionId, stateRef);
  const finish = (stopReason) => {
    if (stateRef.responded) return;
    stateRef.responded = true;
    active.delete(sessionId);
    respond(message, { stopReason });
    flush();
  };

  if (scenario === 'death' || text.includes('[[death]]')) {
    flush();
    process.exit(1);
  }

  const longMatch = /\[\[long:(\d+)\]\]/.exec(text);
  const slowMatch = /\[\[slow:(\d+)\]\]/.exec(text);
  const usageMatch = /\[\[usage:(\d+):(\d+)\]\]/.exec(text);

  if (usageMatch) {
    update(sessionId, {
      sessionUpdate: 'usage_update',
      used: Number(usageMatch[1]),
      size: Number(usageMatch[2]),
    });
  }

  if (text.includes('[[hang]]')) {
    await new Promise((resolve) => {
      stateRef.onCancel = resolve;
    });
    finish('cancelled');
    return;
  }

  if (longMatch) {
    const size = Math.max(1, Math.min(Number(longMatch[1]) || 0, 2_000_000));
    const body = `${'abcdefghijklmnopqrstuvwxyz'.repeat(Math.ceil(size / 26)).slice(0, size)}[[LONG_END]]`;
    await streamText(sessionId, body, 500, stateRef);
    update(sessionId, { sessionUpdate: 'tool_call', title: 'write' });
    if (stateRef.cancelled) {
      finish('cancelled');
      return;
    }
    finish('end_turn');
    return;
  }

  // Default/legacy behaviour used by the original protocol tests.
  for (const chunk of ['hel', 'lo', '!']) {
    if (stateRef.cancelled) break;
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
    await sleep(5);
  }
  update(sessionId, { sessionUpdate: 'tool_call', title: 'write' });
  if (!usageMatch) {
    update(sessionId, { sessionUpdate: 'usage_update', used: 42, size: 1000 });
  }

  if (slowMatch) await sleep(Number(slowMatch[1]) || 0);

  if (!text.includes('[[noperm]]') && scenario !== 'hang') {
    record.permission = await askReverse('session/request_permission', {
      sessionId,
      toolCall: { title: 'write demo.txt' },
      options: [
        { optionId: 'allow-1', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject-1', kind: 'reject_once', name: 'Reject' },
      ],
    });
  }

  if (scenario === 'weird') {
    record.weird = await askReverse('session/weird_request', {});
  }

  if (stateRef.cancelled) {
    finish('cancelled');
    return;
  }
  finish(text.includes('[[cancel]]') ? 'cancelled' : 'end_turn');
}

function handleSessionCancel(params) {
  const sessionId = params?.sessionId;
  record.cancels.push(sessionId ?? null);
  const stateRef = active.get(sessionId);
  if (!stateRef) return;
  stateRef.cancelled = true;
  stateRef.onCancel?.();
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
      respond(message, {
        protocolVersion: 1,
        agentInfo: { name: 'fake-acp', version: '2.0.0' },
        agentCapabilities: {
          sessionCapabilities: { resume: {}, list: {}, close: {}, setConfigOption: {} },
        },
        sessionCapabilities: { resume: {}, list: {}, close: {}, setConfigOption: {} },
      });
      return;
    case 'session/new': {
      const sessionId = nextSessionId();
      const cwd = message.params?.cwd;
      if (typeof cwd !== 'string' || !cwd) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'cwd is required' } });
        return;
      }
      const info = {
        sessionId,
        cwd,
        createdAt: Date.now(),
        closed: false,
        configOptions: DEFAULT_CONFIG_OPTIONS,
      };
      sessions.set(sessionId, info);
      state.sessions[sessionId] = info;
      saveState();
      record.newSessions.push({ sessionId, cwd });
      flush();
      respond(message, { sessionId, configOptions: DEFAULT_CONFIG_OPTIONS });
      return;
    }
    case 'session/resume': {
      const sessionId = message.params?.sessionId;
      const cwd = message.params?.cwd;
      const known = sessions.get(sessionId) ?? loadPersisted(sessionId);
      record.resumes.push({ sessionId, cwd, known: Boolean(known) });
      if (!known) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `session is not resumable: ${sessionId}` } });
        return;
      }
      if (typeof cwd !== 'string' || !cwd || known.cwd !== cwd) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `session cwd does not match: ${cwd}` } });
        return;
      }
      known.closed = false;
      sessions.set(sessionId, known);
      state.sessions[sessionId] = known;
      saveState();
      flush();
      respond(message, { configOptions: known.configOptions ?? DEFAULT_CONFIG_OPTIONS });
      return;
    }
    case 'session/list': {
      record.lists.push(message.params ?? {});
      const cwd = message.params?.cwd;
      const items = [...sessions.values()]
        .filter((item) => !item.closed && (!cwd || item.cwd === cwd))
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((item) => ({ sessionId: item.sessionId, cwd: item.cwd }));
      flush();
      respond(message, { sessions: items });
      return;
    }
    case 'session/setConfigOption': {
      record.configSets.push(message.params ?? {});
      const sessionId = message.params?.sessionId;
      const known = sessions.get(sessionId);
      if (!known) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `unknown session: ${sessionId}` } });
        return;
      }
      known.configOptions = (known.configOptions ?? DEFAULT_CONFIG_OPTIONS).map((option) =>
        option.id === message.params?.configId ? { ...option, currentValue: message.params?.value } : option,
      );
      respond(message, { configOptions: known.configOptions });
      return;
    }
    case 'session/close': {
      const sessionId = message.params?.sessionId;
      record.closes.push(sessionId ?? null);
      const known = sessions.get(sessionId);
      if (known) {
        // Keep the persisted header: a later bridge process may resume it.
        known.closed = false;
        state.sessions[sessionId] = known;
        saveState();
        sessions.delete(sessionId);
      }
      flush();
      respond(message, {});
      return;
    }
    case 'session/cancel':
      handleSessionCancel(message.params);
      return;
    case 'session/prompt':
      void handlePrompt(message);
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
