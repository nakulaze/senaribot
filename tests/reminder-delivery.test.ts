import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';

const { initializeDatabase } = await import('@/database/connection.js');
initializeDatabase(':memory:');
const { checkAndSendReminders, setReminderSender } = await import('@/modules/reminder/index.js');
const { ReminderRepository } = await import('@/database/repositories/reminder.repo.js');
const repo = new ReminderRepository();

const now = () => Math.floor(Date.now() / 1000);
function add(jid: string, title: string, trigger: number) {
  return repo.insertReminder({ user_jid: jid, title, description: null, trigger_time: trigger, state: 'pending', recurrence: null });
}

test('reminder jatuh tempo dikirim ke WhatsApp lalu ditandai sent', async () => {
  const sent: Array<[string, string]> = [];
  setReminderSender(async (jid, text) => { sent.push([jid, text]); });
  const r = add('a@s.whatsapp.net', 'Todo: Belajar', now() - 5);
  await checkAndSendReminders();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'a@s.whatsapp.net');
  assert.match(sent[0][1], /Todo: Belajar/);
  assert.equal(repo.getById(r.id)?.state, 'sent');
});

test('reminder masa depan tidak dikirim', async () => {
  const sent: string[] = [];
  setReminderSender(async (jid) => { sent.push(jid); });
  const r = add('b@s.whatsapp.net', 'Nanti', now() + 3600);
  await checkAndSendReminders();
  assert.equal(sent.includes('b@s.whatsapp.net'), false);
  assert.equal(repo.getById(r.id)?.state, 'pending');
});

test('gagal kirim tetap pending dan dicoba lagi di siklus berikutnya', async () => {
  const r = add('c@s.whatsapp.net', 'Retry', now() - 5);
  setReminderSender(async () => { throw new Error('Socket not connected'); });
  await checkAndSendReminders();
  assert.equal(repo.getById(r.id)?.state, 'pending');
  let delivered = 0;
  setReminderSender(async () => { delivered++; });
  await checkAndSendReminders();
  assert.equal(delivered, 1);
  assert.equal(repo.getById(r.id)?.state, 'sent');
});

test('tanpa pengirim, reminder tidak ditandai sent', async () => {
  setReminderSender(null);
  const r = add('d@s.whatsapp.net', 'Belum ada socket', now() - 5);
  await checkAndSendReminders();
  assert.equal(repo.getById(r.id)?.state, 'pending');
});
