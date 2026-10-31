import {
  copyFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  writeFileSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
} from 'fs';
import { join, dirname, basename } from 'path';
import Database from 'better-sqlite3';
import { getDatabase, closeDatabase } from '@/database/connection.js';
import { getConfig } from '@/config/env.js';
import { childLogger } from '@/utils/logger.js';

const log = childLogger('backup');

const MAX_BACKUPS = 7;

function getBackupDir(dbPath?: string): string {
  const config = getConfig();
  const targetDb = dbPath ?? config.SENARIBOT_DB_PATH;
  const backupDir = join(dirname(targetDb), 'backups');
  mkdirSync(backupDir, { recursive: true });
  return backupDir;
}

function formatTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
}

export function generateBackupPath(dbPath?: string): string {
  const config = getConfig();
  const targetDb = dbPath ?? config.SENARIBOT_DB_PATH;
  const backupDir = getBackupDir(targetDb);
  const timestamp = formatTimestamp();
  const baseName = basename(targetDb).replace(/\.db$/, '');
  return join(backupDir, `${baseName}.backup.${timestamp}.db`);
}

function getRetention(): number {
  const raw = process.env.SENARIBOT_BACKUP_RETENTION;
  if (raw && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= 30) return n;
  }
  return MAX_BACKUPS;
}

export function listBackups(dbPath?: string): string[] {
  const backupDir = getBackupDir(dbPath);
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .sort()
    .filter((f) => f.endsWith('.db') && !f.endsWith('.part'));
}

function cleanupOldBackups(keep: number, dbPath?: string): void {
  const backups = listBackups(dbPath);
  for (const backup of backups.slice(0, Math.max(0, backups.length - keep))) {
    try {
      unlinkSync(join(getBackupDir(dbPath), backup));
      log.info('removed old backup %s', backup);
    } catch (error) {
      log.warn('failed to remove old backup %s: %s', backup, error instanceof Error ? error.message : 'unknown');
    }
  }
}

export function checkBackupIntegrity(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const fd = openSync(filePath, 'r');
    const header = Buffer.alloc(32);
    readSync(fd, header, 0, 32, 0);
    closeSync(fd);

    const magic = header.toString('utf8', 0, 16);
    if (magic !== 'SQLite format 3\0') return false;

    const rawPageSize = header.readUInt16BE(16);
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    const pageCount = header.readUInt32BE(28);
    const expectedSize = pageSize * pageCount;
    const actualSize = statSync(filePath).size;

    if (expectedSize > 0 && actualSize !== expectedSize) {
      return false;
    }

    const verifyDb = new Database(filePath, { readonly: true, fileMustExist: true });
    const result = verifyDb.pragma('integrity_check') as any[];
    verifyDb.close();

    return (
      Array.isArray(result) &&
      result.length === 1 &&
      (result[0] === 'ok' || result[0]?.integrity_check === 'ok')
    );
  } catch (err) {
    log.warn('integrity check error: %s', err instanceof Error ? err.message : 'unknown');
    return false;
  }
}

