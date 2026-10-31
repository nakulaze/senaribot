import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { HabitRepository, Habit } from '@/database/repositories/habit.repo.js';
import { aiService, AiError } from '@/core/ai-service.js';
import { splitMessage } from '@/modules/ai/index.js';
import { getConfig } from '@/config/env.js';
import { childLogger } from '@/utils/logger.js';
import { parseHabitArgs } from './args.js';
import {
  periodKey,
  localDate,
  localTime,
  currentStreak,
  longestStreak,
  completionRate,
  countInLastDays,
  expectedInLastDays,
} from './period.js';
import { formatHabitLine, formatHabitList, formatHabitStats, formatHabitHistory, HabitStatsView } from './format.js';
import {
  parseHabitPlan,
  buildPlanPrompt,
  HabitPlan,
  HabitDigest,
  ANALYSIS_SYSTEM_PROMPT,
  RECOMMEND_SYSTEM_PROMPT,
} from './nl.js';

const log = childLogger('habit');
const config = getConfig();
const TZ = config.SENARIBOT_TIMEZONE;
const habitRepo = new HabitRepository();

const MAX_INPUT_CHARS = 1000;
const MAX_HABITS_PER_USER = 30;
const CONFIRM_TTL_MS = 60000;
const inFlight = new Set<string>();

const nowUnix = () => Math.floor(Date.now() / 1000);

export function extractHabitText(ctx: DispatchContext): string {
  const raw = ctx.command?.raw ?? '';
  return raw.slice(config.SENARIBOT_PREFIX.length).trim().replace(/^\S+\s*/, '').trim();
}

export async function replyLong(ctx: DispatchContext, text: string): Promise<void> {
  for (const part of splitMessage(text)) {
    await ctx.reply(part);
  }
}

export function buildStats(h: Habit, now: number = nowUnix(), tz: string = TZ): HabitStatsView {
  const keys = habitRepo.getPeriodKeys(h.id);
  const today = periodKey(now, h.frequency, tz);
  const todayDate = localDate(now, tz);
  const startKey = periodKey(h.created_at, h.frequency, tz);
  const weekDone = h.frequency === 'weekly' ? countInLastDays(keys, todayDate, 7) : countInLastDays(keys, todayDate, 7);
  const monthDone = countInLastDays(keys, todayDate, 30);
  return {
    habit: h,
    current: currentStreak(keys, h.frequency, today),
    longest: longestStreak(keys, h.frequency),
    rate: completionRate(keys, startKey, today, h.frequency),
    totalDone: keys.length,
    doneThisPeriod: keys.includes(today),
    week: { done: weekDone, expected: expectedInLastDays(h.frequency, 7) },
    month: { done: monthDone, expected: expectedInLastDays(h.frequency, 30) },
  };
}

export async function handleAdd(ctx: DispatchContext, tokens: string[]): Promise<void> {
  const jid = ctx.sender;
  const parsed = parseHabitArgs(tokens);
  if (!parsed.name) {
    await ctx.reply('Tulis nama habit.\nContoh: .habit add Baca buku --freq daily --remind 20:00');
    return;
  }
  if (parsed.errors.length > 0) {
    await ctx.reply(parsed.errors.join('\n'));
    return;
  }
  if (habitRepo.getByName(jid, parsed.name)) {
    await ctx.reply(`Habit "${parsed.name}" sudah ada.`);
    return;
  }
  if (habitRepo.list(jid).length >= MAX_HABITS_PER_USER) {
    await ctx.reply(`Maksimal ${MAX_HABITS_PER_USER} habit. Hapus yang tidak dipakai dulu.`);
    return;
  }
  const h = habitRepo.insert({
    user_jid: jid,
    name: parsed.name,
    frequency: parsed.frequency ?? 'daily',
    reminder_time: parsed.remindTime ?? null,
  });
  await ctx.reply(`Habit ditambahkan:\n${formatHabitLine(h, false, 0)}`);
}

export async function handleList(ctx: DispatchContext): Promise<void> {
  const now = nowUnix();
  const lines = habitRepo.list(ctx.sender).map((h) => {
    const s = buildStats(h, now);
    return formatHabitLine(h, s.doneThisPeriod, s.current);
  });
  await replyLong(ctx, formatHabitList(lines));
}

type PendingAction =
  | { kind: 'delete'; habitId: number; name: string }
  | { kind: 'plan'; plan: HabitPlan };

const pendingConfirm = new Map<string, { action: PendingAction; expires: number }>();

