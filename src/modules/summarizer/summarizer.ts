import { createHash } from 'node:crypto';
import { aiService, type ChatOptions } from '@/core/ai-service.js';
import { getConfig } from '@/config/env.js';
import { childLogger } from '@/utils/logger.js';
import type { SummaryStyle } from './args.js';
import { chunkText } from './chunker.js';
import {
  SUMMARY_SYSTEM_PROMPT,
  buildSinglePrompt,
  buildChunkPrompt,
  buildReducePrompt,
} from './prompts.js';

const log = childLogger('summarizer');

export interface SummarizerDeps {
  chat: (messages: { role: 'user'; content: string }[], options: ChatOptions) => Promise<string>;
}

const defaultDeps: SummarizerDeps = {
  chat: (messages, options) => aiService.chat(messages, options),
};

const MAX_NOTES_CHARS = 12000;

export class Summarizer {
  private cache = new Map<string, { value: string; at: number }>();
  private pending = new Map<string, Promise<string>>();
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private deps: SummarizerDeps = defaultDeps) {}

  private get config() {
    return getConfig();
  }

  static cacheKey(text: string, style: SummaryStyle): string {
    return createHash('sha256').update(style).update('\0').update(text).digest('hex');
  }

  /** Batas konkurensi: permintaan berlebih mengantre, tidak ditolak. */
  private async acquire(): Promise<void> {
    if (this.active < this.config.SUM_MAX_CONCURRENT) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // slot langsung dialihkan ke antrean berikutnya
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }

  private getCached(key: string): string | undefined {
    const ttl = this.config.SUM_CACHE_TTL_MS;
    if (ttl <= 0) return undefined;
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > ttl) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.value;
  }

  private setCached(key: string, value: string): void {
    if (this.config.SUM_CACHE_TTL_MS <= 0) return;
    this.cache.set(key, { value, at: Date.now() });
    if (this.cache.size > 100) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private ask(prompt: string, maxTokens: number): Promise<string> {
    return this.deps.chat([{ role: 'user', content: prompt }], {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      maxTokens,
      temperature: 0.2,
    });
  }

  /** Ringkas teks. Hasil identik dipakai ulang dari cache atau digabung dengan permintaan yang sedang berjalan. */
  async summarize(text: string, style: SummaryStyle): Promise<{ summary: string; cached: boolean; chunks: number }> {
    const key = Summarizer.cacheKey(text, style);

    const cached = this.getCached(key);
    if (cached !== undefined) return { summary: cached, cached: true, chunks: 0 };

    const inflight = this.pending.get(key);
    if (inflight) return { summary: await inflight, cached: true, chunks: 0 };

    const chunkCount = chunkText(text, this.config.SUM_CHUNK_CHARS).length;
    const job = this.run(text, style).then((summary) => {
      this.setCached(key, summary);
      return summary;
    });
    this.pending.set(key, job);
    try {
      return { summary: await job, cached: false, chunks: chunkCount };
    } finally {
      this.pending.delete(key);
    }
  }

  private async run(text: string, style: SummaryStyle): Promise<string> {
    await this.acquire();
    try {
      const chunkChars = this.config.SUM_CHUNK_CHARS;
      const maxOut = this.config.SUM_MAX_OUTPUT_TOKENS;

      if (text.length <= chunkChars) {
        return await this.ask(buildSinglePrompt(text, style), maxOut);
      }

      const chunks = chunkText(text, chunkChars);
      log.info('summarizing %d chars in %d chunks', text.length, chunks.length);

      // Tahap map berjalan berurutan agar tidak memicu rate limit APInex.
      const notes: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        notes.push(await this.ask(buildChunkPrompt(chunks[i], i + 1, chunks.length), 400));
      }

      // Jika gabungan catatan terlalu besar, reduksi bertahap.
      let level = notes;
      while (level.join('\n\n').length > MAX_NOTES_CHARS && level.length > 1) {
        const groups = chunkText(level.join('\n\n'), MAX_NOTES_CHARS);
        if (groups.length >= level.length) break;
        const next: string[] = [];
        for (let i = 0; i < groups.length; i++) {
          next.push(await this.ask(buildChunkPrompt(groups[i], i + 1, groups.length), 400));
        }
        level = next;
      }

      return await this.ask(buildReducePrompt(level, style), maxOut);
    } finally {
      this.release();
    }
  }

  clear(): void {
    this.cache.clear();
    this.pending.clear();
    this.waiters = [];
    this.active = 0;
  }
}

export const summarizer = new Summarizer();
