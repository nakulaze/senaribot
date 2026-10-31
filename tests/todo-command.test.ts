import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';
process.env.APINEX_API_KEY = 'sk-test-key';
process.env.AI_TIMEOUT_MS = '1000';

const { handleTodo } = await import('@/modules/todo/index.js');
const { TodoRepository } = await import('@/database/repositories/todo.repo.js');
const { ReminderRepository } = await import('@/database/repositories/reminder.repo.js');
const { initializeDatabase } = await import('@/database/connection.js');

initializeDatabase(':memory:');
const todoRepo = new TodoRepository();
const reminderRepo = new ReminderRepository();

const realFetch = globalThis.fetch;
let calls = 0;

function mockAi(content: string): void {
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
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
    command: { name: 'todo', args: [], raw: text },
    reply: async (t: string) => {
      replies.push(t);
    },
  };
  await handleTodo(ctx);
  return replies;
}

function futureIso(hours: number): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

test('.todo tanpa argumen menampilkan bantuan', async () => {
  const r = await run(jidFor('help'), '.todo');
  assert.match(r[0], /Todo List/);
});

test('add menyimpan tugas dengan kategori, prioritas, dan deadline', async () => {
  const jid = jidFor('add');
  const r = await run(jid, '.todo add Belajar Python --cat Kuliah --prio high --due besok jam 7 malam');
  assert.match(r[0], /Tugas ditambahkan/);
  const tasks = todoRepo.list(jid);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Belajar Python');
  assert.equal(tasks[0].category, 'Kuliah');
  assert.equal(tasks[0].priority, 'high');
  assert.ok(tasks[0].deadline && tasks[0].deadline > Date.now() / 1000);
});

test('add tanpa judul dan dengan deadline tidak valid ditolak', async () => {
  const jid = jidFor('bad');
  const empty = await run(jid, '.todo add');
  assert.match(empty[0], /Tulis tugasnya/);
  const bad = await run(jid, '.todo add Tugas --due kapan-kapan saja');
  assert.match(bad[0], /tidak bisa dipahami/);
  assert.equal(todoRepo.list(jid).length, 0);
});

test('list mengurutkan berdasarkan deadline lalu prioritas', async () => {
  const jid = jidFor('sort');
  todoRepo.insert({ user_jid: jid, title: 'tanpa-deadline-high', priority: 'high' });
  const base = Math.floor(Date.now() / 1000);
  todoRepo.insert({ user_jid: jid, title: 'lusa-low', priority: 'low', deadline: base + 2 * 86400 });
  todoRepo.insert({ user_jid: jid, title: 'besok-low', priority: 'low', deadline: base + 86400 });
  todoRepo.insert({ user_jid: jid, title: 'besok-high', priority: 'high', deadline: base + 86400 });
  const titles = todoRepo.list(jid).map((t) => t.title);
  assert.deepEqual(titles, ['besok-high', 'besok-low', 'lusa-low', 'tanpa-deadline-high']);
  const r = await run(jid, '.todo list');
  assert.match(r[0], /Daftar Tugas \(4\)/);
});

test('done menandai selesai dan membatalkan reminder terkait', async () => {
  const jid = jidFor('done');
  await run(jid, '.todo add Kirim laporan --due besok jam 9 pagi');
  const task = todoRepo.list(jid)[0];
  assert.ok(task.reminder_id);
  assert.equal(reminderRepo.getById(task.reminder_id!)?.state, 'pending');

  const r = await run(jid, `.todo done ${task.id}`);
  assert.match(r[0], /Selesai/);
  assert.equal(todoRepo.getById(jid, task.id)?.status, 'done');
  assert.equal(reminderRepo.getById(task.reminder_id!)?.state, 'cancelled');

  const again = await run(jid, `.todo done ${task.id}`);
  assert.match(again[0], /sudah selesai/);
  const missing = await run(jid, '.todo done 99999');
  assert.match(missing[0], /tidak ditemukan/);
  const usage = await run(jid, '.todo done abc');
  assert.match(usage[0], /Usage/);
});

