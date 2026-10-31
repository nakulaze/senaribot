import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';
process.env.APINEX_API_KEY = 'sk-test-key';
process.env.AI_TIMEOUT_MS = '1000';
process.env.AI_MAX_HISTORY = '4';

const { handleAsk, handleReset, extractQuestion } = await import('@/modules/ai/index.js');
const { aiRepo } = await import('@/database/repositories/ai.repo.js');
const { initializeDatabase } = await import('@/database/connection.js');

initializeDatabase(':memory:');

const realFetch = globalThis.fetch;
let calls = 0;

function mockFetch(impl: () => Promise<Response>): void {
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return impl();
  }) as any;
}

function okResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}

function makeCtx(text: string, sender: string) {
  const replies: string[] = [];
  const ctx: any = {
    id: 'm1',
    from: sender,
    sender,
    text,
    command: { name: 'ask', args: [], raw: text },
    reply: async (t: string) => {
      replies.push(t);
    },
  };
  return { ctx, replies };
}

test('extractQuestion mengambil teks setelah command dan alias', () => {
  assert.equal(extractQuestion({ command: { raw: '.ask apa itu regresi?' } } as any), 'apa itu regresi?');
  assert.equal(extractQuestion({ command: { raw: '.ai   halo   dunia' } } as any), 'halo   dunia');
  assert.equal(extractQuestion({ command: { raw: '.ask' } } as any), '');
  assert.equal(extractQuestion({ command: { raw: '.ask   ' } } as any), '');
});

test('input kosong ditolak tanpa memanggil API', async () => {
  mockFetch(async () => okResponse('tidak boleh terpanggil'));
  const { ctx, replies } = makeCtx('.ask', 'kosong@s.whatsapp.net');
  await handleAsk(ctx);
  assert.equal(calls, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /Tulis pertanyaannya/);
});

test('input terlalu panjang ditolak tanpa memanggil API', async () => {
  mockFetch(async () => okResponse('tidak boleh terpanggil'));
  const { ctx, replies } = makeCtx('.ask ' + 'x'.repeat(4001), 'panjang@s.whatsapp.net');
  await handleAsk(ctx);
  assert.equal(calls, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /terlalu panjang/);
});

test('alur sukses: jawaban terkirim dan riwayat tersimpan', async () => {
  mockFetch(async () => okResponse('Regresi linear adalah model statistik.'));
  const jid = 'sukses@s.whatsapp.net';
  const { ctx, replies } = makeCtx('.ask apa itu regresi linear?', jid);
  await handleAsk(ctx);
  assert.equal(calls, 1);
  assert.equal(replies[0], 'Sedang memproses pertanyaan Anda...');
  assert.equal(replies[1], 'Regresi linear adalah model statistik.');
  const history = aiRepo.getHistory(jid, 10);
  assert.equal(history.length, 2);
  assert.equal(history[0].role, 'user');
  assert.equal(history[1].role, 'assistant');
});

test('kegagalan API menghasilkan pesan ramah dan tidak menyimpan riwayat', async () => {
  mockFetch(async () => new Response('', { status: 401 }));
  const jid = 'gagal@s.whatsapp.net';
  const { ctx, replies } = makeCtx('.ask halo', jid);
  await handleAsk(ctx);
  const last = replies[replies.length - 1];
  assert.match(last, /Autentikasi/);
  assert.ok(!last.includes('sk-test-key'));
  assert.equal(aiRepo.getHistory(jid, 10).length, 0);
});

test('error jaringan tidak membocorkan detail internal', async () => {
  mockFetch(async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:443');
  });
  const { ctx, replies } = makeCtx('.ask tes jaringan', 'jaringan@s.whatsapp.net');
  await handleAsk(ctx);
  const last = replies[replies.length - 1];
  assert.match(last, /Tidak bisa terhubung/);
  assert.ok(!last.includes('ECONNREFUSED'));
  assert.ok(!last.includes('10.0.0.5'));
});

test('kegagalan simpan riwayat tidak menggagalkan jawaban', async () => {
  mockFetch(async () => okResponse('jawaban tetap terkirim'));
  const original = aiRepo.addExchange.bind(aiRepo);
  aiRepo.addExchange = () => {
    throw new Error('disk full');
  };
  try {
    const { ctx, replies } = makeCtx('.ask uji simpan gagal', 'dbfail@s.whatsapp.net');
    await handleAsk(ctx);
    assert.equal(replies[replies.length - 1], 'jawaban tetap terkirim');
  } finally {
    aiRepo.addExchange = original;
  }
});

test('pertanyaan identik dalam 10 detik diabaikan', async () => {
  mockFetch(async () => okResponse('jawaban pertama'));
  const jid = 'duplikat@s.whatsapp.net';
  const first = makeCtx('.ask pertanyaan sama', jid);
  await handleAsk(first.ctx);
  assert.equal(calls, 1);

  const second = makeCtx('.ask pertanyaan sama', jid);
  await handleAsk(second.ctx);
  assert.equal(calls, 1);
  assert.equal(second.replies.length, 1);
  assert.match(second.replies[0], /Permintaan ganda diabaikan/);
});

test('permintaan kedua saat yang pertama berjalan ditolak', async () => {
  let release: (r: Response) => void = () => {};
  mockFetch(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const jid = 'inflight@s.whatsapp.net';
  const first = makeCtx('.ask pertanyaan lambat', jid);
  const pending = handleAsk(first.ctx);
  await new Promise((r) => setTimeout(r, 20));

  const second = makeCtx('.ask pertanyaan lain', jid);
  await handleAsk(second.ctx);
  assert.equal(calls, 1);
  assert.match(second.replies[0], /masih diproses/);

  release(okResponse('selesai'));
  await pending;
  assert.equal(first.replies[first.replies.length - 1], 'selesai');
});

test('resetai menghapus riwayat milik pengirim saja', async () => {
  const a = 'reset-a@s.whatsapp.net';
  const b = 'reset-b@s.whatsapp.net';
  aiRepo.addMessage(a, 'user', 'x');
  aiRepo.addMessage(a, 'assistant', 'y');
  aiRepo.addMessage(b, 'user', 'z');

  const { ctx, replies } = makeCtx('.resetai', a);
  await handleReset(ctx);
  assert.match(replies[0], /2 pesan dihapus/);
  assert.equal(aiRepo.getHistory(a, 10).length, 0);
  assert.equal(aiRepo.getHistory(b, 10).length, 1);

  const again = makeCtx('.resetai', a);
  await handleReset(again.ctx);
  assert.match(again.replies[0], /Belum ada riwayat/);
});

test('pulihkan fetch asli', () => {
  globalThis.fetch = realFetch;
});
