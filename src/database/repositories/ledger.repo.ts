import { randomUUID } from 'crypto';
import { getDatabase } from '../connection.js';

export interface LedgerEntry {
  id: string;
  amount: number;
  category: string;
  description: string;
  currency: string;
  entry_date: number;
  created_at: number;
  updated_at: number;
}

export class LedgerRepository {
  private db = getDatabase();

  insertEntry(input: Omit<LedgerEntry, 'id' | 'created_at' | 'updated_at'>): LedgerEntry {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO ledger_entries (id, amount, category, description, currency, entry_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, input.amount, input.category, input.description, input.currency, input.entry_date, now, now);

    return {
      id,
      ...input,
      created_at: now,
      updated_at: now,
    };
  }

  getByDateRange(startDate: number, endDate: number): LedgerEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM ledger_entries
      WHERE entry_date >= ? AND entry_date <= ?
      ORDER BY entry_date DESC
    `);

    const rows = stmt.all(startDate, endDate) as LedgerEntry[];
    return rows;
  }

  getByCategory(category: string, limit: number = 50): LedgerEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM ledger_entries
      WHERE category = ?
      ORDER BY entry_date DESC
      LIMIT ?
    `);

    const rows = stmt.all(category, limit) as LedgerEntry[];
    return rows;
  }

  getSummaryByMonth(year: number, month: number): Record<string, number> {
    const stmt = this.db.prepare(`
      SELECT category, SUM(amount) as total
      FROM ledger_entries
      WHERE strftime('%Y', datetime(entry_date, 'unixepoch')) = ?
        AND strftime('%m', datetime(entry_date, 'unixepoch')) = ?
      GROUP BY category
    `);

    const rows = stmt.all(
      String(year).padStart(4, '0'),
      String(month).padStart(2, '0')
    ) as Array<{ category: string; total: number }>;

    return Object.fromEntries(rows.map(r => [r.category, r.total]));
  }

  updateEntry(id: string, updates: Partial<Omit<LedgerEntry, 'id' | 'created_at'>>): LedgerEntry | null {
    const entry = this.getById(id);
    if (!entry) return null;

    const now = Math.floor(Date.now() / 1000);
    const allowed = new Set(['amount', 'category', 'description', 'currency', 'entry_date']);
    for (const key of Object.keys(updates)) {
      if (!allowed.has(key)) {
        throw new Error(`Invalid ledger column: ${key}`);
      }
    }

    const fields = Object.entries(updates)
      .filter(([_, v]) => v !== undefined)
      .map(([k]) => `${k} = ?`)
      .join(', ');

    if (!fields) return entry;

    const values = Object.values(updates).filter(v => v !== undefined);

    const stmt = this.db.prepare(`
      UPDATE ledger_entries
      SET ${fields}, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(...values, now, id);
    return this.getById(id);
  }

  deleteEntry(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM ledger_entries WHERE id = ?');
    const result = stmt.run(id);
    return (result.changes ?? 0) > 0;
  }

  getById(id: string): LedgerEntry | null {
    const stmt = this.db.prepare('SELECT * FROM ledger_entries WHERE id = ?');
    return (stmt.get(id) as LedgerEntry) || null;
  }
}
