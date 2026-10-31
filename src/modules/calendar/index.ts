import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { getDatabase } from '@/database/connection.js';
import { getConfig } from '@/config/env.js';

const config = getConfig();

export interface CalendarEvent {
  id: number;
  user_jid: string;
  title: string;
  description: string | null;
  location: string | null;
  start_time: number;
  end_time: number | null;
  reminder_minutes: number | null;
  reminder_id: string | null;
  created_at: number;
  updated_at: number;
}

interface EventInput {
  title: string;
  description?: string;
  location?: string;
  start_time: number;
  end_time?: number;
  reminder_minutes?: number;
}

function parseDateTime(dateStr: string, timeStr?: string): number | null {
  try {
    const now = new Date();
    
    // Handle relative dates
    if (dateStr.toLowerCase() === 'today') {
      const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (timeStr) {
        const [hours, minutes] = parseTime(timeStr);
        base.setHours(hours, minutes, 0, 0);
      }
      return base.getTime();
    }
    
    if (dateStr.toLowerCase() === 'tomorrow' || dateStr.toLowerCase() === 'besok') {
      const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      if (timeStr) {
        const [hours, minutes] = parseTime(timeStr);
        base.setHours(hours, minutes, 0, 0);
      }
      return base.getTime();
    }
    
    // Parse ISO date or DD/MM/YYYY
    let parsed: Date;
    if (dateStr.includes('/')) {
      const [day, month, year] = dateStr.split('/').map(Number);
      parsed = new Date(year, month - 1, day);
    } else {
      parsed = new Date(dateStr);
    }
    
    if (isNaN(parsed.getTime())) return null;
    
    if (timeStr) {
      const [hours, minutes] = parseTime(timeStr);
      parsed.setHours(hours, minutes, 0, 0);
    }
    
    return parsed.getTime();
  } catch {
    return null;
  }
}

function parseTime(timeStr: string): [number, number] {
  // Parse HH:MM or H:MM or HHpagi/siang/malam
  const match = timeStr.match(/(\d{1,2}):?(\d{2})?/);
  if (!match) return [0, 0];
  
  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  
  // Handle pagi/siang/sore/malam
  if (timeStr.includes('malam') && hours < 12) hours += 12;
  if (timeStr.includes('siang') && hours < 12) hours += 12;
  if (timeStr.includes('sore') && hours < 12) hours += 12;
  
  return [hours, minutes];
}

function formatEventTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('id-ID', {
    timeZone: config.SENARIBOT_TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatEventTimeShort(timestamp: number): string {
  return new Date(timestamp).toLocaleString('id-ID', {
    timeZone: config.SENARIBOT_TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getDayBounds(date: Date): [number, number] {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  return [start.getTime(), end.getTime()];
}

function getWeekBounds(): [number, number] {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  
  const start = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), 0, 0, 0, 0);
  const end = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate(), 23, 59, 59, 999);
  return [start.getTime(), end.getTime()];
}

function checkConflict(db: any, userJid: string, startTime: number, endTime: number | null, excludeId?: number): CalendarEvent | null {
  const query = excludeId
    ? `SELECT * FROM calendar_events WHERE user_jid = ? AND id != ? AND start_time < ? AND (end_time IS NULL OR end_time > ?) ORDER BY start_time LIMIT 1`
    : `SELECT * FROM calendar_events WHERE user_jid = ? AND start_time < ? AND (end_time IS NULL OR end_time > ?) ORDER BY start_time LIMIT 1`;
  
  const checkEnd = endTime || startTime + 3600000; // default 1 hour
  const params = excludeId ? [userJid, excludeId, checkEnd, startTime] : [userJid, checkEnd, startTime];
  
  return db.prepare(query).get(...params) as CalendarEvent | null;
}

function createEvent(db: any, userJid: string, input: EventInput): number {
  const stmt = db.prepare(`
    INSERT INTO calendar_events (user_jid, title, description, location, start_time, end_time, reminder_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  const result = stmt.run(
    userJid,
    input.title,
    input.description || null,
    input.location || null,
    input.start_time,
    input.end_time || null,
    input.reminder_minutes || null,
  );
  
  return result.lastInsertRowid as number;
}

function getEvent(db: any, id: number, userJid: string): CalendarEvent | null {
  const stmt = db.prepare('SELECT * FROM calendar_events WHERE id = ? AND user_jid = ?');
  return stmt.get(id, userJid) as CalendarEvent | null;
}

function getEventsByRange(db: any, userJid: string, startTime: number, endTime: number): CalendarEvent[] {
  const stmt = db.prepare(`
    SELECT * FROM calendar_events 
    WHERE user_jid = ? AND start_time >= ? AND start_time <= ?
    ORDER BY start_time ASC
  `);
  return stmt.all(userJid, startTime, endTime) as CalendarEvent[];
}

function deleteEvent(db: any, id: number, userJid: string): boolean {
  const stmt = db.prepare('DELETE FROM calendar_events WHERE id = ? AND user_jid = ?');
  const result = stmt.run(id, userJid);
  return result.changes > 0;
}

function formatEventList(events: CalendarEvent[]): string {
  if (events.length === 0) {
    return 'Tidak ada agenda.';
  }
  
  const lines = ['📅 Agenda:'];
  lines.push('');
  
  for (const event of events) {
    lines.push(`[${event.id}] ${event.title}`);
    lines.push(`   ${formatEventTimeShort(event.start_time)}`);
    if (event.location) {
      lines.push(`   📍 ${event.location}`);
    }
    lines.push('');
  }
  
  return lines.join('\n');
}

function formatEventDetail(event: CalendarEvent): string {
  const lines = [`📅 ${event.title}`, ''];
  
  lines.push(`Waktu: ${formatEventTime(event.start_time)}`);
  
  if (event.end_time) {
    lines.push(`Selesai: ${formatEventTime(event.end_time)}`);
  }
  
  if (event.location) {
    lines.push(`Lokasi: ${event.location}`);
  }
  
  if (event.description) {
    lines.push('');
    lines.push(`Deskripsi:\n${event.description}`);
  }
  
  if (event.reminder_minutes) {
    lines.push('');
    lines.push(`Pengingat: ${event.reminder_minutes} menit sebelumnya`);
  }
  
  lines.push('');
  lines.push(`ID: ${event.id}`);
  
  return lines.join('\n');
}

async function handleCalendarToday(ctx: DispatchContext): Promise<void> {
  try {
    const db = getDatabase();
    const now = new Date();
    const [startTime, endTime] = getDayBounds(now);
    
    const events = getEventsByRange(db, ctx.sender, startTime, endTime);
    await ctx.reply(formatEventList(events));
  } catch (error) {
    await ctx.reply('Terjadi kesalahan saat mengambil agenda.');
  }
}

async function handleCalendarTomorrow(ctx: DispatchContext): Promise<void> {
  try {
    const db = getDatabase();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const [startTime, endTime] = getDayBounds(tomorrow);
    
    const events = getEventsByRange(db, ctx.sender, startTime, endTime);
    await ctx.reply(formatEventList(events));
  } catch (error) {
    await ctx.reply('Terjadi kesalahan saat mengambil agenda.');
  }
}

async function handleCalendarWeek(ctx: DispatchContext): Promise<void> {
  try {
    const db = getDatabase();
    const [startTime, endTime] = getWeekBounds();
    
    const events = getEventsByRange(db, ctx.sender, startTime, endTime);
    await ctx.reply(formatEventList(events));
  } catch (error) {
    await ctx.reply('Terjadi kesalahan saat mengambil agenda.');
  }
}

async function handleCalendarAdd(ctx: DispatchContext): Promise<void> {
  const text = ctx.command?.raw ?? '';
  const parts = text.slice(config.SENARIBOT_PREFIX.length).trim().split(/\s+/);
  
  // .calendar add <title> <date> <time>
  if (parts.length < 4) {
    await ctx.reply(
      'Usage: .calendar add <judul> <tanggal> <waktu>\n\nContoh:\n.calendar add Meeting 31/10/2026 14:00\n.calendar add Belajar tomorrow 19:00\n.calendar add Olahraga today 07:00',
    );
    return;
  }
  
  const title = parts[2];
  const dateStr = parts[3];
  const timeStr = parts[4];
  
  const startTime = parseDateTime(dateStr, timeStr);
  if (!startTime) {
    await ctx.reply('Format tanggal/waktu tidak valid. Gunakan DD/MM/YYYY dan HH:MM atau "today"/"tomorrow".');
    return;
  }
  
  if (startTime < Date.now()) {
    await ctx.reply('Waktu tidak boleh di masa lalu.');
    return;
  }
  
  try {
    const db = getDatabase();
    
    // Check conflict
    const conflict = checkConflict(db, ctx.sender, startTime, null);
    if (conflict) {
      await ctx.reply(
        `⚠️ Bentrok dengan agenda lain:\n"${conflict.title}" pada ${formatEventTimeShort(conflict.start_time)}\n\nTetap simpan? Ketik: .calendar add! <judul> <tanggal> <waktu>`,
      );
      return;
    }
    
    const input: EventInput = {
      title,
      start_time: startTime,
    };
    
    const id = createEvent(db, ctx.sender, input);
    await ctx.reply(`✅ Agenda ditambahkan dengan ID ${id}:\n${title}\n${formatEventTime(startTime)}`);
  } catch (error) {
    await ctx.reply('Terjadi kesalahan saat menyimpan agenda.');
  }
}

async function handleCalendarDelete(ctx: DispatchContext): Promise<void> {
  const text = ctx.command?.raw ?? '';
  const parts = text.slice(config.SENARIBOT_PREFIX.length).trim().split(/\s+/);
  
  // .calendar delete <id>
  if (parts.length < 3) {
    await ctx.reply('Usage: .calendar delete <id>\n\nContoh: .calendar delete 5');
    return;
  }
  
  const id = parseInt(parts[2], 10);
  if (isNaN(id)) {
    await ctx.reply('ID tidak valid. Gunakan angka.');
    return;
  }
  
  try {
    const db = getDatabase();
    const event = getEvent(db, id, ctx.sender);
    
    if (!event) {
      await ctx.reply('Agenda tidak ditemukan.');
      return;
    }
    
    const deleted = deleteEvent(db, id, ctx.sender);
    if (deleted) {
      await ctx.reply(`✅ Agenda "${event.title}" telah dihapus.`);
    } else {
      await ctx.reply('Gagal menghapus agenda.');
    }
  } catch (error) {
    await ctx.reply('Terjadi kesalahan saat menghapus agenda.');
  }
}

async function handleCalendarDetail(ctx: DispatchContext): Promise<void> {
  const text = ctx.command?.raw ?? '';
  const parts = text.slice(config.SENARIBOT_PREFIX.length).trim().split(/\s+/);
  
  // .calendar detail <id>
  if (parts.length < 3) {
    await ctx.reply('Usage: .calendar detail <id>\n\nContoh: .calendar detail 5');
    return;
  }
  
  const id = parseInt(parts[2], 10);
  if (isNaN(id)) {
    await ctx.reply('ID tidak valid. Gunakan angka.');
    return;
  }
  
  try {
    const db = getDatabase();
    const event = getEvent(db, id, ctx.sender);
    
    if (!event) {
      await ctx.reply('Agenda tidak ditemukan.');
      return;
    }
    
    await ctx.reply(formatEventDetail(event));
  } catch (error) {
    await ctx.reply('Terjadi kesalahan saat mengambil detail agenda.');
  }
}

export async function handleCalendar(ctx: DispatchContext): Promise<void> {
  const text = ctx.command?.raw ?? '';
  const parts = text.slice(config.SENARIBOT_PREFIX.length).trim().split(/\s+/);
  
  if (parts.length < 2) {
    await ctx.reply(
      'Senaribot Calendar\n\nCommands:\n.calendar today\n.calendar tomorrow\n.calendar week\n.calendar add <judul> <tanggal> <waktu>\n.calendar delete <id>\n.calendar detail <id>',
    );
    return;
  }
  
  const subcommand = parts[1].toLowerCase();
  
  switch (subcommand) {
    case 'today':
    case 'hari':
      await handleCalendarToday(ctx);
      break;
    case 'tomorrow':
    case 'besok':
      await handleCalendarTomorrow(ctx);
      break;
    case 'week':
    case 'minggu':
      await handleCalendarWeek(ctx);
      break;
    case 'add':
    case 'tambah':
      await handleCalendarAdd(ctx);
      break;
    case 'delete':
    case 'hapus':
      await handleCalendarDelete(ctx);
      break;
    case 'detail':
      await handleCalendarDetail(ctx);
      break;
    default:
      await ctx.reply('Subcommand tidak dikenal. Gunakan: today, tomorrow, week, add, delete, detail');
  }
}

export async function setup(): Promise<Command[]> {
  return [
    {
      name: 'calendar',
      aliases: ['cal', 'agenda'],
      description: 'Calendar dan schedule manager',
      handler: handleCalendar,
    },
  ];
}

export function teardown(): void {
  // No cleanup needed
}
