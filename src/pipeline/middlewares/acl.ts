import { DispatchContext } from '../dispatcher.js';
import { getConfig } from '@/config/env.js';

const config = getConfig();

export async function aclGuard(ctx: DispatchContext): Promise<void> {
  const isOwner = config.SENARIBOT_OWNER_JIDS.includes(ctx.sender);
  if (!isOwner) {
    throw new Error('Access denied.');
  }
}
