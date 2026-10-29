/**
 * Session pool on top of the ACP client.
 *
 * One persistent ACP process can host several sessions; each session allows one
 * in-flight prompt. This module owns:
 *
 * - session create / resume / list (resume is what makes the task binding
 *   durable across bridge restarts);
 * - a per-session request queue whose entries can be cancelled *individually*
 *   (cancelling one queued request must never cancel the running prompt, and
 *   cancelling a queued request must never touch the ACP session);
 * - deadline propagation across queue wait + prompt;
 * - the bounded summary buffer plus a streaming writer that keeps the complete
 *   text on disk;
 * - projection of ACP `session/update` events into tool names, usage and
 *   progress callbacks.
 */

import { AcpTimeoutError } from './acp.mjs';
import { BridgeCancelledError, BridgeTimeoutError } from './deadline.mjs';

const DEFAULT_MAX_BUFFER_CHARS = 8_000;

export class SessionPool {
  constructor({ client, maxBufferChars = DEFAULT_MAX_BUFFER_CHARS, onUpdate } = {}) {
    if (!client) throw new Error('SessionPool requires an ACP client');
    this.client = client;
    this.maxBufferChars = maxBufferChars;
    this.onUpdate = onUpdate ?? null;
    this.sessions = new Map();

    client.onNotification((method, params) => {
      if (method !== 'session/update') return;
      const sessionId = params?.sessionId;
      if (typeof sessionId !== 'string') return;
      this.project(sessionId, params.update ?? {});
    });
  }

  get(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }

  makeRecord(sessionId, cwd, configOptions = []) {
    return {
      id: sessionId,
      cwd,
      buffer: '',
      truncated: false,
      fullChars: 0,
      tools: new Set(),
      usage: null,
      lastUsage: null,
      stopReason: null,
      queue: [],
      running: null,
      writer: null,
      tainted: false,
      configOptions,
      promptCount: 0,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
  }

  async open(cwd, { mcpServers = [], timeoutMs } = {}) {
    const result = await this.client.request(
      'session/new',
      { cwd, mcpServers },
      timeoutMs ? { timeoutMs } : undefined,
    );
    const sessionId = result?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('session/new did not return a sessionId');
    }
    const record = this.makeRecord(sessionId, cwd, result.configOptions ?? []);
    this.sessions.set(sessionId, record);
    return record;
  }

  /**
   * Resume a persisted session. DSH requires the same cwd that the session was
   * created with; callers must pass the binding's project directory.
   */
  async resume(sessionId, cwd, { mcpServers = [], timeoutMs } = {}) {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const result = await this.client.request(
      'session/resume',
      { sessionId, cwd, mcpServers },
      timeoutMs ? { timeoutMs } : undefined,
    );
    const record = this.makeRecord(sessionId, cwd, result?.configOptions ?? []);
    this.sessions.set(sessionId, record);
    return record;
  }

  async list({ cwd, cursor, timeoutMs } = {}) {
    const params = {};
    if (typeof cwd === 'string' && cwd) params.cwd = cwd;
    if (typeof cursor === 'string' && cursor) params.cursor = cursor;
    return this.client.request('session/list', params, timeoutMs ? { timeoutMs } : undefined);
  }

  async setConfigOption(sessionId, configId, value, { timeoutMs } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    const result = await this.client.request(
      'session/setConfigOption',
      { sessionId, configId, value },
      timeoutMs ? { timeoutMs } : undefined,
    );
    if (Array.isArray(result?.configOptions)) session.configOptions = result.configOptions;
    return session.configOptions;
  }

