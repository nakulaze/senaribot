import { watch } from 'fs';
import { childLogger } from '@/utils/logger.js';

const log = childLogger('registry');

export interface Command {
  name: string;
  aliases: string[];
  description: string;
  handler: (ctx: any) => Promise<void>;
  middlewares?: string[];
  /** Jika mengembalikan true, cooldown dilewati untuk pesan ini (ACL tetap berlaku). */
  cooldownExempt?: (ctx: any) => boolean;
}

export class PluginRegistry {
  private commands: Map<string, Command> = new Map();
  private watchers: Map<string, any> = new Map();
  private moduleCache: Map<string, any> = new Map();

  async loadPlugin(modulePath: string, moduleName: string): Promise<void> {
    try {
      delete require.cache[require.resolve(modulePath)];

      const module = await import(`file://${modulePath}?t=${Date.now()}`);
      const plugin = module.default || module;

      if (!plugin || typeof plugin.setup !== 'function') {
        log.warn('plugin %s does not export setup function', moduleName);
        return;
      }

      const commands = await plugin.setup();
      if (!Array.isArray(commands)) {
        log.warn('plugin %s setup did not return array of commands', moduleName);
        return;
      }

      for (const cmd of commands) {
        this.registerCommand(cmd);
      }

      this.moduleCache.set(moduleName, module);
      log.info('plugin %s loaded with %d commands', moduleName, commands.length);
    } catch (error) {
      log.error(error, 'failed to load plugin %s', moduleName);
      throw error;
    }
  }

  registerCommand(cmd: Command): void {
    if (!cmd.name || typeof cmd.handler !== 'function') {
      log.warn('invalid command structure', cmd);
      return;
    }

    const keys = [cmd.name, ...(cmd.aliases ?? [])];
    for (const key of keys) {
      const existing = this.commands.get(key);
      if (existing && existing.name !== cmd.name) {
        log.warn('command/alias \'%s\' of \'%s\' overrides the one from \'%s\'', key, cmd.name, existing.name);
      }
      this.commands.set(key, cmd);
    }

    log.debug('registered command %s with aliases %s', cmd.name, cmd.aliases?.join(', ') || 'none');
  }

  getCommand(name: string): Command | undefined {
    return this.commands.get(name);
  }

  getAllCommands(): Command[] {
    const seen = new Set<string>();
    const result: Command[] = [];

    for (const cmd of this.commands.values()) {
      if (!seen.has(cmd.name)) {
        seen.add(cmd.name);
        result.push(cmd);
      }
    }

    return result;
  }

  watchPlugin(modulePath: string, moduleName: string, onReload?: () => void): void {
    const watcher = watch(modulePath, async () => {
      try {
        await this.loadPlugin(modulePath, moduleName);
        log.info('plugin %s reloaded', moduleName);
        onReload?.();
      } catch (error) {
        log.error(error, 'failed to reload plugin %s', moduleName);
      }
    });

    this.watchers.set(moduleName, watcher);
  }

  unwatch(moduleName: string): void {
    const watcher = this.watchers.get(moduleName);
    if (watcher) {
      watcher.close();
      this.watchers.delete(moduleName);
    }
  }

  unwatchAll(): void {
    for (const [name] of this.watchers) {
      this.unwatch(name);
    }
  }
}

export const registry = new PluginRegistry();
