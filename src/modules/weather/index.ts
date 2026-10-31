import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { aiService, AiError } from '@/core/ai-service.js';
import { getConfig } from '@/config/env.js';
import { childLogger } from '@/utils/logger.js';
import { splitMessage } from '@/modules/ai/index.js';

const log = childLogger('weather');
const config = getConfig();

const MAX_CITY_LENGTH = 100;
const CACHE_TTL_MS = 600000; // 10 minutes
const inFlight = new Set<string>();

export interface WeatherData {
  city: string;
  country: string;
  temp_c: number;
  condition: string;
  humidity: number;
  wind_kph: number;
  feels_like_c: number;
  timestamp: number;
  timezone: string;
}

export interface ForecastDay {
  date: string;
  max_temp_c: number;
  min_temp_c: number;
  condition: string;
  chance_of_rain: number;
}

export interface WeatherResponse {
  current: WeatherData;
  forecast?: ForecastDay[];
}

class WeatherError extends Error {
  constructor(
    public kind: 'not_configured' | 'not_found' | 'network' | 'rate_limit' | 'invalid_response' | 'server',
    message: string,
  ) {
    super(message);
    this.name = 'WeatherError';
  }
}

interface CacheEntry {
  data: WeatherResponse;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

function getCacheKey(city: string, includeForecast: boolean): string {
  return `${city.toLowerCase()}:${includeForecast ? 'forecast' : 'current'}`;
}

function getFromCache(city: string, includeForecast: boolean): WeatherResponse | null {
  const key = getCacheKey(city, includeForecast);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(city: string, includeForecast: boolean, data: WeatherResponse): void {
  const key = getCacheKey(city, includeForecast);
  cache.set(key, {
    data,
    expires: Date.now() + CACHE_TTL_MS,
  });
}

async function fetchWeather(city: string, includeForecast: boolean): Promise<WeatherResponse> {
  if (!config.WEATHER_API_KEY) {
    throw new WeatherError('not_configured', 'Weather API belum dikonfigurasi');
  }

  const cached = getFromCache(city, includeForecast);
  if (cached) {
    log.debug('weather cache hit for %s', city);
    return cached;
  }

  let timer: NodeJS.Timeout | null = null;
  const controller = new AbortController();

  try {
    // Using WeatherAPI.com (free tier: 1M calls/month)
    const baseUrl = 'https://api.weatherapi.com/v1';
    const endpoint = includeForecast ? 'forecast.json' : 'current.json';
    const params = new URLSearchParams({
      key: config.WEATHER_API_KEY,
      q: city,
      aqi: 'no',
    });

    if (includeForecast) {
      params.set('days', '3');
    }

    const url = `${baseUrl}/${endpoint}?${params}`;
    
    timer = setTimeout(() => controller.abort(), config.WEATHER_TIMEOUT_MS);

    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timer);
    timer = null;

    if (res.status === 400) {
      const data = await res.json();
      if ((data as any)?.error?.code === 1006) {
        throw new WeatherError('not_found', 'Kota tidak ditemukan');
      }
      throw new WeatherError('invalid_response', 'Invalid request');
    }

    if (res.status === 403) {
      throw new WeatherError('rate_limit', 'API key invalid atau rate limit');
    }

    if (res.status === 429) {
      throw new WeatherError('rate_limit', 'Rate limit tercapai');
    }

    if (res.status >= 500) {
      throw new WeatherError('server', 'Server weather error');
    }

    if (!res.ok) {
      throw new WeatherError('invalid_response', `HTTP ${res.status}`);
    }

    const data = await res.json();

    const current: WeatherData = {
      city: (data as any).location.name,
      country: (data as any).location.country,
      temp_c: (data as any).current.temp_c,
      condition: (data as any).current.condition.text,
      humidity: (data as any).current.humidity,
      wind_kph: (data as any).current.wind_kph,
      feels_like_c: (data as any).current.feelslike_c,
      timestamp: (data as any).current.last_updated_epoch,
      timezone: (data as any).location.tz_id,
    };

    const result: WeatherResponse = { current };

    if (includeForecast && (data as any).forecast?.forecastday) {
      result.forecast = (data as any).forecast.forecastday.map((day: any) => ({
        date: day.date,
        max_temp_c: day.day.maxtemp_c,
        min_temp_c: day.day.mintemp_c,
        condition: day.day.condition.text,
        chance_of_rain: day.day.daily_chance_of_rain,
      }));
    }

    setCache(city, includeForecast, result);
    return result;
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (error instanceof WeatherError) throw error;
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new WeatherError('network', 'Timeout');
      }
      if (error.message.includes('fetch')) {
        throw new WeatherError('network', 'Network error');
      }
    }
    log.warn('weather fetch failed: %s', error instanceof Error ? error.message : 'unknown');
    throw new WeatherError('network', 'Network error');
  }
}

