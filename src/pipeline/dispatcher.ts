import { MessageContext } from '@/core/serializer.js';
import { registry } from './registry.js';
import { childLogger } from '@/utils/logger.js';
import { getConfig } from '@/config/env.js';

const log = childLogger('dispatcher');
const config = getConfig();

export interface ParsedCommand {
  name: string;
  args: string[];
  raw: string;
}

export interface DispatchContext extends MessageContext {
  command?: ParsedCommand;
  reply: (text: string) => Promise<void>;
}

export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

export class Dispatcher {
  parseCommand(text: string, prefix: string): ParsedCommand | null {
    const trimmed = text.trim();

    if (!trimmed.startsWith(prefix)) {
      return null;
    }

    const withoutPrefix = trimmed.slice(prefix.length).trim();
    const parts = withoutPrefix.split(/\s+/);
    const name = parts[0]?.toLowerCase();

    if (!name) return null;

    return {
      name,
      args: parts.slice(1),
      raw: trimmed,
    };
  }

  async dispatch(ctx: DispatchContext): Promise<void> {
    const cmd = this.parseCommand(ctx.text, config.SENARIBOT_PREFIX);

    if (!cmd) {
      log.debug('no command matched in %s', ctx.id);
      return;
    }

    if (!config.SENARIBOT_OWNER_JIDS.includes(ctx.sender)) {
      log.warn('ignored command from non-owner sender');
      return;
    }

    const command = registry.getCommand(cmd.name);
    if (!command) {
      await ctx.reply(`Command '${cmd.name}' not found. Type '.help' for available commands.`);
      return;
    }

    // Gunakan nama canonical agar alias (.ask/.ai) berbagi cooldown yang sama.
    ctx.command = { ...cmd, name: command.name };

    try {
      await this.applyMiddlewares(ctx, command.middlewares || [], command.cooldownExempt?.(ctx) === true);
      await command.handler(ctx);
    } catch (error) {
      log.error(error, 'error executing command %s', cmd.name);
      const userMessage =
        error instanceof UserFacingError
          ? error.message
          : 'Terjadi kesalahan saat menjalankan command. Silakan coba lagi.';
      try {
        await ctx.reply(userMessage);
      } catch (replyError) {
        log.error(replyError, 'failed to send error reply for command %s', cmd.name);
      }
    }
  }

  private async applyMiddlewares(ctx: DispatchContext, middlewareNames: string[], skipCooldown = false): Promise<void> {
    // ACL dan cooldown selalu aktif (secure by default). Nama di middlewareNames
    // hanya dipakai untuk middleware tambahan di masa depan, bukan untuk menonaktifkan ACL.
    // skipCooldown hanya melewati cooldown (misalnya konfirmasi ya/tidak); ACL tidak pernah dilewati.
    void middlewareNames;
    const middlewares: Array<(ctx: DispatchContext) => Promise<void>> = skipCooldown
      ? [aclMiddleware]
      : [aclMiddleware, cooldownMiddleware];

    for (const mw of middlewares) {
      await mw(ctx);
    }
  }
}

const cooldownMap = new Map<string, number>();
const COOLDOWN_MS = 3000;

async function aclMiddleware(ctx: DispatchContext): Promise<void> {
  const isOwner = config.SENARIBOT_OWNER_JIDS.includes(ctx.sender);

  if (!isOwner) {
    throw new UserFacingError('Anda tidak memiliki izin untuk memakai command ini.');
  }
}

async function cooldownMiddleware(ctx: DispatchContext): Promise<void> {
  const key = `${ctx.sender}:${ctx.command?.name}`;
  const lastRun = cooldownMap.get(key) || 0;
  const now = Date.now();

  if (now - lastRun < COOLDOWN_MS) {
    throw new UserFacingError(`Mohon tunggu ${Math.ceil((COOLDOWN_MS - (now - lastRun)) / 1000)} detik sebelum memakai command ini lagi.`);
  }

  cooldownMap.set(key, now);

  if (cooldownMap.size > 500) {
    for (const [k, t] of cooldownMap) {
      if (now - t >= COOLDOWN_MS) cooldownMap.delete(k);
    }
  }
}

export const dispatcher = new Dispatcher();
