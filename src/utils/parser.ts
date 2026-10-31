import * as chrono from 'chrono-node';

export interface TimeParseResult {
  iso: string;
  unix: number;
  relative: string;
}

export function parseTimeExpression(input: string): TimeParseResult | null {
  const trimmed = input.toLowerCase().trim();
  const now = new Date();

  const results = chrono.parse(trimmed, now);
  if (results.length === 0) return null;

  const first = results[0];
  if (!first.start) return null;

  const date = first.start.date();
  const offset = date.getTime() - now.getTime();

  return {
    iso: date.toISOString(),
    unix: Math.floor(date.getTime() / 1000),
    relative: formatRelativeTime(offset),
  };
}

function formatRelativeTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);

  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function parseCurrency(input: string): number | null {
  const cleaned = input.replace(/[^\d.,-]/g, '').trim();
  const parsed = parseFloat(cleaned.replace(/,/g, ''));
  return isNaN(parsed) ? null : parsed;
}

export function formatCurrency(value: number, currency: string = 'IDR'): string {
  const formatted = new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
  return formatted;
}

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('62')) return digits;
  if (digits.startsWith('8')) return '62' + digits.slice(1);
  if (digits.startsWith('0')) return '62' + digits.slice(1);
  return digits;
}
