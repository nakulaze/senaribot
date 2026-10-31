import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { aiService } from '@/core/ai-service.js';
import { getConfig } from '@/config/env.js';
import { childLogger } from '@/utils/logger.js';
import { splitMessage } from '@/modules/ai/index.js';

const log = childLogger('currency');
const config = getConfig();

const CACHE_TTL_MS = 3600000; // 1 hour
const inFlight = new Set<string>();

export interface ExchangeRate {
  base: string;
  rates: Record<string, number>;
  timestamp: number;
}

class CurrencyError extends Error {
  constructor(
    public kind: 'invalid_currency' | 'network' | 'rate_limit' | 'server' | 'not_supported',
    message: string,
  ) {
    super(message);
    this.name = 'CurrencyError';
  }
}

interface CacheEntry {
  data: ExchangeRate;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

// ISO 4217 common currencies (subset for validation)
const VALID_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'AUD', 'CAD', 'CHF', 'HKD', 'SGD',
  'SEK', 'KRW', 'NOK', 'NZD', 'INR', 'MXN', 'TWD', 'ZAR', 'BRL', 'PHP',
  'CZK', 'DKK', 'HUF', 'ILS', 'MYR', 'PLN', 'RUB', 'THB', 'TRY', 'IDR',
  'AED', 'ARS', 'CLP', 'COP', 'EGP', 'KWD', 'MAD', 'NGN', 'OMR', 'PEN',
  'PKR', 'QAR', 'SAR', 'VND', 'BDT', 'DZD', 'IQD', 'IRR', 'JOD', 'KES',
  'LBP', 'LKR', 'RON', 'UAH', 'UYU', 'VEF',
]);

function validateCurrency(code: string): boolean {
  return VALID_CURRENCIES.has(code.toUpperCase());
}

function getCacheKey(base: string): string {
  return base.toUpperCase();
}

function getFromCache(base: string): ExchangeRate | null {
  const key = getCacheKey(base);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(base: string, data: ExchangeRate): void {
  const key = getCacheKey(base);
  cache.set(key, {
    data,
    expires: Date.now() + CACHE_TTL_MS,
  });
}

async function fetchExchangeRates(base: string): Promise<ExchangeRate> {
  const cached = getFromCache(base);
  if (cached) {
    log.debug('currency cache hit for %s', base);
    return cached;
  }

  let timer: NodeJS.Timeout | null = null;
  const controller = new AbortController();

  try {
    // Using ExchangeRate-API.com (free tier: 1500 requests/month, no auth required)
    const url = `https://open.exchangerate-api.com/v6/latest/${base.toUpperCase()}`;
    
    timer = setTimeout(() => controller.abort(), config.CURRENCY_TIMEOUT_MS);

    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timer);
    timer = null;

    if (res.status === 404) {
      throw new CurrencyError('invalid_currency', 'Kode mata uang tidak valid');
    }

    if (res.status === 429) {
      throw new CurrencyError('rate_limit', 'Rate limit tercapai');
    }

    if (res.status >= 500) {
      throw new CurrencyError('server', 'Server error');
    }

    if (!res.ok) {
      throw new CurrencyError('network', `HTTP ${res.status}`);
    }

    const data = await res.json();

    if ((data as any).result === 'error') {
      const errorType = (data as any)['error-type'];
      if (errorType === 'unsupported-code') {
        throw new CurrencyError('invalid_currency', 'Kode mata uang tidak didukung');
      }
      throw new CurrencyError('server', 'API error');
    }

    const result: ExchangeRate = {
      base: (data as any).base_code,
      rates: (data as any).rates,
      timestamp: (data as any).time_last_update_unix * 1000,
    };

    setCache(base, result);
    return result;
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (error instanceof CurrencyError) throw error;
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new CurrencyError('network', 'Timeout');
      }
      if (error.message.includes('fetch')) {
        throw new CurrencyError('network', 'Network error');
      }
    }
    log.warn('currency fetch failed: %s', error instanceof Error ? error.message : 'unknown');
    throw new CurrencyError('network', 'Network error');
  }
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Fallback if currency not supported by Intl
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
  }
}

