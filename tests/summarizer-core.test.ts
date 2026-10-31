import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';
process.env.APINEX_API_KEY = 'sk-test-key';
process.env.SUM_CHUNK_CHARS = '500';
process.env.SUM_MAX_CONCURRENT = '1';
process.env.SUM_CACHE_TTL_MS = '600000';

const { Summarizer } = await import('@/modules/summarizer/summarizer.js');

function makeChat(impl?: (prompt: string) => Promise<string>) {
  const calls: { prompt: string; maxTokens?: number; systemPrompt?: string }[] = [];
  const chat = async (messages: { role: 'user'; content: string }[], options: any) => {
    calls.push({ prompt: messages[0].content, maxTokens: options.maxTokens, systemPrompt: options.systemPrompt });
    return impl ? impl(messages[0].content) : 'RINGKASAN';
  };
  return { chat, calls };
}

const longText = Array.from({ length: 60 }, (_, i) => `Kalimat penting nomor ${i} tentang topik.`).join(' ');

test('teks pendek: satu permintaan dengan system prompt summarizer', async () => {
  const { chat, calls } = makeChat();
  const s = new Summarizer({ chat });
  const out = await s.summarize('teks singkat yang muat dalam satu chunk saja', 'short');
  assert.equal(out.summary, 'RINGKASAN');
  assert.equal(out.cached, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].systemPrompt ?? '', /Summarizer/);
  assert.ok(calls[0].maxTokens && calls[0].maxTokens <= 1024);
});

test('teks panjang: map per chunk lalu reduce sekali', async () => {
  const { chat, calls } = makeChat();
  const s = new Summarizer({ chat });
  const out = await s.summarize(longText, 'detailed');
  assert.ok(out.chunks > 1);
  assert.equal(calls.length, out.chunks + 1);
  assert.match(calls[0].prompt, /Ini bagian 1 dari/);
  assert.match(calls[calls.length - 1].prompt, /Catatan bagian 1/);
});

test('permintaan identik kedua dilayani dari cache tanpa memanggil AI', async () => {
  const { chat, calls } = makeChat();
  const s = new Summarizer({ chat });
  await s.summarize('teks untuk uji cache yang cukup panjang', 'short');
  const before = calls.length;
  const second = await s.summarize('teks untuk uji cache yang cukup panjang', 'short');
  assert.equal(second.cached, true);
  assert.equal(calls.length, before);
});

test('gaya berbeda tidak berbagi cache', async () => {
  const { chat, calls } = makeChat();
  const s = new Summarizer({ chat });
  await s.summarize('teks sama untuk dua gaya berbeda', 'short');
  await s.summarize('teks sama untuk dua gaya berbeda', 'bullets');
  assert.equal(calls.length, 2);
});

test('permintaan identik yang sedang berjalan digabung menjadi satu panggilan', async () => {
  let release: (v: string) => void = () => {};
  const { chat, calls } = makeChat(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const s = new Summarizer({ chat });
  const a = s.summarize('teks paralel yang sama persis', 'short');
  const b = s.summarize('teks paralel yang sama persis', 'short');
  await new Promise((r) => setTimeout(r, 20));
  release('HASIL');
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  assert.equal(ra.summary, 'HASIL');
  assert.equal(rb.summary, 'HASIL');
});

test('kegagalan AI tidak disimpan ke cache dan bisa dicoba ulang', async () => {
  let fail = true;
  const { chat, calls } = makeChat(async () => {
    if (fail) throw new Error('boom');
    return 'BERHASIL';
  });
  const s = new Summarizer({ chat });
  await assert.rejects(() => s.summarize('teks untuk uji kegagalan ai', 'short'));
  fail = false;
  const out = await s.summarize('teks untuk uji kegagalan ai', 'short');
  assert.equal(out.summary, 'BERHASIL');
  assert.equal(out.cached, false);
  assert.equal(calls.length, 2);
});

test('batas konkurensi: job berbeda berjalan bergantian', async () => {
  let running = 0;
  let peak = 0;
  const { chat } = makeChat(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 15));
    running--;
    return 'OK';
  });
  const s = new Summarizer({ chat });
  await Promise.all([
    s.summarize('teks pertama yang berbeda', 'short'),
    s.summarize('teks kedua yang berbeda', 'short'),
    s.summarize('teks ketiga yang berbeda', 'short'),
  ]);
  assert.equal(peak, 1);
});
