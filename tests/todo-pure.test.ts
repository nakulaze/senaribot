import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTodoArgs, parsePriority } from '@/modules/todo/args.js';
import { normalizeIndonesian, parseDeadline } from '@/modules/todo/date.js';
import { parseAiPlan, extractJson } from '@/modules/todo/nl.js';

test('parsePriority mengenali alias Indonesia dan Inggris', () => {
  assert.equal(parsePriority('high'), 'high');
  assert.equal(parsePriority('TINGGI'), 'high');
  assert.equal(parsePriority('sedang'), 'medium');
  assert.equal(parsePriority('rendah'), 'low');
  assert.equal(parsePriority('urgent'), null);
});

test('parseTodoArgs memisahkan judul dan opsi', () => {
  const r = parseTodoArgs('Belajar Python --cat Kuliah --prio high --due besok jam 7 malam'.split(' '));
  assert.equal(r.title, 'Belajar Python');
  assert.equal(r.category, 'Kuliah');
  assert.equal(r.priority, 'high');
  assert.equal(r.dueText, 'besok jam 7 malam');
  assert.deepEqual(r.errors, []);
});

test('parseTodoArgs melaporkan prioritas tidak valid dan opsi kosong', () => {
  const r = parseTodoArgs(['Tugas', '--prio', 'urgent']);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /tidak dikenal/);
  assert.equal(parseTodoArgs(['Tugas', '--cat']).errors.length, 1);
  assert.equal(parseTodoArgs(['Tugas', '--due']).errors.length, 1);
});

test('parseTodoArgs menolak judul dan kategori terlalu panjang', () => {
  assert.equal(parseTodoArgs(['x'.repeat(201)]).errors.length, 1);
  assert.equal(parseTodoArgs(['Tugas', '--cat', 'k'.repeat(31)]).errors.length, 1);
});

const NOW = new Date(2026, 10, 4, 10, 0, 0);

test('normalizeIndonesian mengubah jam 7 malam ke format 24 jam', () => {
  assert.match(normalizeIndonesian('besok jam 7 malam'), /tomorrow at 19:00/);
  assert.match(normalizeIndonesian('jam 7 pagi'), /at 07:00/);
  assert.match(normalizeIndonesian('pukul 12 siang'), /at 12:00/);
  assert.match(normalizeIndonesian('lusa'), /in 2 days/);
});

test('parseDeadline: besok jam 7 malam menjadi 19:00 keesokan hari', () => {
  const r = parseDeadline('besok jam 7 malam', NOW);
  assert.ok(r);
  assert.equal(r.hasTime, true);
  const d = new Date(r.unix * 1000);
  assert.equal(d.getDate(), 5);
  assert.equal(d.getHours(), 19);
  assert.equal(d.getMinutes(), 0);
});

test('parseDeadline: tanggal tanpa jam diset ke 23:59', () => {
  const r = parseDeadline('besok', NOW);
  assert.ok(r);
  assert.equal(r.hasTime, false);
  const d = new Date(r.unix * 1000);
  assert.equal(d.getDate(), 5);
  assert.equal(d.getHours(), 23);
  assert.equal(d.getMinutes(), 59);
});

test('parseDeadline menerima ISO 8601 dan menolak teks tak dikenal', () => {
  const r = parseDeadline('2026-11-10T08:30:00+07:00', NOW);
  assert.ok(r);
  assert.equal(r.hasTime, true);
  assert.equal(r.unix, Math.floor(new Date('2026-11-10T08:30:00+07:00').getTime() / 1000));
  assert.equal(parseDeadline('kapan-kapan saja', NOW), null);
  assert.equal(parseDeadline('   ', NOW), null);
});

test('extractJson membaca JSON polos dan JSON dalam code fence', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.equal(extractJson('tidak ada json'), null);
  assert.equal(extractJson('{rusak'), null);
});

test('parseAiPlan menerima rencana valid', () => {
  const add = parseAiPlan('{"action":"add","title":"Belajar Python","priority":"high","deadline":"2026-11-05T19:00:00+07:00"}');
  assert.ok(add && add.action === 'add');
  const del = parseAiPlan('{"action":"delete","ids":[1,2]}');
  assert.ok(del && del.action === 'delete');
});

test('parseAiPlan menolak aksi tak dikenal, SQL, dan data tidak valid', () => {
  assert.equal(parseAiPlan('{"action":"sql","query":"DROP TABLE todo_tasks"}'), null);
  assert.equal(parseAiPlan('DROP TABLE todo_tasks;'), null);
  assert.equal(parseAiPlan('{"action":"delete","ids":[]}'), null);
  assert.equal(parseAiPlan('{"action":"delete","ids":["1; DROP TABLE x"]}'), null);
  assert.equal(parseAiPlan('{"action":"add","title":""}'), null);
  assert.equal(parseAiPlan('{"action":"add","title":"x","priority":"urgent"}'), null);
  assert.equal(parseAiPlan('{"action":"done","ids":[0]}'), null);
});

test('parseDeadline: keterangan waktu tanpa kata jam (besok sore, lusa pagi, nanti malam)', () => {
  const sore = parseDeadline('besok sore', NOW);
  assert.ok(sore, 'besok sore harus bisa diparse');
  const dSore = new Date(sore.unix * 1000);
  assert.equal(dSore.getDate(), 5);
  assert.equal(dSore.getHours(), 17);

  const pagi = parseDeadline('lusa pagi', NOW);
  assert.ok(pagi, 'lusa pagi harus bisa diparse');
  const dPagi = new Date(pagi.unix * 1000);
  assert.equal(dPagi.getDate(), 6);
  assert.equal(dPagi.getHours(), 8);

  const malam = parseDeadline('hari ini malam', NOW);
  assert.ok(malam, 'hari ini malam harus bisa diparse');
  const dMalam = new Date(malam.unix * 1000);
  assert.equal(dMalam.getDate(), 4);
  assert.equal(dMalam.getHours(), 19);
});
