import { Boom } from '@hapi/boom';
import {
  DisconnectReason,
  WASocket,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  makeWASocket,
} from '@whiskeysockets/baileys';
import { childLogger } from '@/utils/logger.js';
import { SqliteAuthStore, SqliteSignalKeyStore } from './auth-sqlite.js';
import { TrafficShaper } from './traffic-shaper.js';
import { serializeMessage } from './serializer.js';
import {
  SOCKET_TIMEOUT_MS,
  SOCKET_RECONNECT_BACKOFF_MS,
  SOCKET_RECONNECT_MAX_RETRIES,
  PAIRING_CODE_TIMEOUT_MS,
} from '@/config/constants.js';

const log = childLogger('socket');

export interface SocketConfig {
  phoneNumber: string;
  dbPath: string;
  ownerJids: string[];
  onMessage: (ctx: any) => Promise<void>;
}

class SocketError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'SocketError';
  }
}

export class BaileysSocket {
  private sock: WASocket | null = null;
  private config: SocketConfig;
  private authStore: SqliteAuthStore;
  private signalKeyStore: SqliteSignalKeyStore;
  private trafficShaper: TrafficShaper;
  private reconnectAttempts = 0;
  private isShuttingDown = false;
  private seenMessageIds = new Set<string>();

  /** Return true jika ID pesan sudah pernah diproses. Penampung dibatasi 1000 entri. */
  private isDuplicateMessage(id: string): boolean {
    if (!id) return false;
    if (this.seenMessageIds.has(id)) return true;
    this.seenMessageIds.add(id);
    if (this.seenMessageIds.size > 1000) {
      const oldest = this.seenMessageIds.values().next().value;
      if (oldest !== undefined) this.seenMessageIds.delete(oldest);
    }
    return false;
  }

  constructor(config: SocketConfig) {
    this.config = config;
    this.authStore = new SqliteAuthStore();
    this.signalKeyStore = new SqliteSignalKeyStore();
    this.trafficShaper = new TrafficShaper((msg) => this.sendQueuedMessage(msg));
  }

  async connect(): Promise<void> {
    try {
      const creds = await this.authStore.loadCreds();

      if (!creds.registered) {
        log.info('requesting pairing code for %s', this.config.phoneNumber);
        await this.requestPairingCode();
      }

      await this.establishSocket();
      this.reconnectAttempts = 0;
    } catch (error) {
      log.error(error, 'failed to connect socket');
      throw error;
    }
  }

