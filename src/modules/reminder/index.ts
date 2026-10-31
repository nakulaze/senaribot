import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { ReminderRepository } from '@/database/repositories/reminder.repo.js';
import { parseTimeExpression } from '@/utils/parser.js';
import { childLogger } from '@/utils/logger.js';

const log = childLogger('modules/reminder');
const reminderRepo = new ReminderRepository();

let reminderCheckInterval: NodeJS.Timeout | null = null;
let checking = false;

export type ReminderSender = (jid: string, text: string) => Promise<void>;
let sendReminderMessage: ReminderSender | null = null;

// Dipasang dari bootstrap setelah socket dibuat, agar reminder benar-benar terkirim ke WhatsApp.
export function setReminderSender(sender: ReminderSender | null): void {
  sendReminderMessage = sender;
}

async function handleSet(ctx: DispatchContext): Promise<void> {
  const args = ctx.command?.args || [];
  if (args.length < 2) {
    await ctx.reply('Usage: .remind <time> <title> [recurrence]');
    return;
  }

  const timeExpr = args[0];
  const title = args.slice(1).join(' ');

  const parsed = parseTimeExpression(timeExpr);
  if (!parsed) {
    await ctx.reply('Could not parse time. Try: "tomorrow 9am", "in 2 hours", "next Monday"');
    return;
  }

  try {
    const reminder = reminderRepo.insertReminder({
      user_jid: ctx.sender,
      title,
      description: null,
      trigger_time: parsed.unix,
      state: 'pending',
      recurrence: null,
    });

    await ctx.reply(`Reminder set for ${parsed.relative}: "${title}"`);
    log.info('reminder created: %s', reminder.id);
  } catch (error) {
    log.error(error, 'failed to create reminder');
    await ctx.reply('Failed to set reminder.');
  }
}

async function handleList(ctx: DispatchContext): Promise<void> {
  try {
    const reminders = reminderRepo.getRemindersByUser(ctx.sender);

    if (reminders.length === 0) {
      await ctx.reply('No reminders set.');
      return;
    }

    let text = `Your reminders (${reminders.length}):\n\n`;

    for (const reminder of reminders) {
      const date = new Date(reminder.trigger_time * 1000).toLocaleString('id-ID');
      const status = reminder.state === 'pending' ? '⏰' : reminder.state === 'sent' ? '✓' : '❌';
      text += `${status} ${date} | ${reminder.title} (${reminder.id.slice(0, 8)})\n`;
    }

    await ctx.reply(text);
  } catch (error) {
    log.error(error, 'failed to list reminders');
    await ctx.reply('Failed to list reminders.');
  }
}

async function handleCancel(ctx: DispatchContext): Promise<void> {
  const args = ctx.command?.args || [];
  if (args.length === 0) {
    await ctx.reply('Usage: .cancel <reminder-id>');
    return;
  }

  const reminderId = args[0];

  try {
    const reminder = reminderRepo.getById(reminderId);
    if (!reminder) {
      await ctx.reply('Reminder not found.');
      return;
    }

    if (reminder.user_jid !== ctx.sender) {
      await ctx.reply('Cannot cancel reminder created by someone else.');
      return;
    }

    reminderRepo.updateState(reminderId, 'cancelled');
    await ctx.reply(`Reminder cancelled: "${reminder.title}"`);
  } catch (error) {
    log.error(error, 'failed to cancel reminder');
    await ctx.reply('Failed to cancel reminder.');
  }
}

export async function checkAndSendReminders(): Promise<void> {
  // Cegah siklus tumpang tindih dan jangan menandai terkirim bila pengirim belum tersedia.
  if (checking || !sendReminderMessage) return;
  checking = true;
  try {
    const pending = reminderRepo.getPendingReminders();

    for (const reminder of pending) {
      try {
        await sendReminderMessage(reminder.user_jid, `⏰ Pengingat: ${reminder.title}`);
        reminderRepo.updateState(reminder.id, 'sent');
        log.info('reminder sent: %s to %s', reminder.id, reminder.user_jid);
      } catch (error) {
        // Tetap 'pending' agar dicoba lagi pada siklus berikutnya.
        log.warn('failed to deliver reminder %s, will retry: %s', reminder.id, error instanceof Error ? error.message : 'unknown');
      }
    }
  } catch (error) {
    log.error(error, 'failed to check reminders');
  } finally {
    checking = false;
  }
}

export async function setup(): Promise<Command[]> {
  if (!reminderCheckInterval) {
    reminderCheckInterval = setInterval(checkAndSendReminders, 30000);
  }

  return [
    {
      name: 'remind',
      aliases: ['r', 'reminder'],
      description: 'Set a reminder',
      handler: handleSet,
    },
    {
      name: 'reminders',
      aliases: ['rlist', 'remindlist'],
      description: 'List all reminders',
      handler: handleList,
    },
    {
      name: 'cancel',
      aliases: ['deletereminder'],
      description: 'Cancel a reminder',
      handler: handleCancel,
    },
  ];
}

export function teardown(): void {
  if (reminderCheckInterval) {
    clearInterval(reminderCheckInterval);
    reminderCheckInterval = null;
  }
}