function findHabit(jid: string, tokens: string[]): Habit | null {
  const name = tokens.join(' ').trim();
  if (!name) return null;
  return habitRepo.getByName(jid, name);
}

export async function handleDone(ctx: DispatchContext, tokens: string[]): Promise<void> {
  const name = tokens.join(' ').trim();
  if (!name) {
    await ctx.reply('Usage: .habit done <nama>');
    return;
  }
  const h = habitRepo.getByName(ctx.sender, name);
  if (!h) {
    await ctx.reply(`Habit "${name}" tidak ditemukan.`);
    return;
  }
  const now = nowUnix();
  const key = periodKey(now, h.frequency, TZ);
  const unit = h.frequency === 'weekly' ? 'minggu ini' : 'hari ini';
  if (!habitRepo.addLog(h.id, key, now)) {
    await ctx.reply(`"${h.name}" sudah dicatat ${unit}.`);
    return;
  }
  const s = buildStats(h, now);
  await ctx.reply(`Tercatat: ${h.name} (${unit})\nStreak: ${s.current} ${h.frequency === 'weekly' ? 'minggu' : 'hari'}`);
}

export async function handleStats(ctx: DispatchContext, tokens: string[]): Promise<void> {
  const h = findHabit(ctx.sender, tokens);
  if (!h) {
    await ctx.reply(tokens.length === 0 ? 'Usage: .habit stats <nama>' : `Habit "${tokens.join(' ')}" tidak ditemukan.`);
    return;
  }
  await ctx.reply(formatHabitStats(buildStats(h)));
}

export async function handleHistory(ctx: DispatchContext, tokens: string[]): Promise<void> {
  const h = findHabit(ctx.sender, tokens);
  if (!h) {
    await ctx.reply(tokens.length === 0 ? 'Usage: .habit history <nama>' : `Habit "${tokens.join(' ')}" tidak ditemukan.`);
    return;
  }
  await replyLong(ctx, formatHabitHistory(h.name, habitRepo.getPeriodKeys(h.id)));
}

export async function handleDelete(ctx: DispatchContext, tokens: string[]): Promise<void> {
  const h = findHabit(ctx.sender, tokens);
  if (!h) {
    await ctx.reply(tokens.length === 0 ? 'Usage: .habit delete <nama>' : `Habit "${tokens.join(' ')}" tidak ditemukan.`);
    return;
  }
  const total = habitRepo.getPeriodKeys(h.id).length;
  pendingConfirm.set(ctx.sender, { action: { kind: 'delete', habitId: h.id, name: h.name }, expires: Date.now() + CONFIRM_TTL_MS });
  await ctx.reply(
    `Hapus habit "${h.name}" beserta ${total} catatan riwayatnya?\nBalas .habit yes dalam 60 detik untuk melanjutkan, atau .habit no untuk membatalkan.`,
  );
}

function summarizePlan(plan: HabitPlan): string {
  if (plan.action === 'done') return `Catat habit "${plan.name}" selesai untuk periode ini.`;
  if (plan.action === 'delete') return `Hapus habit "${plan.name}" beserta seluruh riwayatnya.`;
  return 'Perubahan habit';
}

export async function handleConfirm(ctx: DispatchContext, accept: boolean): Promise<void> {
  const jid = ctx.sender;
  const pending = pendingConfirm.get(jid);
  if (!pending) {
    await ctx.reply('Tidak ada aksi yang menunggu konfirmasi.');
    return;
  }
  pendingConfirm.delete(jid);
  if (Date.now() > pending.expires) {
    await ctx.reply('Konfirmasi sudah kedaluwarsa. Ulangi perintahnya.');
    return;
  }
  if (!accept) {
    await ctx.reply('Dibatalkan. Tidak ada perubahan.');
    return;
  }

  const action = pending.action;
  if (action.kind === 'delete') {
    habitRepo.remove(jid, action.habitId);
    await ctx.reply(`Habit dihapus: ${action.name}`);
    return;
  }
  if (action.plan.action === 'delete') {
    const h = habitRepo.getByName(jid, action.plan.name);
    if (!h) {
      await ctx.reply(`Habit "${action.plan.name}" tidak ditemukan.`);
      return;
    }
    habitRepo.remove(jid, h.id);
    await ctx.reply(`Habit dihapus: ${h.name}`);
    return;
  }
  if (action.plan.action === 'done') {
    await handleDone(ctx, [action.plan.name]);
    return;
  }
  await ctx.reply('Aksi tidak dikenali.');
}

