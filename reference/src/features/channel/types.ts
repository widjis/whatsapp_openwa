export type ChannelTextMessage = {
  kind: 'text';
  text: string;
  mentions?: string[];
};

export type ChannelImageMessage = {
  kind: 'image';
  caption?: string;
  mentions?: string[];
  source:
    | { kind: 'buffer'; buffer: Buffer }
    | { kind: 'url'; url: string };
};

export type ChannelDocumentMessage = {
  kind: 'document';
  document: Buffer;
  mimetype: string;
  fileName: string;
  caption?: string;
  mentions?: string[];
};

export type ChannelMessage = ChannelTextMessage | ChannelImageMessage | ChannelDocumentMessage;

export type ChannelSendResult = {
  messageId?: string;
  remoteJid?: string;
  raw?: unknown;
};

export type ChannelGroupSummary = {
  id: string;
  subject: string;
};

export type ChannelGroupParticipant = {
  id: string;
  isAdmin: boolean;
};

export type ChannelGroupMetadata = {
  announce: boolean | null;
  participants: ChannelGroupParticipant[] | null;
};

export interface ChannelService {
  isReady(): boolean;
  getSelfJids(): string[];
  checkRegisteredNumber(jid: string): Promise<boolean>;
  sendMessage(chatId: string, message: ChannelMessage): Promise<ChannelSendResult>;
  listGroups(): Promise<ChannelGroupSummary[]>;
  getGroupMetadata(chatId: string): Promise<ChannelGroupMetadata | null>;
}
