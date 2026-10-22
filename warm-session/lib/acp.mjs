/**
 * ACP stdio transport client.
 *
 * Structure intentionally mirrors the hardening in `subagent-mcp`'s
 * `adapters/acp_stdio.py` (MIT): newline-delimited framing with a line-size cap,
 * JSON-RPC envelope validation, per-request timeouts, reverse-request dedupe and
 * concurrency limits, and a typed error taxonomy. Implementation is independent
 * JavaScript; no code is copied verbatim.
 */

import { spawn } from 'node:child_process';

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REVERSE_IDS = 4096;
const DEFAULT_MAX_ACTIVE_REVERSE = 32;
const STDERR_TAIL_BYTES = 4096;

export class AcpError extends Error {}
export class AcpProtocolError extends AcpError {}
export class AcpProcessError extends AcpError {}
export class AcpTimeoutError extends AcpError {}

export class AcpRpcError extends AcpError {
  constructor(code, message, data) {
    super(`ACP rpc error ${code}: ${message}`);
    this.code = code;
    this.data = data;
  }
}

export class AcpClient {
  constructor({
    command,
    args = [],
    cwd,
    env,
    startupTimeoutMs = 10_000,
    requestTimeoutMs = 30_000,
    closeTimeoutMs = 1_000,
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    maxReverseIds = DEFAULT_MAX_REVERSE_IDS,
    maxActiveReverse = DEFAULT_MAX_ACTIVE_REVERSE,
  }) {
    if (!command) throw new Error('AcpClient requires a command');
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.maxLineBytes = maxLineBytes;
    this.maxReverseIds = maxReverseIds;
    this.maxActiveReverse = maxActiveReverse;

    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.reverseIds = new Map();
    this.activeReverse = 0;
    this.reverseHandler = null;
    this.notificationHandler = null;
    this.stderrTail = '';
    this.closed = false;
    this.terminalError = null;
    this.buffer = '';
    this.startPromise = null;
  }

  /** Spawn the agent process and wire stdio. Resolves once the process exists. */
  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      this.child = child;

      const onSpawnError = (error) => {
        this.fail(new AcpProcessError(`failed to start ACP process: ${error.message}`));
        reject(error);
      };
      child.on('error', onSpawnError);
      child.on('spawn', () => {
        child.off('error', onSpawnError);
        child.on('error', (error) => this.fail(new AcpProcessError(error.message)));
        resolve();
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.onStdout(chunk));

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
      });

      child.on('close', (code, signal) => {
        if (this.closed) return;
        this.fail(
          new AcpProcessError(
            `ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})` +
              (this.stderrTail ? `\n--- stderr tail ---\n${this.stderrTail.trim()}` : ''),
          ),
        );
      });
    });
    return this.startPromise;
  }

  /** Register the handler for agent -> client requests. May return a result object. */
  onReverseRequest(handler) {
    this.reverseHandler = handler;
  }

  /** Register the handler for agent -> client notifications. */
  onNotification(handler) {
    this.notificationHandler = handler;
  }

  async request(method, params = {}, { timeoutMs } = {}) {
    this.ensureUsable();
    const id = this.nextId++;
    const timeout = timeoutMs ?? this.requestTimeoutMs;
    if (!(timeout > 0)) throw new Error('request timeout must be positive');

    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpTimeoutError(`ACP request timed out after ${timeout}ms: ${method}`));
      }, timeout);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer, method });
      this.write(message).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async notify(method, params = {}) {
    this.ensureUsable();
    await this.write({ jsonrpc: '2.0', method, params });
  }

  /** Graceful shutdown: SIGTERM, wait, then SIGKILL. Always settles. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(new AcpProcessError('ACP client closed'));

    const child = this.child;
    if (!child || child.exitCode !== null) return;

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('close', finish);
      this.killTree('SIGTERM');
      const timer = setTimeout(() => {
        this.killTree('SIGKILL');
        finish();
      }, this.closeTimeoutMs);
      timer.unref?.();
    });
  }

  /* ------------------------------------------------------------------ internals */

  ensureUsable() {
    if (this.terminalError) throw this.terminalError;
    if (this.closed) throw new AcpProcessError('ACP client is closed');
    if (!this.child) throw new AcpProcessError('ACP client has not been started');
  }

  fail(error) {
    if (!this.terminalError) this.terminalError = error;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  killTree(signal) {
    const child = this.child;
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  async write(message) {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) {
      throw new AcpProcessError('ACP stdin is not available');
    }
    await new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(new AcpProcessError(`ACP write failed: ${error.message}`));
        else resolve();
      });
    });
  }

  onStdout(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        this.fail(new AcpProtocolError('ACP line exceeds the size limit'));
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new AcpProtocolError('ACP line is not valid JSON'));
        return;
      }
      try {
        this.dispatch(message);
      } catch (error) {
        this.fail(error instanceof AcpError ? error : new AcpProtocolError(String(error)));
        return;
      }
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes) {
      this.fail(new AcpProtocolError('ACP partial line exceeds the size limit'));
    }
  }

  dispatch(message) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      throw new AcpProtocolError('ACP message is not an object');
    }
    if (message.jsonrpc !== '2.0') throw new AcpProtocolError('ACP message is not JSON-RPC 2.0');

    const hasId = message.id !== undefined && message.id !== null;
    const hasMethod = typeof message.method === 'string' && message.method.length > 0;
    const hasResult = message.result !== undefined;
    const hasError = message.error !== undefined;

    if (hasResult || hasError) {
      if (hasMethod || !hasId || hasResult === hasError) {
        throw new AcpProtocolError('ACP response envelope is invalid');
      }
      this.handleResponse(message);
      return;
    }
    if (!hasMethod) throw new AcpProtocolError('ACP message has neither result nor method');

    const params = message.params ?? {};
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new AcpProtocolError('ACP params must be an object');
    }
    if (!hasId) {
      this.notificationHandler?.(message.method, params);
      return;
    }
    this.handleReverse(message);
  }

  handleResponse(message) {
    const entry = this.pending.get(message.id);
    if (!entry) return; // late or duplicate response: ignore
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(
        new AcpRpcError(
          message.error?.code ?? 'unknown',
          message.error?.message ?? 'unknown error',
          message.error?.data,
        ),
      );
    } else {
      entry.resolve(message.result);
    }
  }

  handleReverse(message) {
    const key = String(message.id);
    if (this.reverseIds.has(key)) return; // duplicate id: never answer twice
    this.reverseIds.set(key, true);
    if (this.reverseIds.size > this.maxReverseIds) {
      this.reverseIds.delete(this.reverseIds.keys().next().value);
    }
    if (this.activeReverse >= this.maxActiveReverse) {
      throw new AcpProtocolError('too many concurrent ACP reverse requests');
    }
    this.activeReverse += 1;
    void Promise.resolve()
      .then(() => this.answerReverse(message.method, message.params ?? {}))
      .then(
        (result) => {
          if (result && result.__methodNotFound) {
            return this.write({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: 'Method not found' },
            });
          }
          return this.write({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
        },
        (error) =>
          this.write({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: error?.message || 'handler failed' },
          }),
      )
      .catch(() => {})
      .finally(() => {
        this.activeReverse -= 1;
      });
  }

  async answerReverse(method, params) {
    if (!this.reverseHandler) return { __methodNotFound: true };
    return this.reverseHandler(method, params);
  }
}
