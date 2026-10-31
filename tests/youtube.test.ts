import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';
process.env.YOUTUBE_TIMEOUT_MS = '5000';
process.env.APINEX_API_KEY = 'sk-test-key';

const { handleYouTube, teardown } = await import('@/modules/youtube/index.js');

const realFetch = globalThis.fetch;

// Mock YoutubeTranscript module
const mockTranscripts = new Map<string, any>();

function mockYouTubeTranscript(videoId: string, items: any[]): void {
  mockTranscripts.set(videoId, items);
}

function mockYouTubeError(videoId: string, errorType: 'not_found' | 'no_transcript' | 'disabled'): void {
  mockTranscripts.set(videoId, { error: errorType });
}

// Patch YoutubeTranscript
const ytModule = await import('youtube-transcript');
const originalFetch = ytModule.YoutubeTranscript.fetchTranscript;
ytModule.YoutubeTranscript.fetchTranscript = async (videoId: string) => {
  const mock = mockTranscripts.get(videoId);
  if (!mock) {
    throw new Error('Could not find video');
  }
  if (mock.error === 'not_found') {
    throw new Error('Could not find video');
  }
  if (mock.error === 'no_transcript') {
    throw new Error('Transcript is disabled on this video');
  }
  if (mock.error === 'disabled') {
    throw new Error('Transcript is disabled on this video');
  }
  return mock;
};

function mockAI(response: string): void {
  globalThis.fetch = (async (url: string) => {
    if (typeof url === 'string' && url.includes('apinex')) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: response } }],
        }),
        { status: 200 },
      );
    }
    return realFetch(url);
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
    command: { name: 'youtube', args: [], raw: text },
    reply: async (t: string) => {
      replies.push(t);
    },
  };
  await handleYouTube(ctx);
  return replies;
}

test('.youtube tanpa URL menampilkan help', async () => {
  const r = await run(jidFor('help'), '.youtube');
  assert.match(r[0], /Commands:/);
  assert.match(r[0], /.yt <url>/);
});

test('.yt tanpa URL menampilkan help', async () => {
  const r = await run(jidFor('help2'), '.yt');
  assert.match(r[0], /Commands:/);
});

test('URL tidak valid ditolak', async () => {
  const r = await run(jidFor('invalid'), '.yt https://example.com/video');
  assert.match(r[0], /tidak valid/);
});

test('URL YouTube valid diekstrak video ID', async () => {
  teardown();
  mockYouTubeTranscript('dQw4w9WgXcQ', [
    { text: 'Test transcript', duration: 1000, offset: 0 },
  ]);
  mockAI('Ringkasan: Test video');

  const r = await run(jidFor('valid'), '.yt https://youtube.com/watch?v=dQw4w9WgXcQ');
  const output = r.join('\n');
  assert.match(output, /Ringkasan/);
  assert.match(output, /youtube.com\/watch\?v=dQw4w9WgXcQ/);
});

test('URL youtu.be valid', async () => {
  teardown();
  mockYouTubeTranscript('shorturl123', [
    { text: 'Short URL test', duration: 1000, offset: 0 },
  ]);
  mockAI('Ringkasan: Short URL video');

  const r = await run(jidFor('short'), '.yt https://youtu.be/shorturl123');
  const output = r.join('\n');
  assert.match(output, /Ringkasan/);
});

test('video ID langsung diterima', async () => {
  teardown();
  mockYouTubeTranscript('directid456', [
    { text: 'Direct ID test', duration: 1000, offset: 0 },
  ]);
  mockAI('Ringkasan: Direct ID');

  const r = await run(jidFor('direct'), '.yt directid456');
  const output = r.join('\n');
  assert.match(output, /Ringkasan/);
});

test('.yt short mode menghasilkan ringkasan singkat', async () => {
  teardown();
  mockYouTubeTranscript('shortmode01', [
    { text: 'Test short mode', duration: 1000, offset: 0 },
  ]);
  mockAI('📺 RINGKASAN VIDEO\n\n📝 Ringkasan Utama:\nTest');

  const r = await run(jidFor('shortmode'), '.yt short shortmode01');
  const output = r.join('\n');
  assert.match(output, /RINGKASAN VIDEO/);
});

