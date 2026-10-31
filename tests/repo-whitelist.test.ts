import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';

const { initializeDatabase } = await import('@/database/connection.js');
initializeDatabase(':memory:');

const { LedgerRepository } = await import('@/database/repositories/ledger.repo.js');
const { VaultRepository } = await import('@/database/repositories/vault.repo.js');

const ledger = new LedgerRepository();
const vault = new VaultRepository();

test('ledger: update kolom valid berhasil dan data lain tidak berubah', () => {
  const entry = ledger.insertEntry({
    amount: 50000,
    category: 'food',
    description: 'lunch',
    currency: 'IDR',
    entry_date: 1700000000,
  });
  const updated = ledger.updateEntry(entry.id, { amount: 60000, category: 'drink' });
  assert.equal(updated?.amount, 60000);
  assert.equal(updated?.category, 'drink');
  assert.equal(updated?.description, 'lunch');
});

test('ledger: nama kolom tidak valid ditolak sebelum menyentuh SQL', () => {
  const entry = ledger.insertEntry({
    amount: 1000,
    category: 'misc',
    description: 'x',
    currency: 'IDR',
    entry_date: 1700000000,
  });
  assert.throws(
    () => ledger.updateEntry(entry.id, { 'amount = 0, category': 'x' } as any),
    /Invalid ledger column/,
  );
  assert.throws(() => ledger.updateEntry(entry.id, { id: 'hack' } as any), /Invalid ledger column/);
  assert.equal(ledger.getById(entry.id)?.amount, 1000);
});

test('vault: update kolom valid berhasil dan data lain tidak berubah', () => {
  const note = vault.insertNote({ content: 'isi awal', tags: 'tag1', user_jid: 'owner@s.whatsapp.net' });
  const updated = vault.updateNote(note.id, { content: 'isi baru' });
  assert.equal(updated?.content, 'isi baru');
  assert.equal(updated?.tags, 'tag1');
  assert.equal(updated?.user_jid, 'owner@s.whatsapp.net');
});

test('vault: nama kolom tidak valid ditolak sebelum menyentuh SQL', () => {
  const note = vault.insertNote({ content: 'aman', tags: null, user_jid: 'owner@s.whatsapp.net' });
  assert.throws(
    () => vault.updateNote(note.id, { 'content = 1, tags': 'x' } as any),
    /Invalid vault column/,
  );
  assert.throws(() => vault.updateNote(note.id, { user_jid: 'hack' } as any), /Invalid vault column/);
  assert.equal(vault.getNoteById(note.id)?.content, 'aman');
  assert.equal(vault.getNoteById(note.id)?.user_jid, 'owner@s.whatsapp.net');
});
