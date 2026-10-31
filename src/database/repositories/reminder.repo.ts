import { randomUUID } from 'crypto';
import { getDatabase } from '../connection.js';

export type ReminderState = 'pending' | 'sent' | 'snoozed' | 'completed' | 'cancelled';

export interface Reminder {
  id: string;
  user_jid: string;
  title: string;
  description: string | null;
  trigger_time: number;
  state: ReminderState;
  snooze_count: number;
  recurrence: string | null;
  created_at: number;
  updated_at: number;
}

export class ReminderRepository {
  private db = getDatabase();

  insertReminder(input: Omit<Reminder, 'id' | 'created_at' | 'updated_at' | 'snooze_count'>): Reminder {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO reminders (id, user_jid, title, description, trigger_time, state, snooze_count, recurrence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `);

    stmt.run(
      id,
      input.user_jid,
      input.title,
      input.description,
      input.trigger_time,
      input.state,
      input.recurrence,
      now,
      now
    );

    return {
      id,
      ...input,
      snooze_count: 0,
      created_at: now,
      updated_at: now,
    };
  }

  getPendingReminders(): Reminder[] {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      SELECT * FROM reminders
      WHERE state IN ('pending', 'snoozed')
        AND trigger_time <= ?
      ORDER BY trigger_time ASC
    `);

    return stmt.all(now) as Reminder[];
  }

  getRemindersByUser(userJid: string): Reminder[] {
    const stmt = this.db.prepare(`
      SELECT * FROM reminders
      WHERE user_jid = ?
      ORDER BY trigger_time DESC
    `);

    return stmt.all(userJid) as Reminder[];
  }

  getById(id: string): Reminder | null {
    const stmt = this.db.prepare('SELECT * FROM reminders WHERE id = ?');
    return (stmt.get(id) as Reminder) || null;
  }

  updateState(id: string, state: ReminderState): Reminder | null {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      UPDATE reminders
      SET state = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(state, now, id);
    return this.getById(id);
  }

  snooze(id: string, snoozeUntil: number): Reminder | null {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      UPDATE reminders
      SET state = 'snoozed', trigger_time = ?, snooze_count = snooze_count + 1, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(snoozeUntil, now, id);
    return this.getById(id);
  }

  deleteReminder(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM reminders WHERE id = ?');
    const result = stmt.run(id);
    return (result.changes ?? 0) > 0;
  }

  getUpcomingReminders(userJid: string, limit: number = 10): Reminder[] {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      SELECT * FROM reminders
      WHERE user_jid = ? AND state IN ('pending', 'snoozed') AND trigger_time > ?
      ORDER BY trigger_time ASC
      LIMIT ?
    `);

    return stmt.all(userJid, now, limit) as Reminder[];
  }
}
