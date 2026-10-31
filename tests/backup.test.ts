import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';

const testDbPath = path.join(process.cwd(), 'tmp', 'test_backup.db');

const {
  createBackup,
  restoreBackup,
  restoreLatestBackup,
  countBackups,
  scheduleDailyBackup,
  generateBackupPath,
  listBackups,
} = await import('../dist/core/backup.js');

function setupTestDb() {
  const dbDir = path.dirname(testDbPath);
  fs.mkdirSync(dbDir, { recursive: true });

  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
  if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');

  const db = new Database(testDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger_entries (id INTEGER PRIMARY KEY, amount REAL NOT NULL, category TEXT NOT NULL);
  `);
  db.exec("INSERT INTO users (name) VALUES ('Alice'), ('Bob')");
  db.exec("INSERT INTO ledger_entries (amount, category) VALUES (100, 'food')");
  db.close();
}

function tearDown() {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
  if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
  const backupDir = path.join(path.dirname(testDbPath), 'backups');
  if (fs.existsSync(backupDir)) {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}

test('createBackup fails when no database configured', () => {
  const result = createBackup(':memory:');
  assert.equal(result.success, false);
  assert.ok(result.error?.includes('No file database'));
});

test('createBackup fails when database file does not exist', () => {
  tearDown();
  const result = createBackup(testDbPath);
  assert.equal(result.success, false);
  assert.ok(result.error?.includes('Database file does not exist'));
  setupTestDb();
});

test('createBackup creates a valid timestamped backup', () => {
  setupTestDb();
  const result = createBackup(testDbPath);
  assert.equal(result.success, true);
  assert.ok(result.path, 'path should be set');
  assert.ok(result.path!.endsWith('.db'));
  assert.ok(!result.path!.includes('.part'));
  assert.ok(fs.existsSync(result.path!));
  assert.equal(countBackups(testDbPath), 1);
  tearDown();
});

test('createBackup validates backup integrity', () => {
  setupTestDb();
  const result = createBackup(testDbPath);
  assert.equal(result.success, true);
  assert.ok(result.path);
  const db = new Database(result.path!);
  const users = db.prepare('SELECT COUNT(*) as n FROM users').get();
  assert.equal((users as { n: number }).n, 2);
  const rows = db.prepare('SELECT COUNT(*) as n FROM ledger_entries').get();
  assert.equal((rows as { n: number }).n, 1);
  db.close();
  tearDown();
});

test('createBackup prevents concurrent backup', () => {
  setupTestDb();
  const backupDir = path.join(path.dirname(testDbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const lockFile = path.join(backupDir, '.backup.lock');
  fs.writeFileSync(lockFile, '99999');

  const result = createBackup(testDbPath);
  assert.equal(result.success, false);
  assert.ok(result.error?.includes('already in progress'));

  fs.unlinkSync(lockFile);
  tearDown();
});

test('createBackup enforces retention limit', () => {
  setupTestDb();
  process.env.SENARIBOT_BACKUP_RETENTION = '2';
  for (let i = 0; i < 4; i++) {
    createBackup(testDbPath);
  }
  assert.ok(countBackups(testDbPath) <= 2, 'should keep at most 2 backups');
  process.env.SENARIBOT_BACKUP_RETENTION = '7';
  tearDown();
});

test('restoreBackup validates integrity before restore', () => {
  setupTestDb();
  const result = restoreBackup('/nonexistent/path/backup.db', testDbPath);
  assert.equal(result.success, false);
  assert.ok(result.error?.includes('does not exist'));
  tearDown();
});

test('restoreBackup cannot restore over the same file', () => {
  setupTestDb();
  const result = restoreBackup(testDbPath, testDbPath);
  assert.equal(result.success, false);
  assert.ok(result.error?.includes('Cannot restore over the same file'));
  tearDown();
});

test('restoreBackup restores data correctly', () => {
  setupTestDb();
  createBackup(testDbPath);

  // Verify before
  const before = new Database(testDbPath);
  const alice = before.prepare("SELECT * FROM users WHERE name = 'Alice'").get();
  assert.ok(alice, 'Alice exists before corruption');
  before.close();

  // Corrupt the database
  const db = new Database(testDbPath);
  db.exec('DELETE FROM users');
  db.close();

  // Restore from latest backup
  const result = restoreLatestBackup(testDbPath);
  assert.equal(result.success, true, 'restore should succeed');

  const after = new Database(testDbPath);
  const aliceAfter = after.prepare("SELECT * FROM users WHERE name = 'Alice'").get();
  assert.ok(aliceAfter, 'Alice restored after corruption');
  const bobAfter = after.prepare("SELECT * FROM users WHERE name = 'Bob'").get();
  assert.ok(bobAfter, 'Bob restored after corruption');
  after.close();
  tearDown();
});

test('restoreBackup logs integrity failure properly', () => {
  setupTestDb();
  const res = createBackup(testDbPath);
  assert.ok(res.path);

  // Corrupt the backup file
  fs.appendFileSync(res.path!, 'CORRUPT_DATA_GARBAGE');
  const result = restoreBackup(res.path!, testDbPath);
  assert.equal(result.success, false);
  assert.ok(result.error?.includes('integrity'));
  tearDown();
});

test('restoreLatestBackup reports when no backups exist', () => {
  tearDown();
  setupTestDb();
  const result = restoreLatestBackup(testDbPath);
  assert.equal(result.success, false);
  assert.ok(result.error?.includes('No backups available'));
  tearDown();
});

test('scheduleDailyBackup schedules without crashing', () => {
  tearDown();
  setupTestDb();
  assert.doesNotThrow(() => scheduleDailyBackup(), 'should not throw');
  tearDown();
});

test('createBackup handles WAL files correctly', () => {
  setupTestDb();
  const db = new Database(testDbPath);
  db.exec("INSERT INTO users (name) VALUES ('Charlie')");
  db.close();

  const result = createBackup(testDbPath);
  assert.equal(result.success, true);
  assert.ok(result.path);

  const backupDb = new Database(result.path!);
  const count = backupDb.prepare('SELECT COUNT(*) as n FROM users').get();
  assert.equal((count as { n: number }).n, 3);
  backupDb.close();
  tearDown();
});
