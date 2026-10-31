import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';
process.env.GITHUB_TOKEN = 'ghp_test123';
process.env.GITHUB_TIMEOUT_MS = '5000';

const { handleGitHub, teardown } = await import('@/modules/github/index.js');

const realFetch = globalThis.fetch;

function mockGitHubRepo(repoName: string, stars: number): void {
  globalThis.fetch = (async (url: string) => {
    if (typeof url === 'string' && url.includes('/repos/')) {
      return new Response(
        JSON.stringify({
          name: repoName.split('/')[1],
          full_name: repoName,
          description: 'Test repository',
          html_url: `https://github.com/${repoName}`,
          stargazers_count: stars,
          forks_count: 100,
          open_issues_count: 5,
          language: 'TypeScript',
          created_at: '2020-01-01T00:00:00Z',
          updated_at: '2026-10-31T00:00:00Z',
          default_branch: 'main',
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  }) as any;
}

function mockGitHubUser(username: string, repos: number): void {
  globalThis.fetch = (async (url: string) => {
    if (typeof url === 'string' && url.includes('/users/')) {
      return new Response(
        JSON.stringify({
          login: username,
          name: 'Test User',
          bio: 'Test bio',
          html_url: `https://github.com/${username}`,
          public_repos: repos,
          followers: 50,
          following: 30,
          created_at: '2020-01-01T00:00:00Z',
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  }) as any;
}

function mockGitHubError(status: number): void {
  globalThis.fetch = (async () => {
    if (status === 403) {
      return new Response('{}', {
        status: 403,
        headers: { 'X-RateLimit-Remaining': '0' },
      });
    }
    return new Response('{}', { status });
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
    command: { name: 'github', args: [], raw: text },
    reply: async (t: string) => {
      replies.push(t);
    },
  };
  await handleGitHub(ctx);
  return replies;
}

test('.github tanpa argument menampilkan help', async () => {
  const r = await run(jidFor('help'), '.github');
  assert.match(r[0], /Commands:/);
  assert.match(r[0], /github repo/);
});

test('.github repo tanpa nama repo menampilkan error', async () => {
  const r = await run(jidFor('norepo'), '.github repo');
  assert.match(r[0], /Argument required/);
});

test('.github repo <owner>/<repo> menampilkan info repo', async () => {
  mockGitHubRepo('facebook/react', 200000);
  const r = await run(jidFor('repo'), '.github repo facebook/react');
  const output = r.join('\n');
  assert.match(output, /facebook\/react/);
  assert.match(output, /Test repository/);
  assert.match(output, /200\.000 stars/);
});

test('.github user <username> menampilkan info user', async () => {
  mockGitHubUser('torvalds', 25);
  const r = await run(jidFor('user'), '.github user torvalds');
  const output = r.join('\n');
  assert.match(output, /Test User/);
  assert.match(output, /@torvalds/);
  assert.match(output, /25 repositories/);
});

test('HTTP 404 not found', async () => {
  teardown();
  mockGitHubError(404);
  const r = await run(jidFor('notfound'), '.github repo doesnotexist/repo');
  assert.match(r.join(' '), /tidak ditemukan/);
});

test('HTTP 403 rate limit', async () => {
  teardown();
  mockGitHubError(403);
  const r = await run(jidFor('ratelimit'), '.github repo test/test');
  assert.match(r.join(' '), /Rate limit/);
});

test('HTTP 401 unauthorized', async () => {
  teardown();
  mockGitHubError(401);
  const r = await run(jidFor('unauth'), '.github repo test/test');
  assert.match(r.join(' '), /Token GitHub tidak valid/);
});

test('HTTP 500 server error', async () => {
  teardown();
  mockGitHubError(500);
  const r = await run(jidFor('server'), '.github repo test/test');
  assert.match(r.join(' '), /bermasalah/);
});

test('concurrent requests blocked per user+subcommand+arg', async () => {
  let delayed = false;
  globalThis.fetch = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    delayed = true;
    return new Response(
      JSON.stringify({
        name: 'test',
        full_name: 'test/test',
        description: 'Test',
        html_url: 'https://github.com/test/test',
        stargazers_count: 1,
        forks_count: 0,
        open_issues_count: 0,
        language: null,
        created_at: '2020-01-01T00:00:00Z',
        updated_at: '2026-10-31T00:00:00Z',
        default_branch: 'main',
      }),
      { status: 200 },
    );
  }) as any;

  const jid = jidFor('concurrent');
  const p1 = run(jid, '.github repo test/test');
  const p2 = run(jid, '.github repo test/test');

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok(delayed);
  assert.ok(
    r2.some((s) => s.includes('masih diproses')),
    'second request should be blocked',
  );
});

test('cache: second request served from cache', async () => {
  teardown();

  let apiCalls = 0;
  globalThis.fetch = (async () => {
    apiCalls++;
    return new Response(
      JSON.stringify({
        name: 'cache',
        full_name: 'test/cache',
        description: 'Cache test',
        html_url: 'https://github.com/test/cache',
        stargazers_count: 10,
        forks_count: 2,
        open_issues_count: 1,
        language: 'JavaScript',
        created_at: '2020-01-01T00:00:00Z',
        updated_at: '2026-10-31T00:00:00Z',
        default_branch: 'main',
      }),
      { status: 200 },
    );
  }) as any;

  const jid = jidFor('cache');
  await run(jid, '.github repo test/cache');
  assert.equal(apiCalls, 1);

  await run(jid, '.github repo test/cache');
  assert.equal(apiCalls, 1, 'should use cache');
});

test('unknown subcommand shows error', async () => {
  const r = await run(jidFor('unknown'), '.github invalid test/test');
  assert.match(r[0], /tidak dikenal/);
});

test('alias .gh works', async () => {
  mockGitHubRepo('test/alias', 1);
  const r = await run(jidFor('alias'), '.gh repo test/alias');
  assert.match(r.join('\n'), /test\/alias/);
});

test('timeout handled', async () => {
  teardown();
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

  const r = await run(jidFor('timeout'), '.github repo slow/repo');
  assert.match(r.join(' '), /terlalu lama|Timeout/);
});

test('restore fetch and teardown', () => {
  globalThis.fetch = realFetch;
  teardown();
});
