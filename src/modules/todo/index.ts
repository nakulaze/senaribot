import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { TodoRepository, TodoTask, TodoPriority } from '@/database/repositories/todo.repo.js';
import { ReminderRepository } from '@/database/repositories/reminder.repo.js';
import { aiService, AiError } from '@/core/ai-service.js';
import { splitMessage } from '@/modules/ai/index.js';
import { getConfig } from '@/config/env.js';
import { childLogger } from '@/utils/logger.js';
import { parseTodoArgs, parsePriority } from './args.js';
import { parseDeadline } from './date.js';
import { formatList, formatStats, formatTask } from './format.js';
import { buildSystemPrompt, parseAiPlan, AiPlan } from './nl.js';

const log = childLogger('todo');
const config = getConfig();
const todoRepo = new TodoRepository();

// Dibuat lazy: ReminderRepository memanggil getDatabase() di konstruktor.
let reminderRepoInstance: ReminderRepository | null = null;
function reminders(): ReminderRepository {
  if (!reminderRepoInstance) reminderRepoInstance = new ReminderRepository();
  return reminderRepoInstance;
}

// Integrasi Reminders yang sudah ada (tanpa sistem reminder kedua).
export function createReminder(jid: string, title: string, deadline: number): string | null {
  try {
    return reminders().insertReminder({
      user_jid: jid,
      title: `Todo: ${title}`,
      description: null,
      trigger_time: deadline,
      state: 'pending',
      recurrence: null,
    }).id;
  } catch (error) {
    log.error(error, 'failed to create reminder for todo');
    return null;
  }
}

export function cancelReminder(reminderId: string | null): void {
  if (!reminderId) return;
  try {
    const r = reminders().getById(reminderId);
    if (r && (r.state === 'pending' || r.state === 'snoozed')) {
      reminders().updateState(reminderId, 'cancelled');
    }
  } catch (error) {
    log.error(error, 'failed to cancel reminder for todo');
  }
}

const CONFIRM_TTL_MS = 60000;
const MAX_INPUT_CHARS = 1000;
const inFlight = new Set<string>();

type PendingAction =
  | { kind: 'clear'; scope: 'all' | 'done' }
  | { kind: 'plan'; plan: AiPlan; summary: string };

const pendingConfirm = new Map<string, { action: PendingAction; expires: number }>();

export function extractTodoText(ctx: DispatchContext): string {
  const raw = ctx.command?.raw ?? '';
  return raw.slice(config.SENARIBOT_PREFIX.length).trim().replace(/^\S+\s*/, '').trim();
}

