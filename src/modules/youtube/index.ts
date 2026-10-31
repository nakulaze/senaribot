import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { aiService } from '@/core/ai-service.js';
import { getConfig } from '@/config/env.js';
import { childLogger } from '@/utils/logger.js';
import { splitMessage } from '@/modules/ai/index.js';
import { YoutubeTranscript } from 'youtube-transcript';

const log = childLogger('youtube');
const config = getConfig();

const CACHE_TTL_MS = 600000; // 10 minutes
const MAX_TRANSCRIPT_CHARS = 50000;
const inFlight = new Set<string>();

interface CacheEntry<T> {
  data: T;
  expires: number;
}

const cache = new Map<string, CacheEntry<any>>();

interface TranscriptItem {
  text: string;
  duration: number;
  offset: number;
}

interface VideoSummary {
  videoId: string;
  url: string;
  transcript: string;
  summary: string;
  mode: 'short' | 'detailed';
}

class YouTubeError extends Error {
  constructor(
    public kind: 'invalid_url' | 'no_transcript' | 'private' | 'network' | 'unavailable' | 'too_long',
    message: string,
  ) {
    super(message);
    this.name = 'YouTubeError';
  }
}

function extractVideoId(url: string): string | null {
  // youtube.com/watch?v=ID
  // youtu.be/ID
  // youtube.com/embed/ID
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{8,11})/,
    /^([a-zA-Z0-9_-]{8,11})$/, // direct ID
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function getCacheKey(videoId: string, mode: string): string {
  return `${videoId}:${mode}`;
}

function getFromCache<T>(videoId: string, mode: string): T | null {
  const key = getCacheKey(videoId, mode);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(videoId: string, mode: string, data: T): void {
  const key = getCacheKey(videoId, mode);
  cache.set(key, {
    data,
    expires: Date.now() + CACHE_TTL_MS,
  });
}

async function fetchTranscript(videoId: string): Promise<string> {
  const cached = getFromCache<string>(videoId, 'transcript');
  if (cached) {
    log.debug('transcript cache hit for %s', videoId);
    return cached;
  }

  let timer: NodeJS.Timeout | null = null;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timeout')), config.YOUTUBE_TIMEOUT_MS);
    });

    const transcriptPromise = YoutubeTranscript.fetchTranscript(videoId);

    const items = (await Promise.race([transcriptPromise, timeoutPromise])) as TranscriptItem[];

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    if (!items || items.length === 0) {
      throw new YouTubeError('no_transcript', 'Video tidak memiliki captions/transcript');
    }

    const fullTranscript = items.map((item) => item.text).join(' ');

    if (fullTranscript.length > MAX_TRANSCRIPT_CHARS) {
      throw new YouTubeError('too_long', `Transcript terlalu panjang (${fullTranscript.length} chars)`);
    }

    setCache(videoId, 'transcript', fullTranscript);
    return fullTranscript;
  } catch (error) {
    if (timer) clearTimeout(timer);

    if (error instanceof YouTubeError) throw error;

    if (error instanceof Error) {
      if (error.message === 'Timeout') {
        throw new YouTubeError('network', 'Timeout saat mengambil transcript');
      }
      if (error.message.includes('Could not find video')) {
        throw new YouTubeError('unavailable', 'Video tidak ditemukan atau private');
      }
      if (error.message.includes('Transcript is disabled')) {
        throw new YouTubeError('no_transcript', 'Transcript dinonaktifkan untuk video ini');
      }
      if (error.message.includes('unavailable')) {
        throw new YouTubeError('unavailable', 'Video tidak tersedia');
      }
    }

    log.warn('youtube transcript failed: %s', error instanceof Error ? error.message : 'unknown');
    throw new YouTubeError('network', 'Gagal mengambil transcript');
  }
}

async function summarizeTranscript(
  transcript: string,
  mode: 'short' | 'detailed',
): Promise<string> {
  if (!aiService.isConfigured()) {
    throw new Error('AI service not configured');
  }

  const maxWords = mode === 'short' ? 150 : 400;
  const detail = mode === 'short' ? 'ringkas' : 'detail';

  const prompt = [
    `Kamu adalah asisten yang merangkum video YouTube berdasarkan transcript.`,
    ``,
    `Tugas: Buat ringkasan ${detail} dalam bahasa Indonesia.`,
    ``,
    `Format output:`,
    `📺 RINGKASAN VIDEO`,
    ``,
    `📝 Ringkasan Utama:`,
    `[Ringkasan 2-3 kalimat]`,
    ``,
    `🔑 Poin Penting:`,
    `- [Poin 1]`,
    `- [Poin 2]`,
    `- [Poin 3]`,
    mode === 'detailed' ? `- [Poin 4]` : '',
    mode === 'detailed' ? `- [Poin 5]` : '',
    ``,
    `💡 Istilah Penting:`,
    `- [Istilah 1]: [Penjelasan singkat]`,
    `- [Istilah 2]: [Penjelasan singkat]`,
    ``,
    `✅ Kesimpulan:`,
    `[Kesimpulan 1-2 kalimat]`,
    ``,
    `Aturan:`,
    `- Hanya gunakan informasi dari transcript`,
    `- JANGAN mengarang informasi yang tidak ada`,
    `- Maksimal ${maxWords} kata`,
    `- Format plain text untuk WhatsApp`,
    `- Jika transcript tidak jelas, sebutkan keterbatasannya`,
    ``,
    `Transcript:`,
    transcript.substring(0, 15000), // Limit for AI input
  ]
    .filter(Boolean)
    .join('\n');

  const summary = await aiService.chat([{ role: 'user', content: prompt }], {
    systemPrompt: 'You are a helpful video summarizer. Follow instructions exactly.',
    temperature: 0.3,
    maxTokens: mode === 'short' ? 500 : 800,
  });

  return summary;
}