function formatNumber(num: number): string {
  return new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(num);
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

async function showRate(from: string, to: string): Promise<string> {
  const fromUpper = from.toUpperCase();
  const toUpper = to.toUpperCase();

  if (!validateCurrency(fromUpper)) {
    throw new CurrencyError('invalid_currency', `Kode mata uang tidak valid: ${fromUpper}`);
  }

  if (!validateCurrency(toUpper)) {
    throw new CurrencyError('invalid_currency', `Kode mata uang tidak valid: ${toUpper}`);
  }

  const rates = await fetchExchangeRates(fromUpper);

  if (!rates.rates[toUpper]) {
    throw new CurrencyError('not_supported', `Kurs ${fromUpper} → ${toUpper} tidak tersedia`);
  }

  const rate = rates.rates[toUpper];
  const reverseRate = 1 / rate;

  const lines = [
    `💱 Kurs Mata Uang`,
    '',
    `1 ${fromUpper} = ${formatNumber(rate)} ${toUpper}`,
    `1 ${toUpper} = ${formatNumber(reverseRate)} ${fromUpper}`,
    '',
    `Diperbarui: ${formatTimestamp(rates.timestamp)}`,
  ];

  return lines.join('\n');
}

function buildCurrencyAnalysisPrompt(amount: number, from: string, to: string, rate: number, result: number): string {
  return [
    'Kamu adalah asisten keuangan yang membantu menjelaskan konversi mata uang.',
    '',
    'Tugas: Berikan konteks singkat tentang konversi ini dalam bahasa Indonesia.',
    '',
    'Aturan:',
    '- Jangan mengarang atau mengubah nilai numerik yang diberikan',
    '- Berikan konteks umum (ekonomi, perjalanan, perdagangan)',
    '- Jika angkanya besar/kecil, sebutkan',
    '- Maksimal 100 kata, format plain text',
    '',
    `Data konversi:`,
    `${amount} ${from} = ${result.toFixed(2)} ${to}`,
    `Kurs: 1 ${from} = ${rate} ${to}`,
  ].join('\n');
}

function friendlyCurrencyError(error: unknown): string {
  if (error instanceof CurrencyError) {
    switch (error.kind) {
      case 'invalid_currency':
        return error.message;
      case 'network':
        return error.message === 'Timeout'
          ? 'Request terlalu lama. Coba lagi.'
          : 'Tidak dapat terhubung ke layanan kurs. Coba lagi nanti.';
      case 'rate_limit':
        return 'Batas request tercapai. Tunggu beberapa saat lalu coba lagi.';
      case 'server':
        return 'Layanan kurs sedang bermasalah. Coba lagi nanti.';
      case 'not_supported':
        return error.message;
      default:
        return 'Terjadi kesalahan. Coba lagi.';
    }
  }
  return 'Terjadi kesalahan. Coba lagi.';
}

export async function handleConvert(ctx: DispatchContext): Promise<void> {
  const text = ctx.command?.raw ?? '';
  const parts = text.slice(config.SENARIBOT_PREFIX.length).trim().split(/\s+/);
  
  // .convert <amount> <from> <to>
  if (parts.length !== 4) {
    await ctx.reply(
      'Usage: .convert <jumlah> <dari> <ke>\n\nContoh:\n.convert 100 USD IDR\n.convert 500000 IDR USD\n\nGunakan kode ISO 4217 (USD, EUR, IDR, dll)',
    );
    return;
  }

  const amountStr = parts[1];
  const from = parts[2];
  const to = parts[3];

  const amount = parseFloat(amountStr.replace(/,/g, ''));
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply('Jumlah tidak valid. Masukkan angka positif.');
    return;
  }

  if (amount > 1e15) {
    await ctx.reply('Jumlah terlalu besar. Maksimal 1 kuadriliun.');
    return;
  }

  const requestKey = `${ctx.sender}:convert`;
  if (inFlight.has(requestKey)) {
    await ctx.reply('Request konversi sebelumnya masih diproses. Mohon tunggu.');
    return;
  }

  inFlight.add(requestKey);

  try {
    await ctx.reply('💱 Menghitung konversi...');

    const fromUpper = from.toUpperCase();
    const toUpper = to.toUpperCase();

    // Fetch rates once
    const rates = await fetchExchangeRates(fromUpper);
    
    if (!validateCurrency(fromUpper)) {
      throw new CurrencyError('invalid_currency', `Kode mata uang tidak valid: ${fromUpper}`);
    }

    if (!validateCurrency(toUpper)) {
      throw new CurrencyError('invalid_currency', `Kode mata uang tidak valid: ${toUpper}`);
    }

    if (!rates.rates[toUpper]) {
      throw new CurrencyError('not_supported', `Konversi ${fromUpper} → ${toUpper} tidak didukung`);
    }

    const rate = rates.rates[toUpper];
    const converted = amount * rate;

    // Format result
    const lines = [
      `💱 Konversi Mata Uang`,
      '',
      `${formatCurrency(amount, fromUpper)} =`,
      `${formatCurrency(converted, toUpper)}`,
      '',
      `Kurs: 1 ${fromUpper} = ${formatNumber(rate)} ${toUpper}`,
      `Diperbarui: ${formatTimestamp(rates.timestamp)}`,
    ];
    const result = lines.join('\n');

    // Try AI analysis if configured
    if (aiService.isConfigured()) {
      try {
        const analysis = await aiService.chat(
          [{ role: 'user', content: buildCurrencyAnalysisPrompt(amount, fromUpper, toUpper, rate, converted) }],
          {
            systemPrompt: 'You are a helpful financial assistant. Follow instructions exactly. Never fabricate numbers.',
            temperature: 0.3,
            maxTokens: 300,
          },
        );

        const sections = [`💬 Ringkasan:\n${analysis}`, '', '📊 Detail:', result];
        for (const part of splitMessage(sections.join('\n'))) {
          await ctx.reply(part);
        }
      } catch (aiError) {
        log.warn('ai analysis failed, showing raw data: %s', aiError instanceof Error ? aiError.message : 'unknown');
        for (const part of splitMessage(result)) {
          await ctx.reply(part);
        }
      }
    } else {
      for (const part of splitMessage(result)) {
        await ctx.reply(part);
      }
    }
  } catch (error) {
    log.warn('convert request failed: %s', error instanceof Error ? error.message : 'unknown');
    await ctx.reply(friendlyCurrencyError(error));
  } finally {
    inFlight.delete(requestKey);
  }
}

