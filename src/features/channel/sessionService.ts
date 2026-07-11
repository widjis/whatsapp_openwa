import type { SessionSummary } from './types.js';
import { OpenwaClient } from './openwaClient.js';

type QrResponse = {
  qrCode?: string;
  status?: string;
};

type PairingCodeResponse = {
  pairingCode?: string;
  status?: string;
};

export class SessionService {
  constructor(private readonly client: OpenwaClient) {}

  isReady(): boolean {
    return this.client.isConfigured();
  }

  async getCurrentSession(): Promise<SessionSummary> {
    const sessionId = await this.client.resolveSessionId();
    return await this.client.get<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  async listSessions(): Promise<SessionSummary[]> {
    return await this.client.listSessions();
  }

  async startCurrentSession(): Promise<SessionSummary> {
    const sessionId = await this.client.resolveSessionId();
    return await this.client.post<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}/start`);
  }

  async stopCurrentSession(): Promise<SessionSummary> {
    const sessionId = await this.client.resolveSessionId();
    return await this.client.post<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}/stop`);
  }

  async getCurrentQrCode(): Promise<QrResponse> {
    const sessionId = await this.client.resolveSessionId();
    return await this.client.get<QrResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/qr`);
  }

  async requestCurrentPairingCode(phoneNumber: string): Promise<PairingCodeResponse> {
    const sessionId = await this.client.resolveSessionId();
    return await this.client.post<PairingCodeResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/pairing-code`,
      { phoneNumber }
    );
  }
}