function friendlyYouTubeError(error: unknown): string {
  if (error instanceof YouTubeError) {
    switch (error.kind) {
      case 'invalid_url':
        return 'URL YouTube tidak valid. Gunakan format: youtube.com/watch?v=ID atau youtu.be/ID';
      case 'no_transcript':
        return 'Video tidak memiliki captions/transcript. Tidak dapat membuat ringkasan.';
      case 'private':
      case 'unavailable':
        return 'Video tidak tersedia, private, atau telah dihapus.';
      case 'network':
        return error.message === 'Timeout saat mengambil transcript'
          ? 'Request terlalu lama. Coba lagi.'
          : 'Gagal mengambil data video. Coba lagi nanti.';
      case 'too_long':
        return 'Transcript video terlalu panjang (maks 50.000 karakter). Coba video yang lebih pendek.';
      default:
        return 'Terjadi kesalahan. Coba lagi.';
    }
  }
  return 'Terjadi kesalahan. Coba lagi.';
}

export async function handleYouTube(ctx: DispatchContext): Promise<void> {
  const text = ctx.command?.raw ?? '';
  const parts = text.slice(config.SENARIBOT_PREFIX.length).trim().split(/\s+/);

  let url = '';
  let mode: 'short' | 'detailed' = 'short';

  if (parts[0] === 'youtube' || parts[0] === 'yt') {
    // .yt <url>
    // .yt short <url>
    // .yt detailed <url>
    if (parts[1] === 'short' || parts[1] === 'detailed') {
      mode = parts[1];
      url = parts.slice(2).join(' ').trim();
    } else {
      url = parts.slice(1).join(' ').trim();
    }
  }

  if (!url) {
    await ctx.reply(
      'YouTube Summarizer\n\nCommands:\n.youtube <url>\n.yt <url>\n.yt short <url>\n.yt detailed <url>\n\nContoh:\n.yt https://youtube.com/watch?v=dQw4w9WgXcQ',
    );
    return;
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    await ctx.reply('URL YouTube tidak valid. Gunakan format: youtube.com/watch?v=ID atau youtu.be/ID');
    return;
  }

  const requestKey = `${ctx.sender}:${videoId}`;
  if (inFlight.has(requestKey)) {
    await ctx.reply('Request sebelumnya masih diproses. Mohon tunggu.');
    return;
  }

  inFlight.add(requestKey);

  try {
    await ctx.reply('📺 Mengambil transcript video...');

    const cached = getFromCache<VideoSummary>(videoId, mode);
    if (cached) {
      const output = [
        `${cached.summary}`,
        '',
        `🔗 ${cached.url}`,
      ].join('\n');

      for (const part of splitMessage(output)) {
        await ctx.reply(part);
      }
      return;
    }

    const transcript = await fetchTranscript(videoId);

    await ctx.reply('🤖 Membuat ringkasan...');

    const summary = await summarizeTranscript(transcript, mode);

    const videoUrl = `https://youtube.com/watch?v=${videoId}`;
    const result: VideoSummary = {
      videoId,
      url: videoUrl,
      transcript,
      summary,
      mode,
    };

    setCache(videoId, mode, result);

    const output = [
      summary,
      '',
      `🔗 ${videoUrl}`,
    ].join('\n');

    for (const part of splitMessage(output)) {
      await ctx.reply(part);
    }
  } catch (error) {
    log.warn('youtube summarize failed: %s', error instanceof Error ? error.message : 'unknown');
    await ctx.reply(friendlyYouTubeError(error));
  } finally {
    inFlight.delete(requestKey);
  }
}

export async function setup(): Promise<Command[]> {
  return [
    {
      name: 'youtube',
      aliases: ['yt'],
      description: 'YouTube video summarizer dengan AI',
      handler: handleYouTube,
    },
  ];
}

export function teardown(): void {
  inFlight.clear();
  cache.clear();
}
