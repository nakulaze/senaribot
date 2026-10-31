import { getDatabase } from '@/database/connection.js';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class AiRepository {
  addMessage(userJid: string, role: AiMessage['role'], content: string): void {
    getDatabase()
      .prepare('INSERT INTO ai_messages (user_jid, role, content) VALUES (?, ?, ?)')
      .run(userJid, role, content);
  }

  /** Simpan pasangan pertanyaan-jawaban secara atomik dalam satu transaksi. */
  addExchange(userJid: string, question: string, answer: string, keep: number): void {
    const db = getDatabase();
    const insert = db.prepare('INSERT INTO ai_messages (user_jid, role, content) VALUES (?, ?, ?)');
    const run = db.transaction(() => {
      insert.run(userJid, 'user', question);
      insert.run(userJid, 'assistant', answer);
      this.trim(userJid, keep);
    });
    run();
  }

  getHistory(userJid: string, limit: number): AiMessage[] {
    const rows = getDatabase()
      .prepare('SELECT role, content FROM ai_messages WHERE user_jid = ? ORDER BY id DESC LIMIT ?')
      .all(userJid, limit) as AiMessage[];
    return rows.reverse();
  }

  clearHistory(userJid: string): number {
    return getDatabase().prepare('DELETE FROM ai_messages WHERE user_jid = ?').run(userJid).changes;
  }

  trim(userJid: string, keep: number): void {
    getDatabase()
      .prepare(
        'DELETE FROM ai_messages WHERE user_jid = ? AND id NOT IN (SELECT id FROM ai_messages WHERE user_jid = ? ORDER BY id DESC LIMIT ?)',
      )
      .run(userJid, userJid, keep);
  }
}

export const aiRepo = new AiRepository();
