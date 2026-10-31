import * as chrono from 'chrono-node';

export interface ParsedDeadline {
  unix: number;
  hasTime: boolean;
}

const DAY_NAMES: Record<string, string> = {
  senin: 'monday',
  selasa: 'tuesday',
  rabu: 'wednesday',
  kamis: 'thursday',
  jumat: 'friday',
  "jum'at": 'friday',
  sabtu: 'saturday',
  minggu: 'sunday',
};

function to24h(hour: number, period: string | undefined): number {
  const p = (period ?? '').toLowerCase();
  if (p === 'pagi') return hour === 12 ? 0 : hour;
  if (p === 'siang') return hour >= 1 && hour <= 6 ? hour + 12 : hour;
  if (p === 'sore') return hour < 12 ? hour + 12 : hour;
  if (p === 'malam') return hour === 12 ? 0 : hour < 12 ? hour + 12 : hour;
  return hour;
}

// Ubah frasa Indonesia umum menjadi bentuk Inggris yang dipahami chrono.
export function normalizeIndonesian(input: string): string {
  let text = ` ${input.toLowerCase().trim()} `;

  // "jam 7 malam", "jam 07.30 pagi", "pukul 19:00"
  text = text.replace(
    /\b(?:jam|pukul|pkl)\s*(\d{1,2})(?:[.:](\d{2}))?\s*(pagi|siang|sore|malam)?\b/g,
    (_m, h: string, min: string | undefined, period: string | undefined) => {
      const hour = to24h(Number(h), period);
      return ` at ${String(hour).padStart(2, '0')}:${min ?? '00'} `;
    },
  );

  // Keterangan waktu tanpa jam eksplisit: "besok sore", "lusa pagi", "hari ini malam".
  const PERIOD_HOUR: Record<string, string> = { pagi: '08:00', siang: '12:00', sore: '17:00', malam: '19:00' };
  text = text.replace(/\b(pagi|siang|sore|malam)\b/g, (_m, p: string) => ` at ${PERIOD_HOUR[p]} `);

  text = text
    .replace(/\bhari ini\b/g, ' today ')
    .replace(/\bbesok\b/g, ' tomorrow ')
    .replace(/\blusa\b/g, ' in 2 days ')
    .replace(/\bkemarin\b/g, ' yesterday ')
    .replace(/\bminggu depan\b/g, ' next week ')
    .replace(/\bbulan depan\b/g, ' next month ')
    .replace(/\b(\d+)\s*hari lagi\b/g, ' in $1 days ')
    .replace(/\b(\d+)\s*minggu lagi\b/g, ' in $1 weeks ')
    .replace(/\b(\d+)\s*jam lagi\b/g, ' in $1 hours ')
    .replace(/\b(\d+)\s*menit lagi\b/g, ' in $1 minutes ');

  for (const [id, en] of Object.entries(DAY_NAMES)) {
    text = text.replace(new RegExp(`\\b${id}\\s+depan\\b`, 'g'), ` next ${en} `);
    text = text.replace(new RegExp(`\\b${id}\\b`, 'g'), ` ${en} `);
  }

  return text.replace(/\s+/g, ' ').trim();
}

export function parseDeadline(input: string, now: Date = new Date()): ParsedDeadline | null {
  const text = normalizeIndonesian(input);
  if (!text) return null;

  // Terima juga ISO 8601 (dipakai ketika AI menghasilkan tanggal terstruktur).
  if (/^\d{4}-\d{2}-\d{2}(t\d{2}:\d{2}(:\d{2})?(z|[+-]\d{2}:?\d{2})?)?$/i.test(text)) {
    const iso = new Date(input.trim());
    if (!Number.isNaN(iso.getTime())) {
      const hasTime = /t\d{2}:\d{2}/i.test(text);
      if (!hasTime) iso.setHours(23, 59, 0, 0);
      return { unix: Math.floor(iso.getTime() / 1000), hasTime };
    }
  }

  const results = chrono.parse(text, now, { forwardDate: true });
  if (results.length === 0 || !results[0].start) return null;

  const start = results[0].start;
  const hasTime = start.isCertain('hour');
  const date = start.date();
  if (!hasTime) date.setHours(23, 59, 0, 0);

  return { unix: Math.floor(date.getTime() / 1000), hasTime };
}

export function formatDeadline(unix: number): string {
  const d = new Date(unix * 1000);
  const tanggal = d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  const jam = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
  return jam === '23.59' ? tanggal : `${tanggal} ${jam}`;
}
