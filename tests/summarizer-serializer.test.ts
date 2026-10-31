import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';

const { serializeMessage } = await import('@/core/serializer.js');

const OWN = 'bot@s.whatsapp.net';
const USER = 'owner@s.whatsapp.net';

function wrap(message: any, id = 'ID1'): any {
  return { key: { remoteJid: USER, id, fromMe: false }, message, messageTimestamp: 1700000000 };
}

const docFields = { fileName: 'laporan.pdf', mimetype: 'application/pdf', fileLength: 2048, title: 'laporan.pdf' };

test('dokumen dengan caption: text berisi caption command, bukan nama file', () => {
  const ctx = serializeMessage(wrap({ documentMessage: { ...docFields, caption: '.summarize short' } }), OWN)!;
  assert.equal(ctx.type, 'document');
  assert.equal(ctx.text, '.summarize short');
  assert.equal(ctx.document?.fileName, 'laporan.pdf');
  assert.equal(ctx.document?.mimeType, 'application/pdf');
  assert.equal(ctx.document?.fileLength, 2048);
});

test('dokumen berbungkus documentWithCaptionMessage tetap dikenali', () => {
  const ctx = serializeMessage(
    wrap({ documentWithCaptionMessage: { message: { documentMessage: { ...docFields, caption: '.sum' } } } }),
    OWN,
  )!;
  assert.equal(ctx.type, 'document');
  assert.equal(ctx.text, '.sum');
  assert.equal(ctx.document?.fileName, 'laporan.pdf');
});

test('dokumen tanpa caption memakai judul sebagai cadangan dan tidak dianggap command', () => {
  const ctx = serializeMessage(wrap({ documentMessage: { ...docFields } }), OWN)!;
  assert.equal(ctx.text, 'laporan.pdf');
  assert.ok(!ctx.text.startsWith('.'));
});

test('reply ke dokumen: document berasal dari pesan yang di-reply', () => {
  const ctx = serializeMessage(
    wrap({
      extendedTextMessage: {
        text: '.summarize bullets',
        contextInfo: {
          stanzaId: 'QUOTED1',
          participant: 'teman@s.whatsapp.net',
          quotedMessage: { documentMessage: { ...docFields, fileName: 'catatan.txt', mimetype: 'text/plain' } },
        },
      },
    }),
    OWN,
  )!;
  assert.equal(ctx.text, '.summarize bullets');
  assert.equal(ctx.document?.fileName, 'catatan.txt');
  assert.equal((ctx.document?.source as any).key.id, 'QUOTED1');
});

test('reply ke teks biasa: document null dan quoted.text terisi', () => {
  const ctx = serializeMessage(
    wrap({
      extendedTextMessage: {
        text: '.summarize',
        contextInfo: { stanzaId: 'Q2', quotedMessage: { conversation: 'isi pesan yang dirangkum' } },
      },
    }),
    OWN,
  )!;
  assert.equal(ctx.document, null);
  assert.equal(ctx.quoted?.text, 'isi pesan yang dirangkum');
});

test('pesan teks biasa tidak punya document', () => {
  const ctx = serializeMessage(wrap({ conversation: '.ping' }), OWN)!;
  assert.equal(ctx.document, null);
});