test('deadline membuat reminder lewat tabel reminders yang sudah ada', async () => {
  const jid = jidFor('rem');
  await run(jid, '.todo add Presentasi --due besok jam 8 pagi');
  const task = todoRepo.list(jid)[0];
  const reminder = reminderRepo.getById(task.reminder_id!);
  assert.ok(reminder);
  assert.equal(reminder!.user_jid, jid);
  assert.equal(reminder!.trigger_time, task.deadline);
  assert.match(reminder!.title, /Presentasi/);

  await run(jid, 'x');
  const noDue = await run(jid, '.todo add Tanpa deadline');
  assert.match(noDue[0], /Tugas ditambahkan/);
  const plain = todoRepo.list(jid).find((t) => t.title === 'Tanpa deadline');
  assert.equal(plain?.reminder_id, null);
});

test('edit mengubah judul, prioritas, dan memindahkan reminder', async () => {
  const jid = jidFor('edit');
  await run(jid, '.todo add Tugas lama --due besok jam 8 pagi');
  const before = todoRepo.list(jid)[0];
  const oldReminder = before.reminder_id!;

  const r = await run(jid, `.todo edit ${before.id} Tugas baru --prio high --due lusa jam 10 pagi`);
  assert.match(r[0], /diperbarui/);
  const after = todoRepo.getById(jid, before.id)!;
  assert.equal(after.title, 'Tugas baru');
  assert.equal(after.priority, 'high');
  assert.ok(after.deadline! > before.deadline!);
  assert.equal(reminderRepo.getById(oldReminder)?.state, 'cancelled');
  assert.equal(reminderRepo.getById(after.reminder_id!)?.state, 'pending');

  const none = await run(jid, `.todo edit ${before.id}`);
  assert.match(none[0], /Tidak ada perubahan/);
});

test('delete menghapus tugas dan membatalkan reminder', async () => {
  const jid = jidFor('del');
  await run(jid, '.todo add Hapus aku --due besok jam 8 pagi');
  const task = todoRepo.list(jid)[0];
  const r = await run(jid, `.todo delete ${task.id}`);
  assert.match(r[0], /dihapus/);
  assert.equal(todoRepo.getById(jid, task.id), null);
  assert.equal(reminderRepo.getById(task.reminder_id!)?.state, 'cancelled');
});

test('pengguna tidak bisa mengakses tugas milik pengguna lain', async () => {
  const a = jidFor('owner-a');
  const b = jidFor('owner-b');
  await run(a, '.todo add Rahasia A');
  const task = todoRepo.list(a)[0];
  assert.match((await run(b, `.todo done ${task.id}`))[0], /tidak ditemukan/);
  assert.match((await run(b, `.todo delete ${task.id}`))[0], /tidak ditemukan/);
  assert.match((await run(b, `.todo edit ${task.id} Diretas`))[0], /tidak ditemukan/);
  assert.equal(todoRepo.getById(a, task.id)?.title, 'Rahasia A');
});

test('stats menghitung total, selesai, terlambat, dan prioritas', async () => {
  const jid = jidFor('stats');
  const past = Math.floor(Date.now() / 1000) - 3600;
  todoRepo.insert({ user_jid: jid, title: 'a', priority: 'high', deadline: past });
  todoRepo.insert({ user_jid: jid, title: 'b', priority: 'low' });
  const c = todoRepo.insert({ user_jid: jid, title: 'c', priority: 'medium' });
  todoRepo.setStatus(jid, c.id, 'done');
  const s = todoRepo.stats(jid);
  assert.equal(s.total, 3);
  assert.equal(s.done, 1);
  assert.equal(s.pending, 2);
  assert.equal(s.overdue, 1);
  assert.equal(s.byPriority.high, 1);
  assert.equal(s.byPriority.low, 1);
  const r = await run(jid, '.todo stats');
  assert.match(r[0], /Statistik Todo/);
  assert.match(r[0], /Total: 3/);
});

