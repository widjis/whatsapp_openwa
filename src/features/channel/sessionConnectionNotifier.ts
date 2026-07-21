import type { MessagingService } from './messagingService.js';
import type { SessionService } from './sessionService.js';
import type { SessionSummary } from './types.js';

type SessionConnectionNotifierDeps = {
  sessionService: SessionService;
  messagingService: MessagingService;
  notifyChatId?: string;
  intervalMs?: number;
};

function normalizeStatus(status: string | null | undefined): string {
  return status?.trim().toLowerCase() ?? '';
}

function isConnectedStatus(status: string): boolean {
  return status === 'ready' || status === 'connected';
}

function buildConnectionKey(session: SessionSummary): string {
  return [session.status, session.connectedAt, session.lastActive, session.updatedAt].filter(Boolean).join('|');
}

function buildConnectedMessage(session: SessionSummary): string {
  const lines = ['whatsapp succesfully connected', `session: ${session.name}`];

  if (session.phone?.trim()) lines.push(`phone: ${session.phone.trim()}`);
  if (session.connectedAt?.trim()) lines.push(`connectedAt: ${session.connectedAt.trim()}`);

  return lines.join('\n');
}

export class SessionConnectionNotifier {
  private readonly notifyChatId?: string;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private lastStatus = '';
  private lastConnectionKey = '';
  private running = false;

  constructor(private readonly deps: SessionConnectionNotifierDeps) {
    this.notifyChatId = deps.notifyChatId?.trim() || undefined;
    this.intervalMs = Math.max(1_000, deps.intervalMs ?? 5_000);
  }

  start(): void {
    if (!this.notifyChatId || this.timer) return;

    void this.checkNow();
    this.timer = setInterval(() => {
      void this.checkNow();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async checkNow(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const session = await this.deps.sessionService.getCurrentSession();
      const status = normalizeStatus(session.status);
      const connectionKey = buildConnectionKey(session);
      const shouldNotify =
        Boolean(this.notifyChatId) &&
        isConnectedStatus(status) &&
        (this.lastStatus === '' || !isConnectedStatus(this.lastStatus) || this.lastConnectionKey !== connectionKey);

      this.lastStatus = status;
      this.lastConnectionKey = connectionKey;

      if (!shouldNotify || !this.notifyChatId) return;

      await this.deps.messagingService.sendText({
        chatId: this.notifyChatId,
        text: buildConnectedMessage(session),
      });
      console.log(`[session:notifier] Connected notification sent to ${this.notifyChatId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[session:notifier] Failed to monitor session status: ${message}`);
    } finally {
      this.running = false;
    }
  }
}
