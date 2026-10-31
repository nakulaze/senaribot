import type { HabitFrequency } from '@/database/repositories/habit.repo.js';

export const MAX_NAME_CHARS = 50;

export interface ParsedHabitArgs {
  name: string;
  frequency?: HabitFrequency;
  remindTime?: string;
  errors: string[];
}

const FREQ_ALIASES: Record<string, HabitFrequency> = {
  daily: 'daily',
  harian: 'daily',
  hari: 'daily',
  weekly: 'weekly',
  mingguan: 'weekly',
  minggu: 'weekly',
};

export function parseFrequency(value: string): HabitFrequency | null {
  return FREQ_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function parseReminderTime(value: string): string | null {
  const m = value.trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const OPTION_KEYS: Record<string, 'freq' | 'remind'> = {
  '--freq': 'freq',
  '--tiap': 'freq',
  '--remind': 'remind',
  '--ingatkan': 'remind',
};

export function parseHabitArgs(tokens: string[]): ParsedHabitArgs {
  const errors: string[] = [];
  const nameParts: string[] = [];
  const values: Partial<Record<'freq' | 'remind', string[]>> = {};
  let current: 'freq' | 'remind' | null = null;

  for (const token of tokens) {
    const key = OPTION_KEYS[token.toLowerCase()];
    if (key) {
      current = key;
      values[key] = values[key] ?? [];
      continue;
    }
    if (current) values[current]!.push(token);
    else nameParts.push(token);
  }

  const result: ParsedHabitArgs = { name: nameParts.join(' ').trim(), errors };

  if (result.name.length > MAX_NAME_CHARS) {
    errors.push(`Nama habit terlalu panjang (maksimal ${MAX_NAME_CHARS} karakter).`);
  }

  if (values.freq) {
    const raw = values.freq.join(' ').trim();
    const freq = parseFrequency(raw);
    if (!freq) errors.push(`Frekuensi "${raw}" tidak dikenal. Gunakan daily atau weekly.`);
    else result.frequency = freq;
  }

  if (values.remind) {
    const raw = values.remind.join(' ').trim();
    const t = parseReminderTime(raw);
    if (!t) errors.push(`Jam reminder "${raw}" tidak valid. Gunakan format HH:MM, contoh 07:30.`);
    else result.remindTime = t;
  }

  return result;
}
