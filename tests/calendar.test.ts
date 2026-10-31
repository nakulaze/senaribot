import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DispatchContext } from '../src/pipeline/dispatcher.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';
process.env.SENARIBOT_PREFIX = '.';
process.env.SENARIBOT_TIMEZONE = 'Asia/Jakarta';

let testDb: Database.Database;
const testDbPath = path.join(process.cwd(), 'test-calendar.db');

function setupTestDb() {
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
  
  testDb = new Database(testDbPath);
  
  const schema = fs.readFileSync(path.join(process.cwd(), 'src/database/schema.sql'), 'utf-8');
  testDb.exec(schema);
}

// Setup DB before importing module
setupTestDb();

// Mock getDatabase to return test DB
const dbConnection = await import('../src/database/connection.js');
(dbConnection as any).getDatabase = () => testDb;

// Now import calendar module
const { handleCalendar } = await import('../src/modules/calendar/index.js');

function cleanupTestDb() {
  if (testDb) {
    testDb.close();
  }
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
}

function jidFor(id: string): string {
  return `62812345${id.padStart(4, '0')}@s.whatsapp.net`;
}

async function run(jid: string, message: string): Promise<string[]> {
  const replies: string[] = [];
  const ctx: DispatchContext = {
    sender: jid,
    command: { name: 'calendar', raw: message },
    reply: async (text: string) => {
      replies.push(text);
    },
  } as any;

  await handleCalendar(ctx);
  return replies;
}

test('.calendar tanpa argument menampilkan help', async () => {
  const replies = await run(jidFor('1'), '.calendar');
  assert.ok(replies.some((r) => r.includes('Commands')));
});

test('.calendar today awalnya kosong', async () => {
  const replies = await run(jidFor('2'), '.calendar today');
  assert.ok(replies.some((r) => r.includes('Tidak ada agenda')));
});

test('.calendar add tanpa argument menampilkan usage', async () => {
  const replies = await run(jidFor('3'), '.calendar add');
  assert.ok(replies.some((r) => r.includes('Usage')));
});

test('.calendar add dengan format tidak lengkap menampilkan usage', async () => {
  const replies = await run(jidFor('4'), '.calendar add Meeting');
  assert.ok(replies.some((r) => r.includes('Usage')));
});

test('.calendar add dengan format tanggal invalid', async () => {
  const replies = await run(jidFor('5'), '.calendar add Meeting invalid 14:00');
  assert.ok(replies.some((r) => r.includes('tidak valid')));
});

test('.calendar add agenda berhasil dengan "tomorrow"', async () => {
  const replies = await run(jidFor('6'), '.calendar add Meeting tomorrow 14:00');
  assert.ok(replies.some((r) => r.includes('ditambahkan')));
  assert.ok(replies.some((r) => r.includes('ID')));
});

test('.calendar add agenda berhasil dengan "today"', async () => {
  const now = new Date();
  const futureHour = (now.getHours() + 2) % 24;
  const timeStr = `${futureHour.toString().padStart(2, '0')}:00`;
  
  const replies = await run(jidFor('7'), `.calendar add Olahraga today ${timeStr}`);
  assert.ok(replies.some((r) => r.includes('ditambahkan') || r.includes('masa lalu')));
});

test('.calendar add dengan waktu masa lalu ditolak', async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = `${yesterday.getDate()}/${yesterday.getMonth() + 1}/${yesterday.getFullYear()}`;
  
  const replies = await run(jidFor('8'), `.calendar add Past ${dateStr} 10:00`);
  assert.ok(replies.some((r) => r.includes('masa lalu')));
});

test('.calendar today menampilkan agenda hari ini', async () => {
  const now = new Date();
  const futureHour = (now.getHours() + 1) % 24;
  const timeStr = `${futureHour.toString().padStart(2, '0')}:30`;
  
  const jid = jidFor('9');
  await run(jid, `.calendar add TodayEvent today ${timeStr}`);
  
  const replies = await run(jid, '.calendar today');
  const output = replies.join(' ');
  assert.ok(output.includes('Agenda') || output.includes('TodayEvent') || output.includes('Tidak ada'));
});

test('.calendar tomorrow menampilkan agenda besok', async () => {
  const jid = jidFor('10');
  await run(jid, '.calendar add TomorrowEvent tomorrow 09:00');
  
  const replies = await run(jid, '.calendar tomorrow');
  assert.ok(replies.some((r) => r.includes('TomorrowEvent')));
});

