import { getDatabase } from '../connection.js';

export type HabitFrequency = 'daily' | 'weekly';

export interface Habit {
  id: number;
  user_jid: string;
  name: string;
  name_key: string;
  frequency: HabitFrequency;
  reminder_time: string | null;
  last_reminded_period: string | null;
  created_at: number;
  updated_at: number;
}

export interface HabitLog {
  id: number;
  habit_id: number;
  period_key: string;
  logged_at: number;
}

export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export class HabitRepository {
  private get db() {
    return getDatabase();
  }

  insert(input: { user_jid: string; name: string; frequency?: HabitFrequency; reminder_time?: string | null }): Habit {
    const now = Math.floor(Date.now() / 1000);
    const name = input.name.trim().replace(/\s+/g, ' ');
    const result = this.db
      .prepare(
        `INSERT INTO habits (user_jid, name, name_key, frequency, reminder_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.user_jid, name, nameKey(name), input.frequency ?? 'daily', input.reminder_time ?? null, now, now);
    return this.getById(input.user_jid, Number(result.lastInsertRowid)) as Habit;
  }

  getById(userJid: string, id: number): Habit | null {
    const row = this.db.prepare('SELECT * FROM habits WHERE id = ? AND user_jid = ?').get(id, userJid);
    return (row as Habit) || null;
  }

  getByName(userJid: string, name: string): Habit | null {
    const row = this.db
      .prepare('SELECT * FROM habits WHERE user_jid = ? AND name_key = ?')
      .get(userJid, nameKey(name));
    return (row as Habit) || null;
  }

  list(userJid: string): Habit[] {
    return this.db.prepare('SELECT * FROM habits WHERE user_jid = ? ORDER BY id ASC').all(userJid) as Habit[];
  }

  update(userJid: string, id: number, changes: { frequency?: HabitFrequency; reminder_time?: string | null }): Habit | null {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (changes.frequency !== undefined) {
      sets.push('frequency = ?');
      params.push(changes.frequency);
    }
    if (changes.reminder_time !== undefined) {
      sets.push('reminder_time = ?');
      params.push(changes.reminder_time);
    }
    if (sets.length === 0) return this.getById(userJid, id);
    sets.push('updated_at = ?');
    params.push(Math.floor(Date.now() / 1000));
    params.push(id, userJid);
    this.db.prepare(`UPDATE habits SET ${sets.join(', ')} WHERE id = ? AND user_jid = ?`).run(...params);
    return this.getById(userJid, id);
  }

  remove(userJid: string, id: number): boolean {
    const result = this.db.prepare('DELETE FROM habits WHERE id = ? AND user_jid = ?').run(id, userJid);
    return (result.changes ?? 0) > 0;
  }

  // Mengembalikan true bila log baru tercatat, false bila periode itu sudah terisi.
  addLog(habitId: number, periodKey: string, loggedAt: number = Math.floor(Date.now() / 1000)): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO habit_logs (habit_id, period_key, logged_at) VALUES (?, ?, ?)')
      .run(habitId, periodKey, loggedAt);
    return (result.changes ?? 0) > 0;
  }

  hasLog(habitId: number, periodKey: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM habit_logs WHERE habit_id = ? AND period_key = ?').get(habitId, periodKey));
  }

  getLogs(habitId: number): HabitLog[] {
    return this.db
      .prepare('SELECT * FROM habit_logs WHERE habit_id = ? ORDER BY period_key ASC')
      .all(habitId) as HabitLog[];
  }

  getPeriodKeys(habitId: number): string[] {
    return (
      this.db.prepare('SELECT period_key FROM habit_logs WHERE habit_id = ? ORDER BY period_key ASC').all(habitId) as Array<{
        period_key: string;
      }>
    ).map((r) => r.period_key);
  }

  // Habit dengan reminder aktif, dipakai oleh scheduler reminder otomatis.
  listWithReminder(): Habit[] {
    return this.db.prepare('SELECT * FROM habits WHERE reminder_time IS NOT NULL').all() as Habit[];
  }

  markReminded(id: number, periodKey: string): void {
    this.db.prepare('UPDATE habits SET last_reminded_period = ? WHERE id = ?').run(periodKey, id);
  }
}