function digestFor(h: Habit): HabitDigest {
  const s = buildStats(h);
  return {
    name: h.name,
    frequency: h.frequency,
    current_streak: s.current,
    longest_streak: s.longest,
    completion_rate_pct: s.rate,
    last_7_days: `${s.week.done}/${s.week.expected}`,
    last_30_days: `${s.month.done}/${s.month.expected}`,
  };
}

function friendlyAiError(error: unknown): string {
  if (error instanceof AiError) {
    switch (error.kind) {
      case 'not_configured':
        return 'Fitur AI belum dikonfigurasi. Isi APINEX_API_KEY di .env lalu restart bot.';
      case 'timeout':
        return 'AI terlalu lama merespons. Coba lagi sebentar lagi.';
      case 'rate_limit':
        return 'AI sedang kebanjiran permintaan. Tunggu beberapa saat lalu coba lagi.';
      case 'server':
        return 'Layanan AI sedang bermasalah. Coba lagi nanti.';
      case 'auth':
        return 'Autentikasi ke layanan AI gagal. Periksa APINEX_API_KEY di .env.';
      case 'network':
        return 'Tidak bisa terhubung ke layanan AI. Periksa koneksi internet.';
      default:
        return 'AI mengembalikan respons yang tidak valid. Coba lagi.';
    }
  }
  return 'Terjadi kesalahan saat memproses permintaan.';
}

async function runCoach(ctx: DispatchContext, systemPrompt: string, payload: unknown): Promise<void> {
  const answer = await aiService.chat([{ role: 'user', content: JSON.stringify(payload) }], {
    systemPrompt,
    temperature: 0.5,
    maxTokens: 500,
  });
  await replyLong(ctx, answer);
}

export async function handleNatural(ctx: DispatchContext, text: string): Promise<void> {
  const jid = ctx.sender;

  if (text.length > MAX_INPUT_CHARS) {
    await ctx.reply(`Teks terlalu panjang (${text.length} karakter). Maksimal ${MAX_INPUT_CHARS} karakter.`);
    return;
  }
  if (!aiService.isConfigured()) {
    await ctx.reply('Perintah tidak dikenali dan fitur AI belum dikonfigurasi.\nGunakan: .habit add|list|done|stats|history|delete');
    return;
  }
  if (inFlight.has(jid)) {
    await ctx.reply('Permintaan habit sebelumnya masih diproses. Mohon tunggu.');
    return;
  }

  inFlight.add(jid);
  try {
    const habits = habitRepo.list(jid);
    const raw = await aiService.chat([{ role: 'user', content: text }], {
      systemPrompt: buildPlanPrompt(habits.map((h) => h.name)),
      temperature: 0,
      maxTokens: 300,
    });
    const plan = parseHabitPlan(raw);
    if (!plan) {
      await ctx.reply('Saya tidak bisa memahami instruksi itu. Coba gunakan command biasa, misalnya .habit add <nama>.');
      return;
    }

    switch (plan.action) {
      case 'unknown':
        await ctx.reply(plan.message || 'Saya tidak yakin maksud Anda. Coba tulis ulang instruksinya.');
        return;
      case 'list':
        await handleList(ctx);
        return;
      case 'stats':
        await handleStats(ctx, plan.name.split(/\s+/));
        return;
      case 'history':
        await handleHistory(ctx, plan.name.split(/\s+/));
        return;
      case 'add': {
        const tokens = plan.name.split(/\s+/);
        if (plan.frequency) tokens.push('--freq', plan.frequency);
        if (plan.remind_time) tokens.push('--remind', plan.remind_time);
        await handleAdd(ctx, tokens);
        return;
      }
      case 'analyze': {
        const target = plan.name ? habitRepo.getByName(jid, plan.name) : null;
        const list = target ? [target] : habits;
        if (list.length === 0) {
          await ctx.reply('Belum ada habit untuk dianalisis. Tambah dulu dengan .habit add <nama>.');
          return;
        }
        await runCoach(ctx, ANALYSIS_SYSTEM_PROMPT, { habits: list.map(digestFor) });
        return;
      }
      case 'recommend':
        await runCoach(ctx, RECOMMEND_SYSTEM_PROMPT, {
          preferences: plan.preferences ?? text,
          habits: habits.map((h) => ({ name: h.name, frequency: h.frequency, reminder_time: h.reminder_time })),
        });
        return;
      case 'done':
      case 'delete': {
        if (!habitRepo.getByName(jid, plan.name)) {
          await ctx.reply(`Habit "${plan.name}" tidak ditemukan.`);
          return;
        }
        pendingConfirm.set(jid, { action: { kind: 'plan', plan }, expires: Date.now() + CONFIRM_TTL_MS });
        await ctx.reply(`${summarizePlan(plan)}\n\nBalas .habit yes dalam 60 detik untuk melanjutkan, atau .habit no untuk membatalkan.`);
        return;
      }
    }
  } catch (error) {
    log.warn('habit ai failed: %s', error instanceof AiError ? error.kind : 'unexpected');
    await ctx.reply(friendlyAiError(error));
  } finally {
    inFlight.delete(jid);
  }
}

