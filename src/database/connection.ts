import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { childLogger } from '@/utils/logger.js';

const log = childLogger('database');
const __dirname = join(fileURLToPath(import.meta.url), '..');

let dbInstance: Database.Database | null = null;

export function initializeDatabase(dbPath: string): Database.Database {
  if (dbInstance) return dbInstance;

  try {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    dbInstance = new Database(dbPath);

    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('synchronous = NORMAL');
    dbInstance.pragma('cache_size = -64000');
    dbInstance.pragma('foreign_keys = ON');
    dbInstance.pragma('temp_store = MEMORY');

    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    dbInstance.exec(schema);

    log.info('database initialized at %s', dbPath);
    return dbInstance;
  } catch (error) {
    log.error(error, 'failed to initialize database');
    throw error;
  }
}

export function getDatabase(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initializeDatabase first.');
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    log.info('database connection closed');
  }
}
