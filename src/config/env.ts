import { z } from 'zod';

const envSchema = z.object({
  SENARIBOT_PHONE_NUMBER: z.string().min(1, 'Phone number required'),
  SENARIBOT_OWNER_JIDS: z.string().min(1, 'Owner JIDs required').transform(v => v.split(',').map(j => j.trim()).filter(j => j.length > 0)),
  SENARIBOT_DB_PATH: z.string().default('./data/senaribot.db'),
  SENARIBOT_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SENARIBOT_PREFIX: z.string().min(1, 'Prefix must not be empty').default('.'),
  SENARIBOT_RATE_LIMIT_BURST: z.string().default('5').transform(Number).pipe(z.number().min(1)),
  SENARIBOT_WORKER_THREADS: z.string().default('2').transform(Number).pipe(z.number().min(1)),
  APAI_PROVIDER: z.string().default('apinex'),
  APINEX_API_KEY: z.string().optional(),
  APINEX_BASE_URL: z.string().url().default('https://api.apinex.bond/v1'),
  APINEX_MODEL: z.string().default('free/gpt-6-luna'),
  AI_MAX_HISTORY: z.string().default('10').transform(Number).pipe(z.number().int().min(1).max(50)),
  AI_MAX_OUTPUT_TOKENS: z.string().default('4096').transform(Number).pipe(z.number().int().min(16)),
  AI_TEMPERATURE: z.string().default('0.7').transform(Number).pipe(z.number().min(0).max(2)),
  AI_TIMEOUT_MS: z.string().default('60000').transform(Number).pipe(z.number().int().min(1000)),
  AI_SYSTEM_PROMPT: z.string().optional(),
  SUM_MAX_INPUT_CHARS: z.string().default('60000').transform(Number).pipe(z.number().int().min(500)),
  SUM_CHUNK_CHARS: z.string().default('8000').transform(Number).pipe(z.number().int().min(500)),
  SUM_MAX_OUTPUT_TOKENS: z.string().default('1024').transform(Number).pipe(z.number().int().min(64)),
  SUM_MAX_FILE_BYTES: z.string().default('5242880').transform(Number).pipe(z.number().int().min(1024)),
  SUM_CACHE_TTL_MS: z.string().default('600000').transform(Number).pipe(z.number().int().min(0)),
  SUM_MAX_CONCURRENT: z.string().default('2').transform(Number).pipe(z.number().int().min(1).max(10)),
  SENARIBOT_TIMEZONE: z
    .string()
    .default('Asia/Jakarta')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Timezone tidak valid (contoh: Asia/Jakarta)'),
  SEARCH_PROVIDER: z.enum(['serpapi', 'brave']).default('brave'),
  SEARCH_API_KEY: z.string().optional(),
  SEARCH_TIMEOUT_MS: z.string().default('30000').transform(Number).pipe(z.number().int().min(1000)),
  WEATHER_API_KEY: z.string().optional(),
  WEATHER_TIMEOUT_MS: z.string().default('15000').transform(Number).pipe(z.number().int().min(1000)),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_TIMEOUT_MS: z.string().default('10000').transform(Number).pipe(z.number().int().min(1000)),
  YOUTUBE_TIMEOUT_MS: z.string().default('30000').transform(Number).pipe(z.number().int().min(1000)),
  CURRENCY_TIMEOUT_MS: z.string().default('10000').transform(Number).pipe(z.number().int().min(1000)),
  NODE_ENV: z.enum(['development', 'production']).default('production'),
});

export type Config = z.infer<typeof envSchema>;

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;

  // Anggap variabel kosong sebagai tidak diisi agar nilai default tetap berlaku.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const messages = Object.entries(errors)
      .map(([key, msgs]) => `${key}: ${msgs?.join(', ')}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${messages}`);
  }

  cachedConfig = result.data;
  return cachedConfig;
}
