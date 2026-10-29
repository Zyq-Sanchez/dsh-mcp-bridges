/**
 * Result store with a streaming writer.
 *
 * The old bridge kept only a bounded in-memory string and then persisted that
 * same truncated string, so anything past the buffer was unrecoverable. Here the
 * agent_message_chunk stream is written to disk as it arrives, independent of
 * the bounded summary buffer, and the handle always contains the complete text
 * (or the complete partial text when a run fails).
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

const HANDLE_RE = /^run-[a-z0-9]+-\d+$/;

export class ResultStore {
  constructor({ dir, defaultReadChars = 4000, maxReadChars = 8000 } = {}) {
    if (!dir) throw new Error('ResultStore requires a results dir');
    this.dir = dir;
    this.defaultReadChars = defaultReadChars;
    this.maxReadChars = maxReadChars;
    this.seq = 0;
    mkdirSync(this.dir, { recursive: true });
  }

  nextHandle() {
    return `run-${Date.now().toString(36)}-${++this.seq}`;
  }

  static isHandle(value) {
    return typeof value === 'string' && HANDLE_RE.test(value);
  }

  /** Start a streaming writer for one prompt. */
  begin(handle) {
    const h = ResultStore.isHandle(handle) ? handle : this.nextHandle();
    const partial = path.join(this.dir, `${h}.partial`);
    const finalFile = path.join(this.dir, `${h}.md`);
    const fd = openSync(partial, 'w');
    let finished = false;
    let chars = 0;
    return {
      handle: h,
      partial,
      get chars() {
        return chars;
      },
      write(text) {
        if (finished || typeof text !== 'string' || text.length === 0) return;
        writeSync(fd, Buffer.from(text, 'utf8'));
        chars += text.length;
      },
      /** Write the final `.md` (header + full body) and remove the partial file. */
      finish(header) {
        if (finished) return { handle: h, total: -1 };
        finished = true;
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
        let body = '';
        try {
          body = readFileSync(partial, 'utf8');
        } catch {
          body = '';
        }
        const full = header ? `${header}\n\n${body}` : body;
        writeFileSync(finalFile, full, 'utf8');
        try {
          unlinkSync(partial);
        } catch {
          /* ignore */
        }
        return { handle: h, total: full.length, bodyChars: body.length };
      },
    };
  }

  /** One-shot write for small text results (e.g. cancelled before any chunk). */
  store(text, handle) {
    const h = handle && ResultStore.isHandle(handle) ? handle : this.nextHandle();
    writeFileSync(path.join(this.dir, `${h}.md`), String(text ?? ''), 'utf8');
    return { handle: h, total: String(text ?? '').length };
  }

  read(handle, offset, maxChars) {
    if (!ResultStore.isHandle(handle)) {
      throw new Error(`invalid handle: ${String(handle)}`);
    }
    const file = path.join(this.dir, `${handle}.md`);
    if (!existsSync(file)) throw new Error(`unknown handle: ${handle}`);
    const text = readFileSync(file, 'utf8');
    const start = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, text.length));
    const size = Math.min(
      Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : this.defaultReadChars,
      this.maxReadChars,
    );
    const slice = text.slice(start, start + size);
    return { slice, total: text.length, start, end: start + slice.length };
  }
}
