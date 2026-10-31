import { Command } from '@/pipeline/registry.js';
import { DispatchContext } from '@/pipeline/dispatcher.js';
import { VaultRepository } from '@/database/repositories/vault.repo.js';
import { childLogger } from '@/utils/logger.js';

const log = childLogger('modules/vault');
const vaultRepo = new VaultRepository();

async function handleSave(ctx: DispatchContext): Promise<void> {
  const args = ctx.command?.args || [];
  if (args.length === 0) {
    await ctx.reply('Usage: .save <tags> | <content>');
    return;
  }

  const text = args.join(' ');
  const [tagsStr, ...contentParts] = text.split('|');
  const tags = tagsStr.trim();
  const content = contentParts.join('|').trim();

  if (!content) {
    await ctx.reply('Usage: .save <tags> | <content>');
    return;
  }

  try {
    const note = vaultRepo.insertNote({
      content,
      tags: tags || null,
      user_jid: ctx.sender,
    });

    await ctx.reply(`Saved to vault (ID: ${note.id.slice(0, 8)})\nTags: ${tags || 'none'}`);
    log.info('vault note created: %s', note.id);
  } catch (error) {
    log.error(error, 'failed to save note');
    await ctx.reply('Failed to save note.');
  }
}

async function handleSearch(ctx: DispatchContext): Promise<void> {
  const args = ctx.command?.args || [];
  if (args.length === 0) {
    await ctx.reply('Usage: .search <query>');
    return;
  }

  const query = args.join(' ');

  try {
    const results = vaultRepo.searchNotes(ctx.sender, query, 5);

    if (results.length === 0) {
      await ctx.reply(`No results for: "${query}"`);
      return;
    }

    let text = `Search results for "${query}" (${results.length}):\n\n`;
    for (const result of results) {
      text += `[${result.note.id.slice(0, 8)}] ${result.snippet}\n`;
      text += `Tags: ${result.note.tags || 'none'}\n\n`;
    }

    await ctx.reply(text);
  } catch (error) {
    log.error(error, 'failed to search vault');
    await ctx.reply('Search failed.');
  }
}

async function handleList(ctx: DispatchContext): Promise<void> {
  const args = ctx.command?.args || [];
  const limit = parseInt(args[0]) || 10;

  try {
    const notes = vaultRepo.getNotesByUser(ctx.sender, limit);

    if (notes.length === 0) {
      await ctx.reply('Vault is empty.');
      return;
    }

    let text = `Recent notes (${notes.length}):\n\n`;
    for (const note of notes) {
      const preview = note.content.slice(0, 50).replace(/\n/g, ' ');
      const date = new Date(note.created_at * 1000).toLocaleDateString('id-ID');
      text += `[${note.id.slice(0, 8)}] ${date} | ${preview}...\n`;
    }

    await ctx.reply(text);
  } catch (error) {
    log.error(error, 'failed to list notes');
    await ctx.reply('Failed to list notes.');
  }
}

async function handleGet(ctx: DispatchContext): Promise<void> {
  const args = ctx.command?.args || [];
  if (args.length === 0) {
    await ctx.reply('Usage: .get <note-id>');
    return;
  }

  const noteId = args[0];

  try {
    const note = vaultRepo.getNoteById(noteId);
    if (!note) {
      await ctx.reply('Note not found.');
      return;
    }

    if (note.user_jid !== ctx.sender) {
      await ctx.reply('Cannot access note created by someone else.');
      return;
    }

    const date = new Date(note.created_at * 1000).toLocaleString('id-ID');
    let text = `ID: ${note.id}\nDate: ${date}\nTags: ${note.tags || 'none'}\n\n${note.content}`;
    await ctx.reply(text);
  } catch (error) {
    log.error(error, 'failed to get note');
    await ctx.reply('Failed to get note.');
  }
}

async function handleDelete(ctx: DispatchContext): Promise<void> {
  const args = ctx.command?.args || [];
  if (args.length === 0) {
    await ctx.reply('Usage: .delete <note-id>');
    return;
  }

  const noteId = args[0];

  try {
    const note = vaultRepo.getNoteById(noteId);
    if (!note) {
      await ctx.reply('Note not found.');
      return;
    }

    if (note.user_jid !== ctx.sender) {
      await ctx.reply('Cannot delete note created by someone else.');
      return;
    }

    vaultRepo.deleteNote(noteId);
    await ctx.reply(`Note deleted: ${noteId.slice(0, 8)}`);
  } catch (error) {
    log.error(error, 'failed to delete note');
    await ctx.reply('Failed to delete note.');
  }
}

export async function setup(): Promise<Command[]> {
  return [
    {
      name: 'save',
      aliases: ['note', 'memo'],
      description: 'Save a note to vault',
      handler: handleSave,
    },
    {
      name: 'search',
      aliases: ['find', 'query'],
      description: 'Search vault by keywords',
      handler: handleSearch,
    },
    {
      name: 'vault',
      aliases: ['notes'],
      description: 'List recent notes',
      handler: handleList,
    },
    {
      name: 'get',
      aliases: ['show', 'read'],
      description: 'Retrieve a specific note',
      handler: handleGet,
    },
    {
      name: 'delete',
      aliases: ['remove', 'rm'],
      description: 'Delete a note',
      handler: handleDelete,
    },
  ];
}