function formatWeatherCurrent(data: WeatherData): string {
  const time = new Date(data.timestamp * 1000).toLocaleString('id-ID', {
    timeZone: data.timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return [
    `🌤 Cuaca ${data.city}, ${data.country}`,
    '',
    `Suhu: ${data.temp_c}°C (terasa ${data.feels_like_c}°C)`,
    `Kondisi: ${data.condition}`,
    `Kelembapan: ${data.humidity}%`,
    `Angin: ${data.wind_kph} km/jam`,
    '',
    `Waktu: ${time}`,
  ].join('\n');
}

function formatWeatherForecast(response: WeatherResponse): string {
  const lines = [formatWeatherCurrent(response.current), ''];

  if (response.forecast && response.forecast.length > 0) {
    lines.push('📅 Prakiraan:');
    lines.push('');
    response.forecast.forEach((day) => {
      const date = new Date(day.date).toLocaleDateString('id-ID', { dateStyle: 'medium' });
      lines.push(`${date}`);
      lines.push(`  ${day.min_temp_c}°C - ${day.max_temp_c}°C`);
      lines.push(`  ${day.condition}`);
      lines.push(`  Kemungkinan hujan: ${day.chance_of_rain}%`);
      lines.push('');
    });
  }

  return lines.join('\n').trim();
}

function buildWeatherAnalysisPrompt(response: WeatherResponse, includeForecast: boolean): string {
  const data = {
    city: response.current.city,
    current: {
      temp_c: response.current.temp_c,
      feels_like_c: response.current.feels_like_c,
      condition: response.current.condition,
      humidity: response.current.humidity,
      wind_kph: response.current.wind_kph,
    },
    forecast: includeForecast ? response.forecast : undefined,
  };

  return [
    'Kamu adalah asisten cuaca yang membantu pengguna memahami kondisi cuaca.',
    '',
    'Tugas: Berikan ringkasan cuaca dan saran aktivitas dalam bahasa Indonesia.',
    '',
    'Aturan:',
    '- Hanya gunakan data cuaca yang diberikan',
    '- JANGAN mengarang data cuaca atau memberikan kepastian berlebihan',
    '- Saran aktivitas umum saja (tidak personal)',
    '- Jika prakiraan ada, sebutkan tren cuaca',
    '- Maksimal 150 kata, format plain text untuk WhatsApp',
    '',
    'Data cuaca:',
    JSON.stringify(data, null, 2),
  ].join('\n');
}

function friendlyWeatherError(error: unknown): string {
  if (error instanceof WeatherError) {
    switch (error.kind) {
      case 'not_configured':
        return 'Fitur cuaca belum dikonfigurasi. Isi WEATHER_API_KEY di .env lalu restart bot.';
      case 'not_found':
        return 'Kota tidak ditemukan. Coba nama kota yang lebih spesifik atau gunakan nama dalam bahasa Inggris.';
      case 'network':
        return error.message === 'Timeout'
          ? 'Request cuaca terlalu lama. Coba lagi.'
          : 'Tidak dapat terhubung ke layanan cuaca. Coba lagi nanti.';
      case 'rate_limit':
        return 'Batas request cuaca tercapai. Tunggu beberapa saat lalu coba lagi.';
      case 'server':
        return 'Layanan cuaca sedang bermasalah. Coba lagi nanti.';
      default:
        return 'Terjadi kesalahan saat mengambil data cuaca. Coba lagi.';
    }
  }
  if (error instanceof AiError) {
    return 'AI gagal menganalisis cuaca. Data mentah ditampilkan.';
  }
  return 'Terjadi kesalahan. Coba lagi.';
}

export async function handleWeather(ctx: DispatchContext): Promise<void> {
  const text = ctx.command?.raw ?? '';
  const parts = text.slice(config.SENARIBOT_PREFIX.length).trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  
  let city = '';
  let includeForecast = false;

  if (command === 'forecast') {
    includeForecast = true;
    city = parts.slice(1).join(' ').trim();
  } else if (command === 'weather') {
    // .weather today <city> or .weather <city>
    if (parts[1]?.toLowerCase() === 'today') {
      city = parts.slice(2).join(' ').trim();
    } else {
      city = parts.slice(1).join(' ').trim();
    }
  }

  if (!city) {
    await ctx.reply(
      'Usage:\n.weather <kota>\n.weather today <kota>\n.forecast <kota>\n\nContoh:\n.weather Jakarta\n.forecast Bandung',
    );
    return;
  }

  if (city.length > MAX_CITY_LENGTH) {
    await ctx.reply(`Nama kota terlalu panjang (${city.length} karakter). Maksimal ${MAX_CITY_LENGTH} karakter.`);
    return;
  }

  if (!config.WEATHER_API_KEY) {
    await ctx.reply('Fitur cuaca belum dikonfigurasi. Isi WEATHER_API_KEY di .env lalu restart bot.');
    return;
  }

  const jid = ctx.sender;
  const requestKey = `${jid}:${city}`;
  if (inFlight.has(requestKey)) {
    await ctx.reply('Request cuaca sebelumnya masih diproses. Mohon tunggu.');
    return;
  }

  inFlight.add(requestKey);

  try {
    await ctx.reply('🌤 Mengambil data cuaca...');

    const weatherData = await fetchWeather(city, includeForecast);
    const rawData = includeForecast ? formatWeatherForecast(weatherData) : formatWeatherCurrent(weatherData.current);

    // Try AI analysis, fall back to raw data
    if (aiService.isConfigured()) {
      try {
        const analysis = await aiService.chat(
          [{ role: 'user', content: buildWeatherAnalysisPrompt(weatherData, includeForecast) }],
          {
            systemPrompt: 'You are a helpful weather assistant. Follow instructions exactly.',
            temperature: 0.3,
            maxTokens: 400,
          },
        );

        const sections = [`💬 Ringkasan:\n${analysis}`, '', '📊 Detail:', rawData];
        for (const part of splitMessage(sections.join('\n'))) {
          await ctx.reply(part);
        }
      } catch (aiError) {
        log.warn('ai analysis failed, showing raw data: %s', aiError instanceof Error ? aiError.message : 'unknown');
        for (const part of splitMessage(rawData)) {
          await ctx.reply(part);
        }
      }
    } else {
      for (const part of splitMessage(rawData)) {
        await ctx.reply(part);
      }
    }
  } catch (error) {
    log.warn('weather request failed: %s', error instanceof Error ? error.message : 'unknown');
    await ctx.reply(friendlyWeatherError(error));
  } finally {
    inFlight.delete(requestKey);
  }
}

export async function setup(): Promise<Command[]> {
  return [
    {
      name: 'weather',
      aliases: ['forecast'],
      description: 'Informasi cuaca dan prakiraan dengan analisis AI',
      handler: handleWeather,
    },
  ];
}

export function teardown(): void {
  inFlight.clear();
  cache.clear();
}
