import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { DocumentInfo } from '@/core/serializer.js';

export type ExtractErrorKind = 'unsupported' | 'too_large' | 'download_failed' | 'unreadable' | 'empty';

export class ExtractError extends Error {
  constructor(
    public kind: ExtractErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ExtractError';
  }
}

export type DocKind = 'pdf' | 'txt';

export function detectDocKind(doc: Pick<DocumentInfo, 'fileName' | 'mimeType'>): DocKind | null {
  const name = doc.fileName.toLowerCase();
  const mime = doc.mimeType.toLowerCase();
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (mime === 'text/plain' || name.endsWith('.txt')) return 'txt';
  return null;
}

/** Hapus karakter kontrol dan rapikan spasi berlebih tanpa membuang baris baru. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n\n') : text;
  } catch {
    throw new ExtractError('unreadable', 'PDF tidak dapat dibaca (mungkin rusak atau terkunci kata sandi).');
  }
}

export interface ExtractOptions {
  maxFileBytes: number;
  maxChars: number;
  /** Dapat diganti saat test agar tidak mengunduh dari WhatsApp. */
  download?: (doc: DocumentInfo) => Promise<Buffer>;
}

async function defaultDownload(doc: DocumentInfo): Promise<Buffer> {
  const data = await downloadMediaMessage(doc.source, 'buffer', {});
  return data as Buffer;
}

export async function extractDocumentText(
  doc: DocumentInfo,
  opts: ExtractOptions,
): Promise<{ text: string; truncated: boolean; kind: DocKind }> {
  const kind = detectDocKind(doc);
  if (!kind) {
    throw new ExtractError('unsupported', 'Format dokumen tidak didukung. Hanya PDF dan TXT.');
  }
  if (doc.fileLength > opts.maxFileBytes) {
    throw new ExtractError('too_large', `Dokumen terlalu besar. Maksimal ${Math.floor(opts.maxFileBytes / 1024 / 1024)} MB.`);
  }

  let buffer: Buffer;
  try {
    buffer = await (opts.download ?? defaultDownload)(doc);
  } catch {
    throw new ExtractError('download_failed', 'Gagal mengunduh dokumen dari WhatsApp.');
  }
  if (buffer.length > opts.maxFileBytes) {
    throw new ExtractError('too_large', `Dokumen terlalu besar. Maksimal ${Math.floor(opts.maxFileBytes / 1024 / 1024)} MB.`);
  }

  const raw = kind === 'pdf' ? await extractPdfText(buffer) : buffer.toString('utf8');
  const text = normalizeText(raw);
  if (!text) {
    throw new ExtractError(
      'empty',
      kind === 'pdf'
        ? 'PDF tidak berisi teks yang bisa dibaca (kemungkinan hasil scan/gambar).'
        : 'File TXT kosong.',
    );
  }

  const truncated = text.length > opts.maxChars;
  return { text: truncated ? text.slice(0, opts.maxChars) : text, truncated, kind };
}
