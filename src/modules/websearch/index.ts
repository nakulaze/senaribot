import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { aiService, AiError } from '@/core/ai-service.js';
import { getConfig } from '@/config/env.js';
import { childLogger } from '@/utils/logger.js';
import { splitMessage } from '@/modules/ai/index.js';

const log = childLogger('websearch');
const config = getConfig();

const MAX_QUERY_LENGTH = 200;
const MAX_RESULTS = 5;
const inFlight = new Set<string>();

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
}

class SearchError extends Error {
  constructor(
    public kind: 'not_configured' | 'network' | 'rate_limit' | 'invalid_response' | 'server',
    message: string,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}

function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

async function searchWeb(query: string): Promise<SearchResponse> {
  if (!config.SEARCH_API_KEY) {
    throw new SearchError('not_configured', 'Search API belum dikonfigurasi');
  }

  const provider = config.SEARCH_PROVIDER.toLowerCase();
  
  let timer: NodeJS.Timeout | null = null;
  const controller = new AbortController();

  try {
    let url: string;
    let headers: Record<string, string>;

    if (provider === 'serpapi') {
      const params = new URLSearchParams({
        q: query,
        num: String(MAX_RESULTS),
        api_key: config.SEARCH_API_KEY,
      });
      url = `https://serpapi.com/search?${params}`;
      headers = {};
    } else if (provider === 'brave') {
      url = 'https://api.search.brave.com/res/v1/web/search';
      headers = {
        'Accept': 'application/json',
        'X-Subscription-Token': config.SEARCH_API_KEY,
      };
      const params = new URLSearchParams({ q: query, count: String(MAX_RESULTS) });
      url = `${url}?${params}`;
    } else {
      throw new SearchError('not_configured', `Provider ${provider} tidak didukung`);
    }

    timer = setTimeout(() => controller.abort(), config.SEARCH_TIMEOUT_MS);

    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timer);
    timer = null;

    if (res.status === 429) {
      throw new SearchError('rate_limit', 'Rate limit tercapai');
    }
    if (res.status >= 500) {
      throw new SearchError('server', 'Server search error');
    }
    if (!res.ok) {
      throw new SearchError('invalid_response', `HTTP ${res.status}`);
    }

    const data = await res.json();
    const results: SearchResult[] = [];

    if (provider === 'serpapi') {
      const organic = (data as any).organic_results || [];
      for (const item of organic.slice(0, MAX_RESULTS)) {
        if (item.title && item.link && item.snippet) {
          results.push({
            title: item.title,
            url: item.link,
            snippet: item.snippet,
          });
        }
      }
    } else if (provider === 'brave') {
      const webResults = (data as any).web?.results || [];
      for (const item of webResults.slice(0, MAX_RESULTS)) {
        if (item.title && item.url && item.description) {
          results.push({
            title: item.title,
            url: item.url,
            snippet: item.description,
          });
        }
      }
    }

    if (results.length === 0) {
      throw new SearchError('invalid_response', 'Tidak ada hasil pencarian');
    }

    return { results, query };
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (error instanceof SearchError) throw error;
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new SearchError('network', 'Timeout');
      }
      if (error.message.includes('fetch')) {
        throw new SearchError('network', 'Network error');
      }
    }
    log.warn('search failed: %s', error instanceof Error ? error.message : 'unknown');
    throw new SearchError('network', 'Network error');
  }
}

