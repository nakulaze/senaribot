import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';

const { dispatcher, UserFacingError } = await import('@/pipeline/dispatcher.js');
const { registry } = await import('@/pipeline/registry.js');

let runs = 0;

registry.registerCommand({
  name: 'dtest',
  aliases: ['dt'],
  description: 'test command',
  handler: async () => {
    runs++;
  },
  middlewares: ['acl'],
});

registry.registerCommand({
  name: 'dboom',
  aliases: [],
  description: 'throws internal error',
  handler: async () => {
    throw new Error('secret internal path C:/internal/db.sqlite');
  },
});

registry.registerCommand({
  name: 'dfriendly',
  aliases: [],
  description: 'throws user facing error',
  handler: async () => {
    throw new UserFacingError('pesan aman untuk pengguna');
  },
});

function makeCtx(text: string, sender: string) {
  const replies: string[] = [];
  const ctx: any = {
    id: 'm1',
    from: sender,
    sender,
    text,
    reply: async (t: string) => {
      replies.push(t);
    },
  };
  return { ctx, replies };
}

test('non-owner diabaikan tanpa balasan, walau command mendeklarasikan acl', async () => {
  runs = 0;
  const { ctx, replies } = makeCtx('.dtest', 'stranger@s.whatsapp.net');
  await dispatcher.dispatch(ctx);
  assert.equal(runs, 0);
  assert.equal(replies.length, 0);
});

test('non-owner tidak mendapat balasan untuk command yang tidak dikenal', async () => {
  const { ctx, replies } = makeCtx('.tidakada', 'stranger@s.whatsapp.net');
  await dispatcher.dispatch(ctx);
  assert.equal(replies.length, 0);
});

test('owner menjalankan command, lalu alias memakai cooldown yang sama', async () => {
  runs = 0;
  const first = makeCtx('.dtest', 'owner@s.whatsapp.net');
  await dispatcher.dispatch(first.ctx);
  assert.equal(runs, 1);

  const second = makeCtx('.dt', 'owner@s.whatsapp.net');
  await dispatcher.dispatch(second.ctx);
  assert.equal(runs, 1);
  assert.match(second.replies[0], /Mohon tunggu/);
});

test('error internal tidak membocorkan detail ke pengguna', async () => {
  const { ctx, replies } = makeCtx('.dboom', 'owner@s.whatsapp.net');
  await dispatcher.dispatch(ctx);
  assert.equal(replies.length, 1);
  assert.ok(!replies[0].includes('secret'));
  assert.ok(!replies[0].includes('db.sqlite'));
  assert.match(replies[0], /Terjadi kesalahan/);
});

test('UserFacingError menampilkan pesannya apa adanya', async () => {
  const { ctx, replies } = makeCtx('.dfriendly', 'owner@s.whatsapp.net');
  await dispatcher.dispatch(ctx);
  assert.equal(replies[0], 'pesan aman untuk pengguna');
});

test('command tidak dikenal dari owner mendapat balasan', async () => {
  const { ctx, replies } = makeCtx('.tidakada', 'owner@s.whatsapp.net');
  await dispatcher.dispatch(ctx);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /not found/);
});
