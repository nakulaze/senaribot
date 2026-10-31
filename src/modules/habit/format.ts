import type { Habit } from '@/database/repositories/habit.repo.js';

export interface HabitStatsView {
  habit: Habit;
  current: number;
  longest: number;
  rate: number;
  totalDone: number;
  doneThisPeriod: boolean;
  week: { done: number; expected: number };
  month: { done: number; expected: number };
}

const FREQ_LABEL = { daily: 'Harian', weekly: 'Mingguan' } as const;
const UNIT = { daily: 'hari', weekly: 'minggu' } as const;

export function formatHabitLine(h: Habit, doneThisPeriod: boolean, current: number): string {
  const box = doneThisPeriod ? '✅' : '⬜';
  const remind = h.reminder_time ? ` | ⏰ ${h.reminder_time}` : '';
  return `${box} ${h.name}\n     ${FREQ_LABEL[h.frequency]} | 🔥 ${current} ${UNIT[h.frequency]}${remind}`;
}

export function formatHabitList(lines: string[]): string {
  if (lines.length === 0) return 'Belum ada habit.\nTambah dengan: .habit add <nama> [--freq daily|weekly] [--remind 07:30]';
  return `Daftar Habit (${lines.length})\n\n${lines.join('\n')}`;
}

export function formatHabitStats(s: HabitStatsView): string {
  const u = UNIT[s.habit.frequency];
  return [
    `📊 Statistik: ${s.habit.name}`,
    `Frekuensi: ${FREQ_LABEL[s.habit.frequency]}`,
    '',
    `Streak saat ini: ${s.current} ${u}`,
    `Streak terpanjang: ${s.longest} ${u}`,
    `Completion rate: ${s.rate}%`,
    `Total selesai: ${s.totalDone}`,
    `Periode ini: ${s.doneThisPeriod ? 'sudah selesai' : 'belum selesai'}`,
    '',
    `7 hari terakhir: ${s.week.done}/${s.week.expected}`,
    `30 hari terakhir: ${s.month.done}/${s.month.expected}`,
  ].join('\n');
}

export function formatHabitHistory(name: string, keys: string[], limit = 30): string {
  if (keys.length === 0) return `Riwayat ${name}\n\nBelum ada catatan.`;
  const recent = keys.slice(-limit).reverse();
  const more = keys.length > recent.length ? `\n... dan ${keys.length - recent.length} catatan lebih lama` : '';
  return `Riwayat ${name} (${keys.length})\n\n${recent.map((k) => `✅ ${k}`).join('\n')}${more}`;
}
