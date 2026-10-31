import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { AiError, aiService } from '@/core/ai-service.js';
import { getConfig } from '@/config/env.js';
import { childLogger } from '@/utils/logger.js';
import { splitMessage } from '@/modules/ai/index.js';
import { parseSummarizeArgs } from './args.js';
import { ExtractError, extractDocumentText } from './extractor.js';
import { STYLE_LABELS } from './prompts.js';
import { summarizer } from './summarizer.js';

const log = childLogger('summarizer-cmd');
const config = getConfig();

const MIN_INPUT_CHARS = 200;
const inFlight = new Set<string>();

const USAGE =
  'Cara pakai AI Summarizer:\n' +
  '- .summarize <teks panjang>\n' +
  '- .summarize short|detailed|bullets|executive <teks>\n' +
  '- Reply pesan teks atau dokumen PDF/TXT dengan .summarize\n' +
  '- Kirim PDF/TXT dengan caption .summarize\n' +
  'Alias: .sum';

function friendlyError(error: unknown): string {
  if (error instanceof ExtractError) return error.message;
  if (error instanceof AiError) {
    switch (error.kind) {
      case 'not_configured':
        return 'Fitur AI belum dikonfigurasi. Isi APINEX_API_KEY di file .env lalu restart bot.';
      case 'timeout':
        return 'AI terlalu lama merespons. Coba lagi sebentar lagi.';
      case 'rate_limit':
        return 'AI sedang kebanjiran permintaan (rate limit). Tunggu beberapa saat lalu coba lagi.';
      case 'server':
        return 'Layanan AI sedang bermasalah. Coba lagi nanti.';
      case 'auth':
        return 'Autentikasi ke layanan AI gagal. Periksa APINEX_API_KEY di .env.';
      case 'network':
        return 'Tidak bisa terhubung ke layanan AI. Periksa koneksi internet.';
      default:
        return 'AI mengembalikan respons yang tidak valid. Coba lagi.';
    }
  }
  return 'Terjadi kesalahan saat merangkum. Silakan coba lagi.';
}

export async function handleSummarize(ctx: DispatchContext): Promise<void> {
  const jid = ctx.sender;
  const parsed = parseSummarizeArgs(ctx.command?.raw ?? '', config.SENARIBOT_PREFIX);

  if (!aiService.isConfigured()) {
    await ctx.reply(friendlyError(new AiError('not_configured', '')));
    return;
  }

  if (inFlight.has(jid)) {
    await ctx.reply('Permintaan ringkasan sebelumnya masih diproses. Mohon tunggu sampai selesai.');
    return;
  }

  const hasInlineText = parsed.text.length > 0;
  const doc = ctx.document ?? null;
  const quotedText = ctx.quoted?.text?.trim() ?? '';

  if (!hasInlineText && !doc && !quotedText) {
    await ctx.reply(USAGE);
    return;
  }

  inFlight.add(jid);
  try {
    let text = parsed.text;
    let truncated = false;
    let origin = 'teks';

    if (!hasInlineText && doc) {
      await ctx.reply(`Membaca dokumen "${doc.fileName}"...`);
      const out = await extractDocumentText(doc, {
        maxFileBytes: config.SUM_MAX_FILE_BYTES,
        maxChars: config.SUM_MAX_INPUT_CHARS,
      });
      text = out.text;
      truncated = out.truncated;
      origin = out.kind.toUpperCase();
    } else if (!hasInlineText) {
      text = quotedText;
    }

    if (text.length > config.SUM_MAX_INPUT_CHARS) {
      text = text.slice(0, config.SUM_MAX_INPUT_CHARS);
      truncated = true;
    }

    if (text.length < MIN_INPUT_CHARS) {
      await ctx.reply(`Teks terlalu pendek untuk dirangkum (minimal ${MIN_INPUT_CHARS} karakter).`);
      return;
    }

    await ctx.reply(`Sedang merangkum ${origin} (${text.length} karakter, ${STYLE_LABELS[parsed.style]})...`);

    const { summary, cached } = await summarizer.summarize(text, parsed.style);

    const parts = splitMessage(summary);
    for (const part of parts) await ctx.reply(part);

    const notes: string[] = [];
    if (truncated) {
      notes.push(`Catatan: input dipotong ke ${config.SUM_MAX_INPUT_CHARS} karakter pertama.`);
    }
    if (cached) notes.push('Hasil dari cache.');
    if (notes.length) await ctx.reply(notes.join(' '));
  } catch (error) {
    log.warn('summarize failed: %s', error instanceof Error ? error.name : 'unexpected');
    await ctx.reply(friendlyError(error));
  } finally {
    inFlight.delete(jid);
  }
}

export async function setup(): Promise<Command[]> {
  return [
    {
      name: 'summarize',
      aliases: ['sum'],
      description: 'Ringkas teks/PDF/TXT dengan AI. Contoh: .summarize short <teks>',
      handler: handleSummarize,
    },
  ];
}

export function teardown(): void {
  inFlight.clear();
  summarizer.clear();
}
