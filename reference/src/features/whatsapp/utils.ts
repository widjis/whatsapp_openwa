import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { proto } from '@whiskeysockets/baileys';
import type { InMemoryStore } from './store.js';

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function phoneNumberFormatter(number: string | number): string {
  let formatted = String(number);
  if (formatted.endsWith('@s.whatsapp.net')) return formatted;

  formatted = formatted.replace(/\D/g, '');
  if (formatted.startsWith('0')) {
    formatted = `62${formatted.slice(1)}`;
  }
  return `${formatted}@s.whatsapp.net`;
}

function extractMessageContentFromMessage(message: proto.IMessage): string {
  if (message.conversation) return message.conversation;
  if (message.imageMessage) return message.imageMessage.caption ?? 'Image';
  if (message.videoMessage) return message.videoMessage.caption ?? 'Video';
  if (message.extendedTextMessage) return message.extendedTextMessage.text ?? '';
  if (message.documentMessage) return message.documentMessage.caption ?? 'Document';
  if (message.buttonsResponseMessage) return message.buttonsResponseMessage.selectedButtonId ?? '';
  if (message.listResponseMessage) {
    return message.listResponseMessage.singleSelectReply?.selectedRowId ?? '';
  }
  if (message.templateButtonReplyMessage) return message.templateButtonReplyMessage.selectedId ?? '';

  const ephemeralContent = message.ephemeralMessage?.message;
  if (ephemeralContent) {
    return extractMessageContentFromMessage(ephemeralContent);
  }

  return 'Media/Other';
}

export function extractMessageContent(msg: proto.IWebMessageInfo): string {
  const message = msg.message;
  if (!message) return '';

  return extractMessageContentFromMessage(message);
}

export function resolveSenderNumber(args: {
  msg: proto.IWebMessageInfo;
  remoteJid: string;
  store: InMemoryStore;
  authInfoDir: string;
}): string {
  const { msg, remoteJid, store, authInfoDir } = args;
  const isGroup = remoteJid.endsWith('@g.us');
  const sender = isGroup ? msg.key?.participant ?? remoteJid : remoteJid;

  if (!sender.includes('@lid')) return sender;

  const contactId = store.contacts[sender]?.id;
  const mappedViaContacts = contactId ?? sender;
  if (!mappedViaContacts.includes('@lid')) return mappedViaContacts;

  const lidUser = sender.split('@')[0] ?? '';
  const mappingFile = path.join(authInfoDir, `lid-mapping-${lidUser}_reverse.json`);
  if (!existsSync(mappingFile)) return mappedViaContacts;

  try {
    const raw = readFileSync(mappingFile, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string' && parsed) {
      return `${parsed}@s.whatsapp.net`;
    }
  } catch {
    return mappedViaContacts;
  }

  return mappedViaContacts;
}
