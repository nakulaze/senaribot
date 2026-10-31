import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';
process.env.APINEX_API_KEY = 'sk-test-key';
process.env.AI_TIMEOUT_MS = '1000';
process.env.SUM_MAX_INPUT_CHARS = '1000';
process.env.SUM_CHUNK_CHARS = '8000';
process.env.SUM_CACHE_TTL_MS = '0';

const { handleSummarize } = await import('@/modules/summarizer/index.js');
const { summarizer } = await import('@/modules/summarizer/summarizer.js');

const realFetch = globalThis.fetch;
let calls = 0;
let lastBody: any = null;

function mockFetch(impl: () => Promise<Response>): void {
  calls = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    calls++;
    lastBody = init?.body ? JSON.parse(init.body) : null;
    return impl();
  }) as any;
}

function okResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}

function makeCtx(raw: string, sender: string, extra: Record<string, unknown> = {}) {
  const replies: string[] = [];
  const ctx: any = {
    id: 'm1',
    from: sender,
    sender,
    text: raw,
    command: { name: 'summarize', args: [], raw },
    quoted: null,
    document: null,
    reply: async (t: string) => {
      replies.push(t);
    },
    ...extra,
  };
  return { ctx, replies };
}

const body = 'Regresi linear adalah metode statistik untuk memodelkan hubungan antara variabel. '.repeat(5);

test('tanpa teks, dokumen, atau reply: tampilkan petunjuk tanpa memanggil API', async () => {
  mockFetch(async () => okResponse('tidak boleh terpanggil'));
  summarizer.clear();
  const { ctx, replies } = makeCtx('.summarize', 'usage@s.whatsapp.net');
  await handleSummarize(ctx);
  assert.equal(calls, 0);
  assert.match(replies[0], /Cara pakai AI Summarizer/);
});

test('teks terlalu pendek ditolak tanpa memanggil API', async () => {
  mockFetch(async () => okResponse('tidak boleh terpanggil'));
  const { ctx, replies } = makeCtx('.summarize halo', 'pendek@s.whatsapp.net');
  await handleSummarize(ctx);
  assert.equal(calls, 0);
  assert.match(replies[replies.length - 1], /terlalu pendek/);
});

test('alur sukses: model dari konfigurasi dan batas token dipakai', async () => {
  mockFetch(async () => okResponse('JUDUL: Regresi\nRINGKASAN UTAMA: ok'));
  summarizer.clear();
  const { ctx, replies } = makeCtx(`.sum short ${body}`, 'sukses@s.whatsapp.net');
  await handleSummarize(ctx);
  assert.equal(calls, 1);
  assert.equal(lastBody.model, 'free/gpt-6-luna');
  assert.equal(lastBody.max_tokens, 1024);
  assert.match(replies[0], /Sedang merangkum teks/);
  assert.match(replies[0], /Short Summary/);
  assert.match(replies[1], /JUDUL: Regresi/);
});

test('input melebihi batas dipotong dan pengguna diberi tahu', async () => {
  mockFetch(async () => okResponse('ringkasan'));
  summarizer.clear();
  const { ctx, replies } = makeCtx(`.summarize ${'kalimat panjang. '.repeat(200)}`, 'potong@s.whatsapp.net');
  await handleSummarize(ctx);
  assert.match(replies[replies.length - 1], /dipotong ke 1000 karakter/);
});

test('reply ke pesan teks dirangkum', async () => {
  mockFetch(async () => okResponse('ringkasan reply'));
  summarizer.clear();
  const { ctx, replies } = makeCtx('.summarize bullets', 'reply@s.whatsapp.net', {
    quoted: { text: body },
  });
  await handleSummarize(ctx);
  assert.equal(calls, 1);
  assert.equal(replies[replies.length - 1], 'ringkasan reply');
});

test('dokumen format tidak didukung dijelaskan ke pengguna', async () => {
  mockFetch(async () => okResponse('tidak boleh terpanggil'));
  const doc = { fileName: 'laporan.docx', mimeType: 'application/msword', fileLength: 1000, source: {} };
  const { ctx, replies } = makeCtx('.summarize', 'docx@s.whatsapp.net', { document: doc });
  await handleSummarize(ctx);
  assert.equal(calls, 0);
  assert.match(replies[replies.length - 1], /Hanya PDF dan TXT/);
});

test('dokumen terlalu besar ditolak sebelum diunduh', async () => {
  mockFetch(async () => okResponse('tidak boleh terpanggil'));
  const doc = { fileName: 'besar.pdf', mimeType: 'application/pdf', fileLength: 50 * 1024 * 1024, source: {} };
  const { ctx, replies } = makeCtx('.summarize', 'besar@s.whatsapp.net', { document: doc });
  await handleSummarize(ctx);
  assert.equal(calls, 0);
  assert.match(replies[replies.length - 1], /terlalu besar/);
});

test('kegagalan API menghasilkan pesan ramah tanpa membocorkan kunci', async () => {
  mockFetch(async () => new Response('', { status: 401 }));
  summarizer.clear();
  const { ctx, replies } = makeCtx(`.summarize ${body} gagal`, 'gagal@s.whatsapp.net');
  await handleSummarize(ctx);
  const last = replies[replies.length - 1];
  assert.match(last, /Autentikasi/);
  assert.ok(!last.includes('sk-test-key'));
});

test('permintaan kedua saat yang pertama berjalan ditolak', async () => {
  let release: (r: Response) => void = () => {};
  mockFetch(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  summarizer.clear();
  const jid = 'inflight@s.whatsapp.net';
  const first = makeCtx(`.summarize ${body} satu`, jid);
  const pending = handleSummarize(first.ctx);
  await new Promise((r) => setTimeout(r, 20));

  const second = makeCtx(`.summarize ${body} dua`, jid);
  await handleSummarize(second.ctx);
  assert.equal(calls, 1);
  assert.match(second.replies[0], /masih diproses/);

  release(okResponse('selesai'));
  await pending;
  assert.equal(first.replies[first.replies.length - 1], 'selesai');
});

test('pulihkan fetch asli', () => {
  globalThis.fetch = realFetch;
});
