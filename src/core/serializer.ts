import { WAMessage } from '@whiskeysockets/baileys';
import { childLogger } from '@/utils/logger.js';

const log = childLogger('serializer');

export interface MessageContext {
  id: string;
  from: string;
  to: string;
  isGroup: boolean;
  groupId: string | null;
  sender: string;
  timestamp: number;
  text: string;
  type: string;
  quoted: MessageContext | null;
  isOwn: boolean;
  isForwarded: boolean;
  mentions: string[];
  /** Metadata dokumen jika pesan ini (atau pesan yang di-reply) berisi dokumen. */
  document?: DocumentInfo | null;
}

export interface DocumentInfo {
  fileName: string;
  mimeType: string;
  fileLength: number;
  /** Pesan Baileys yang dapat diunduh lewat downloadMediaMessage. */
  source: WAMessage;
}

export function extractDocumentInfo(message: any, source: WAMessage): DocumentInfo | null {
  const doc = message?.documentMessage ?? message?.documentWithCaptionMessage?.message?.documentMessage;
  if (!doc) return null;

  return {
    fileName: doc.fileName || doc.title || 'dokumen',
    mimeType: doc.mimetype || '',
    fileLength: Number(doc.fileLength ?? 0),
    source,
  };
}

export function serializeMessage(msg: WAMessage, ownJid: string): MessageContext | null {
  try {
    if (!msg.message || !msg.key) return null;

    const from = msg.key.remoteJid || '';
    const isGroup = from.endsWith('@g.us');
    const groupId = isGroup ? from : null;
    const sender = msg.key.participant || from;
    const isOwn = sender === ownJid || msg.key.fromMe === true;

    let text = '';
    let type = 'unknown';

    if (msg.message.conversation) {
      text = msg.message.conversation;
      type = 'text';
    } else if (msg.message.extendedTextMessage) {
      text = msg.message.extendedTextMessage.text || '';
      type = 'extended_text';
    } else if (msg.message.imageMessage) {
      text = msg.message.imageMessage.caption || '';
      type = 'image';
    } else if (msg.message.videoMessage) {
      text = msg.message.videoMessage.caption || '';
      type = 'video';
    } else if (msg.message.audioMessage) {
      type = 'audio';
    } else if (msg.message.documentMessage || msg.message.documentWithCaptionMessage) {
      const docMsg = msg.message.documentMessage ?? msg.message.documentWithCaptionMessage?.message?.documentMessage;
      // Caption membawa command (mis. ".summarize"); judul/nama file hanya cadangan.
      text = docMsg?.caption || docMsg?.title || '';
      type = 'document';
    } else if (msg.message.stickerMessage) {
      type = 'sticker';
    } else if (msg.message.locationMessage) {
      text = msg.message.locationMessage.name || '';
      type = 'location';
    } else if (msg.message.contactMessage) {
      text = msg.message.contactMessage.displayName || '';
      type = 'contact';
    }

    const mentions = (msg.message.extendedTextMessage?.contextInfo?.mentionedJid as string[] | undefined) || [];

    let quoted: MessageContext | null = null;
    if (msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
      const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
      const participant = msg.message.extendedTextMessage.contextInfo.participant || '';
      quoted = deserializeQuotedMessage(quotedMsg, participant);
    }

    let document = extractDocumentInfo(msg.message, msg);
    if (!document) {
      const ctxInfo = msg.message.extendedTextMessage?.contextInfo;
      const quotedMsg = ctxInfo?.quotedMessage;
      if (quotedMsg) {
        const quotedSource = {
          key: { remoteJid: from, id: ctxInfo?.stanzaId || '', participant: ctxInfo?.participant || undefined },
          message: quotedMsg,
        } as WAMessage;
        document = extractDocumentInfo(quotedMsg, quotedSource);
      }
    }

    return {
      id: msg.key.id || '',
      from,
      to: isGroup ? groupId! : ownJid,
      isGroup,
      groupId,
      sender,
      timestamp: (msg.messageTimestamp as number) || Math.floor(Date.now() / 1000),
      text: text.trim(),
      type,
      quoted,
      isOwn,
      isForwarded: msg.message.extendedTextMessage?.contextInfo?.isForwarded || false,
      mentions,
      document,
    };
  } catch (error) {
    log.error(error, 'failed to serialize message');
    return null;
  }
}

function deserializeQuotedMessage(msg: any, sender: string): MessageContext | null {
  try {
    let text = '';
    let type = 'unknown';

    if (msg.conversation) {
      text = msg.conversation;
      type = 'text';
    } else if (msg.extendedTextMessage) {
      text = msg.extendedTextMessage.text || '';
      type = 'extended_text';
    } else if (msg.imageMessage) {
      text = msg.imageMessage.caption || '';
      type = 'image';
    } else if (msg.videoMessage) {
      text = msg.videoMessage.caption || '';
      type = 'video';
    }

    return {
      id: '',
      from: '',
      to: '',
      isGroup: false,
      groupId: null,
      sender,
      timestamp: 0,
      text,
      type,
      quoted: null,
      isOwn: false,
      isForwarded: false,
      mentions: [],
    };
  } catch (error) {
    log.error(error, 'failed to deserialize quoted message');
    return null;
  }
}
