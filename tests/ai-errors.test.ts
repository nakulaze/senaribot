import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';
process.env.APINEX_API_KEY = 'sk-test-key';
process.env.AI_TIMEOUT_MS = '1000';

const { aiService, AiError } = await import('@/core/ai-service.js');

const realFetch = globalThis.fetch;
let calls = 0;

function mockFetch(impl: () => Promise<Response>): void {
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return impl();
  }) as any;
}

const msg = [{ role: 'user' as const, content: 'x' }];

test('HTTP 400 menjadi bad_response dan tidak dicoba ulang', async () => {
  mockFetch(async () => new Response('', { status: 400 }));
  await assert.rejects(
    () => aiService.chat(msg),
    (e: any) => e instanceof AiError && e.kind === 'bad_response' && e.status === 400,
  );
  assert.equal(calls, 1);
});

test('HTTP 403 menjadi auth dan tidak dicoba ulang', async () => {
  mockFetch(async () => new Response('', { status: 403 }));
  await assert.rejects(
    () => aiService.chat(msg),
    (e: any) => e instanceof AiError && e.kind === 'auth',
  );
  assert.equal(calls, 1);
});

test('error jaringan menjadi network tanpa detail internal', async () => {
  mockFetch(async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:443');
  });
  await assert.rejects(
    () => aiService.chat(msg),
    (e: any) => e instanceof AiError && e.kind === 'network' && !e.message.includes('10.0.0.5'),
  );
  assert.equal(calls, 1);
});

test('HTTP 503 dicoba ulang 2 kali lalu menjadi error server', async () => {
  mockFetch(async () => new Response('', { status: 503 }));
  await assert.rejects(
    () => aiService.chat(msg),
    (e: any) => e instanceof AiError && e.kind === 'server' && e.status === 503,
  );
  assert.equal(calls, 3);
});

test('JSON tidak valid menjadi bad_response', async () => {
  mockFetch(async () => new Response('bukan json {', { status: 200 }));
  await assert.rejects(
    () => aiService.chat(msg),
    (e: any) => e instanceof AiError && e.kind === 'bad_response',
  );
  assert.equal(calls, 1);
});

test('format respons tak terduga menjadi bad_response', async () => {
  mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: 123 } }] }), { status: 200 }));
  await assert.rejects(
    () => aiService.chat(msg),
    (e: any) => e instanceof AiError && e.kind === 'bad_response',
  );
  mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }] }), { status: 200 }));
  await assert.rejects(
    () => aiService.chat(msg),
    (e: any) => e instanceof AiError && e.kind === 'bad_response',
  );
});

test('Retry-After non-numerik diabaikan dan memakai backoff default', async () => {
  let n = 0;
  mockFetch(async () => {
    n++;
    if (n === 1) return new Response('', { status: 429, headers: { 'retry-after': 'abc' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  });
  assert.equal(await aiService.chat(msg), 'ok');
  assert.equal(calls, 2);
});

test('pulihkan fetch asli', () => {
  globalThis.fetch = realFetch;
});
