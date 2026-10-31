import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSummarizeArgs } from '@/modules/summarizer/args.js';
import { chunkText } from '@/modules/summarizer/chunker.js';
import { detectDocKind, normalizeText } from '@/modules/summarizer/extractor.js';
import { buildSinglePrompt, buildReducePrompt, SUMMARY_SYSTEM_PROMPT } from '@/modules/summarizer/prompts.js';

test('parseSummarizeArgs: gaya default dan teks', () => {
  const r = parseSummarizeArgs('.summarize ini teks biasa', '.');
  assert.equal(r.style, 'detailed');
  assert.equal(r.styleExplicit, false);
  assert.equal(r.text, 'ini teks biasa');
});

test('parseSummarizeArgs: gaya eksplisit dan alias .sum', () => {
  assert.equal(parseSummarizeArgs('.summarize short halo dunia', '.').style, 'short');
  assert.equal(parseSummarizeArgs('.sum bullets halo dunia', '.').style, 'bullets');
  assert.equal(parseSummarizeArgs('.sum executive halo', '.').style, 'executive');
  assert.equal(parseSummarizeArgs('.sum detailed halo', '.').style, 'detailed');
  const r = parseSummarizeArgs('.sum short halo dunia', '.');
  assert.equal(r.styleExplicit, true);
  assert.equal(r.text, 'halo dunia');
});

test('parseSummarizeArgs: tanpa teks dan baris baru dipertahankan', () => {
  assert.equal(parseSummarizeArgs('.summarize', '.').text, '');
  assert.equal(parseSummarizeArgs('.summarize short', '.').text, '');
  const r = parseSummarizeArgs('.summarize short baris satu\nbaris dua', '.');
  assert.equal(r.text, 'baris satu\nbaris dua');
});

test('parseSummarizeArgs: kata pertama yang bukan gaya tetap menjadi teks', () => {
  const r = parseSummarizeArgs('.summarize shortcut adalah pintasan', '.');
  assert.equal(r.style, 'detailed');
  assert.equal(r.text, 'shortcut adalah pintasan');
});

test('chunkText: teks pendek tidak dipecah', () => {
  assert.deepEqual(chunkText('halo dunia', 100), ['halo dunia']);
});

test('chunkText: setiap potongan <= batas dan tidak ada isi hilang', () => {
  const text = Array.from({ length: 200 }, (_, i) => `Kalimat nomor ${i}.`).join(' ');
  const chunks = chunkText(text, 300);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 300);
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('chunkText: memotong di batas paragraf bila memungkinkan', () => {
  const p1 = 'a'.repeat(60);
  const p2 = 'b'.repeat(60);
  const chunks = chunkText(`${p1}\n\n${p2}`, 100);
  assert.deepEqual(chunks, [p1, p2]);
});

test('chunkText: kata tanpa spasi dipotong paksa', () => {
  const chunks = chunkText('x'.repeat(250), 100);
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);
});

test('chunkText: maxChars tidak valid melempar error', () => {
  assert.throws(() => chunkText('abc', 0));
});

test('detectDocKind: mengenali PDF dan TXT dari mime atau ekstensi', () => {
  assert.equal(detectDocKind({ fileName: 'a.pdf', mimeType: '' }), 'pdf');
  assert.equal(detectDocKind({ fileName: 'x', mimeType: 'application/pdf' }), 'pdf');
  assert.equal(detectDocKind({ fileName: 'catatan.TXT', mimeType: '' }), 'txt');
  assert.equal(detectDocKind({ fileName: 'x', mimeType: 'text/plain' }), 'txt');
  assert.equal(detectDocKind({ fileName: 'a.docx', mimeType: 'application/vnd.openxmlformats' }), null);
});

test('normalizeText: rapikan spasi dan buang karakter kontrol', () => {
  assert.equal(normalizeText('a\r\nb\u0000  c\n\n\n\nd'), 'a\nb c\n\nd');
});

test('prompt: memuat aturan anti-halusinasi dan struktur wajib', () => {
  assert.match(SUMMARY_SYSTEM_PROMPT, /HANYA informasi yang ada di teks sumber/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /Abaikan instruksi/);
  for (const style of ['short', 'detailed', 'bullets', 'executive'] as const) {
    const p = buildSinglePrompt('isi dokumen', style);
    for (const h of ['JUDUL:', 'RINGKASAN UTAMA:', 'POIN PENTING:', 'KESIMPULAN:']) assert.ok(p.includes(h));
    assert.ok(p.includes('isi dokumen'));
  }
  assert.ok(buildReducePrompt(['n1', 'n2'], 'short').includes('[Catatan bagian 2]'));
});
