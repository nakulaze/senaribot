import { DispatchContext } from '../dispatcher.js';
import { getConfig } from '@/config/env.js';

const config = getConfig();
const cooldownMap = new Map<string, number[]>();
const COOLDOWN_WINDOW_MS = 60000;

export async function slidingWindowCooldown(ctx: DispatchContext): Promise<void> {
  const key = ctx.sender;
  const bucket = cooldownMap.get(key) || [];

  const now = Date.now();
  const recent = bucket.filter((t: number) => now - t < COOLDOWN_WINDOW_MS);

  if (recent.length >= config.SENARIBOT_RATE_LIMIT_BURST) {
    const oldestTime = Math.min(...recent);
    const waitMs = COOLDOWN_WINDOW_MS - (now - oldestTime);
    throw new Error(`Rate limit exceeded. Wait ${Math.ceil(waitMs / 1000)}s.`);
  }

  recent.push(now);
  cooldownMap.set(key, recent);
}
