import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';
process.env.APINEX_API_KEY = 'sk-test-key';
process.env.AI_TIMEOUT_MS = '1000';
process.env.AI_MAX_HISTORY = '4';

const { aiService, AiError } = await import('@/core/ai-service.js');
const { aiRepo } = await import('@/database/repositories/ai.repo.js');
const { initializeDatabase } = await import('@/database/connection.js');
const { splitMessage } = await import('@/modules/ai/index.js');

initializeDatabase(':memory:');

const realFetch = globalThis.fetch;
let lastBody: any = null;
let calls = 0;

function mockFetch(impl: (init: any) => Promise<Response>): void {
  calls = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    calls++;
    lastBody = JSON.parse(init.body);
    return impl(init);
  }) as any;
}

function okResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}

test('pertanyaan sederhana', async () => {
  let auth = '';
  mockFetch(async (init) => {
    auth = init.headers.Authorization;
    return okResponse('Halo!');
  });
  const answer = await aiService.chat([{ role: 'user', content: 'Hai' }]);
  assert.equal(answer, 'Halo!');
  assert.equal(lastBody.model, 'free/gpt-6-luna');
  assert.equal(lastBody.messages[0].role, 'system');
  assert.equal(lastBody.messages.at(-1).content, 'Hai');
  assert.equal(auth, 'Bearer sk-test-key');
});

test('multi-turn: riwayat ikut terkirim dan dibatasi', async () => {
  const jid = 'multi@s.whatsapp.net';
  mockFetch(async () => okResponse('jawaban'));

  for (let i = 1; i <= 4; i++) {
    const history = aiRepo.getHistory(jid, 4);
    await aiService.chat([...history, { role: 'user', content: `q${i}` }]);
    aiRepo.addMessage(jid, 'user', `q${i}`);
    aiRepo.addMessage(jid, 'assistant', 'jawaban');
    aiRepo.trim(jid, 4);
  }

  const history = aiRepo.getHistory(jid, 10);
  assert.equal(history.length, 4);
  assert.equal(history[0].content, 'q3');
  assert.equal(history[2].content, 'q4');
  // system prompt + 4 riwayat + pertanyaan terakhir (q4) pada request ke-4
  assert.equal(lastBody.messages.length, 1 + 4 + 1);
});

test('reset history', () => {
  const jid = 'reset@s.whatsapp.net';
  aiRepo.addMessage(jid, 'user', 'a');
  aiRepo.addMessage(jid, 'assistant', 'b');
  assert.equal(aiRepo.clearHistory(jid), 2);
  assert.equal(aiRepo.getHistory(jid, 10).length, 0);
  assert.equal(aiRepo.clearHistory(jid), 0);
});

test('respons panjang dipecah menjadi beberapa pesan', () => {
  const paragraph = 'kalimat uji coba yang cukup panjang. '.repeat(40).trim();
  const long = Array.from({ length: 10 }, () => paragraph).join('\n\n');
  const parts = splitMessage(long);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 3500 && p.length > 0));
  assert.equal(splitMessage('pendek').length, 1);
  assert.equal(splitMessage('x'.repeat(8000)).length, 3);
});

test('HTTP 429 dicoba ulang lalu berhasil', async () => {
  let n = 0;
  mockFetch(async () => {
    n++;
    if (n === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
    return okResponse('berhasil setelah retry');
  });
  const answer = await aiService.chat([{ role: 'user', content: 'x' }]);
  assert.equal(answer, 'berhasil setelah retry');
  assert.equal(calls, 2);
});

test('HTTP 429 terus-menerus menghasilkan error rate_limit', async () => {
  mockFetch(async () => new Response('', { status: 429, headers: { 'retry-after': '0' } }));
  await assert.rejects(
    () => aiService.chat([{ role: 'user', content: 'x' }]),
    (e: any) => e instanceof AiError && e.kind === 'rate_limit',
  );
  assert.equal(calls, 3);
});

test('API failure: 500 dicoba ulang lalu berhasil', async () => {
  let n = 0;
  mockFetch(async () => {
    n++;
    return n === 1 ? new Response('', { status: 500 }) : okResponse('pulih');
  });
  assert.equal(await aiService.chat([{ role: 'user', content: 'x' }]), 'pulih');
});

test('API failure: 401 tidak dicoba ulang', async () => {
  mockFetch(async () => new Response('', { status: 401 }));
  await assert.rejects(
    () => aiService.chat([{ role: 'user', content: 'x' }]),
    (e: any) => e instanceof AiError && e.kind === 'auth',
  );
  assert.equal(calls, 1);
});

test('API failure: respons kosong ditolak', async () => {
  mockFetch(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
  await assert.rejects(
    () => aiService.chat([{ role: 'user', content: 'x' }]),
    (e: any) => e instanceof AiError && e.kind === 'bad_response',
  );
});

test('timeout menghasilkan error timeout', async () => {
  mockFetch(
    (init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  );
  await assert.rejects(
    () => aiService.chat([{ role: 'user', content: 'x' }]),
    (e: any) => e instanceof AiError && e.kind === 'timeout',
  );
  assert.equal(calls, 1);
});

test('pulihkan fetch asli', () => {
  globalThis.fetch = realFetch;
});
