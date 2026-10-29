/**
 * Task -> session binding registry.
 *
 * The bridge no longer reuses a warm session per working directory. Instead a
 * task_id is bound to one ACP session and persisted locally, so a later call
 * for the SAME objective continues the same session, while a different
 * objective starts clean by default.
 *
 * Storage is a single JSON file in the bridge state dir. It is written with
 * temp-file + rename so a crash cannot leave a truncated file. Lookups for the
 * current task are O(1); listing is capped by the caller and never scans session
 * transcripts (the registry only holds short metadata).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REGISTRY_VERSION = 1;
const MAX_TASK_ID_LEN = 64;

function isoNow() {
  return new Date().toISOString();
}

function normalizeTaskId(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_TASK_ID_LEN);
}

function slugFromGoal(goal) {
  return String(goal || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

export class TaskRegistry {
  constructor({ dir } = {}) {
    if (!dir) throw new Error('TaskRegistry requires a state dir');
    this.dir = dir;
    this.file = path.join(dir, 'tasks.json');
    this.tasks = new Map();
    this.loadError = null;
    this.load();
  }

  load() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      const list = Array.isArray(raw?.tasks) ? raw.tasks : Array.isArray(raw) ? raw : [];
      for (const task of list) {
        const taskId = normalizeTaskId(task?.task_id);
        if (!taskId) continue;
        this.tasks.set(taskId, {
          ...task,
          task_id: taskId,
          goal: typeof task.goal === 'string' ? task.goal : '',
          project: typeof task.project === 'string' ? task.project : '',
          session_id: typeof task.session_id === 'string' ? task.session_id : null,
          status: typeof task.status === 'string' ? task.status : 'active',
          summary: typeof task.summary === 'string' ? task.summary : '',
          turns: Number.isFinite(task.turns) ? task.turns : 0,
        });
      }
    } catch (error) {
      this.loadError = error;
      // Preserve the unreadable file for inspection; start from an empty map so
      // a corrupt registry never takes the whole bridge down.
      const bad = `${this.file}.corrupt-${Date.now()}`;
      try {
        renameSync(this.file, bad);
      } catch {
        /* ignore */
      }
    }
  }

  save() {
    mkdirSync(this.dir, { recursive: true });
    const payload = JSON.stringify(
      { version: REGISTRY_VERSION, tasks: [...this.tasks.values()] },
      null,
      2,
    );
    const tmp = path.join(this.dir, `tasks.json.tmp-${process.pid}`);
    writeFileSync(tmp, payload, 'utf8');
    try {
      renameSync(tmp, this.file);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  get(taskId) {
    const id = normalizeTaskId(taskId);
    return id ? this.tasks.get(id) ?? null : null;
  }

  findBySession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    for (const task of this.tasks.values()) {
      if (task.session_id === sessionId) return task;
    }
    return null;
  }

  upsert(task) {
    const taskId = normalizeTaskId(task?.task_id);
    if (!taskId) throw new Error('upsert requires a task_id');
    const now = isoNow();
    const previous = this.tasks.get(taskId);
    const next = {
      task_id: taskId,
      goal: typeof task.goal === 'string' ? task.goal : previous?.goal ?? '',
      project: typeof task.project === 'string' ? task.project : previous?.project ?? '',
      session_id:
        task.session_id === undefined ? previous?.session_id ?? null : task.session_id || null,
      status: typeof task.status === 'string' ? task.status : previous?.status ?? 'active',
      summary:
        typeof task.summary === 'string' ? task.summary : previous?.summary ?? '',
      turns: Number.isFinite(task.turns) ? task.turns : previous?.turns ?? 0,
      usage: task.usage === undefined ? previous?.usage ?? null : task.usage,
      handoff_count: Number.isFinite(task.handoff_count)
        ? task.handoff_count
        : previous?.handoff_count ?? 0,
      last_session_ids: Array.isArray(task.last_session_ids)
        ? task.last_session_ids
        : previous?.last_session_ids ?? [],
      created_at: previous?.created_at ?? task.created_at ?? now,
      updated_at: now,
    };
    this.tasks.set(taskId, next);
    this.save();
    return next;
  }

  patch(taskId, patch) {
    const current = this.get(taskId);
    if (!current) return null;
    return this.upsert({ ...current, ...patch });
  }

  all() {
    return [...this.tasks.values()];
  }

  /**
   * Compact candidate search. Deliberately capped: the goal is to recover a
   * task_id, not to replay history. Returns [] for an empty database.
   */
  search({ query, project, limit = 3 } = {}) {
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const projectPath = typeof project === 'string' && project ? path.resolve(project) : '';
    const max = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 3, 5));
    const matches = [];
    for (const task of this.tasks.values()) {
      if (projectPath && path.resolve(task.project || '/') !== projectPath) continue;
      if (needle) {
        const haystack = `${task.task_id}\n${task.goal}\n${task.summary}\n${task.project}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      matches.push(task);
    }
    matches.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return matches.slice(0, max).map((task) => ({
      task_id: task.task_id,
      goal: task.goal,
      project: task.project,
      session_id: task.session_id,
      status: task.status,
      turns: task.turns,
      updated_at: task.updated_at,
      summary: String(task.summary || '').slice(0, 160),
    }));
  }

  newTaskId(goal = '') {
    const slug = slugFromGoal(goal);
    const base = `t-${Date.now().toString(36)}`;
    let id = slug ? `${slug}-${base}` : base;
    let attempt = 0;
    while (this.tasks.has(id)) {
      attempt += 1;
      id = `${slug ? `${slug}-` : ''}${base}-${attempt}`;
    }
    return id;
  }
}
