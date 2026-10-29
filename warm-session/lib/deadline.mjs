/**
 * One wall-clock budget for one bridge call.
 *
 * The same deadline is handed to every phase (process startup, `initialize`,
 * session create/resume, queue wait, and the prompt itself), so a call can never
 * silently spend its budget twice. Errors carry the phase that ran out so the
 * caller can tell "startup was slow" from "the model turn was slow".
 */

export class BridgeError extends Error {
  constructor(message, code = 'BRIDGE_ERROR') {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class BridgeTimeoutError extends BridgeError {
  constructor(phase, deadline, detail) {
    const elapsed = deadline?.elapsed?.() ?? null;
    const budget = deadline?.totalMs ?? null;
    const suffix = [
      elapsed == null ? null : `after ${elapsed}ms`,
      budget == null ? null : `budget ${budget}ms`,
      detail || null,
    ]
      .filter(Boolean)
      .join(', ');
    super(`timeout during ${phase}${suffix ? ` (${suffix})` : ''}`, 'TIMEOUT');
    this.phase = phase;
    this.elapsedMs = elapsed;
    this.budgetMs = budget;
  }
}

export class BridgeCancelledError extends BridgeError {
  constructor(phase = 'call') {
    super(`cancelled during ${phase}`, 'CANCELLED');
    this.phase = phase;
  }
}

/** Invalid tool arguments / binding mismatch. Never a transport failure. */
export class BridgeUsageError extends BridgeError {
  constructor(message) {
    super(message, 'USAGE');
  }
}

export class Deadline {
  constructor(totalMs, label = 'call') {
    const safe = Number.isFinite(totalMs) && totalMs > 0 ? Math.floor(totalMs) : 1;
    this.totalMs = safe;
    this.label = label;
    this.startedAt = Date.now();
    this.phases = [];
  }

  elapsed() {
    return Date.now() - this.startedAt;
  }

  remaining() {
    return Math.max(0, this.totalMs - this.elapsed());
  }

  expired() {
    return this.remaining() <= 0;
  }

  /** Record the duration of a phase that already finished. */
  phase(name, elapsedMs) {
    this.phases.push({ name, ms: Math.max(0, Math.round(elapsedMs)) });
    return this;
  }

  snapshot() {
    return {
      total_ms: this.totalMs,
      elapsed_ms: this.elapsed(),
      remaining_ms: this.remaining(),
      phases: [...this.phases],
    };
  }
}

/**
 * Resolve `promise` or reject with BridgeTimeoutError after `ms`.
 *
 * The wrapped promise always keeps its own handlers attached, so a late
 * rejection after the timeout cannot become an unhandled rejection.
 */
export function withTimeout(promise, ms, phase, deadline) {
  const budget = Math.max(1, Math.floor(Number(ms)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new BridgeTimeoutError(phase, deadline, `waited ${budget}ms`));
    }, budget);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
