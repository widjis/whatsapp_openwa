import type { AnyMessageContent } from '@whiskeysockets/baileys';
import { checkRegisteredNumber, getSocket } from '../whatsapp/start.js';
import type {
  ChannelGroupMetadata,
  ChannelGroupSummary,
  ChannelMessage,
  ChannelSendResult,
  ChannelService,
} from './types.js';

function mapToBaileysPayload(message: ChannelMessage): AnyMessageContent {
  switch (message.kind) {
    case 'text':
      return {
        text: message.text,
        mentions: message.mentions,
      };
    case 'image':
      return {
        image: message.source.kind === 'buffer' ? message.source.buffer : { url: message.source.url },
        caption: message.caption ?? '',
        mentions: message.mentions,
      };
    case 'document':
      return {
        document: message.document,
        mimetype: message.mimetype,
        fileName: message.fileName,
        caption: message.caption ?? '',
        mentions: message.mentions,
      };
  }
}

function getSelfJidsFromSocket(): string[] {
  const sock = getSocket();
  const sockUserRecord =
    sock?.user && typeof sock.user === 'object' ? (sock.user as unknown as Record<string, unknown>) : null;
  const candidates = [
    typeof sock?.user?.id === 'string' ? sock.user.id : null,
    sockUserRecord && typeof sockUserRecord.jid === 'string' ? sockUserRecord.jid : null,
    sockUserRecord && typeof sockUserRecord.lid === 'string' ? sockUserRecord.lid : null,
  ];
  return Array.from(new Set(candidates.filter((value): value is string => typeof value === 'string' && value.length > 0)));
}

export function createBaileysChannelService(): ChannelService {
  return {
    isReady(): boolean {
      return Boolean(getSocket());
    },

    getSelfJids(): string[] {
      return getSelfJidsFromSocket();
    },

    async checkRegisteredNumber(jid: string): Promise<boolean> {
      return await checkRegisteredNumber(jid);
    },

    async sendMessage(chatId: string, message: ChannelMessage): Promise<ChannelSendResult> {
      const sock = getSocket();
      if (!sock) {
        throw new Error('WhatsApp socket is not initialized.');
      }

      const raw = await sock.sendMessage(chatId, mapToBaileysPayload(message));
      const sent = raw as { key?: { id?: unknown; remoteJid?: unknown } };
      return {
        messageId: typeof sent.key?.id === 'string' ? sent.key.id : undefined,
        remoteJid: typeof sent.key?.remoteJid === 'string' ? sent.key.remoteJid : chatId,
        raw,
      };
    },

    async listGroups(): Promise<ChannelGroupSummary[]> {
      const sock = getSocket();
      if (!sock) {
        throw new Error('WhatsApp socket is not initialized.');
      }

      const groupsUnknown = await sock.groupFetchAllParticipating();
      const groups = groupsUnknown as unknown as Record<string, { subject?: unknown }>;
      const entries: ChannelGroupSummary[] = [];
      for (const [id, meta] of Object.entries(groups)) {
        const subject = typeof meta?.subject === 'string' ? meta.subject : '';
        if (!subject) continue;
        entries.push({ id, subject });
      }
      return entries;
    },

    async getGroupMetadata(chatId: string): Promise<ChannelGroupMetadata | null> {
      const sock = getSocket();
      if (!sock) {
        throw new Error('WhatsApp socket is not initialized.');
      }

      const groupMetadataFn: unknown = (sock as unknown as { groupMetadata?: unknown }).groupMetadata;
      if (typeof groupMetadataFn !== 'function') return null;

      const metaUnknown = await (groupMetadataFn as (jid: string) => Promise<unknown>)(chatId);
      if (!metaUnknown || typeof metaUnknown !== 'object') return null;

      const metaRecord = metaUnknown as Record<string, unknown>;
      const announce = typeof metaRecord.announce === 'boolean' ? metaRecord.announce : null;
      const participantsUnknown = metaRecord.participants;
      const participants = Array.isArray(participantsUnknown)
        ? participantsUnknown.flatMap((participantUnknown) => {
            if (!participantUnknown || typeof participantUnknown !== 'object') return [];
            const participant = participantUnknown as Record<string, unknown>;
            const id = typeof participant.id === 'string' ? participant.id : null;
            if (!id) return [];
            const admin = typeof participant.admin === 'string' ? participant.admin : null;
            return [{ id, isAdmin: admin === 'admin' || admin === 'superadmin' }];
          })
        : null;

      return { announce, participants };
    },
  };
}
