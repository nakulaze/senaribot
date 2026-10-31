import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { mkdirSync } from 'fs';

async function handleConvertSticker(ctx: DispatchContext): Promise<void> {
  await ctx.reply('Media processing module loaded.');
}

export async function setup(): Promise<Command[]> {
  mkdirSync('./tmp', { recursive: true });

  return [
    {
      name: 'sticker',
      aliases: ['stick'],
      description: 'Convert image to sticker',
      handler: handleConvertSticker,
    },
  ];
}

export function teardown(): void {
  // no cleanup needed
}
