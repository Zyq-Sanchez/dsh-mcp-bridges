/**
 * Session pool on top of the ACP client.
 *
 * One ACP connection can host several sessions; each session allows one
 * in-flight prompt. Updates are projected into a bounded text buffer so the
 * caller's context stays small — the same budget rule the MCP bridges follow.
 */

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
    return this.sessions.get(sessionId);
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
    const record = {
      id: sessionId,
      cwd,
      buffer: '',
      truncated: false,
      tools: new Set(),
      usage: null,
      stopReason: null,
      queue: Promise.resolve(),
      active: null,
      configOptions: result.configOptions ?? [],
    };
    this.sessions.set(sessionId, record);
    return record;
  }

  /**
   * Submit one prompt and wait for settlement.
   * Per-session calls are serialized; the buffer is reset per prompt.
   */
  async prompt(sessionId, text, { timeoutMs } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);

    const run = async () => {
      session.buffer = '';
      session.truncated = false;
      session.tools.clear();
      session.usage = null;
      session.stopReason = null;

      const result = await this.client.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text }] },
        timeoutMs ? { timeoutMs } : undefined,
      );
      session.stopReason = result?.stopReason ?? 'unknown';
      return {
        text: session.buffer,
        truncated: session.truncated,
        stopReason: session.stopReason,
        tools: [...session.tools],
        usage: session.usage,
      };
    };

    const next = session.queue.then(run, run);
    session.queue = next.catch(() => {});
    return next;
  }

  project(sessionId, update) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const kind = update?.sessionUpdate ?? update?.type;

    if (kind === 'agent_message_chunk') {
      const text = update?.content?.text;
      if (typeof text !== 'string') return;
      const room = this.maxBufferChars - session.buffer.length;
      if (room <= 0) {
        session.truncated = true;
        return;
      }
      session.buffer += text.slice(0, room);
      if (text.length > room) session.truncated = true;
      return;
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const name = update?.title ?? update?.toolName ?? update?.kind;
      if (typeof name === 'string' && name) session.tools.add(name);
      return;
    }

    if (kind === 'usage_update') {
      session.usage = { used: update?.used ?? null, size: update?.size ?? null };
    }

    this.onUpdate?.(sessionId, kind, update);
  }

  async cancel(sessionId) {
    if (!this.sessions.has(sessionId)) return;
    await this.client.notify('session/cancel', { sessionId }).catch(() => {});
  }

  async close(sessionId) {
    if (!this.sessions.has(sessionId)) return;
    this.sessions.delete(sessionId);
    await this.client
      .request('session/close', { sessionId }, { timeoutMs: 5_000 })
      .catch(() => {});
  }

  async closeAll() {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }
}
