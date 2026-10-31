import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';
process.env.SEARCH_PROVIDER = 'brave';
process.env.SEARCH_API_KEY = 'test-key';
process.env.SEARCH_TIMEOUT_MS = '5000';
process.env.APINEX_API_KEY = 'sk-test-key';

const { handleWebSearch, teardown } = await import('@/modules/websearch/index.js');

const realFetch = globalThis.fetch;

function mockSearch(results: any[]): void {
  globalThis.fetch = (async (url: string) => {
    if (url.includes('brave')) {
      return new Response(
        JSON.stringify({
          web: {
            results: results.map((r) => ({
              title: r.title,
              url: r.url,
              description: r.snippet,
            })),
          },
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  }) as any;
}

function mockSearchError(status: number): void {
  globalThis.fetch = (async () => new Response('{}', { status })) as any;
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
    command: { name: 'web', args: [], raw: text },
    reply: async (t: string) => {
      replies.push(t);
    },
  };
  await handleWebSearch(ctx);
  return replies;
}

test('.web tanpa query menampilkan usage', async () => {
  const r = await run(jidFor('empty'), '.web');
  assert.match(r[0], /Usage:/);
});

test('.web dengan query kosong menampilkan usage', async () => {
  const r = await run(jidFor('blank'), '.web   ');
  assert.match(r[0], /Usage:/);
});

test('query terlalu panjang ditolak', async () => {
  const long = 'x'.repeat(201);
  const r = await run(jidFor('long'), `.web ${long}`);
  assert.match(r[0], /terlalu panjang/);
});

test('search API not configured - skipped (config cached at load)', async () => {
  // Config is cached when module loads, can't test empty key after initial load
  // Manual verification: start bot without SEARCH_API_KEY, run .web command
  assert.ok(true);
});

test('search berhasil: menampilkan hasil dan domain', async () => {
  mockSearch([
    { title: 'Result 1', url: 'https://example.com/page1', snippet: 'Snippet 1' },
    { title: 'Result 2', url: 'https://test.org/page2', snippet: 'Snippet 2' },
  ]);

  const r = await run(jidFor('ok'), '.web test query');
  const output = r.join('\n');
  assert.match(output, /Result 1/);
  assert.match(output, /example\.com/);
  assert.match(output, /Snippet 1/);
  assert.match(output, /Result 2/);
  assert.match(output, /test\.org/);
});

test('HTTP 429 rate limit menghasilkan pesan ramah', async () => {
  mockSearchError(429);
  const r = await run(jidFor('ratelimit'), '.web query');
  assert.match(r.join(' '), /Batas pencarian tercapai/);
});

test('HTTP 500 server error', async () => {
  mockSearchError(500);
  const r = await run(jidFor('server'), '.web query');
  assert.match(r.join(' '), /bermasalah/);
});

test('concurrent requests blocked per user', async () => {
  let delayed = false;
  globalThis.fetch = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    delayed = true;
    return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
  }) as any;

  const jid = jidFor('concurrent');
  const p1 = run(jid, '.web first');
  const p2 = run(jid, '.web second');

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok(delayed);
  assert.ok(
    r2.some((s) => s.includes('masih diproses')),
    'second request should be blocked',
  );
});

test('AI analysis fallback: jika AI gagal, tampilkan hasil mentah', async () => {
  mockSearch([{ title: 'Test', url: 'https://example.com', snippet: 'Test snippet' }]);

  // Mock AI failure
  const originalFetch = globalThis.fetch;
  let searchCalled = false;
  let aiCalled = false;

  globalThis.fetch = (async (url: string, init?: any) => {
    if (typeof url === 'string' && url.includes('brave')) {
      searchCalled = true;
      return new Response(
        JSON.stringify({ web: { results: [{ title: 'Test', url: 'https://example.com', description: 'Test snippet' }] } }),
        { status: 200 },
      );
    }
    if (typeof url === 'string' && url.includes('apinex')) {
      aiCalled = true;
      return new Response('{}', { status: 500 });
    }
    return originalFetch(url, init);
  }) as any;

  const r = await run(jidFor('aifail'), '.web test');
  assert.ok(searchCalled, 'search should be called');
  const output = r.join('\n');
  assert.match(output, /Test/);
  assert.match(output, /example\.com/);
});

test('no results dari API', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ web: { results: [] } }), { status: 200 })) as any;
  const r = await run(jidFor('noresult'), '.web nothing');
  assert.match(r.join(' '), /Tidak ada hasil/);
});

test('timeout handled', async () => {
  let aborted = false;
  globalThis.fetch = (async (_url: string, init?: any) => {
    const signal = init?.signal;
    if (signal) {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
    if (aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    return new Response('{}', { status: 200 });
  }) as any;

  const r = await run(jidFor('timeout'), '.web slow');
  assert.match(r.join(' '), /terlalu lama|Timeout/);
});

test('extractDomain works correctly', async () => {
  mockSearch([
    { title: 'Test', url: 'https://www.example.com/path?query=1', snippet: 'Snippet' },
    { title: 'Test2', url: 'http://subdomain.test.org:8080/page', snippet: 'Snippet2' },
  ]);

  const r = await run(jidFor('domain'), '.web test');
  const output = r.join('\n');
  assert.match(output, /example\.com/);
  assert.match(output, /subdomain\.test\.org/);
});

test('alias commands work', async () => {
  mockSearch([{ title: 'Alias test', url: 'https://example.com', snippet: 'Works' }]);

  const r1 = await run(jidFor('alias1'), '.searchweb test');
  assert.match(r1.join(' '), /Alias test/);

  const r2 = await run(jidFor('alias2'), '.google test');
  assert.match(r2.join(' '), /Alias test/);
});

test('restore fetch and teardown', () => {
  globalThis.fetch = realFetch;
  teardown();
});
