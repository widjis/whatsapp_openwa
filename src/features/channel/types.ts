export type SessionStatus =
  | 'created'
  | 'initializing'
  | 'qr_ready'
  | 'authenticating'
  | 'ready'
  | 'disconnected'
  | 'failed';

export type SessionSummary = {
  id: string;
  name: string;
  status: SessionStatus | string;
  phone?: string | null;
  pushName?: string | null;
  connectedAt?: string | null;
  lastActive?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastError?: string | null;
};

export type SendTextMessageInput = {
  chatId: string;
  text: string;
  mentions?: string[];
};

export type SendImageMessageInput = {
  chatId: string;
  caption?: string;
  mentions?: string[];
  source:
    | { kind: 'buffer'; buffer: Buffer; mimetype?: string; filename?: string }
    | { kind: 'url'; url: string };
};

export type SendDocumentMessageInput = {
  chatId: string;
  document: Buffer;
  mimetype: string;
  fileName: string;
  caption?: string;
  mentions?: string[];
};

export type ChannelSendResult = {
  messageId?: string;
  timestamp?: number;
  remoteJid?: string;
  raw?: unknown;
};

export type GroupSummary = {
  id: string;
  subject: string;
};

export type GroupParticipant = {
  id: string;
  isAdmin: boolean;
};

export type GroupMetadata = {
  announce: boolean | null;
  participants: GroupParticipant[] | null;
};
