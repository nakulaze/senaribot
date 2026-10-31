import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  localDate,
  localTime,
  addDays,
  weekStart,
  periodKey,
  currentStreak,
  longestStreak,
  completionRate,
  periodsSince,
  countInLastDays,
  expectedInLastDays,
} = await import('@/modules/habit/period.js');
const { parseHabitArgs, parseReminderTime, parseFrequency } = await import('@/modules/habit/args.js');
const { parseHabitPlan } = await import('@/modules/habit/nl.js');

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

test('localDate: batas hari mengikuti timezone, bukan UTC', () => {
  // 2026-11-01 17:30 UTC = 2026-11-02 00:30 WIB
  assert.equal(localDate(unix('2026-11-01T17:30:00Z'), 'Asia/Jakarta'), '2026-11-02');
  assert.equal(localDate(unix('2026-11-01T17:30:00Z'), 'UTC'), '2026-11-01');
  // 2026-11-01 16:59 UTC = 23:59 WIB, masih tanggal 1
  assert.equal(localDate(unix('2026-11-01T16:59:00Z'), 'Asia/Jakarta'), '2026-11-01');
});

test('localTime: jam lokal 24 jam, tengah malam menjadi 00:xx', () => {
  assert.equal(localTime(unix('2026-11-01T17:05:00Z'), 'Asia/Jakarta'), '00:05');
  assert.equal(localTime(unix('2026-11-01T01:30:00Z'), 'Asia/Jakarta'), '08:30');
});

