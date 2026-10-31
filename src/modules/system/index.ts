import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { childLogger } from '@/utils/logger.js';
import { getConfig } from '@/config/env.js';
import { BaileysSocket } from '@/core/socket.js';
import { performance } from 'perf_hooks';

const log = childLogger('modules/system');

export function setScoketRef(_sock: BaileysSocket): void {
  // socket reference stored internally
}

async function handleStatus(ctx: DispatchContext): Promise<void> {
  try {
    const config = getConfig();
    const uptime = Math.floor(process.uptime());
    const memUsage = process.memoryUsage();

    const statusInfo = `
STATUS REPORT
Uptime: ${formatUptime(uptime)}
Memory: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB
Node Env: ${config.NODE_ENV}
Log Level: ${config.SENARIBOT_LOG_LEVEL}
Prefix: ${config.SENARIBOT_PREFIX}
    `.trim();

    await ctx.reply(statusInfo);
  } catch (error) {
    log.error(error, 'failed to get status');
    await ctx.reply('Failed to get status.');
  }
}

async function handleHelp(ctx: DispatchContext): Promise<void> {
  const helpText = `
SENARIBOT COMMANDS

Ledger (Expense Tracking)
.spend <amount> <category> - Record expense
.summary [month] - Monthly summary
.expenses [category] - List expenses

Reminders
.remind <time> <title> - Set reminder
.reminders - List reminders
.cancel <id> - Cancel reminder

Vault (Notes)
.save <tags> | <content> - Save note
.search <query> - Search notes
.vault - List notes
.get <id> - Get note
.delete <id> - Delete note

AI Assistant
.ask <question> - Ask the AI (alias: .ai)
.resetai - Reset AI conversation history

AI Summarizer
.summarize [short|detailed|bullets|executive] <text> - Summarize text (alias: .sum)
(reply or caption a PDF/TXT with .summarize to summarize a document)

Habit Tracker
.habit add <name> [--freq daily|weekly] [--remind 07:30] - Add habit
.habit list|done|stats|history|delete <name> - Manage habits (alias: .kebiasaan)
.habit <natural language> - AI: add, analyze, recommend

System
.status - Show system status
.help - Show this help
  `.trim();

  await ctx.reply(helpText);
}

async function handlePing(ctx: DispatchContext): Promise<void> {
  const start = performance.now();
  await ctx.reply('Pong');
  const latency = Math.round(performance.now() - start);
  log.debug('ping latency: %dms', latency);
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export async function setup(): Promise<Command[]> {
  return [
    {
      name: 'status',
      aliases: ['stat', 'info'],
      description: 'Show system status',
      handler: handleStatus,
    },
    {
      name: 'help',
      aliases: ['h', 'commands'],
      description: 'Show help',
      handler: handleHelp,
    },
    {
      name: 'ping',
      aliases: ['p'],
      description: 'Ping bot',
      handler: handlePing,
    },
  ];
}
