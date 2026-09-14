import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BridgeError } from '../errors.js';
import type { StoredTask } from '../types.js';

export class TaskStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, workspace_key TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_writer ON tasks(workspace_key) WHERE status NOT IN ('completed','failed','stopped');
      CREATE TABLE IF NOT EXISTS operations (request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);`);
  }
  // Short per-task leases serialize RPC mutations across independent MCP processes.
  acquire(owner: string, name = 'manager', now = Date.now()): boolean {
    return this.db.prepare(`INSERT INTO leases VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE leases.expires < ? OR leases.owner=?`).run(name, owner, now + 60000, now, owner).changes === 1;
  }
  release(owner: string) { this.db.prepare('DELETE FROM leases WHERE owner=?').run(owner); }
  reserve(task: StoredTask): { task: StoredTask; created: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.byRequest(task.request_id);
      if (old) {
        if (old.fingerprint !== task.fingerprint) throw new BridgeError('REQUEST_CONFLICT', 'request_id was already used with different task content.');
        this.db.exec('COMMIT'); return { task: old, created: false };
      }
      const busy = this.db.prepare("SELECT id FROM tasks WHERE workspace_key=? AND status NOT IN ('completed','failed','stopped')").get(task.workspace_key);
      if (busy) throw new BridgeError('WORKSPACE_BUSY', `Workspace already reserved by ${busy.id}. Resolve or stop that task first.`);
      this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?)').run(task.task_id, task.request_id, task.workspace_key, task.status, JSON.stringify(task));
      this.db.exec('COMMIT'); return { task, created: true };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  byRequest(id: string): StoredTask | undefined { return this.decode(this.db.prepare('SELECT body FROM tasks WHERE request_id=?').get(id)); }
  get(id: string): StoredTask {
    const task = this.decode(this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id));
    if (!task) throw new BridgeError('TASK_NOT_FOUND', `Unknown plugin task: ${id}`);
    return task;
  }
  list(): StoredTask[] { return this.db.prepare('SELECT body FROM tasks ORDER BY rowid DESC').all().map(r => this.decode(r)!); }
  save(task: StoredTask) {
    try { this.db.prepare('UPDATE tasks SET status=?,body=? WHERE id=?').run(task.status, JSON.stringify(task), task.task_id); }
    catch(e) { if(String(e).includes('UNIQUE constraint')) throw new BridgeError('WORKSPACE_BUSY', 'Another task currently reserves this workspace.'); throw e; }
  }
  private decode(row: Record<string, unknown> | undefined): StoredTask | undefined { return row ? JSON.parse(String(row.body)) : undefined; }
  operation(request: string, task: string, fingerprint: string): 'pending' | 'done' | undefined {
    const row = this.db.prepare('SELECT * FROM operations WHERE request_id=?').get(request);
    if (row) {
      if (row.task_id !== task || row.fingerprint !== fingerprint) throw new BridgeError('REQUEST_CONFLICT', 'Message request_id was already used with different content.');
      return row.state as 'pending' | 'done';
    }
    return undefined;
  }
  reserveOperation(request: string, task: string, fingerprint: string): 'new' | 'pending' | 'done' {
    const state = this.operation(request, task, fingerprint);
    if (state) return state;
    this.db.prepare("INSERT INTO operations VALUES (?,?,?,'pending',NULL)").run(request, task, fingerprint);
    return 'new';
  }
  reserveFollowup(task: StoredTask, request: string, fingerprint: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.save(task); const state = this.reserveOperation(request,task.task_id,fingerprint); this.db.exec('COMMIT'); return state; }
    catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  completeOperation(request: string) { this.db.prepare("UPDATE operations SET state='done' WHERE request_id=?").run(request); }
  close() { this.db.close(); }
}