  /**
   * Submit one prompt and wait for settlement.
   *
   * Options:
   *   deadline   Deadline object; covers queue wait + prompt.
   *   timeoutMs  Fallback budget when no deadline is supplied (tests).
   *   signal     AbortSignal; queued entries are removed, running prompts get
   *              session/cancel, and the call settles as cancelled.
   *   writer     Streaming writer (see lib/results.mjs) for the complete text.
   *   onStart    ({queueWaitMs}) => void, called when the entry starts running.
   *   onProgress ({type, ...}) => void, ACP update projection for MCP progress.
   */
  prompt(sessionId, text, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return Promise.reject(new Error(`unknown session: ${sessionId}`));
    }
    const { deadline = null, timeoutMs = null, signal = null, writer = null } = options;
    return new Promise((resolve, reject) => {
      const entry = {
        requestId: options.requestId,
        text,
        deadline,
        timeoutMs,
        signal,
        writer,
        onStart: options.onStart ?? null,
        onProgress: options.onProgress ?? null,
        createdAt: Date.now(),
        started: false,
        settled: false,
        cancelled: false,
        resolve,
        reject,
        cleanup: null,
      };

      const onAbort = () => {
        entry.cancelled = true;
        if (!entry.started) {
          const index = session.queue.indexOf(entry);
          if (index >= 0) session.queue.splice(index, 1);
          this.settle(entry, 'reject', new BridgeCancelledError('queued'));
        } else {
          // Only the running prompt gets a session-level cancel.
          this.cancel(sessionId).catch(() => {});
        }
      };

      if (signal) {
        if (signal.aborted) {
          entry.cancelled = true;
          reject(new BridgeCancelledError('queued'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      entry.cleanup = () => signal?.removeEventListener('abort', onAbort);

      session.queue.push(entry);
      this.drain(session);
    });
  }

  settle(entry, kind, value) {
    if (!entry || entry.settled) return false;
    entry.settled = true;
    try {
      entry.cleanup?.();
    } catch {
      /* ignore */
    }
    if (kind === 'resolve') entry.resolve(value);
    else entry.reject(value);
    return true;
  }

  drain(session) {
    if (session.running || session.queue.length === 0) return;
    const entry = session.queue.shift();
    if (entry.settled) {
      this.drain(session);
      return;
    }
    session.running = entry;
    this.runEntry(session, entry)
      .catch((error) => {
        // runEntry normally settles the entry itself; this is a last-resort
        // guard so a bug can never leave the MCP call hanging forever.
        this.settle(entry, 'reject', error);
      })
      .finally(() => {
        session.running = null;
        this.drain(session);
      });
  }

  async runEntry(session, entry) {
    entry.started = true;
    const queueWaitMs = Date.now() - entry.createdAt;
    try {
      entry.onStart?.({ queueWaitMs });
    } catch {
      /* progress/telemetry callbacks must not break the call */
    }

    const budget = () => {
      if (entry.deadline) return entry.deadline.remaining();
      if (Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0) return entry.timeoutMs;
      return null;
    };

    let remaining = budget();
    if (remaining !== null && remaining <= 0) {
      this.settle(
        entry,
        'reject',
        new BridgeTimeoutError('queue', entry.deadline, `queue wait ${queueWaitMs}ms`),
      );
      return;
    }

    session.buffer = '';
    session.truncated = false;
    session.fullChars = 0;
    session.tools.clear();
    session.usage = null;
    session.stopReason = null;
    session.writer = entry.writer;
    session.promptCount += 1;
    session.lastActiveAt = Date.now();

    try {
      const result = await this.client.request(
        'session/prompt',
        { sessionId: session.id, prompt: [{ type: 'text', text: entry.text }] },
        remaining !== null ? { timeoutMs: remaining } : undefined,
      );
      session.stopReason = result?.stopReason ?? 'unknown';
      const cancelled = entry.cancelled || session.stopReason === 'cancelled';
      this.settle(entry, 'resolve', {
        text: session.buffer,
        truncated: session.truncated,
        fullChars: session.fullChars,
        stopReason: session.stopReason,
        tools: [...session.tools],
        usage: session.usage,
        cancelled,
      });
    } catch (error) {
      if (entry.cancelled && !(error instanceof AcpTimeoutError)) {
        this.settle(entry, 'resolve', {
          text: session.buffer,
          truncated: session.truncated,
          fullChars: session.fullChars,
          stopReason: 'cancelled',
          tools: [...session.tools],
          usage: session.usage,
          cancelled: true,
        });
        return;
      }
      if (error instanceof AcpTimeoutError) {
        // The turn outlived its budget. Ask ACP to stop it and quarantine the
        // session so the next call resumes or opens a clean one instead of
        // queuing behind a zombie prompt.
        session.tainted = true;
        await this.cancel(session.id).catch(() => {});
        this.settle(
          entry,
          'reject',
          new BridgeTimeoutError('prompt', entry.deadline, error.message),
        );
        return;
      }
      this.settle(entry, 'reject', error);
    } finally {
      session.writer = null;
    }
  }

  project(sessionId, update) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const kind = update?.sessionUpdate ?? update?.type;

    if (kind === 'agent_message_chunk') {
      const text = update?.content?.text;
      if (typeof text !== 'string') return;
      const room = this.maxBufferChars - session.buffer.length;
      if (room > 0) {
        session.buffer += text.slice(0, room);
        if (text.length > room) session.truncated = true;
      } else {
        session.truncated = true;
      }
      session.fullChars += text.length;
      try {
        session.writer?.write(text);
      } catch (error) {
        // Disk pressure must not break the protocol; note it on the session.
        session.writeError = error;
      }
      session.running?.onProgress?.({
        type: 'chunk',
        chars: text.length,
        totalChars: session.fullChars,
        bufferChars: session.buffer.length,
      });
      return;
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const name = update?.title ?? update?.toolName ?? update?.kind;
      if (typeof name === 'string' && name) {
        session.tools.add(name);
        session.running?.onProgress?.({ type: 'tool', name });
      }
      return;
    }

    if (kind === 'usage_update') {
      const usage = { used: update?.used ?? null, size: update?.size ?? null };
      session.usage = usage;
      session.lastUsage = usage;
    }

    this.onUpdate?.(sessionId, kind, update);
  }

  /** Session-level cancel (notification). Safe to call when nothing runs. */
  async cancel(sessionId) {
    if (!this.sessions.has(sessionId)) return;
    await this.client.notify('session/cancel', { sessionId }).catch(() => {});
  }

  async close(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    // Settle anything still queued so callers cannot hang on a closed session.
    for (const entry of session.queue.splice(0)) {
      this.settle(entry, 'reject', new BridgeCancelledError('session closed'));
    }
    await this.client
      .request('session/close', { sessionId }, { timeoutMs: 5_000 })
      .catch(() => {});
  }

  async closeAll() {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }
}