test('.yt detailed mode menghasilkan ringkasan detail', async () => {
  teardown();
  mockYouTubeTranscript('detailed01', [
    { text: 'Test detailed mode', duration: 1000, offset: 0 },
  ]);
  mockAI('📺 RINGKASAN VIDEO\n\n📝 Ringkasan Utama:\nDetailed summary');

  const r = await run(jidFor('detailed'), '.yt detailed detailed01');
  const output = r.join('\n');
  assert.match(output, /RINGKASAN VIDEO/);
});

test('video tidak ditemukan', async () => {
  teardown();
  mockYouTubeError('notfound99', 'not_found');

  const r = await run(jidFor('notfound'), '.yt notfound99');
  assert.match(r.join(' '), /tidak tersedia|tidak ditemukan/);
});

test('video tanpa transcript', async () => {
  teardown();
  mockYouTubeError('notranscr1', 'no_transcript');

  const r = await run(jidFor('notrans'), '.yt notranscr1');
  assert.match(r.join(' '), /tidak memiliki captions/);
});

test('transcript disabled', async () => {
  teardown();
  mockYouTubeError('disabled01', 'disabled');

  const r = await run(jidFor('disabled'), '.yt disabled01');
  assert.match(r.join(' '), /tidak memiliki captions|dinonaktifkan/);
});

test('concurrent requests blocked per user+videoId', async () => {
  teardown();
  mockYouTubeTranscript('concurrent1', [
    { text: 'Concurrent test', duration: 1000, offset: 0 },
  ]);

  let aiCalls = 0;
  globalThis.fetch = (async (url: string) => {
    if (typeof url === 'string' && url.includes('apinex')) {
      aiCalls++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Summary' } }],
        }),
        { status: 200 },
      );
    }
    return realFetch(url);
  }) as any;

  const jid = jidFor('concurrent');
  const p1 = run(jid, '.yt concurrent1');
  const p2 = run(jid, '.yt concurrent1');

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok(
    r2.some((s) => s.includes('masih diproses')),
    'second request should be blocked',
  );
});

test('cache: summary disimpan dan digunakan kembali', async () => {
  teardown();
  mockYouTubeTranscript('cachevid01', [
    { text: 'Cache test transcript', duration: 1000, offset: 0 },
  ]);

  let aiCalls = 0;
  globalThis.fetch = (async (url: string) => {
    if (typeof url === 'string' && url.includes('apinex')) {
      aiCalls++;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Cached summary' } }],
        }),
        { status: 200 },
      );
    }
    return realFetch(url);
  }) as any;

  const jid = jidFor('cache');
  await run(jid, '.yt cachevid01');
  assert.equal(aiCalls, 1);

  await run(jid, '.yt cachevid01');
  assert.equal(aiCalls, 1, 'should use cached summary');
});

test('cache: short dan detailed terpisah', async () => {
  teardown();
  mockYouTubeTranscript('cachemode1', [
    { text: 'Mode cache test', duration: 1000, offset: 0 },
  ]);

  let aiCalls = 0;
  globalThis.fetch = (async (url: string) => {
    if (typeof url === 'string' && url.includes('apinex')) {
      aiCalls++;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Summary' } }],
        }),
        { status: 200 },
      );
    }
    return realFetch(url);
  }) as any;

  const jid = jidFor('cachemode');
  await run(jid, '.yt short cachemode1');
  assert.equal(aiCalls, 1);

  await run(jid, '.yt detailed cachemode1');
  assert.equal(aiCalls, 2, 'detailed should call AI separately');
});

test('transcript terlalu panjang ditolak', async () => {
  teardown();
  const longText = 'x'.repeat(51000);
  mockYouTubeTranscript('toolong123', [
    { text: longText, duration: 1000, offset: 0 },
  ]);

  const r = await run(jidFor('toolong'), '.yt toolong123');
  assert.match(r.join(' '), /terlalu panjang/);
});

test('AI error fallback', async () => {
  teardown();
  mockYouTubeTranscript('aifail123', [
    { text: 'AI fail test', duration: 1000, offset: 0 },
  ]);

  globalThis.fetch = (async (url: string) => {
    if (typeof url === 'string' && url.includes('apinex')) {
      return new Response('{}', { status: 500 });
    }
    return realFetch(url);
  }) as any;

  const r = await run(jidFor('aifail'), '.yt aifail123');
  assert.match(r.join(' '), /kesalahan/);
});

test('restore and teardown', () => {
  ytModule.YoutubeTranscript.fetchTranscript = originalFetch;
  globalThis.fetch = realFetch;
  mockTranscripts.clear();
  teardown();
});