  private async requestPairingCode(): Promise<void> {
    const { version } = await fetchLatestBaileysVersion();

    const tempSock = makeWASocket({
      version,
      auth: {
        creds: await this.authStore.loadCreds(),
        keys: makeCacheableSignalKeyStore(
          this.signalKeyStore,
          log as any,
        ),
      },
      printQRInTerminal: false,
      logger: log as any,
    });

    const code = await tempSock.requestPairingCode(this.config.phoneNumber);

    log.info('pairing code: %s (expires in %d seconds)', code, PAIRING_CODE_TIMEOUT_MS / 1000);
    console.log(`Pairing code for ${this.config.phoneNumber}: ${code}`);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new SocketError('Pairing code timed out'));
      }, PAIRING_CODE_TIMEOUT_MS);

      const checkInterval = setInterval(() => {
        if (tempSock.user?.id) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve();
        }
      }, 500);
    });

    tempSock.end(undefined);
  }

  private async establishSocket(): Promise<void> {
    this.disposeSocket();

    const { version } = await fetchLatestBaileysVersion();
    const creds = await this.authStore.loadCreds();

    this.sock = makeWASocket({
      version,
      auth: {
        creds,
        keys: makeCacheableSignalKeyStore(
          this.signalKeyStore,
          log as any,
        ),
      },
      printQRInTerminal: false,
      logger: log as any,
      browser: ['senaribot', 'Chrome', '120.0.0.0'],
      defaultQueryTimeoutMs: SOCKET_TIMEOUT_MS,
    });

    this.setupSocketHandlers();
  }

  private setupSocketHandlers(): void {
    if (!this.sock) return;

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log.debug('qr code received');
      }

      if (connection === 'connecting') {
        log.info('connecting to whatsapp');
      }

      if (connection === 'open') {
        log.info('socket connected, user: %s', this.sock!.user?.id);
        this.reconnectAttempts = 0;
      }

      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error).output.statusCode;

        if (reason === DisconnectReason.badSession) {
          log.warn('bad session, clearing auth state');
          this.sock!.logout();
        } else if (reason === DisconnectReason.connectionClosed) {
          log.warn('connection closed, reconnecting');
          await this.safeReconnect();
        } else if (reason === DisconnectReason.connectionLost) {
          log.warn('connection lost, reconnecting');
          await this.safeReconnect();
        } else if (reason === DisconnectReason.connectionReplaced) {
          log.warn('connection replaced');
          this.sock!.end(undefined);
        } else if (reason === DisconnectReason.loggedOut) {
          log.warn('logged out');
          this.sock!.end(undefined);
        } else if (reason === DisconnectReason.restartRequired) {
          log.info('restart required, reconnecting');
          await this.safeReconnect();
        } else if (reason === DisconnectReason.timedOut) {
          log.warn('timed out, reconnecting');
          await this.safeReconnect();
        } else if (reason === DisconnectReason.forbidden) {
          log.error('forbidden, check credentials');
        }
      }
    });

    this.sock.ev.on('creds.update', async () => {
      const creds = this.sock!.authState.creds;
      await this.authStore.saveCreds(creds);
    });

    this.sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        if (!msg.message) continue;

        const ctx = serializeMessage(msg, this.sock!.user!.id);
        if (!ctx || ctx.isOwn) continue;
        if (this.isDuplicateMessage(ctx.id)) {
          log.debug('duplicate message %s ignored', ctx.id);
          continue;
        }

        // Jalankan tanpa await agar command lambat (mis. .ask) tidak menahan pesan lain.
        this.config.onMessage(ctx).catch((error) => {
          log.error(error, 'error handling message');
        });
      }
    });

    this.sock.ev.on('presence.update', (update) => {
      log.debug(update, 'presence update');
    });
  }

  private disposeSocket(): void {
    const old = this.sock;
    if (!old) return;
    this.sock = null;

    try {
      old.ev.removeAllListeners('connection.update');
      old.ev.removeAllListeners('creds.update');
      old.ev.removeAllListeners('messages.upsert');
      old.ev.removeAllListeners('presence.update');
      old.end(undefined);
    } catch (error) {
      log.warn('failed to dispose previous socket: %s', error instanceof Error ? error.message : 'unknown');
    }
  }

  private async safeReconnect(): Promise<void> {
    try {
      await this.reconnect();
    } catch (error) {
      log.fatal(error, 'reconnect failed permanently, exiting so a process manager can restart the bot');
      process.exit(1);
    }
  }

  private async reconnect(): Promise<void> {
    if (this.isShuttingDown) return;

    this.reconnectAttempts++;
    if (this.reconnectAttempts > SOCKET_RECONNECT_MAX_RETRIES) {
      log.error('max reconnect attempts reached, giving up');
      throw new SocketError('Max reconnection attempts exceeded', 'MAX_RECONNECT_EXCEEDED');
    }

    const delay = SOCKET_RECONNECT_BACKOFF_MS * Math.pow(2, this.reconnectAttempts - 1);
    log.info('reconnecting in %dms (attempt %d/%d)', delay, this.reconnectAttempts, SOCKET_RECONNECT_MAX_RETRIES);

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      await this.establishSocket();
    } catch (error) {
      log.error(error, 'reconnection failed');
      await this.reconnect();
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.sock) throw new SocketError('Socket not connected', 'NOT_CONNECTED');

    this.trafficShaper.enqueue(jid, { text });
  }

  private async sendQueuedMessage(msg: any): Promise<void> {
    if (!this.sock) return;

    try {
      await this.sock.sendMessage(msg.jid, { text: msg.payload.text });
    } catch (error) {
      log.error(error, 'failed to send message to %s', msg.jid);
      throw error;
    }
  }

  async sendReaction(jid: string, msgId: string, emoji: string): Promise<void> {
    if (!this.sock) throw new SocketError('Socket not connected', 'NOT_CONNECTED');

    try {
      await this.sock.sendMessage(jid, {
        react: { text: emoji, key: { remoteJid: jid, id: msgId } },
      });
    } catch (error) {
      log.error(error, 'failed to send reaction');
      throw error;
    }
  }

  async setPresence(jid: string, presence: 'available' | 'unavailable' | 'composing' | 'recording'): Promise<void> {
    if (!this.sock) throw new SocketError('Socket not connected', 'NOT_CONNECTED');

    try {
      await this.sock.sendPresenceUpdate(presence, jid);
    } catch (error) {
      log.error(error, 'failed to set presence');
    }
  }

  getUser(): string {
    return this.sock?.user?.id || '';
  }

  isConnected(): boolean {
    return this.sock?.user !== undefined;
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.trafficShaper.stop();

    if (this.sock) {
      await this.sock.end(undefined);
      this.sock = null;
    }

    log.info('socket shutdown complete');
  }
}