test('clear meminta konfirmasi, batal tidak menghapus, yes menghapus', async () => {
  const jid = jidFor('clear');
  await run(jid, '.todo add satu --due besok jam 8 pagi');
  await run(jid, '.todo add dua');
  const reminderId = todoRepo.list(jid).find((t) => t.reminder_id)!.reminder_id!;

  const ask = await run(jid, '.todo clear');
  assert.match(ask[0], /\.todo yes/);
  assert.equal(todoRepo.list(jid).length, 2);

  const no = await run(jid, '.todo no');
  assert.match(no[0], /Dibatalkan/);
  assert.equal(todoRepo.list(jid).length, 2);

  await run(jid, '.todo clear');
  const yes = await run(jid, '.todo yes');
  assert.match(yes[0], /2 tugas dihapus/);
  assert.equal(todoRepo.list(jid).length, 0);
  assert.equal(reminderRepo.getById(reminderId)?.state, 'cancelled');

  const none = await run(jid, '.todo yes');
  assert.match(none[0], /Tidak ada aksi/);
});

test('clear done hanya menghapus tugas selesai', async () => {
  const jid = jidFor('cleardone');
  const a = todoRepo.insert({ user_jid: jid, title: 'selesai' });
  todoRepo.setStatus(jid, a.id, 'done');
  todoRepo.insert({ user_jid: jid, title: 'belum' });
  await run(jid, '.todo clear done');
  await run(jid, '.todo yes');
  const left = todoRepo.list(jid);
  assert.equal(left.length, 1);
  assert.equal(left[0].title, 'belum');
});

test('AI: instruksi natural menambah tugas lewat JSON tervalidasi', async () => {
  const jid = jidFor('ai-add');
  mockAi(JSON.stringify({ action: 'add', title: 'Belajar Python', category: null, priority: 'medium', deadline: futureIso(20) }));
  const r = await run(jid, '.todo Belajar Python besok jam 7 malam');
  assert.equal(calls, 1);
  assert.match(r[0], /Tugas ditambahkan/);
  const tasks = todoRepo.list(jid);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Belajar Python');
  assert.ok(tasks[0].reminder_id);
  assert.equal(reminderRepo.getById(tasks[0].reminder_id!)?.state, 'pending');
});

test('AI: balasan bukan JSON atau SQL ditolak tanpa mengubah database', async () => {
  const jid = jidFor('ai-bad');
  todoRepo.insert({ user_jid: jid, title: 'aman' });
  mockAi('DROP TABLE todo_tasks;');
  const r1 = await run(jid, '.todo hapus semuanya sekarang juga');
  assert.match(r1[0], /tidak bisa memahami/);
  mockAi(JSON.stringify({ action: 'sql', query: 'DELETE FROM todo_tasks' }));
  const r2 = await run(jid, '.todo lakukan sesuatu');
  assert.match(r2[0], /tidak bisa memahami/);
  assert.equal(todoRepo.list(jid).length, 1);
});

test('AI: list dijawab dari repository', async () => {
  const jid = jidFor('ai-list');
  todoRepo.insert({ user_jid: jid, title: 'belum selesai 1' });
  const done = todoRepo.insert({ user_jid: jid, title: 'sudah selesai' });
  todoRepo.setStatus(jid, done.id, 'done');
  mockAi(JSON.stringify({ action: 'list', status: 'pending' }));
  const r = await run(jid, '.todo Apa saja tugas yang belum selesai?');
  assert.match(r[0], /belum selesai 1/);
  assert.ok(!r[0].includes('sudah selesai'));
});

test('AI: penghapusan wajib konfirmasi dan tidak jalan sebelum yes', async () => {
  const jid = jidFor('ai-del');
  const a = todoRepo.insert({ user_jid: jid, title: 'hapus-a' });
  const b = todoRepo.insert({ user_jid: jid, title: 'hapus-b' });
  mockAi(JSON.stringify({ action: 'delete', ids: [a.id, b.id] }));
  const ask = await run(jid, '.todo hapus tugas a dan b');
  assert.match(ask[0], /\.todo yes/);
  assert.equal(todoRepo.list(jid).length, 2);
  const yes = await run(jid, '.todo yes');
  assert.match(yes.join('\n'), /Dihapus/);
  assert.equal(todoRepo.list(jid).length, 0);
});

test('AI: konfirmasi ditolak dengan no tidak mengubah apa pun', async () => {
  const jid = jidFor('ai-no');
  const a = todoRepo.insert({ user_jid: jid, title: 'tetap-ada' });
  mockAi(JSON.stringify({ action: 'delete', ids: [a.id] }));
  await run(jid, '.todo buang tugas itu');
  const no = await run(jid, '.todo no');
  assert.match(no[0], /Dibatalkan/);
  assert.equal(todoRepo.list(jid).length, 1);
});