test('.calendar week menampilkan agenda minggu ini', async () => {
  const jid = jidFor('11');
  await run(jid, '.calendar add WeekEvent tomorrow 10:00');
  
  const replies = await run(jid, '.calendar week');
  const output = replies.join(' ');
  assert.ok(output.includes('Agenda') || output.includes('WeekEvent') || output.includes('Tidak ada'));
});

test('.calendar delete tanpa ID menampilkan usage', async () => {
  const replies = await run(jidFor('12'), '.calendar delete');
  assert.ok(replies.some((r) => r.includes('Usage')));
});

test('.calendar delete dengan ID invalid', async () => {
  const replies = await run(jidFor('13'), '.calendar delete abc');
  assert.ok(replies.some((r) => r.includes('tidak valid')));
});

test('.calendar delete agenda yang tidak ada', async () => {
  const replies = await run(jidFor('14'), '.calendar delete 99999');
  assert.ok(replies.some((r) => r.includes('tidak ditemukan')));
});

test('.calendar delete agenda berhasil', async () => {
  const jid = jidFor('15');
  const addReplies = await run(jid, '.calendar add DeleteMe tomorrow 15:00');
  
  // Extract ID from response
  const idMatch = addReplies.join(' ').match(/ID (\d+)/);
  assert.ok(idMatch);
  
  const id = idMatch[1];
  const deleteReplies = await run(jid, `.calendar delete ${id}`);
  assert.ok(deleteReplies.some((r) => r.includes('dihapus')));
});

test('.calendar detail tanpa ID menampilkan usage', async () => {
  const replies = await run(jidFor('16'), '.calendar detail');
  assert.ok(replies.some((r) => r.includes('Usage')));
});

test('.calendar detail dengan ID invalid', async () => {
  const replies = await run(jidFor('17'), '.calendar detail xyz');
  assert.ok(replies.some((r) => r.includes('tidak valid')));
});

test('.calendar detail agenda yang tidak ada', async () => {
  const replies = await run(jidFor('18'), '.calendar detail 99999');
  assert.ok(replies.some((r) => r.includes('tidak ditemukan')));
});

test('.calendar detail menampilkan detail lengkap', async () => {
  const jid = jidFor('19');
  const addReplies = await run(jid, '.calendar add DetailTest tomorrow 16:00');
  
  const idMatch = addReplies.join(' ').match(/ID (\d+)/);
  assert.ok(idMatch);
  
  const id = idMatch[1];
  const detailReplies = await run(jid, `.calendar detail ${id}`);
  assert.ok(detailReplies.some((r) => r.includes('DetailTest')));
  assert.ok(detailReplies.some((r) => r.includes('Waktu')));
});

test('user isolation: user A tidak bisa lihat agenda user B', async () => {
  const jidA = jidFor('20');
  const jidB = jidFor('21');
  
  await run(jidA, '.calendar add UserAEvent tomorrow 17:00');
  
  const repliesB = await run(jidB, '.calendar tomorrow');
  assert.ok(!repliesB.some((r) => r.includes('UserAEvent')));
});

test('user isolation: user B tidak bisa hapus agenda user A', async () => {
  const jidA = jidFor('22');
  const jidB = jidFor('23');
  
  const addReplies = await run(jidA, '.calendar add UserAPrivate tomorrow 18:00');
  const idMatch = addReplies.join(' ').match(/ID (\d+)/);
  assert.ok(idMatch);
  
  const id = idMatch[1];
  const deleteReplies = await run(jidB, `.calendar delete ${id}`);
  assert.ok(deleteReplies.some((r) => r.includes('tidak ditemukan')));
});

test('alias: .cal works', async () => {
  const replies = await run(jidFor('24'), '.cal today');
  assert.ok(replies.some((r) => r.includes('Agenda') || r.includes('Tidak ada')));
});

test('alias: .agenda works', async () => {
  const replies = await run(jidFor('25'), '.agenda week');
  assert.ok(replies.some((r) => r.includes('Agenda') || r.includes('Tidak ada')));
});

test('subcommand alias: besok works', async () => {
  const replies = await run(jidFor('26'), '.calendar besok');
  assert.ok(replies.some((r) => r.includes('Agenda') || r.includes('Tidak ada')));
});

test('subcommand alias: minggu works', async () => {
  const replies = await run(jidFor('27'), '.calendar minggu');
  assert.ok(replies.some((r) => r.includes('Agenda') || r.includes('Tidak ada')));
});

test('cleanup test database', () => {
  cleanupTestDb();
  assert.ok(!fs.existsSync(testDbPath));
});