export function parseId(value: string | undefined): number | null {
  if (!value || !/^#?\d+$/.test(value)) return null;
  const n = Number(value.replace('#', ''));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function handleAdd(ctx: DispatchContext, tokens: string[]): Promise<void> {
  const jid = ctx.sender;
  const parsed = parseTodoArgs(tokens);
  if (!parsed.title) {
    await ctx.reply('Tulis tugasnya.\nContoh: .todo add Belajar Python --cat Kuliah --prio high --due besok jam 7 malam');
    return;
  }
  if (parsed.errors.length > 0) {
    await ctx.reply(parsed.errors.join('\n'));
    return;
  }

  let deadline: number | null = null;
  if (parsed.dueText) {
    const d = parseDeadline(parsed.dueText);
    if (!d) {
      await ctx.reply(`Deadline "${parsed.dueText}" tidak bisa dipahami. Contoh: besok jam 7 malam, 2026-11-05, minggu depan.`);
      return;
    }
    if (d.unix <= Math.floor(Date.now() / 1000)) {
      await ctx.reply('Deadline sudah lewat. Pilih waktu di masa depan.');
      return;
    }
    deadline = d.unix;
  }

  const task = todoRepo.insert({
    user_jid: jid,
    title: parsed.title,
    category: parsed.category ?? null,
    priority: parsed.priority ?? 'medium',
    deadline,
  });

  if (deadline) {
    const reminderId = createReminder(jid, task.title, deadline);
    if (reminderId) todoRepo.update(jid, task.id, { reminder_id: reminderId });
  }

  await ctx.reply(`Tugas ditambahkan:\n${formatTask(todoRepo.getById(jid, task.id) as TodoTask)}`);
}

// Daftar panjang dipecah agar tidak melewati batas pesan WhatsApp.
export async function replyLong(ctx: DispatchContext, text: string): Promise<void> {
  for (const part of splitMessage(text)) {
    await ctx.reply(part);
  }
}

export async function handleList(ctx: DispatchContext, tokens: string[]): Promise<void> {
  const filter: { status?: 'pending' | 'done'; category?: string; priority?: TodoPriority } = {};
  let title = 'Daftar Tugas';
  const first = tokens[0]?.toLowerCase();
  if (first === 'done' || first === 'selesai') {
    filter.status = 'done';
    title = 'Tugas Selesai';
  } else if (first === 'pending' || first === 'belum') {
    filter.status = 'pending';
    title = 'Tugas Belum Selesai';
  } else if (first) {
    const prio = parsePriority(first);
    if (prio) {
      filter.priority = prio;
      title = `Tugas Prioritas ${prio}`;
    } else {
      filter.category = tokens.join(' ');
      title = `Tugas Kategori ${filter.category}`;
    }
  }
  await replyLong(ctx, formatList(todoRepo.list(ctx.sender, filter), title));
}

export async function handleDone(ctx: DispatchContext, tokens: string[]): Promise<void> {
  const id = parseId(tokens[0]);
  if (!id) {
    await ctx.reply('Usage: .todo done <id>');
    return;
  }
  const task = todoRepo.getById(ctx.sender, id);
  if (!task) {
    await ctx.reply(`Tugas #${id} tidak ditemukan.`);
    return;
  }
  if (task.status === 'done') {
    await ctx.reply(`Tugas #${id} sudah selesai.`);
    return;
  }
  todoRepo.setStatus(ctx.sender, id, 'done');
  cancelReminder(task.reminder_id);
  await ctx.reply(`Selesai: #${id} ${task.title}`);
}

export async function handleDelete(ctx: DispatchContext, tokens: string[]): Promise<void> {
  const id = parseId(tokens[0]);
  if (!id) {
    await ctx.reply('Usage: .todo delete <id>');
    return;
  }
  const task = todoRepo.getById(ctx.sender, id);
  if (!task) {
    await ctx.reply(`Tugas #${id} tidak ditemukan.`);
    return;
  }
  todoRepo.remove(ctx.sender, id);
  cancelReminder(task.reminder_id);
  await ctx.reply(`Tugas dihapus: #${id} ${task.title}`);
}

export async function handleEdit(ctx: DispatchContext, tokens: string[]): Promise<void> {
  const jid = ctx.sender;
  const id = parseId(tokens[0]);
  if (!id) {
    await ctx.reply('Usage: .todo edit <id> <tugas baru> [--cat X] [--prio high] [--due besok]');
    return;
  }
  const task = todoRepo.getById(jid, id);
  if (!task) {
    await ctx.reply(`Tugas #${id} tidak ditemukan.`);
    return;
  }
  const parsed = parseTodoArgs(tokens.slice(1));
  if (parsed.errors.length > 0) {
    await ctx.reply(parsed.errors.join('\n'));
    return;
  }
  if (!parsed.title && !parsed.category && !parsed.priority && !parsed.dueText) {
    await ctx.reply('Tidak ada perubahan. Tulis judul baru atau gunakan --cat, --prio, --due.');
    return;
  }

  const changes: { title?: string; category?: string; priority?: TodoPriority; deadline?: number } = {};
  if (parsed.title) changes.title = parsed.title;
  if (parsed.category) changes.category = parsed.category;
  if (parsed.priority) changes.priority = parsed.priority;

  let newDeadline: number | undefined;
  if (parsed.dueText) {
    const d = parseDeadline(parsed.dueText);
    if (!d) {
      await ctx.reply(`Deadline "${parsed.dueText}" tidak bisa dipahami.`);
      return;
    }
    if (d.unix <= Math.floor(Date.now() / 1000)) {
      await ctx.reply('Deadline sudah lewat. Pilih waktu di masa depan.');
      return;
    }
    newDeadline = d.unix;
    changes.deadline = d.unix;
  }

  todoRepo.update(jid, id, changes);

  if (task.status === 'pending' && (newDeadline !== undefined || changes.title)) {
    const deadline = newDeadline ?? task.deadline;
    if (deadline) {
      cancelReminder(task.reminder_id);
      const reminderId =
        deadline > Math.floor(Date.now() / 1000) ? createReminder(jid, changes.title ?? task.title, deadline) : null;
      todoRepo.update(jid, id, { reminder_id: reminderId });
    }
  }

  await ctx.reply(`Tugas diperbarui:\n${formatTask(todoRepo.getById(jid, id) as TodoTask)}`);
}

export async function handleStats(ctx: DispatchContext): Promise<void> {
  await ctx.reply(formatStats(todoRepo.stats(ctx.sender)));
}

export async function handleClear(ctx: DispatchContext, tokens: string[]): Promise<void> {
  const jid = ctx.sender;
  const scope = tokens[0]?.toLowerCase() === 'done' || tokens[0]?.toLowerCase() === 'selesai' ? 'done' : 'all';
  const count = todoRepo.list(jid, scope === 'done' ? { status: 'done' } : {}).length;
  if (count === 0) {
    await ctx.reply('Tidak ada tugas yang perlu dihapus.');
    return;
  }
  pendingConfirm.set(jid, { action: { kind: 'clear', scope }, expires: Date.now() + CONFIRM_TTL_MS });
  await ctx.reply(
    `Anda akan menghapus ${count} tugas${scope === 'done' ? ' yang sudah selesai' : ' (SEMUA)'}.\nBalas .todo yes dalam 60 detik untuk melanjutkan, atau .todo no untuk membatalkan.`,
  );
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
  if (action.kind === 'clear') {
    const status = action.scope === 'done' ? 'done' : undefined;
    const targets = todoRepo.list(jid, status ? { status } : {});
    for (const t of targets) cancelReminder(t.reminder_id);
    const removed = todoRepo.removeAll(jid, status);
    await ctx.reply(`${removed} tugas dihapus.`);
    return;
  }

  const lines = await executePlan(jid, action.plan);
  await ctx.reply(lines.join('\n'));
}

export async function executePlan(jid: string, plan: AiPlan): Promise<string[]> {
  const out: string[] = [];
  const nowUnix = Math.floor(Date.now() / 1000);

  switch (plan.action) {
    case 'add': {
      let deadline: number | null = null;
      if (plan.deadline) {
        const d = parseDeadline(plan.deadline);
        if (!d) return [`Deadline "${plan.deadline}" tidak bisa dipahami. Tugas tidak ditambahkan.`];
        if (d.unix <= nowUnix) return ['Deadline sudah lewat. Tugas tidak ditambahkan.'];
        deadline = d.unix;
      }
      const task = todoRepo.insert({
        user_jid: jid,
        title: plan.title,
        category: plan.category ?? null,
        priority: plan.priority ?? 'medium',
        deadline,
      });
      if (deadline) {
        const reminderId = createReminder(jid, task.title, deadline);
        if (reminderId) todoRepo.update(jid, task.id, { reminder_id: reminderId });
      }
      out.push('Tugas ditambahkan:');
      out.push(formatTask(todoRepo.getById(jid, task.id) as TodoTask));
      return out;
    }

    case 'done': {
      for (const id of plan.ids) {
        const t = todoRepo.getById(jid, id);
        if (!t) {
          out.push(`Tugas #${id} tidak ditemukan.`);
        } else if (t.status === 'done') {
          out.push(`Tugas #${id} sudah selesai.`);
        } else {
          todoRepo.setStatus(jid, id, 'done');
          cancelReminder(t.reminder_id);
          out.push(`Selesai: #${id} ${t.title}`);
        }
      }
      return out;
    }

    case 'delete': {
      for (const id of plan.ids) {
        const t = todoRepo.getById(jid, id);
        if (!t) {
          out.push(`Tugas #${id} tidak ditemukan.`);
        } else {
          todoRepo.remove(jid, id);
          cancelReminder(t.reminder_id);
          out.push(`Dihapus: #${id} ${t.title}`);
        }
      }
      return out;
    }

    case 'edit': {
      const t = todoRepo.getById(jid, plan.id);
      if (!t) return [`Tugas #${plan.id} tidak ditemukan.`];
      const changes: { title?: string; category?: string; priority?: TodoPriority; deadline?: number } = {};
      if (plan.title) changes.title = plan.title;
      if (plan.category) changes.category = plan.category;
      if (plan.priority) changes.priority = plan.priority;
      let newDeadline: number | undefined;
      if (plan.deadline) {
        const d = parseDeadline(plan.deadline);
        if (!d || d.unix <= nowUnix) return ['Deadline tidak valid atau sudah lewat. Tidak ada perubahan.'];
        newDeadline = d.unix;
        changes.deadline = d.unix;
      }
      if (Object.keys(changes).length === 0) return ['Tidak ada perubahan.'];
      todoRepo.update(jid, plan.id, changes);
      if (t.status === 'pending' && (newDeadline !== undefined || changes.title)) {
        const deadline = newDeadline ?? t.deadline;
        if (deadline) {
          cancelReminder(t.reminder_id);
          const reminderId = deadline > nowUnix ? createReminder(jid, changes.title ?? t.title, deadline) : null;
          todoRepo.update(jid, plan.id, { reminder_id: reminderId });
        }
      }
      out.push('Tugas diperbarui:');
      out.push(formatTask(todoRepo.getById(jid, plan.id) as TodoTask));
      return out;
    }

    case 'prioritize': {
      for (const item of plan.items) {
        const t = todoRepo.getById(jid, item.id);
        if (!t || t.status === 'done') continue;
        todoRepo.update(jid, item.id, { priority: item.priority });
        out.push(`#${item.id} ${t.title} -> ${item.priority}`);
      }
      return out.length > 0 ? ['Prioritas diperbarui:', ...out] : ['Tidak ada tugas yang diubah.'];
    }

    default:
      return ['Aksi tidak dikenali.'];
  }
}

export function needsConfirmation(plan: AiPlan): boolean {
  if (plan.action === 'delete') return true;
  if (plan.action === 'done') return plan.ids.length > 1;
  if (plan.action === 'prioritize') return plan.items.length > 1;
  return false;
}

export function summarizePlan(jid: string, plan: AiPlan): string {
  const name = (id: number) => todoRepo.getById(jid, id)?.title ?? '(tidak ditemukan)';
  if (plan.action === 'delete') return `Hapus ${plan.ids.length} tugas:\n` + plan.ids.map((id) => `- #${id} ${name(id)}`).join('\n');
  if (plan.action === 'done') return `Tandai selesai ${plan.ids.length} tugas:\n` + plan.ids.map((id) => `- #${id} ${name(id)}`).join('\n');
  if (plan.action === 'prioritize') return `Ubah prioritas ${plan.items.length} tugas:\n` + plan.items.map((i) => `- #${i.id} ${name(i.id)} -> ${i.priority}`).join('\n');
  return 'Perubahan tugas';
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

export async function handleNatural(ctx: DispatchContext, text: string): Promise<void> {
  const jid = ctx.sender;

  if (text.length > MAX_INPUT_CHARS) {
    await ctx.reply(`Teks terlalu panjang (${text.length} karakter). Maksimal ${MAX_INPUT_CHARS} karakter.`);
    return;
  }
  if (!aiService.isConfigured()) {
    await ctx.reply('Perintah tidak dikenali dan fitur AI belum dikonfigurasi.\nGunakan: .todo add|list|done|delete|edit|clear|stats');
    return;
  }
  if (inFlight.has(jid)) {
    await ctx.reply('Permintaan todo sebelumnya masih diproses. Mohon tunggu.');
    return;
  }

  inFlight.add(jid);
  try {
    const tasks = todoRepo.list(jid).slice(0, 100).map((t) => ({
      id: t.id,
      title: t.title,
      category: t.category,
      priority: t.priority,
      status: t.status,
      deadline: t.deadline ? new Date(t.deadline * 1000).toISOString() : null,
    }));

    const raw = await aiService.chat([{ role: 'user', content: text }], {
      systemPrompt: buildSystemPrompt(new Date(), JSON.stringify(tasks)),
      temperature: 0,
      maxTokens: 600,
    });

    const plan = parseAiPlan(raw);
    if (!plan) {
      await ctx.reply('Saya tidak bisa memahami instruksi itu. Coba gunakan command biasa, misalnya .todo add <tugas>.');
      return;
    }
    if (plan.action === 'unknown') {
      await ctx.reply(plan.message || 'Saya tidak yakin maksud Anda. Coba tulis ulang instruksinya.');
      return;
    }
    if (plan.action === 'list') {
      const list = todoRepo.list(jid, {
        status: plan.status ?? undefined,
        category: plan.category || undefined,
        priority: plan.priority ?? undefined,
      });
      await replyLong(ctx, formatList(list, 'Hasil'));
      return;
    }

    if (needsConfirmation(plan)) {
      const summary = summarizePlan(jid, plan);
      pendingConfirm.set(jid, { action: { kind: 'plan', plan, summary }, expires: Date.now() + CONFIRM_TTL_MS });
      await ctx.reply(`${summary}\n\nBalas .todo yes dalam 60 detik untuk melanjutkan, atau .todo no untuk membatalkan.`);
      return;
    }

    await ctx.reply((await executePlan(jid, plan)).join('\n'));
  } catch (error) {
    log.warn('todo ai failed: %s', error instanceof AiError ? error.kind : 'unexpected');
    await ctx.reply(friendlyAiError(error));
  } finally {
    inFlight.delete(jid);
  }
}

const HELP_TEXT = [
  '📝 Todo List',
  '',
  '.todo add <tugas> [--cat X] [--prio low|medium|high] [--due besok jam 7 malam]',
  '.todo list [pending|done|<kategori>|<prioritas>]',
  '.todo done <id>',
  '.todo delete <id>',
  '.todo edit <id> <tugas baru> [--cat X] [--prio high] [--due ...]',
  '.todo clear [done]',
  '.todo stats',
  '',
  'Bahasa natural (AI):',
  '.todo Belajar Python besok jam 7 malam',
  '.todo Apa saja tugas yang belum selesai?',
  '.todo Prioritaskan tugasku hari ini',
].join('\n');

// Hanya balasan konfirmasi persis (.todo yes/no/ya/tidak) yang dibebaskan dari cooldown.
export function isConfirmMessage(ctx: DispatchContext): boolean {
  const text = extractTodoText(ctx).toLowerCase();
  return text === 'yes' || text === 'ya' || text === 'no' || text === 'tidak';
}

export async function handleTodo(ctx: DispatchContext): Promise<void> {
  const text = extractTodoText(ctx);
  if (!text) {
    await ctx.reply(HELP_TEXT);
    return;
  }

  const tokens = text.split(/\s+/);
  const sub = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  // Kata seperti "hapus", "selesai", "ubah" juga awalan kalimat natural.
  // Tanpa id, teks diperlakukan sebagai instruksi bahasa natural.
  if ((sub === 'hapus' || sub === 'selesai' || sub === 'ubah') && !parseId(rest[0])) {
    return handleNatural(ctx, text);
  }

  switch (sub) {
    case 'add':
    case 'tambah':
      return handleAdd(ctx, rest);
    case 'list':
    case 'ls':
      return handleList(ctx, rest);
    case 'done':
    case 'selesai':
      return handleDone(ctx, rest);
    case 'delete':
    case 'del':
    case 'hapus':
      return handleDelete(ctx, rest);
    case 'edit':
    case 'ubah':
      return handleEdit(ctx, rest);
    case 'clear':
      return handleClear(ctx, rest);
    case 'stats':
    case 'statistik':
      return handleStats(ctx);
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

export async function setup(): Promise<Command[]> {
  return [
    {
      name: 'todo',
      aliases: ['tugas'],
      description: 'Kelola todo list (add, list, done, delete, edit, clear, stats) atau pakai bahasa natural',
      handler: handleTodo,
      cooldownExempt: isConfirmMessage,
    },
  ];
}

export function teardown(): void {
  inFlight.clear();
  pendingConfirm.clear();
}
