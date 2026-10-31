import { randomUUID } from 'crypto';
import { getDatabase } from '../connection.js';
import { VAULT_FTS5_SNIPPET_SIZE } from '@/config/constants.js';

export interface VaultNote {
  id: string;
  content: string;
  tags: string | null;
  user_jid: string;
  created_at: number;
  updated_at: number;
}

export interface VaultMedia {
  id: string;
  note_id: string;
  media_type: 'image' | 'audio' | 'video' | 'document';
  file_path: string;
  file_size: number;
  mime_type: string | null;
  created_at: number;
}

export interface SearchResult {
  note: VaultNote;
  snippet: string;
  rank: number;
}

export class VaultRepository {
  private db = getDatabase();

  insertNote(input: Omit<VaultNote, 'id' | 'created_at' | 'updated_at'>): VaultNote {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO vault_notes (id, content, tags, user_jid, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, input.content, input.tags, input.user_jid, now, now);

    return {
      id,
      ...input,
      created_at: now,
      updated_at: now,
    };
  }

  searchNotes(userJid: string, query: string, limit: number = 20): SearchResult[] {
    const stmt = this.db.prepare(`
      SELECT
        vault_notes.*,
        snippet(vault_fts, 0, '<mark>', '</mark>', '...', ${VAULT_FTS5_SNIPPET_SIZE}) as snippet,
        rank
      FROM vault_fts
      JOIN vault_notes ON vault_fts.rowid = vault_notes.rowid
      WHERE vault_fts MATCH ? AND vault_notes.user_jid = ?
      ORDER BY rank DESC
      LIMIT ?
    `);

    const rows = stmt.all(query, userJid, limit) as Array<VaultNote & { snippet: string; rank: number }>;

    return rows.map(row => ({
      note: {
        id: row.id,
        content: row.content,
        tags: row.tags,
        user_jid: row.user_jid,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      snippet: row.snippet,
      rank: row.rank,
    }));
  }

  getNoteById(id: string): VaultNote | null {
    const stmt = this.db.prepare('SELECT * FROM vault_notes WHERE id = ?');
    return (stmt.get(id) as VaultNote) || null;
  }

  getNotesByUser(userJid: string, limit: number = 50): VaultNote[] {
    const stmt = this.db.prepare(`
      SELECT * FROM vault_notes
      WHERE user_jid = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    return stmt.all(userJid, limit) as VaultNote[];
  }

  updateNote(id: string, updates: Partial<Omit<VaultNote, 'id' | 'user_jid' | 'created_at'>>): VaultNote | null {
    const note = this.getNoteById(id);
    if (!note) return null;

    const now = Math.floor(Date.now() / 1000);
    const allowed = new Set(['content', 'tags']);
    for (const key of Object.keys(updates)) {
      if (!allowed.has(key)) {
        throw new Error(`Invalid vault column: ${key}`);
      }
    }

    const fields = Object.entries(updates)
      .filter(([_, v]) => v !== undefined)
      .map(([k]) => `${k} = ?`)
      .join(', ');

    if (!fields) return note;

    const values = Object.values(updates).filter(v => v !== undefined);

    const stmt = this.db.prepare(`
      UPDATE vault_notes
      SET ${fields}, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(...values, now, id);
    return this.getNoteById(id);
  }

  deleteNote(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM vault_notes WHERE id = ?');
    const result = stmt.run(id);
    return (result.changes ?? 0) > 0;
  }

  insertMedia(input: Omit<VaultMedia, 'id' | 'created_at'>): VaultMedia {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      INSERT INTO vault_media (id, note_id, media_type, file_path, file_size, mime_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, input.note_id, input.media_type, input.file_path, input.file_size, input.mime_type, now);

    return {
      id,
      ...input,
      created_at: now,
    };
  }

  getMediaByNoteId(noteId: string): VaultMedia[] {
    const stmt = this.db.prepare('SELECT * FROM vault_media WHERE note_id = ?');
    return stmt.all(noteId) as VaultMedia[];
  }

  deleteMedia(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM vault_media WHERE id = ?');
    const result = stmt.run(id);
    return (result.changes ?? 0) > 0;
  }
}