export async function handleRate(ctx: DispatchContext): Promise<void> {
  const text = ctx.command?.raw ?? '';
  const parts = text.slice(config.SENARIBOT_PREFIX.length).trim().split(/\s+/);
  
  // .rate <from> <to>
  if (parts.length !== 3) {
    await ctx.reply(
      'Usage: .rate <dari> <ke>\n\nContoh:\n.rate USD IDR\n.rate EUR GBP\n\nGunakan kode ISO 4217 (USD, EUR, IDR, dll)',
    );
    return;
  }

  const from = parts[1];
  const to = parts[2];

  const requestKey = `${ctx.sender}:rate`;
  if (inFlight.has(requestKey)) {
    await ctx.reply('Request kurs sebelumnya masih diproses. Mohon tunggu.');
    return;
  }

  inFlight.add(requestKey);

  try {
    await ctx.reply('💱 Mengambil kurs...');

    const result = await showRate(from, to);
    for (const part of splitMessage(result)) {
      await ctx.reply(part);
    }
  } catch (error) {
    log.warn('rate request failed: %s', error instanceof Error ? error.message : 'unknown');
    await ctx.reply(friendlyCurrencyError(error));
  } finally {
    inFlight.delete(requestKey);
  }
}

export async function setup(): Promise<Command[]> {
  return [
    {
      name: 'convert',
      aliases: [],
      description: 'Konversi mata uang dengan kurs terkini',
      handler: handleConvert,
    },
    {
      name: 'rate',
      aliases: [],
      description: 'Lihat kurs mata uang terkini',
      handler: handleRate,
    },
  ];
}

export function teardown(): void {
  inFlight.clear();
  cache.clear();
}