test('AI: perubahan massal (prioritize banyak tugas) wajib konfirmasi', async () => {
  const jid = jidFor('ai-prio');
  const a = todoRepo.insert({ user_jid: jid, title: 'p-a', priority: 'low' });
  const b = todoRepo.insert({ user_jid: jid, title: 'p-b', priority: 'low' });
  mockAi(JSON.stringify({ action: 'prioritize', items: [{ id: a.id, priority: 'high' }, { id: b.id, priority: 'medium' }] }));
  const ask = await run(jid, '.todo Prioritaskan tugasku hari ini');
  assert.match(ask[0], /\.todo yes/);
  assert.equal(todoRepo.getById(jid, a.id)?.priority, 'low');
  await run(jid, '.todo yes');
  assert.equal(todoRepo.getById(jid, a.id)?.priority, 'high');
  assert.equal(todoRepo.getById(jid, b.id)?.priority, 'medium');
});

test('AI: id milik pengguna lain tidak bisa diubah', async () => {
  const owner = jidFor('ai-owner');
  const attacker = jidFor('ai-attacker');
  const victim = todoRepo.insert({ user_jid: owner, title: 'milik owner' });
  mockAi(JSON.stringify({ action: 'done', ids: [victim.id] }));
  const r = await run(attacker, `.todo selesaikan tugas ${victim.id}`);
  assert.match(r.join('\n'), /tidak ditemukan/);
  assert.equal(todoRepo.getById(owner, victim.id)?.status, 'pending');
});

test('AI: kegagalan API menghasilkan pesan ramah tanpa membocorkan kunci', async () => {
  const jid = jidFor('ai-fail');
  globalThis.fetch = (async () => new Response('', { status: 401 })) as any;
  const r = await run(jid, '.todo tambahkan sesuatu yang aneh');
  assert.match(r[0], /Autentikasi/);
  assert.ok(!r[0].includes('sk-test-key'));
});

test('edit judul tugas yang deadline-nya sudah lewat tidak membuat reminder di masa lalu', async () => {
  const jid = jidFor('edit-past');
  const past = Math.floor(Date.now() / 1000) - 3600;
  const oldReminder = reminderRepo.insertReminder({
    user_jid: jid,
    title: 'Todo: lama',
    description: null,
    trigger_time: past,
    state: 'pending',
    recurrence: null,
  });
  const task = todoRepo.insert({ user_jid: jid, title: 'lama', deadline: past, reminder_id: oldReminder.id });

  const before = reminderRepo.getRemindersByUser(jid).length;
  const r = await run(jid, `.todo edit ${task.id} judul baru`);
  assert.match(r[0], /diperbarui/);
  assert.equal(todoRepo.getById(jid, task.id)?.title, 'judul baru');

  // Tidak boleh ada reminder baru yang langsung terpicu karena trigger_time sudah lewat.
  assert.equal(reminderRepo.getRemindersByUser(jid).length, before);
  assert.equal(todoRepo.getById(jid, task.id)?.reminder_id, null);
});

test('list panjang dipecah menjadi beberapa pesan <= 3500 karakter tanpa kehilangan tugas', async () => {
  const jid = jidFor('longlist');
  const total = 60;
  for (let i = 1; i <= total; i++) {
    todoRepo.insert({ user_jid: jid, title: `Tugas nomor ${i} ` + 'x'.repeat(80), category: 'Kuliah' });
  }

  const r = await run(jid, '.todo list');
  assert.ok(r.length > 1, 'daftar panjang harus dikirim sebagai beberapa pesan');
  for (const part of r) {
    assert.ok(part.length <= 3500, `pesan melebihi batas: ${part.length}`);
  }

  const joined = r.join('\n');
  for (let i = 1; i <= total; i++) {
    assert.ok(joined.includes(`Tugas nomor ${i} `), `tugas ${i} hilang`);
  }
});

test('pulihkan fetch asli', () => {
  globalThis.fetch = realFetch;
});
