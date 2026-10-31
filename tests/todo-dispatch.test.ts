import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';

const { dispatcher } = await import('@/pipeline/dispatcher.js');
const { registry } = await import('@/pipeline/registry.js');
const todoModule = await import('@/modules/todo/index.js');
const { TodoRepository } = await import('@/database/repositories/todo.repo.js');
const { initializeDatabase } = await import('@/database/connection.js');

initializeDatabase(':memory:');
const todoRepo = new TodoRepository();
const OWNER = 'owner@s.whatsapp.net';

for (const cmd of await todoModule.setup()) registry.registerCommand(cmd);

async function send(text: string): Promise<string[]> {
  const replies: string[] = [];
  const ctx: any = {
    id: 'm1',
    from: OWNER,
    sender: OWNER,
    text,
    reply: async (t: string) => {
      replies.push(t);
    },
  };
  await dispatcher.dispatch(ctx);
  return replies;
}

test('registry: todo dan alias tugas menunjuk command yang sama', () => {
  assert.equal(registry.getCommand('todo')?.name, 'todo');
  assert.equal(registry.getCommand('tugas')?.name, 'todo');
});

test('lewat dispatcher: .todo clear lalu .todo yes langsung berurutan tetap bisa dikonfirmasi', async () => {
  todoRepo.insert({ user_jid: OWNER, title: 'satu' });
  todoRepo.insert({ user_jid: OWNER, title: 'dua' });

  const ask = await send('.todo clear');
  assert.match(ask[0], /\.todo yes/);

  const yes = await send('.todo yes');
  assert.doesNotMatch(yes.join('\n'), /Mohon tunggu/);
  assert.match(yes.join('\n'), /2 tugas dihapus/);
  assert.equal(todoRepo.list(OWNER).length, 0);
});

test('cooldown tetap berlaku untuk pesan .todo selain konfirmasi', async () => {
  await send('.todo stats');
  const second = await send('.todo stats');
  assert.match(second.join('\n'), /Mohon tunggu/);
  const natural = await send('.todo tidak usah hapus semuanya');
  assert.match(natural.join('\n'), /Mohon tunggu/);
});

test('non-owner tidak bisa memakai .todo yes walau dibebaskan dari cooldown', async () => {
  const replies: string[] = [];
  const ctx: any = {
    id: 'm2',
    from: 'stranger@s.whatsapp.net',
    sender: 'stranger@s.whatsapp.net',
    text: '.todo yes',
    reply: async (t: string) => {
      replies.push(t);
    },
  };
  await dispatcher.dispatch(ctx);
  assert.equal(replies.length, 0);
});
