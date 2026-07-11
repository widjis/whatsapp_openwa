import type { ChannelService } from './types.js';
import { createBaileysChannelService } from './baileysChannel.js';
import { createOpenwaChannelService } from './openwaChannel.js';

export type ChannelProviderName = 'baileys' | 'openwa';

function readProviderName(): ChannelProviderName {
  const raw = (process.env.OUTBOUND_CHANNEL_PROVIDER ?? process.env.CHANNEL_PROVIDER ?? 'baileys').trim().toLowerCase();
  return raw === 'openwa' ? 'openwa' : 'baileys';
}

export function createConfiguredChannelService(): ChannelService {
  const provider = readProviderName();
  if (provider === 'openwa') return createOpenwaChannelService();
  return createBaileysChannelService();
}

export function getConfiguredChannelProviderName(): ChannelProviderName {
  return readProviderName();
}
