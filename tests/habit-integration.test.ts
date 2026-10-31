import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net,owner2@s.whatsapp.net,owner3@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';
process.env.SENARIBOT_TIMEZONE = 'Asia/Jakarta';
process.env.APINEX_API_KEY = 'sk-test-key';
process.env.AI_TIMEOUT_MS = '1000';

const { initializeDatabase } = await import('@/database/connection.js');
initializeDatabase(':memory:');

const { dispatcher } = await import('@/pipeline/dispatcher.js');
const { registry } = await import('@/pipeline/registry.js');
const habitModule = await import('@/modules/habit/index.js');
const { HabitRepository } = await import('@/database/repositories/habit.repo.js');
const repo = new HabitRepository();

for (const cmd of await habitModule.setup()) registry.registerCommand(cmd);

function makeCtx(text: string, sender: string) {
  const replies: string[] = [];
  const ctx: any = {
    id: `id-${Math.random()}`,
    from: sender,
    sender,
    text,
    type: 'text',
    quoted: null,
    document: null,
    reply: async (t: string) => {
      replies.push(t);
    },
  };
  return { ctx, replies };
}

async function send(sender: string, text: string): Promise<string[]> {
  const { ctx, replies } = makeCtx(text, sender);
  await dispatcher.dispatch(ctx);
  return replies;
}

test('registry: habit dan alias kebiasaan menunjuk command yang sama', () => {
  assert.equal(registry.getCommand('habit')?.name, 'habit');
  assert.equal(registry.getCommand('kebiasaan')?.name, 'habit');
});

test('non-owner diabaikan tanpa balasan dan tanpa menyentuh database', async () => {
  const r = await send('orang-asing@s.whatsapp.net', '.habit add Rahasia');
  assert.equal(r.length, 0);
  assert.equal(repo.list('orang-asing@s.whatsapp.net').length, 0);
});

test('alias .kebiasaan bekerja lewat dispatcher', async () => {
  const jid = 'owner@s.whatsapp.net';
  const r = await send(jid, '.kebiasaan add Baca buku');
  assert.match(r[0], /ditambahkan/);
  assert.ok(repo.getByName(jid, 'Baca buku'));
});

test('cooldown tetap berlaku untuk command habit biasa', async () => {
  const jid = 'owner2@s.whatsapp.net';
  const first = await send(jid, '.habit add Olahraga');
  assert.match(first[0], /ditambahkan/);
  const second = await send(jid, '.habit list');
  assert.match(second[0], /Mohon tunggu/);
});

test('.habit yes dan .habit no dibebaskan dari cooldown, tetapi konfirmasi tetap memerlukan permintaan delete', async () => {
  const jid = 'owner3@s.whatsapp.net';
  await send(jid, '.habit add Hapus');
  // delete masih dalam cooldown dari add, jadi ditolak
  const blocked = await send(jid, '.habit delete Hapus');
  assert.match(blocked[0], /Mohon tunggu/);
  assert.ok(repo.getByName(jid, 'Hapus'));

  // balasan konfirmasi tidak terkena cooldown walau baru saja memakai command habit
  const yes = await send(jid, '.habit yes');
  assert.doesNotMatch(yes[0] ?? '', /Mohon tunggu/);
  assert.match(yes[0], /Tidak ada aksi/);
  const no = await send(jid, '.habit no');
  assert.doesNotMatch(no[0] ?? '', /Mohon tunggu/);
});

test('pengecualian cooldown tidak melewati ACL: non-owner yang mengirim .habit yes tetap diabaikan', async () => {
  const r = await send('penyusup@s.whatsapp.net', '.habit yes');
  assert.equal(r.length, 0);
});

test('teks natural yang diawali kata konfirmasi tapi lebih panjang tetap terkena cooldown', async () => {
  const jid = 'owner3@s.whatsapp.net';
  const r = await send(jid, '.habit yes tolong hapus semuanya');
  assert.match(r[0], /Mohon tunggu/);
});

test('teardown: bersihkan timer', () => {
  habitModule.teardown();
});
