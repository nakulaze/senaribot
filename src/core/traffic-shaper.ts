import { childLogger } from '@/utils/logger.js';
import { TRAFFIC_SHAPER_TICK_MS, TRAFFIC_SHAPER_TYPING_JITTER_MIN_MS, TRAFFIC_SHAPER_TYPING_JITTER_MAX_MS } from '@/config/constants.js';

const log = childLogger('traffic-shaper');

const MAX_SEND_ATTEMPTS = 3;

export interface QueuedMessage {
  jid: string;
  payload: any;
  timestamp: number;
  attempts?: number;
}

export class TrafficShaper {
  private queue: QueuedMessage[] = [];
  private processing = false;
  private sending = false;
  private tickInterval: NodeJS.Timeout | null = null;
  private onSend: (msg: QueuedMessage) => Promise<void>;

  constructor(onSend: (msg: QueuedMessage) => Promise<void>) {
    this.onSend = onSend;
  }

  enqueue(jid: string, payload: any): void {
    this.queue.push({
      jid,
      payload,
      timestamp: Date.now(),
    });

    if (!this.processing) {
      this.start();
    }
  }

  private start(): void {
    if (this.processing) return;
    this.processing = true;

    this.tickInterval = setInterval(async () => {
      if (this.sending) return;

      if (this.queue.length === 0) {
        this.processing = false;
        if (this.tickInterval) clearInterval(this.tickInterval);
        return;
      }

      const msg = this.queue.shift();
      if (!msg) return;

      this.sending = true;
      try {
        await this.onSend(msg);
      } catch (error) {
        msg.attempts = (msg.attempts ?? 0) + 1;
        if (msg.attempts < MAX_SEND_ATTEMPTS) {
          log.error(error, 'failed to send queued message to %s (attempt %d), will retry', msg.jid, msg.attempts);
          this.queue.unshift(msg);
        } else {
          log.error(error, 'dropping message to %s after %d failed attempts', msg.jid, msg.attempts);
        }
      } finally {
        this.sending = false;
      }
    }, TRAFFIC_SHAPER_TICK_MS);
  }

  getTypingJitter(): number {
    return Math.random() * (TRAFFIC_SHAPER_TYPING_JITTER_MAX_MS - TRAFFIC_SHAPER_TYPING_JITTER_MIN_MS) + TRAFFIC_SHAPER_TYPING_JITTER_MIN_MS;
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.processing = false;
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}
