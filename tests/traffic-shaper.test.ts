import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';

const { TrafficShaper } = await import('@/core/traffic-shaper.js');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(20);
  }
}

test('pengiriman tidak tumpang tindih dan urutan terjaga', async () => {
  const sent: string[] = [];
  let active = 0;
  let maxActive = 0;

  const shaper = new TrafficShaper(async (msg: any) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(250);
    sent.push(msg.payload.text);
    active--;
  });

  shaper.enqueue('a@s.whatsapp.net', { text: 'bagian-1' });
  shaper.enqueue('a@s.whatsapp.net', { text: 'bagian-2' });
  shaper.enqueue('a@s.whatsapp.net', { text: 'bagian-3' });

  await waitFor(() => sent.length === 3);
  shaper.stop();

  assert.equal(maxActive, 1);
  assert.deepEqual(sent, ['bagian-1', 'bagian-2', 'bagian-3']);
});

test('pesan yang selalu gagal dibuang setelah 3 percobaan dan tidak memblokir antrean', async () => {
  const attempts: Record<string, number> = {};
  const delivered: string[] = [];

  const shaper = new TrafficShaper(async (msg: any) => {
    const text = msg.payload.text as string;
    attempts[text] = (attempts[text] ?? 0) + 1;
    if (text === 'rusak') throw new Error('send failed');
    delivered.push(text);
  });

  shaper.enqueue('a@s.whatsapp.net', { text: 'rusak' });
  shaper.enqueue('a@s.whatsapp.net', { text: 'normal' });

  await waitFor(() => delivered.includes('normal'));
  await waitFor(() => shaper.getQueueLength() === 0);
  shaper.stop();

  assert.equal(attempts['rusak'], 3);
  assert.equal(attempts['normal'], 1);
  assert.deepEqual(delivered, ['normal']);
});