test('addDays: lintas bulan, tahun, dan tahun kabisat', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('weekStart: Senin adalah awal minggu, Minggu masuk minggu sebelumnya', () => {
  assert.equal(weekStart('2026-11-02'), '2026-11-02'); // Senin
  assert.equal(weekStart('2026-11-08'), '2026-11-02'); // Minggu
  assert.equal(weekStart('2026-11-09'), '2026-11-09'); // Senin berikutnya
  assert.equal(weekStart('2026-10-31'), '2026-10-26'); // Sabtu
});

test('periodKey: harian = tanggal lokal, mingguan = tanggal Senin', () => {
  const t = unix('2026-10-31T10:00:00Z'); // Sabtu
  assert.equal(periodKey(t, 'daily', 'Asia/Jakarta'), '2026-10-31');
  assert.equal(periodKey(t, 'weekly', 'Asia/Jakarta'), '2026-10-26');
});

test('currentStreak harian: berurutan sampai hari ini', () => {
  const keys = ['2026-10-29', '2026-10-30', '2026-10-31'];
  assert.equal(currentStreak(keys, 'daily', '2026-10-31'), 3);
});

test('currentStreak harian: hari ini belum diisi tidak memutus streak kemarin', () => {
  const keys = ['2026-10-29', '2026-10-30'];
  assert.equal(currentStreak(keys, 'daily', '2026-10-31'), 2);
});

test('currentStreak harian: terlewat satu hari penuh memutus streak', () => {
  const keys = ['2026-10-28', '2026-10-29'];
  assert.equal(currentStreak(keys, 'daily', '2026-10-31'), 0);
});

test('currentStreak: tanpa log menghasilkan 0', () => {
  assert.equal(currentStreak([], 'daily', '2026-10-31'), 0);
  assert.equal(currentStreak([], 'weekly', '2026-10-26'), 0);
});

test('currentStreak mingguan: minggu berurutan, lintas bulan', () => {
  const keys = ['2026-10-12', '2026-10-19', '2026-10-26'];
  assert.equal(currentStreak(keys, 'weekly', '2026-10-26'), 3);
  // minggu ini (2026-11-02) belum diisi, minggu lalu terisi: streak tetap
  assert.equal(currentStreak(keys, 'weekly', '2026-11-02'), 3);
  // satu minggu penuh terlewat: putus
  assert.equal(currentStreak(keys, 'weekly', '2026-11-09'), 0);
});

test('currentStreak: lintas pergantian tahun', () => {
  const keys = ['2026-12-30', '2026-12-31', '2027-01-01'];
  assert.equal(currentStreak(keys, 'daily', '2027-01-01'), 3);
});

test('longestStreak: memilih rentetan terpanjang, bukan yang terakhir', () => {
  const keys = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-10', '2026-10-11'];
  assert.equal(longestStreak(keys, 'daily'), 4);
});

test('longestStreak: kosong 0, satu log 1, duplikat dan urutan acak diabaikan', () => {
  assert.equal(longestStreak([], 'daily'), 0);
  assert.equal(longestStreak(['2026-10-01'], 'daily'), 1);
  assert.equal(longestStreak(['2026-10-03', '2026-10-01', '2026-10-02', '2026-10-02'], 'daily'), 3);
});

test('longestStreak mingguan', () => {
  const keys = ['2026-10-05', '2026-10-12', '2026-10-26'];
  assert.equal(longestStreak(keys, 'weekly'), 2);
});

test('periodsSince dan completionRate: harian', () => {
  assert.equal(periodsSince('2026-10-22', '2026-10-31', 'daily'), 10);
  assert.equal(completionRate(['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26'], '2026-10-22', '2026-10-31', 'daily'), 50);
});

test('completionRate: habit baru dibuat hari ini dan sudah selesai = 100%, tanpa log = 0%', () => {
  assert.equal(completionRate(['2026-10-31'], '2026-10-31', '2026-10-31', 'daily'), 100);
  assert.equal(completionRate([], '2026-10-31', '2026-10-31', 'daily'), 0);
});

test('completionRate mingguan dan tidak pernah melebihi 100', () => {
  assert.equal(periodsSince('2026-10-05', '2026-10-26', 'weekly'), 4);
  assert.equal(completionRate(['2026-10-05', '2026-10-12'], '2026-10-05', '2026-10-26', 'weekly'), 50);
  assert.equal(completionRate(['2026-10-01', '2026-10-02', '2026-10-03'], '2026-10-03', '2026-10-03', 'daily'), 100);
});

test('countInLastDays dan expectedInLastDays', () => {
  const keys = ['2026-10-01', '2026-10-25', '2026-10-30', '2026-10-31'];
  assert.equal(countInLastDays(keys, '2026-10-31', 7), 3);
  // Jendela 30 hari berakhir 2026-10-31 dimulai 2026-10-02, jadi 2026-10-01 berada di luar.
  assert.equal(countInLastDays(keys, '2026-10-31', 30), 3);
  assert.equal(countInLastDays(['2026-10-01'], '2026-10-31', 30), 0);
  assert.equal(countInLastDays(['2026-10-02'], '2026-10-31', 30), 1);
  assert.equal(countInLastDays([], '2026-10-31', 7), 0);
  assert.equal(expectedInLastDays('daily', 7), 7);
  assert.equal(expectedInLastDays('weekly', 30), 5);
});

test('parseReminderTime: format valid dan batas jam', () => {
  assert.equal(parseReminderTime('7:30'), '07:30');
  assert.equal(parseReminderTime('20.05'), '20:05');
  assert.equal(parseReminderTime('23:59'), '23:59');
  assert.equal(parseReminderTime('24:00'), null);
  assert.equal(parseReminderTime('12:60'), null);
  assert.equal(parseReminderTime('abc'), null);
});

test('parseFrequency: alias Indonesia dan Inggris', () => {
  assert.equal(parseFrequency('harian'), 'daily');
  assert.equal(parseFrequency('WEEKLY'), 'weekly');
  assert.equal(parseFrequency('bulanan'), null);
});

test('parseHabitArgs: nama, frekuensi, reminder, dan error', () => {
  const ok = parseHabitArgs(['Baca', 'buku', '--freq', 'weekly', '--remind', '20:00']);
  assert.equal(ok.name, 'Baca buku');
  assert.equal(ok.frequency, 'weekly');
  assert.equal(ok.remindTime, '20:00');
  assert.equal(ok.errors.length, 0);

  const bad = parseHabitArgs(['Olahraga', '--freq', 'bulanan', '--remind', '99:99']);
  assert.equal(bad.errors.length, 2);

  const long = parseHabitArgs(['x'.repeat(51)]);
  assert.equal(long.errors.length, 1);

  assert.equal(parseHabitArgs([]).name, '');
});

test('parseHabitPlan: menerima JSON valid, menolak aksi tak dikenal dan SQL', () => {
  assert.equal(parseHabitPlan('{"action":"add","name":"Baca buku","frequency":"daily"}')?.action, 'add');
  assert.equal(parseHabitPlan('```json\n{"action":"analyze","name":null}\n```')?.action, 'analyze');
  assert.equal(parseHabitPlan('{"action":"drop_table","name":"x"}'), null);
  assert.equal(parseHabitPlan('DROP TABLE habits;'), null);
  assert.equal(parseHabitPlan('{"action":"add","name":""}'), null);
});
