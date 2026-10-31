import type { TodoPriority } from '@/database/repositories/todo.repo.js';

export interface ParsedTodoArgs {
  title: string;
  category?: string;
  priority?: TodoPriority;
  dueText?: string;
  errors: string[];
}

const PRIORITY_ALIASES: Record<string, TodoPriority> = {
  low: 'low',
  rendah: 'low',
  l: 'low',
  medium: 'medium',
  sedang: 'medium',
  med: 'medium',
  m: 'medium',
  high: 'high',
  tinggi: 'high',
  h: 'high',
};

export function parsePriority(value: string): TodoPriority | null {
  return PRIORITY_ALIASES[value.trim().toLowerCase()] ?? null;
}

export const MAX_TITLE_CHARS = 200;
export const MAX_CATEGORY_CHARS = 30;

const OPTION_KEYS: Record<string, 'cat' | 'prio' | 'due'> = {
  '--cat': 'cat',
  '--kategori': 'cat',
  '--prio': 'prio',
  '--prioritas': 'prio',
  '--due': 'due',
  '--deadline': 'due',
};

export function parseTodoArgs(tokens: string[]): ParsedTodoArgs {
  const errors: string[] = [];
  const titleParts: string[] = [];
  const values: Partial<Record<'cat' | 'prio' | 'due', string[]>> = {};
  let current: 'cat' | 'prio' | 'due' | null = null;

  for (const token of tokens) {
    const key = OPTION_KEYS[token.toLowerCase()];
    if (key) {
      current = key;
      values[key] = values[key] ?? [];
      continue;
    }
    if (current) {
      values[current]!.push(token);
    } else {
      titleParts.push(token);
    }
  }

  const result: ParsedTodoArgs = { title: titleParts.join(' ').trim(), errors };

  if (result.title.length > MAX_TITLE_CHARS) {
    errors.push(`Judul terlalu panjang (maksimal ${MAX_TITLE_CHARS} karakter).`);
  }

  if (values.cat) {
    const cat = values.cat.join(' ').trim();
    if (!cat) {
      errors.push('Nilai --cat kosong.');
    } else if (cat.length > MAX_CATEGORY_CHARS) {
      errors.push(`Kategori terlalu panjang (maksimal ${MAX_CATEGORY_CHARS} karakter).`);
    } else {
      result.category = cat;
    }
  }

  if (values.prio) {
    const raw = values.prio.join(' ').trim();
    const prio = parsePriority(raw);
    if (!prio) {
      errors.push(`Prioritas "${raw}" tidak dikenal. Gunakan low, medium, atau high.`);
    } else {
      result.priority = prio;
    }
  }

  if (values.due) {
    const due = values.due.join(' ').trim();
    if (!due) {
      errors.push('Nilai --due kosong.');
    } else {
      result.dueText = due;
    }
  }

  return result;
}
