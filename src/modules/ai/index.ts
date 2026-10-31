import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { aiService, AiError, ChatMessage } from '@/core/ai-service.js';
import { aiRepo } from '@/database/repositories/ai.repo.js';
import { getConfig } from '@/config/env.js';
import { childLogger } from '@/utils/logger.js';

const log = childLogger('ai');
const config = getConfig();

const MAX_CHUNK = 3500;
const DUPLICATE_WINDOW_MS = 10000;
const MAX_QUESTION_CHARS = 4000;

const inFlight = new Set<string>();
const lastQuestion = new Map<string, { text: string; at: number }>();

export function splitMessage(text: string, max = MAX_CHUNK): string[] {
  const chunks: string[] = [];
  let rest = text.trim();

  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) chunks.push(rest);
  return chunks;
}

export function extractQuestion(ctx: DispatchContext): string {
  const raw = ctx.command?.raw ?? '';
  return raw.slice(config.SENARIBOT_PREFIX.length).trim().replace(/^\S+\s*/, '').trim();
}

function friendlyError(error: unknown): string {
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
  return 'Terjadi kesalahan saat memproses permintaan AI.';
}

export async function handleAsk(ctx: DispatchContext): Promise<void> {
  const question = extractQuestion(ctx);
  const jid = ctx.sender;

  if (!question) {
    await ctx.reply('Tulis pertanyaannya setelah perintah.\nContoh: .ask apa itu regresi linear?');
    return;
  }

  if (question.length > MAX_QUESTION_CHARS) {
    await ctx.reply(`Pertanyaan terlalu panjang (${question.length} karakter). Maksimal ${MAX_QUESTION_CHARS} karakter.`);
    return;
  }

  if (!aiService.isConfigured()) {
    await ctx.reply(friendlyError(new AiError('not_configured', '')));
    return;
  }

  if (inFlight.has(jid)) {
    await ctx.reply('Permintaan AI sebelumnya masih diproses. Mohon tunggu sampai selesai.');
    return;
  }

  const last = lastQuestion.get(jid);
  const now = Date.now();
  if (last && last.text === question && now - last.at < DUPLICATE_WINDOW_MS) {
    await ctx.reply('Pertanyaan yang sama baru saja dikirim. Permintaan ganda diabaikan.');
    return;
  }
  lastQuestion.set(jid, { text: question, at: now });

  inFlight.add(jid);
  try {
    await ctx.reply('Sedang memproses pertanyaan Anda...');

    const history = aiRepo.getHistory(jid, config.AI_MAX_HISTORY);
    const messages: ChatMessage[] = [...history, { role: 'user', content: question }];
    const answer = await aiService.chat(messages);

    try {
      aiRepo.addExchange(jid, question, answer, config.AI_MAX_HISTORY);
    } catch (dbError) {
      // Jawaban AI sudah berhasil; kegagalan simpan riwayat tidak boleh menggagalkan balasan.
      log.error(dbError, 'failed to persist ai history');
    }

    for (const part of splitMessage(answer)) {
      await ctx.reply(part);
    }
  } catch (error) {
    log.warn('ai request failed: %s', error instanceof AiError ? error.kind : 'unexpected');
    lastQuestion.delete(jid);
    await ctx.reply(friendlyError(error));
  } finally {
    inFlight.delete(jid);
  }
}

export async function handleReset(ctx: DispatchContext): Promise<void> {
  const removed = aiRepo.clearHistory(ctx.sender);
  lastQuestion.delete(ctx.sender);
  await ctx.reply(
    removed > 0
      ? `Riwayat percakapan AI direset (${removed} pesan dihapus).`
      : 'Belum ada riwayat percakapan AI yang perlu direset.',
  );
}

export async function setup(): Promise<Command[]> {
  return [
    {
      name: 'ask',
      aliases: ['ai'],
      description: 'Tanya AI assistant (multi-turn). Contoh: .ask apa itu regresi linear?',
      handler: handleAsk,
    },
    {
      name: 'resetai',
      aliases: [],
      description: 'Reset riwayat percakapan AI',
      handler: handleReset,
    },
  ];
}

export function teardown(): void {
  inFlight.clear();
  lastQuestion.clear();
}