export function createBackup(dbPathOverride?: string): { success: boolean; path: string | null; error?: string } {
  const config = getConfig();
  const dbPath = dbPathOverride ?? config.SENARIBOT_DB_PATH;

  if (!dbPath || dbPath === ':memory:') {
    return { success: false, path: null, error: 'No file database configured for backup' };
  }

  if (!existsSync(dbPath)) {
    return { success: false, path: null, error: 'Database file does not exist' };
  }

  const backupDir = getBackupDir(dbPath);
  const lockPath = join(backupDir, '.backup.lock');

  try {
    if (existsSync(lockPath)) {
      const lockedAt = new Date(statSync(lockPath).mtimeMs);
      if (Date.now() - lockedAt.getTime() > 300000) {
        unlinkSync(lockPath);
      } else {
        return { success: false, path: null, error: 'A backup is already in progress' };
      }
    }

    try {
      writeFileSync(lockPath, process.pid.toString());
    } catch {
      return { success: false, path: null, error: 'Unable to acquire backup lock' };
    }

    const backupPath = generateBackupPath(dbPath);
    const partPath = backupPath + '.part';

    let sourceDb: Database.Database | null = null;
    let shouldCloseSource = false;

    try {
      if (!dbPathOverride) {
        try {
          sourceDb = getDatabase();
        } catch {
          // not open yet
        }
      }

      if (!sourceDb) {
        sourceDb = new Database(dbPath, { readonly: true, fileMustExist: true });
        shouldCloseSource = true;
      }

      if (existsSync(partPath)) {
        try {
          unlinkSync(partPath);
        } catch {}
      }

      sourceDb.prepare('VACUUM INTO ?').run(partPath);

      if (shouldCloseSource && sourceDb) {
        sourceDb.close();
        sourceDb = null;
        shouldCloseSource = false;
      }

      renameSync(partPath, backupPath);

      if (!checkBackupIntegrity(backupPath)) {
        try {
          unlinkSync(backupPath);
        } catch {}
        return { success: false, path: null, error: 'Backup integrity check failed' };
      }

      const size = statSync(backupPath).size;
      log.info('backup created successfully: %s (%d bytes)', backupPath, size);

      cleanupOldBackups(getRetention(), dbPath);

      return { success: true, path: backupPath };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'unknown';
      log.error('backup failed: %s', errorMessage);
      try {
        if (existsSync(partPath)) unlinkSync(partPath);
      } catch {}
      return { success: false, path: null, error: errorMessage };
    } finally {
      if (shouldCloseSource && sourceDb) {
        try {
          sourceDb.close();
        } catch {}
      }
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'unknown';
    log.error('backup failed unexpectedly: %s', errorMessage);
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {}
    return { success: false, path: null, error: errorMessage };
  }
}

export function restoreBackup(backupPath: string, dbPathOverride?: string): { success: boolean; error?: string } {
  const config = getConfig();
  const dbPath = dbPathOverride ?? config.SENARIBOT_DB_PATH;

  if (!backupPath) {
    return { success: false, error: 'Backup path required' };
  }

  if (!existsSync(backupPath)) {
    return { success: false, error: 'Backup file does not exist' };
  }

  if (backupPath === dbPath) {
    return { success: false, error: 'Cannot restore over the same file' };
  }

  if (!checkBackupIntegrity(backupPath)) {
    return { success: false, error: 'Backup integrity check failed before restore' };
  }

  try {
    try {
      closeDatabase();
    } catch {}

    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (existsSync(walPath)) {
      try {
        unlinkSync(walPath);
      } catch {}
    }
    if (existsSync(shmPath)) {
      try {
        unlinkSync(shmPath);
      } catch {}
    }

    copyFileSync(backupPath, dbPath);

    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'unknown';
    log.error('restore failed: %s', errorMessage);
    return { success: false, error: errorMessage };
  }
}

export function restoreLatestBackup(dbPath?: string): { success: boolean; error?: string; path?: string } {
  const backups = listBackups(dbPath);
  if (backups.length === 0) {
    return { success: false, error: 'No backups available' };
  }
  const latest = backups[backups.length - 1];
  const backupPath = join(getBackupDir(dbPath), latest);
  const result = restoreBackup(backupPath, dbPath);
  return { ...result, path: backupPath };
}

export function scheduleDailyBackup(): NodeJS.Timeout | null {
  const now = Date.now();
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0).getTime();
  const delay = midnight + 24 * 60 * 60 * 1000 - now;

  if (delay <= 0) return null;

  const timer = setTimeout(() => {
    createBackup();
    scheduleDailyBackup();
  }, delay);

  timer.unref();
  return timer;
}

export function countBackups(dbPath?: string): number {
  return listBackups(dbPath).length;
}
