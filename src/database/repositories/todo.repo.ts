import { getDatabase } from '../connection.js';

export type TodoPriority = 'low' | 'medium' | 'high';
export type TodoStatus = 'pending' | 'done';

export interface TodoTask {
  id: number;
  user_jid: string;
  title: string;
  category: string | null;
  priority: TodoPriority;
  deadline: number | null;
  status: TodoStatus;
  reminder_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface NewTodo {
  user_jid: string;
  title: string;
  category?: string | null;
  priority?: TodoPriority;
  deadline?: number | null;
  reminder_id?: string | null;
}

export interface TodoUpdate {
  title?: string;
  category?: string | null;
  priority?: TodoPriority;
  deadline?: number | null;
  reminder_id?: string | null;
}

export interface TodoStats {
  total: number;
  pending: number;
  done: number;
  overdue: number;
  byPriority: Record<TodoPriority, number>;
}

export interface TodoFilter {
  status?: TodoStatus;
  category?: string;
  priority?: TodoPriority;
}

// Urutan: pending dulu, deadline terdekat dulu (tanpa deadline paling akhir),
// lalu prioritas High > Medium > Low, terakhir id.
const ORDER_SQL = `ORDER BY
  CASE status WHEN 'pending' THEN 0 ELSE 1 END,
  CASE WHEN deadline IS NULL THEN 1 ELSE 0 END,
  deadline ASC,
  CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
  id ASC`;

export class TodoRepository {
  private get db() {
    return getDatabase();
  }

  insert(input: NewTodo): TodoTask {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .prepare(
        `INSERT INTO todo_tasks (user_jid, title, category, priority, deadline, status, reminder_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        input.user_jid,
        input.title,
        input.category ?? null,
        input.priority ?? 'medium',
        input.deadline ?? null,
        input.reminder_id ?? null,
        now,
        now,
      );
    return this.getById(input.user_jid, Number(result.lastInsertRowid)) as TodoTask;
  }

  getById(userJid: string, id: number): TodoTask | null {
    const row = this.db.prepare('SELECT * FROM todo_tasks WHERE id = ? AND user_jid = ?').get(id, userJid);
    return (row as TodoTask) || null;
  }

  list(userJid: string, filter: TodoFilter = {}): TodoTask[] {
    const where = ['user_jid = ?'];
    const params: Array<string | number> = [userJid];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.category) {
      where.push('LOWER(category) = LOWER(?)');
      params.push(filter.category);
    }
    if (filter.priority) {
      where.push('priority = ?');
      params.push(filter.priority);
    }
    return this.db
      .prepare(`SELECT * FROM todo_tasks WHERE ${where.join(' AND ')} ${ORDER_SQL}`)
      .all(...params) as TodoTask[];
  }

  update(userJid: string, id: number, changes: TodoUpdate): TodoTask | null {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (changes.title !== undefined) {
      sets.push('title = ?');
      params.push(changes.title);
    }
    if (changes.category !== undefined) {
      sets.push('category = ?');
      params.push(changes.category);
    }
    if (changes.priority !== undefined) {
      sets.push('priority = ?');
      params.push(changes.priority);
    }
    if (changes.deadline !== undefined) {
      sets.push('deadline = ?');
      params.push(changes.deadline);
    }
    if (changes.reminder_id !== undefined) {
      sets.push('reminder_id = ?');
      params.push(changes.reminder_id);
    }
    if (sets.length === 0) return this.getById(userJid, id);
    sets.push('updated_at = ?');
    params.push(Math.floor(Date.now() / 1000));
    params.push(id, userJid);
    this.db.prepare(`UPDATE todo_tasks SET ${sets.join(', ')} WHERE id = ? AND user_jid = ?`).run(...params);
    return this.getById(userJid, id);
  }

  setStatus(userJid: string, id: number, status: TodoStatus): TodoTask | null {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare('UPDATE todo_tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND user_jid = ?')
      .run(status, status === 'done' ? now : null, now, id, userJid);
    return this.getById(userJid, id);
  }

  remove(userJid: string, id: number): boolean {
    const result = this.db.prepare('DELETE FROM todo_tasks WHERE id = ? AND user_jid = ?').run(id, userJid);
    return (result.changes ?? 0) > 0;
  }

  removeAll(userJid: string, status?: TodoStatus): number {
    const result = status
      ? this.db.prepare('DELETE FROM todo_tasks WHERE user_jid = ? AND status = ?').run(userJid, status)
      : this.db.prepare('DELETE FROM todo_tasks WHERE user_jid = ?').run(userJid);
    return result.changes ?? 0;
  }

  stats(userJid: string, nowUnix: number = Math.floor(Date.now() / 1000)): TodoStats {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done,
           COALESCE(SUM(CASE WHEN status = 'pending' AND deadline IS NOT NULL AND deadline < ? THEN 1 ELSE 0 END), 0) AS overdue,
           COALESCE(SUM(CASE WHEN status = 'pending' AND priority = 'high' THEN 1 ELSE 0 END), 0) AS high,
           COALESCE(SUM(CASE WHEN status = 'pending' AND priority = 'medium' THEN 1 ELSE 0 END), 0) AS medium,
           COALESCE(SUM(CASE WHEN status = 'pending' AND priority = 'low' THEN 1 ELSE 0 END), 0) AS low
         FROM todo_tasks WHERE user_jid = ?`,
      )
      .get(nowUnix, userJid) as Record<string, number>;
    return {
      total: row.total,
      pending: row.pending,
      done: row.done,
      overdue: row.overdue,
      byPriority: { high: row.high, medium: row.medium, low: row.low },
    };
  }
}
