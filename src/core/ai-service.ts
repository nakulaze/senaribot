import { getConfig } from '@/config/env.js';
import { childLogger } from '@/utils/logger.js';

const log = childLogger('ai-service');

export type AiErrorKind =
  | 'not_configured'
  | 'timeout'
  | 'rate_limit'
  | 'server'
  | 'auth'
  | 'network'
  | 'bad_response';

export class AiError extends Error {
  constructor(
    public kind: AiErrorKind,
    message: string,
    public status?: number,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** Ganti system prompt default untuk pemanggilan ini saja. */
  systemPrompt?: string;
  /** Batas token output untuk pemanggilan ini; default AI_MAX_OUTPUT_TOKENS. */
  maxTokens?: number;
  /** Suhu sampling untuk pemanggilan ini; default AI_TEMPERATURE. */
  temperature?: number;
}

const DEFAULT_SYSTEM_PROMPT =
  'You are Senaribot AI, a helpful assistant inside WhatsApp. ' +
  'Reply in the same language the user writes in (Indonesian or English). ' +
  'Be clear and concise. Use plain text suitable for WhatsApp, no markdown tables.';

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
  return undefined;
}

export class AiService {
  private config = getConfig();

  isConfigured(): boolean {
    return Boolean(this.config.APINEX_API_KEY);
  }

  getSystemPrompt(): string {
    return this.config.AI_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
  }

  private async requestOnce(messages: ChatMessage[], maxTokens?: number, temperature?: number): Promise<string> {
    if (!this.isConfigured()) {
      throw new AiError('not_configured', 'AI belum dikonfigurasi (APINEX_API_KEY kosong).');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.AI_TIMEOUT_MS);
    const url = `${this.config.APINEX_BASE_URL.replace(/\/+$/, '')}/chat/completions`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.APINEX_API_KEY}`,
        },
        body: JSON.stringify({
          model: this.config.APINEX_MODEL,
          messages,
          max_tokens: maxTokens ?? this.config.AI_MAX_OUTPUT_TOKENS,
          temperature: temperature ?? this.config.AI_TEMPERATURE,
        }),
      });
      return await this.parseResponse(res);
    } catch (error) {
      if (error instanceof AiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AiError('timeout', 'Permintaan ke AI melebihi batas waktu.');
      }
      log.warn('ai network error: %s', error instanceof Error ? error.message : 'unknown');
      throw new AiError('network', 'Gagal terhubung ke layanan AI.');
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseResponse(res: Response): Promise<string> {
    if (res.status === 429) {
      throw new AiError('rate_limit', 'Terlalu banyak permintaan ke AI.', 429, parseRetryAfter(res.headers.get('retry-after')));
    }
    if (res.status === 401 || res.status === 403) {
      log.error('ai auth failed with status %d', res.status);
      throw new AiError('auth', 'Autentikasi ke layanan AI gagal.', res.status);
    }
    if (res.status >= 500) {
      throw new AiError('server', 'Layanan AI sedang bermasalah.', res.status);
    }
    if (!res.ok) {
      log.warn('ai request failed with status %d', res.status);
      throw new AiError('bad_response', `Permintaan AI ditolak (HTTP ${res.status}).`, res.status);
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new AiError('bad_response', 'Respons AI tidak valid.');
    }

    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new AiError('bad_response', 'AI mengembalikan respons kosong.');
    }
    return text.trim();
  }

  async chat(history: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: options.systemPrompt ?? this.getSystemPrompt() },
      ...history,
    ];
    const maxRetries = 2;

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(messages, options.maxTokens, options.temperature);
      } catch (error) {
        const retryable = error instanceof AiError && (error.kind === 'rate_limit' || error.kind === 'server');
        if (!retryable || attempt >= maxRetries) throw error;

        const delay = (error as AiError).retryAfterMs ?? 1000 * Math.pow(2, attempt + 1);
        log.warn('ai request failed (%s), retry %d/%d in %dms', (error as AiError).kind, attempt + 1, maxRetries, delay);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}

export const aiService = new AiService();
