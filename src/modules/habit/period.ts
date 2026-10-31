export type Frequency = 'daily' | 'weekly';

const DAY_MS = 86400000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// Tanggal lokal (YYYY-MM-DD) untuk sebuah waktu unix di timezone tertentu.
export function localDate(unix: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(unix * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Jam lokal (HH:MM) untuk sebuah waktu unix di timezone tertentu.
export function localTime(unix: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(unix * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

function toUtcMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

// Senin sebagai awal minggu.
export function weekStart(date: string): string {
  const dow = new Date(toUtcMs(date)).getUTCDay(); // 0 = Minggu
  const offset = (dow + 6) % 7;
  return addDays(date, -offset);
}

// Kunci periode: tanggal untuk harian, tanggal Senin untuk mingguan.
export function periodKey(unix: number, freq: Frequency, tz: string): string {
  const date = localDate(unix, tz);
  return freq === 'weekly' ? weekStart(date) : date;
}

export function prevPeriod(key: string, freq: Frequency): string {
  return addDays(key, freq === 'weekly' ? -7 : -1);
}

export function nextPeriod(key: string, freq: Frequency): string {
  return addDays(key, freq === 'weekly' ? 7 : 1);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

// Current streak: hitung mundur dari periode ini. Periode ini yang belum diisi
// tidak memutus streak selama periode sebelumnya terisi.
export function currentStreak(keys: string[], freq: Frequency, todayKey: string): number {
  const set = new Set(keys);
  let cursor = set.has(todayKey) ? todayKey : prevPeriod(todayKey, freq);
  let streak = 0;
  while (set.has(cursor)) {
    streak++;
    cursor = prevPeriod(cursor, freq);
  }
  return streak;
}

// Longest streak: rentetan terpanjang periode berurutan dalam riwayat.
export function longestStreak(keys: string[], freq: Frequency): number {
  const sorted = Array.from(new Set(keys)).sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const k of sorted) {
    run = prev !== null && nextPeriod(prev, freq) === k ? run + 1 : 1;
    if (run > best) best = run;
    prev = k;
  }
  return best;
}

// Jumlah periode dari periode pertama habit dibuat sampai periode ini (inklusif).
export function periodsSince(startKey: string, todayKey: string, freq: Frequency): number {
  const days = daysBetween(startKey, todayKey);
  if (days < 0) return 1;
  return (freq === 'weekly' ? Math.floor(days / 7) : days) + 1;
}

// Completion rate (0-100) sejak habit dibuat.
export function completionRate(keys: string[], startKey: string, todayKey: string, freq: Frequency): number {
  const total = periodsSince(startKey, todayKey, freq);
  const done = new Set(keys).size;
  return Math.min(100, Math.round((done / total) * 100));
}

// Jumlah log yang jatuh dalam N hari terakhir (termasuk hari ini).
export function countInLastDays(keys: string[], todayDate: string, days: number): number {
  const from = addDays(todayDate, -(days - 1));
  return new Set(keys).size === 0 ? 0 : Array.from(new Set(keys)).filter((k) => k >= from && k <= todayDate).length;
}

// Target jumlah periode dalam N hari terakhir (harian = N, mingguan = ceil(N/7)).
export function expectedInLastDays(freq: Frequency, days: number): number {
  return freq === 'weekly' ? Math.ceil(days / 7) : days;
}
