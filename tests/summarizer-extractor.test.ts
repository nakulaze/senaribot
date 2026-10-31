import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENARIBOT_PHONE_NUMBER = '+620000000000';
process.env.SENARIBOT_OWNER_JIDS = 'owner@s.whatsapp.net';
process.env.SENARIBOT_LOG_LEVEL = 'error';

const { extractDocumentText, ExtractError } = await import('@/modules/summarizer/extractor.js');

/** Bangun PDF valid (xref dihitung benar) agar unpdf benar-benar diuji. */
function makePdf(text: string): Buffer {
  const stream = text ? `BT /F1 18 Tf 20 100 Td (${text}) Tj ET` : '';
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Root 1 0 R/Size ${objs.length + 1}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const mk = (fileName: string, mimeType: string, fileLength = 100) => ({ fileName, mimeType, fileLength, source: {} as any });
const opts = (data: Buffer | Error, extra: Record<string, unknown> = {}) => ({
  maxFileBytes: 1024 * 1024,
  maxChars: 10000,
  download: async () => {
    if (data instanceof Error) throw data;
    return data;
  },
  ...extra,
});
const kindIs = (kind: string) => (e: any) => e instanceof ExtractError && e.kind === kind;

test('TXT UTF-8: karakter non-ASCII utuh dan CRLF dirapikan', async () => {
  const buf = Buffer.from('Ringkasan: café — angka 1.234,5\r\n\r\n\r\nBaris dua', 'utf8');
  const out = await extractDocumentText(mk('catatan.txt', 'text/plain'), opts(buf));
  assert.equal(out.kind, 'txt');
  assert.ok(out.text.includes('café — angka 1.234,5'));
  assert.ok(!out.text.includes('\r'));
  assert.equal(out.truncated, false);
});

test('PDF bertext: teks berhasil diekstrak oleh unpdf', async () => {
  const out = await extractDocumentText(mk('laporan.pdf', 'application/pdf'), opts(makePdf('Halo Senaribot')));
  assert.equal(out.kind, 'pdf');
  assert.ok(out.text.includes('Halo Senaribot'), `hasil: ${out.text}`);
});

test('PDF tanpa teks (mirip hasil scan) menghasilkan error empty', async () => {
  await assert.rejects(() => extractDocumentText(mk('scan.pdf', 'application/pdf'), opts(makePdf(''))), kindIs('empty'));
});

test('PDF rusak menghasilkan error unreadable tanpa detail internal', async () => {
  await assert.rejects(
    () => extractDocumentText(mk('rusak.pdf', 'application/pdf'), opts(Buffer.from('ini bukan pdf sama sekali'))),
    (e: any) => kindIs('unreadable')(e) && !/pdfjs|stack|\.js/i.test(e.message),
  );
});

test('TXT kosong atau hanya spasi menghasilkan error empty', async () => {
  await assert.rejects(() => extractDocumentText(mk('kosong.txt', 'text/plain'), opts(Buffer.from('  \n \n'))), kindIs('empty'));
});

test('gagal unduh menghasilkan download_failed tanpa membocorkan detail', async () => {
  await assert.rejects(
    () => extractDocumentText(mk('a.pdf', 'application/pdf'), opts(new Error('ECONNRESET 10.0.0.9'))),
    (e: any) => kindIs('download_failed')(e) && !e.message.includes('10.0.0.9'),
  );
});

test('ukuran sebenarnya melebihi batas walau metadata kecil ditolak', async () => {
  const big = Buffer.alloc(2048, 'a');
  await assert.rejects(
    () => extractDocumentText(mk('b.txt', 'text/plain', 10), opts(big, { maxFileBytes: 1024 })),
    kindIs('too_large'),
  );
});

test('hasil ekstraksi dipotong ke maxChars dan ditandai truncated', async () => {
  const out = await extractDocumentText(mk('c.txt', 'text/plain'), opts(Buffer.from('x'.repeat(500)), { maxChars: 20 }));
  assert.equal(out.text.length, 20);
  assert.equal(out.truncated, true);
});

test('format tidak didukung ditolak sebelum unduh', async () => {
  let downloaded = false;
  await assert.rejects(
    () =>
      extractDocumentText(mk('d.docx', 'application/msword'), {
        maxFileBytes: 1024,
        maxChars: 100,
        download: async () => {
          downloaded = true;
          return Buffer.alloc(1);
        },
      }),
    kindIs('unsupported'),
  );
  assert.equal(downloaded, false);
});
