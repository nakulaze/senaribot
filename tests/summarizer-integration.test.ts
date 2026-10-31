import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net,owner2@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';
process.env.APINEX_API_KEY = 'sk-test-key';
process.env.AI_TIMEOUT_MS = '1000';
process.env.SUM_CACHE_TTL_MS = '0';

const { initializeDatabase } = await import('@/database/connection.js');
initializeDatabase(':memory:');

const { dispatcher } = await import('@/pipeline/dispatcher.js');
const { registry } = await import('@/pipeline/registry.js');
const summarizerModule = await import('@/modules/summarizer/index.js');
const aiModule = await import('@/modules/ai/index.js');
const ledgerModule = await import('@/modules/ledger/index.js');

for (const mod of [aiModule, ledgerModule, summarizerModule]) {
  for (const cmd of await mod.setup()) registry.registerCommand(cmd);
}

const realFetch = globalThis.fetch;
let calls = 0;
function mockFetch(text: string): void {
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
  }) as any;
}

function makeCtx(text: string, sender: string, extra: Record<string, unknown> = {}) {
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
    ...extra,
  };
  return { ctx, replies };
}

const body = 'Regresi linear adalah metode statistik untuk memodelkan hubungan antar variabel. '.repeat(5);

test('registry: summarize dan alias sum menunjuk command yang sama, command lain tidak tertimpa', () => {
  assert.equal(registry.getCommand('summarize')?.name, 'summarize');
  assert.equal(registry.getCommand('sum')?.name, 'summarize');
  assert.equal(registry.getCommand('summary')?.name, 'summary');
  assert.equal(registry.getCommand('ask')?.name, 'ask');
});

test('owner: .sum short dikenali lewat dispatcher dan menghasilkan ringkasan', async () => {
  mockFetch('JUDUL: Tes\nRINGKASAN UTAMA: ok');
  const { ctx, replies } = makeCtx(`.sum short ${body}`, 'owner@s.whatsapp.net');
  await dispatcher.dispatch(ctx);
  assert.equal(calls, 1);
  assert.ok(replies.some((r) => r.includes('JUDUL: Tes')));
});

test('non-owner: diabaikan tanpa balasan dan tanpa memanggil API', async () => {
  mockFetch('tidak boleh terpanggil');
  const { ctx, replies } = makeCtx(`.summarize ${body}`, 'orang-asing@s.whatsapp.net');
  await dispatcher.dispatch(ctx);
  assert.equal(calls, 0);
  assert.equal(replies.length, 0);
});

test('cooldown: pemanggilan beruntun .sum lalu .summarize oleh owner yang sama dibatasi', async () => {
  mockFetch('ringkasan');
  const first = makeCtx(`.sum ${body}`, 'owner2@s.whatsapp.net');
  await dispatcher.dispatch(first.ctx);
  const second = makeCtx(`.summarize ${body} lain`, 'owner2@s.whatsapp.net');
  await dispatcher.dispatch(second.ctx);
  assert.equal(calls, 1);
  assert.match(second.replies[0], /Mohon tunggu/);
});

test('pulihkan fetch asli', () => {
  globalThis.fetch = realFetch;
});
