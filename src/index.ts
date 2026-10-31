import 'dotenv/config';
import { getConfig } from '@/config/env.js';
import { initializeDatabase, closeDatabase } from '@/database/connection.js';
import { childLogger } from '@/utils/logger.js';
import { BaileysSocket } from '@/core/socket.js';
import { dispatcher, DispatchContext } from '@/pipeline/dispatcher.js';
import { registry } from '@/pipeline/registry.js';
import { setScoketRef } from '@/modules/system/index.js';
import { scheduleDailyBackup } from '@/core/backup.js';
import * as ledgerModule from '@/modules/ledger/index.js';
import * as reminderModule from '@/modules/reminder/index.js';
import { setReminderSender } from '@/modules/reminder/index.js';
import * as vaultModule from '@/modules/vault/index.js';
import * as mediaModule from '@/modules/media/index.js';
import * as systemModule from '@/modules/system/index.js';
import * as aiModule from '@/modules/ai/index.js';
import * as summarizerModule from '@/modules/summarizer/index.js';
import * as todoModule from '@/modules/todo/index.js';
import * as habitModule from '@/modules/habit/index.js';
import { setHabitSender } from '@/modules/habit/index.js';
import * as websearchModule from '@/modules/websearch/index.js';
import * as weatherModule from '@/modules/weather/index.js';
import * as currencyModule from '@/modules/currency/index.js';
import * as calendarModule from '@/modules/calendar/index.js';
import * as githubModule from '@/modules/github/index.js';
import * as youtubeModule from '@/modules/youtube/index.js';

const log = childLogger('bootstrap');

class Senaribot {
  private socket: BaileysSocket | null = null;
  private config = getConfig();
  private teardowns: Array<{ name: string; fn: () => unknown }> = [];
  private backupTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    try {
      log.info('senaribot starting in %s mode', this.config.NODE_ENV);

      initializeDatabase(this.config.SENARIBOT_DB_PATH);
      log.info('database initialized');

      await this.loadModules();
      log.info('modules loaded: %d commands registered', registry.getAllCommands().length);

      this.socket = new BaileysSocket({
        phoneNumber: this.config.SENARIBOT_PHONE_NUMBER,
        dbPath: this.config.SENARIBOT_DB_PATH,
        ownerJids: this.config.SENARIBOT_OWNER_JIDS,
        onMessage: (ctx: any) => this.handleMessage(ctx),
      });

      this.setupShutdownHandlers();

      setScoketRef(this.socket);
      setReminderSender((jid, text) => this.socket!.sendMessage(jid, text));
      setHabitSender((jid, text) => this.socket!.sendMessage(jid, text));
      await this.socket.connect();

      this.backupTimer = scheduleDailyBackup();
      if (this.backupTimer) {
        log.info('daily backup scheduled');
      }

      log.info('senaribot ready');
    } catch (error) {
      log.fatal(error, 'failed to start senaribot');
      process.exit(1);
    }
  }

  private async loadModules(): Promise<void> {
    const modules = [
      { name: 'ledger', setup: ledgerModule.setup, teardown: (ledgerModule as any).teardown },
      { name: 'reminder', setup: reminderModule.setup, teardown: reminderModule.teardown },
      { name: 'vault', setup: vaultModule.setup, teardown: (vaultModule as any).teardown },
      { name: 'media', setup: mediaModule.setup, teardown: mediaModule.teardown },
      { name: 'system', setup: systemModule.setup, teardown: (systemModule as any).teardown },
      { name: 'ai', setup: aiModule.setup, teardown: aiModule.teardown },
      { name: 'summarizer', setup: summarizerModule.setup, teardown: summarizerModule.teardown },
      { name: 'todo', setup: todoModule.setup, teardown: todoModule.teardown },
      { name: 'habit', setup: habitModule.setup, teardown: habitModule.teardown },
      { name: 'websearch', setup: websearchModule.setup, teardown: websearchModule.teardown },
      { name: 'weather', setup: weatherModule.setup, teardown: weatherModule.teardown },
      { name: 'currency', setup: currencyModule.setup, teardown: currencyModule.teardown },
      { name: 'calendar', setup: calendarModule.setup, teardown: calendarModule.teardown },
      { name: 'github', setup: githubModule.setup, teardown: githubModule.teardown },
      { name: 'youtube', setup: youtubeModule.setup, teardown: youtubeModule.teardown },
    ];

    for (const module of modules) {
      try {
        const commands = await module.setup();
        for (const cmd of commands) {
          registry.registerCommand(cmd);
        }
        if (typeof module.teardown === 'function') {
          this.teardowns.push({ name: module.name, fn: module.teardown });
        }
        log.debug('module %s loaded', module.name);
      } catch (error) {
        log.error(error, 'failed to load module %s', module.name);
      }
    }
  }

  private async handleMessage(ctx: any): Promise<void> {
    try {
      const dispatchCtx: DispatchContext = {
        ...ctx,
        reply: (text: string) => this.socket!.sendMessage(ctx.from, text),
      };

      await dispatcher.dispatch(dispatchCtx);
    } catch (error) {
      log.error(error, 'error in message handler');
    }
  }

  private setupShutdownHandlers(): void {
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  private shuttingDown = false;

  private async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    log.info('shutdown signal received');

    const shutdownTimeout = setTimeout(() => {
      log.error('shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, 30000);

    try {
      if (this.backupTimer) {
        clearTimeout(this.backupTimer);
        this.backupTimer = null;
      }

      setReminderSender(null);
      setHabitSender(null);

      if (this.socket) {
        await this.socket.shutdown();
      }

      for (const { name, fn } of this.teardowns) {
        try {
          await fn();
        } catch (error) {
          log.error(error, 'teardown failed for module %s', name);
        }
      }

      registry.unwatchAll();
      closeDatabase();

      clearTimeout(shutdownTimeout);
      log.info('senaribot shutdown complete');
      process.exit(0);
    } catch (error) {
      log.error(error, 'error during shutdown');
      clearTimeout(shutdownTimeout);
      process.exit(1);
    }
  }
}

process.on('unhandledRejection', (reason) => {
  log.error(reason instanceof Error ? reason : new Error(String(reason)), 'unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  log.fatal(error, 'uncaught exception');
  process.exit(1);
});

const bot = new Senaribot();
bot.start();
