import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';
process.env.SENARIBOT_TIMEZONE = 'Asia/Jakarta';
process.env.APINEX_API_KEY = 'sk-test-key';
process.env.AI_TIMEOUT_MS = '1000';

const { initializeDatabase, getDatabase } = await import('@/database/connection.js');
initializeDatabase(':memory:');
const { handleHabit, checkHabitReminders, setHabitSender, teardown } = await import('@/modules/habit/index.js');
const { HabitRepository } = await import('@/database/repositories/habit.repo.js');
const repo = new HabitRepository();

const realFetch = globalThis.fetch;
let aiCalls = 0;
function mockAi(content: string): void {
  aiCalls = 0;
  globalThis.fetch = (async () => {
    aiCalls++;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as any;
}

let counter = 0;
function jidFor(label: string): string {
  counter++;
  return `${label}${counter}@s.whatsapp.net`;
}

async function run(jid: string, text: string): Promise<string[]> {
  const replies: string[] = [];
  const ctx: any = {
    id: 'm1',
    from: jid,
    sender: jid,
    text,
    command: { name: 'habit', args: [], raw: text },
    reply: async (t: string) => {
      replies.push(t);
    },
  };
  await handleHabit(ctx);
  return replies;
}

test('.habit tanpa argumen menampilkan bantuan', async () => {
  const r = await run(jidFor('help'), '.habit');
  assert.match(r[0], /Habit Tracker/);
});

test('add: menyimpan habit, menolak duplikat (tanpa peduli kapitalisasi) dan input tidak valid', async () => {
  const jid = jidFor('add');
  assert.match((await run(jid, '.habit add Baca Buku --freq weekly --remind 20:00'))[0], /ditambahkan/);
  const h = repo.getByName(jid, 'baca  buku');
  assert.equal(h?.frequency, 'weekly');
  assert.equal(h?.reminder_time, '20:00');
  assert.match((await run(jid, '.habit add baca buku'))[0], /sudah ada/);
  assert.match((await run(jid, '.habit add'))[0], /Tulis nama/);
  assert.match((await run(jid, '.habit add X --freq bulanan'))[0], /tidak dikenal/);
  assert.equal(repo.list(jid).length, 1);
});

test('done: pencatatan ganda pada periode yang sama ditolak dan log tetap satu', async () => {
  const jid = jidFor('done');
  await run(jid, '.habit add Olahraga');
  assert.match((await run(jid, '.habit done Olahraga'))[0], /Tercatat/);
  assert.match((await run(jid, '.habit done olahraga'))[0], /sudah dicatat/);
  const h = repo.getByName(jid, 'Olahraga')!;
  assert.equal(repo.getPeriodKeys(h.id).length, 1);
  assert.match((await run(jid, '.habit done Tidakada'))[0], /tidak ditemukan/);
  assert.match((await run(jid, '.habit done'))[0], /Usage/);
});

test('constraint UNIQUE database mencegah log ganda walau dipanggil langsung', () => {
  const jid = jidFor('uniq');
  const h = repo.insert({ user_jid: jid, name: 'Uji' });
  assert.equal(repo.addLog(h.id, '2026-10-31'), true);
  assert.equal(repo.addLog(h.id, '2026-10-31'), false);
  assert.equal(repo.getLogs(h.id).length, 1);
});

test('stats dan history menampilkan data habit', async () => {
  const jid = jidFor('stats');
  await run(jid, '.habit add Menulis');
  await run(jid, '.habit done Menulis');
  const s = (await run(jid, '.habit stats Menulis'))[0];
  assert.match(s, /Streak saat ini: 1 hari/);
  assert.match(s, /Completion rate: 100%/);
  assert.match((await run(jid, '.habit history Menulis'))[0], /Riwayat Menulis \(1\)/);
  assert.match((await run(jid, '.habit stats Hantu'))[0], /tidak ditemukan/);
});

test('list menampilkan status periode ini', async () => {
  const jid = jidFor('list');
  assert.match((await run(jid, '.habit list'))[0], /Belum ada habit/);
  await run(jid, '.habit add A');
  await run(jid, '.habit add B');
  await run(jid, '.habit done A');
  const out = (await run(jid, '.habit list'))[0];
  assert.match(out, /✅ A/);
  assert.match(out, /⬜ B/);
});

test('pengguna tidak bisa melihat atau mengubah habit milik pengguna lain', async () => {
  const a = jidFor('usera');
  const b = jidFor('userb');
  await run(a, '.habit add Rahasia');
  assert.match((await run(b, '.habit done Rahasia'))[0], /tidak ditemukan/);
  assert.match((await run(b, '.habit stats Rahasia'))[0], /tidak ditemukan/);
  assert.match((await run(b, '.habit list'))[0], /Belum ada habit/);
  await run(b, '.habit add Rahasia');
  assert.equal(repo.list(a).length, 1);
  assert.equal(repo.list(b).length, 1);
});

test('delete meminta konfirmasi; no membatalkan; yes menghapus habit dan riwayatnya (cascade)', async () => {
  const jid = jidFor('del');
  await run(jid, '.habit add Hapus');
  await run(jid, '.habit done Hapus');
  const id = repo.getByName(jid, 'Hapus')!.id;

  assert.match((await run(jid, '.habit delete Hapus'))[0], /\.habit yes/);
  assert.ok(repo.getByName(jid, 'Hapus'), 'belum boleh terhapus sebelum konfirmasi');
  assert.match((await run(jid, '.habit no'))[0], /Dibatalkan/);
  assert.ok(repo.getByName(jid, 'Hapus'));

  await run(jid, '.habit delete Hapus');
  assert.match((await run(jid, '.habit yes'))[0], /dihapus/);
  assert.equal(repo.getByName(jid, 'Hapus'), null);
  assert.equal(repo.getLogs(id).length, 0);
  assert.match((await run(jid, '.habit yes'))[0], /Tidak ada aksi/);
});

test('data modul lain tidak terpengaruh: tabel todo, reminders, ledger, vault tetap ada', () => {
  const names = (getDatabase().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
  for (const t of ['habits', 'habit_logs', 'todo_tasks', 'reminders', 'ledger_entries', 'vault_notes']) {
    assert.ok(names.includes(t), `tabel ${t} hilang`);
  }
});

test('reminder habit: terkirim sekali per periode, tidak dikirim bila sudah selesai atau belum waktunya', async () => {
  const sent: Array<[string, string]> = [];
  setHabitSender(async (jid, text) => {
    sent.push([jid, text]);
  });
  const jid = jidFor('rem');
  const done = jidFor('remdone');
  repo.insert({ user_jid: jid, name: 'Minum air', reminder_time: '08:00' });
  const hDone = repo.insert({ user_jid: done, name: 'Sudah', reminder_time: '08:00' });

  const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
  // 07:30 WIB belum waktunya
  await checkHabitReminders(at('2026-11-02T00:30:00Z'), 'Asia/Jakarta');
  assert.equal(sent.filter((s) => s[0] === jid).length, 0);

  // 08:15 WIB: kirim. Habit yang sudah selesai periode itu tidak dikirim.
  repo.addLog(hDone.id, '2026-11-02');
  await checkHabitReminders(at('2026-11-02T01:15:00Z'), 'Asia/Jakarta');
  assert.equal(sent.filter((s) => s[0] === jid).length, 1);
  assert.equal(sent.filter((s) => s[0] === done).length, 0);

  // siklus berikutnya di hari yang sama: tidak dikirim lagi
  await checkHabitReminders(at('2026-11-02T02:15:00Z'), 'Asia/Jakarta');
  assert.equal(sent.filter((s) => s[0] === jid).length, 1);

  // hari berikutnya: dikirim lagi
  await checkHabitReminders(at('2026-11-03T01:15:00Z'), 'Asia/Jakarta');
  assert.equal(sent.filter((s) => s[0] === jid).length, 2);
  setHabitSender(null);
});

test('reminder habit: gagal kirim dicoba lagi, tanpa pengirim tidak ditandai terkirim', async () => {
  const jid = jidFor('remfail');
  const h = repo.insert({ user_jid: jid, name: 'Retry', reminder_time: '06:00' });
  const t = Math.floor(new Date('2026-11-04T01:00:00Z').getTime() / 1000);

  setHabitSender(null);
  await checkHabitReminders(t, 'Asia/Jakarta');
  assert.equal(repo.getById(jid, h.id)?.last_reminded_period, null);

  setHabitSender(async () => {
    throw new Error('Socket not connected');
  });
  await checkHabitReminders(t, 'Asia/Jakarta');
  assert.equal(repo.getById(jid, h.id)?.last_reminded_period, null);

  let delivered = 0;
  setHabitSender(async (to) => {
    if (to === jid) delivered++;
  });
  await checkHabitReminders(t, 'Asia/Jakarta');
  assert.equal(delivered, 1);
  assert.equal(repo.getById(jid, h.id)?.last_reminded_period, '2026-11-04');
  setHabitSender(null);
});

test('AI: instruksi natural menambah habit lewat JSON tervalidasi', async () => {
  const jid = jidFor('aiadd');
  mockAi('{"action":"add","name":"Membaca buku","frequency":"daily","remind_time":null}');
  const r = await run(jid, '.habit Tambahkan membaca buku setiap hari');
  assert.match(r[0], /ditambahkan/);
  assert.equal(repo.getByName(jid, 'Membaca buku')?.frequency, 'daily');
});

test('AI: balasan bukan JSON atau SQL ditolak tanpa mengubah database', async () => {
  const jid = jidFor('aibad');
  mockAi('DROP TABLE habits;');
  const r = await run(jid, '.habit lakukan sesuatu');
  assert.match(r[0], /tidak bisa memahami/);
  assert.equal(repo.list(jid).length, 0);
});

test('AI: done dan delete wajib konfirmasi, tidak mengubah riwayat sebelum yes', async () => {
  const jid = jidFor('aiconf');
  await run(jid, '.habit add Belajar');
  const h = repo.getByName(jid, 'Belajar')!;

  mockAi('{"action":"done","name":"Belajar"}');
  const r1 = await run(jid, '.habit aku sudah belajar');
  assert.match(r1[0], /\.habit yes/);
  assert.equal(repo.getPeriodKeys(h.id).length, 0);
  assert.match((await run(jid, '.habit yes'))[0], /Tercatat/);
  assert.equal(repo.getPeriodKeys(h.id).length, 1);

  mockAi('{"action":"delete","name":"Belajar"}');
  const r2 = await run(jid, '.habit tolong buang kebiasaan belajar');
  assert.match(r2[0], /\.habit yes/);
  assert.ok(repo.getByName(jid, 'Belajar'));
  assert.match((await run(jid, '.habit no'))[0], /Dibatalkan/);
  assert.equal(repo.getPeriodKeys(h.id).length, 1);
});

test('AI: analisis hanya mengirim ringkasan statistik, bukan riwayat mentah, dan tidak mengubah data', async () => {
  const jid = jidFor('aian');
  await run(jid, '.habit add Meditasi');
  await run(jid, '.habit done Meditasi');
  const h = repo.getByName(jid, 'Meditasi')!;
  const before = repo.getPeriodKeys(h.id).length;

  const bodies: string[] = [];
  let n = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    bodies.push(String(init.body));
    n++;
    const content = n === 1 ? '{"action":"analyze","name":"Meditasi"}' : 'Konsistensi Anda baik.';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as any;

  const r = await run(jid, '.habit Analisis konsistensi meditasiku');
  assert.match(r.join('\n'), /Konsistensi Anda baik/);
  assert.equal(n, 2);
  assert.match(bodies[1], /current_streak/);
  assert.doesNotMatch(bodies[1], /\d{4}-\d{2}-\d{2}/, 'tanggal riwayat mentah tidak boleh dikirim ke AI');
  assert.equal(repo.getPeriodKeys(h.id).length, before);
});

test('AI: kegagalan API menghasilkan pesan ramah tanpa membocorkan kunci', async () => {
  const jid = jidFor('aifail');
  globalThis.fetch = (async () => new Response('{}', { status: 401 })) as any;
  const r = await run(jid, '.habit analisis konsistensiku');
  assert.match(r[0], /Autentikasi/);
  assert.doesNotMatch(r[0], /sk-test-key/);
});

test('pulihkan fetch asli', () => {
  globalThis.fetch = realFetch;
});

test('teardown: bersihkan timer', () => {
  teardown();
});