const HELP_TEXT = [
  '🔥 Habit Tracker',
  '',
  '.habit add <nama> [--freq daily|weekly] [--remind 07:30]',
  '.habit list',
  '.habit done <nama>',
  '.habit stats <nama>',
  '.habit history <nama>',
  '.habit delete <nama>',
  '',
  'Bahasa natural (AI):',
  '.habit Tambahkan membaca buku setiap hari',
  '.habit Analisis konsistensi belajarku',
  '.habit Rekomendasikan jadwal olahraga',
].join('\n');

// Hanya balasan konfirmasi persis (.habit yes/no/ya/tidak) yang dibebaskan dari cooldown.
export function isConfirmMessage(ctx: DispatchContext): boolean {
  const text = extractHabitText(ctx).toLowerCase();
  return text === 'yes' || text === 'ya' || text === 'no' || text === 'tidak';
}

export async function handleHabit(ctx: DispatchContext): Promise<void> {
  const text = extractHabitText(ctx);
  if (!text) {
    await ctx.reply(HELP_TEXT);
    return;
  }
  const tokens = text.split(/\s+/);
  const sub = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  switch (sub) {
    case 'add':
    case 'tambah':
      return handleAdd(ctx, rest);
    case 'list':
    case 'ls':
      return handleList(ctx);
    case 'done':
    case 'selesai':
      return handleDone(ctx, rest);
    case 'stats':
    case 'statistik':
      return handleStats(ctx, rest);
    case 'history':
    case 'riwayat':
      return handleHistory(ctx, rest);
    case 'delete':
    case 'del':
    case 'hapus':
      return handleDelete(ctx, rest);
    case 'yes':
    case 'ya':
      return handleConfirm(ctx, true);
    case 'no':
    case 'tidak':
      return handleConfirm(ctx, false);
    case 'help':
    case 'bantuan':
      await ctx.reply(HELP_TEXT);
      return;
    default:
      return handleNatural(ctx, text);
  }
}

// ---- Reminder otomatis ----
export type HabitSender = (jid: string, text: string) => Promise<void>;
let sendHabitMessage: HabitSender | null = null;
let reminderTimer: NodeJS.Timeout | null = null;
let reminding = false;

export function setHabitSender(sender: HabitSender | null): void {
  sendHabitMessage = sender;
}

export async function checkHabitReminders(now: number = nowUnix(), tz: string = TZ): Promise<void> {
  if (reminding || !sendHabitMessage) return;
  reminding = true;
  try {
    const nowTime = localTime(now, tz);
    for (const h of habitRepo.listWithReminder()) {
      if (!h.reminder_time || nowTime < h.reminder_time) continue;
      const key = periodKey(now, h.frequency, tz);
      if (h.last_reminded_period === key || habitRepo.hasLog(h.id, key)) continue;
      try {
        await sendHabitMessage(h.user_jid, `⏰ Pengingat habit: ${h.name}\nBalas .habit done ${h.name} bila sudah selesai.`);
        habitRepo.markReminded(h.id, key);
      } catch (error) {
        log.warn('failed to deliver habit reminder %d, will retry: %s', h.id, error instanceof Error ? error.message : 'unknown');
      }
    }
    // ponytail: bersihkan konfirmasi kedaluwarsa untuk mencegah memory leak
    if (pendingConfirm.size > 0) {
      const nowMs = Date.now();
      for (const [jid, pending] of pendingConfirm) {
        if (nowMs > pending.expires) pendingConfirm.delete(jid);
      }
    }
  } catch (error) {
    log.error(error, 'failed to check habit reminders');
  } finally {
    reminding = false;
  }
}

export async function setup(): Promise<Command[]> {
  if (!reminderTimer) {
    reminderTimer = setInterval(() => void checkHabitReminders(), 60000);
  }
  return [
    {
      name: 'habit',
      aliases: ['kebiasaan'],
      description: 'Habit tracker (add, list, done, stats, history, delete) atau pakai bahasa natural',
      handler: handleHabit,
      cooldownExempt: isConfirmMessage,
    },
  ];
}

export function teardown(): void {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }
  inFlight.clear();
  pendingConfirm.clear();
}