function formatSearchResults(response: SearchResponse): string {
  const lines: string[] = [
    `🔍 Hasil pencarian: ${response.query}`,
    '',
  ];

  response.results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${extractDomain(r.url)}`);
    lines.push(`   ${r.snippet}`);
    lines.push(`   ${r.url}`);
    lines.push('');
  });

  return lines.join('\n').trim();
}

function buildAnalysisPrompt(response: SearchResponse): string {
  const sources = response.results.map((r, i) => ({
    index: i + 1,
    title: r.title,
    url: r.url,
    domain: extractDomain(r.url),
    snippet: r.snippet,
  }));

  return [
    `Kamu adalah asisten pencarian web yang membantu pengguna memahami hasil pencarian.`,
    ``,
    `Tugas: Analisis hasil pencarian dan buat ringkasan yang informatif dalam bahasa Indonesia.`,
    ``,
    `Aturan:`,
    `- Hanya gunakan informasi dari hasil pencarian yang diberikan`,
    `- Bedakan fakta dan opini dengan jelas`,
    `- JANGAN mengarang informasi atau sumber`,
    `- Sertakan nomor referensi [1], [2], dst untuk klaim penting`,
    `- Prioritaskan sumber dari domain terpercaya (.edu, .gov, organisasi kredibel)`,
    `- Jika informasi kontradiktif, sebutkan perbedaan dan sumbernya`,
    `- Jika hasil tidak cukup untuk menjawab, katakan "Hasil pencarian tidak cukup lengkap"`,
    `- Maksimal 300 kata, format plain text untuk WhatsApp`,
    ``,
    `Query: "${response.query}"`,
    ``,
    `Hasil pencarian:`,
    JSON.stringify(sources, null, 2),
  ].join('\n');
}

function friendlySearchError(error: unknown): string {
  if (error instanceof SearchError) {
    switch (error.kind) {
      case 'not_configured':
        return 'Fitur web search belum dikonfigurasi. Isi SEARCH_API_KEY di .env lalu restart bot.';
      case 'network':
        return error.message === 'Timeout'
          ? 'Pencarian terlalu lama. Coba query yang lebih spesifik.'
          : 'Tidak dapat terhubung ke layanan pencarian. Coba lagi nanti.';
      case 'rate_limit':
        return 'Batas pencarian tercapai. Tunggu beberapa saat lalu coba lagi.';
      case 'server':
        return 'Layanan pencarian sedang bermasalah. Coba lagi nanti.';
      case 'invalid_response':
        return error.message === 'Tidak ada hasil pencarian'
          ? 'Tidak ada hasil pencarian ditemukan. Coba kata kunci lain.'
          : 'Terjadi kesalahan saat mencari. Coba lagi.';
      default:
        return 'Terjadi kesalahan saat mencari. Coba lagi.';
    }
  }
  if (error instanceof AiError) {
    switch (error.kind) {
      case 'not_configured':
        return 'AI belum dikonfigurasi untuk menganalisis hasil. Hasil mentah ditampilkan.';
      case 'timeout':
        return 'AI terlalu lama merespons. Hasil mentah ditampilkan.';
      case 'rate_limit':
        return 'AI sedang sibuk. Hasil mentah ditampilkan.';
      default:
        return 'AI gagal menganalisis hasil. Hasil mentah ditampilkan.';
    }
  }
  return 'Terjadi kesalahan. Coba lagi.';
}

export async function handleWebSearch(ctx: DispatchContext): Promise<void> {
  const text = ctx.command?.raw ?? '';
  const query = text.slice(config.SENARIBOT_PREFIX.length).trim().replace(/^\S+\s*/, '').trim();

  if (!query) {
    await ctx.reply('Usage: .web <query>\n\nContoh:\n.web capital of Indonesia\n.web resep rendang');
    return;
  }

  if (query.length > MAX_QUERY_LENGTH) {
    await ctx.reply(`Query terlalu panjang (${query.length} karakter). Maksimal ${MAX_QUERY_LENGTH} karakter.`);
    return;
  }

  if (!config.SEARCH_API_KEY) {
    await ctx.reply('Fitur web search belum dikonfigurasi. Isi SEARCH_API_KEY di .env lalu restart bot.');
    return;
  }

  const jid = ctx.sender;
  if (inFlight.has(jid)) {
    await ctx.reply('Pencarian sebelumnya masih diproses. Mohon tunggu.');
    return;
  }

  inFlight.add(jid);
  
  try {
    await ctx.reply('🔍 Mencari...');
    
    const searchResponse = await searchWeb(query);
    const rawResults = formatSearchResults(searchResponse);

    // Try AI analysis, fall back to raw results
    if (aiService.isConfigured()) {
      try {
        const analysis = await aiService.chat(
          [{ role: 'user', content: buildAnalysisPrompt(searchResponse) }],
          {
            systemPrompt: 'You are a helpful web search assistant. Follow instructions exactly.',
            temperature: 0.3,
            maxTokens: 600,
          },
        );

        const sections = [`📊 Ringkasan:\n${analysis}`, '', '🔗 Sumber:', rawResults];
        for (const part of splitMessage(sections.join('\n'))) {
          await ctx.reply(part);
        }
      } catch (aiError) {
        log.warn('ai analysis failed, showing raw results: %s', aiError instanceof Error ? aiError.message : 'unknown');
        for (const part of splitMessage(rawResults)) {
          await ctx.reply(part);
        }
      }
    } else {
      for (const part of splitMessage(rawResults)) {
        await ctx.reply(part);
      }
    }
  } catch (error) {
    log.warn('web search failed: %s', error instanceof Error ? error.message : 'unknown');
    await ctx.reply(friendlySearchError(error));
  } finally {
    inFlight.delete(jid);
  }
}

export async function setup(): Promise<Command[]> {
  return [
    {
      name: 'web',
      aliases: ['searchweb', 'google'],
      description: 'Web search dengan analisis AI',
      handler: handleWebSearch,
    },
  ];
}

export function teardown(): void {
  inFlight.clear();
}
