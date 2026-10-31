import { SignalKeyStore, AuthenticationCreds, initAuthCreds } from '@whiskeysockets/baileys';
import { getDatabase } from '@/database/connection.js';
import { childLogger } from '@/utils/logger.js';

const log = childLogger('auth-sqlite');

export class SqliteSignalKeyStore implements SignalKeyStore {
  private db = getDatabase();

  async get(type: string, ids: string[]): Promise<{ [_: string]: any }> {
    const result: { [_: string]: any } = {};

    for (const id of ids) {
      const stmt = this.db.prepare(
        'SELECT data FROM auth_keys WHERE type = ? AND id = ?'
      );
      const row = stmt.get(type, id) as { data: Buffer } | undefined;

      if (row) {
        try {
          result[id] = JSON.parse(row.data.toString());
        } catch (err) {
          log.warn({ id, type, err }, 'failed to parse stored key');
        }
      }
    }

    return result;
  }

  async set(data: { [_: string]: { [_: string]: any } }): Promise<void> {
    for (const [type, entries] of Object.entries(data)) {
      for (const [id, value] of Object.entries(entries)) {
        const serialized = JSON.stringify(value);
        const now = Math.floor(Date.now() / 1000);

        const stmt = this.db.prepare(`
          INSERT INTO auth_keys (id, type, data, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
        `);

        stmt.run(id, type, Buffer.from(serialized), now, now);
      }
    }
  }
}

export class SqliteAuthStore {
  private db = getDatabase();
  private creds: AuthenticationCreds | null = null;

  async loadCreds(): Promise<AuthenticationCreds> {
    if (this.creds) return this.creds;

    try {
      const stmt = this.db.prepare(
        'SELECT data FROM auth_credentials WHERE id = ?'
      );
      const row = stmt.get('creds') as { data: string } | undefined;

      if (row) {
        const parsed = JSON.parse(row.data);
        this.creds = parsed as AuthenticationCreds;
        return this.creds;
      }

      const newCreds = initAuthCreds();
      this.creds = newCreds;
      await this.saveCreds(newCreds);
      return newCreds;
    } catch (error) {
      log.error(error, 'failed to load credentials');
      const newCreds = initAuthCreds();
      this.creds = newCreds;
      await this.saveCreds(newCreds);
      return newCreds;
    }
  }

  async saveCreds(creds: AuthenticationCreds): Promise<void> {
    try {
      this.creds = creds;
      const serialized = JSON.stringify(creds);
      const now = Math.floor(Date.now() / 1000);

      const stmt = this.db.prepare(`
        INSERT INTO auth_credentials (id, data, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
      `);

      stmt.run('creds', serialized, now, now);
    } catch (error) {
      log.error(error, 'failed to save credentials');
      throw error;
    }
  }

  getCreds(): AuthenticationCreds | null {
    return this.creds;
  }
}
