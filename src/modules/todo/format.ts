import type { TodoTask, TodoStats } from '@/database/repositories/todo.repo.js';
import { formatDeadline } from './date.js';

const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;
const PRIORITY_ICON = { high: '🔴', medium: '🟡', low: '🟢' } as const;

export function formatTask(t: TodoTask, nowUnix: number = Math.floor(Date.now() / 1000)): string {
  const box = t.status === 'done' ? '✅' : '⬜';
  const meta: string[] = [`${PRIORITY_ICON[t.priority]} ${PRIORITY_LABEL[t.priority]}`];
  if (t.category) meta.push(`📁 ${t.category}`);
  if (t.deadline) {
    const late = t.status === 'pending' && t.deadline < nowUnix;
    meta.push(`⏰ ${formatDeadline(t.deadline)}${late ? ' (terlambat)' : ''}`);
  }
  return `${box} #${t.id} ${t.title}\n     ${meta.join(' | ')}`;
}

export function formatList(tasks: TodoTask[], title: string, nowUnix: number = Math.floor(Date.now() / 1000)): string {
  if (tasks.length === 0) return `${title}\n\nTidak ada tugas.`;
  const body = tasks.map((t) => formatTask(t, nowUnix)).join('\n');
  return `${title} (${tasks.length})\n\n${body}`;
}

export function formatStats(s: TodoStats): string {
  const percent = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
  return [
    '📊 Statistik Todo',
    '',
    `Total: ${s.total}`,
    `Selesai: ${s.done} (${percent}%)`,
    `Belum selesai: ${s.pending}`,
    `Terlambat: ${s.overdue}`,
    '',
    'Belum selesai per prioritas:',
    `🔴 High: ${s.byPriority.high}`,
    `🟡 Medium: ${s.byPriority.medium}`,
    `🟢 Low: ${s.byPriority.low}`,
  ].join('\n');
}
