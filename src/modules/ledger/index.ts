import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { LedgerRepository } from '@/database/repositories/ledger.repo.js';
import { parseCurrency, formatCurrency } from '@/utils/parser.js';
import { childLogger } from '@/utils/logger.js';

const log = childLogger('modules/ledger');
const ledgerRepo = new LedgerRepository();

async function handleAdd(ctx: DispatchContext): Promise<void> {
  const args = ctx.command?.args || [];
  if (args.length < 2) {
    await ctx.reply('Usage: .spend <amount> <category> [description]');
    return;
  }

  const amount = parseCurrency(args[0]);
  if (amount === null) {
    await ctx.reply('Invalid amount. Use format: 1000 or 10.50');
    return;
  }

  const category = args[1];
  const description = args.slice(2).join(' ') || `Entry from WhatsApp`;

  try {
    const entry = ledgerRepo.insertEntry({
      amount,
      category,
      description,
      currency: 'IDR',
      entry_date: Math.floor(Date.now() / 1000),
    });

    await ctx.reply(`Added: ${formatCurrency(amount)} to ${category}\n${description}`);
    log.info('ledger entry created: %s', entry.id);
  } catch (error) {
    log.error(error, 'failed to add ledger entry');
    await ctx.reply('Failed to add expense.');
  }
}

async function handleSummary(ctx: DispatchContext): Promise<void> {
  const args = ctx.command?.args || [];
  const now = new Date();

  let year = now.getFullYear();
  let month = now.getMonth() + 1;

  if (args.length > 0) {
    const parsed = parseInt(args[0]);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 12) {
      month = parsed;
    }
  }

  try {
    const summary = ledgerRepo.getSummaryByMonth(year, month);

    if (Object.keys(summary).length === 0) {
      await ctx.reply(`No expenses for ${year}-${String(month).padStart(2, '0')}`);
      return;
    }

    const total = Object.values(summary).reduce((a, b) => a + b, 0);
    let text = `Summary for ${year}-${String(month).padStart(2, '0')}:\n\n`;

    for (const [category, amount] of Object.entries(summary)) {
      const pct = ((amount / total) * 100).toFixed(0);
      text += `${category}: ${formatCurrency(amount)} (${pct}%)\n`;
    }

    text += `\nTotal: ${formatCurrency(total)}`;
    await ctx.reply(text);
  } catch (error) {
    log.error(error, 'failed to generate summary');
    await ctx.reply('Failed to generate summary.');
  }
}

async function handleList(ctx: DispatchContext): Promise<void> {
  const args = ctx.command?.args || [];
  const category = args[0] || 'all';
  const limit = parseInt(args[1]) || 10;

  try {
    let entries;

    if (category === 'all') {
      const now = Math.floor(Date.now() / 1000);
      const startOfMonth = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000);
      entries = ledgerRepo.getByDateRange(startOfMonth, now);
    } else {
      entries = ledgerRepo.getByCategory(category, limit);
    }

    if (entries.length === 0) {
      await ctx.reply(`No entries found for ${category}`);
      return;
    }

    let text = `Recent ${category === 'all' ? 'entries' : category} (${entries.length}):\n\n`;
    for (const entry of entries.slice(0, limit)) {
      const date = new Date(entry.entry_date * 1000).toLocaleDateString('id-ID');
      text += `${date} | ${formatCurrency(entry.amount)} | ${entry.description}\n`;
    }

    await ctx.reply(text);
  } catch (error) {
    log.error(error, 'failed to list entries');
    await ctx.reply('Failed to list entries.');
  }
}

export async function setup(): Promise<Command[]> {
  return [
    {
      name: 'spend',
      aliases: ['s', 'expense'],
      description: 'Record an expense',
      handler: handleAdd,
    },
    {
      name: 'summary',
      aliases: ['ledger', 'monthly'],
      description: 'Show monthly expense summary',
      handler: handleSummary,
    },
    {
      name: 'expenses',
      aliases: ['list', 'exp'],
      description: 'List recent expenses',
      handler: handleList,
    },
  ];
}
