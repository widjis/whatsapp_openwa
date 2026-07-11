type WebhookStatus = 'new' | 'updated';

type WebhookBody = {
  id: string;
  status: WebhookStatus;
  receiver: string;
  receiver_type: string;
  notify_requester_new?: string;
  notify_requester_update?: string;
  notify_requester_assign?: string;
  notify_technician?: string;
};

type ParsedArgs = {
  url: string;
  id: string;
  status: WebhookStatus;
  receiver: string;
  receiverType: string;
  notifyRequesterNew?: string;
  notifyRequesterUpdate?: string;
  notifyRequesterAssign?: string;
  notifyTechnician?: string;
  xForwardedFor?: string;
};

function isWebhookStatus(value: string): value is WebhookStatus {
  return value === 'new' || value === 'updated';
}

function parseBoolAsString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'true') return 'true';
  if (v === 'false') return 'false';
  return undefined;
}

function readArgValue(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  if (idx < 0) return undefined;
  const v = args[idx + 1];
  if (!v || v.startsWith('--')) return undefined;
  return v;
}

function readArgFlag(args: string[], key: string): boolean {
  return args.includes(key);
}

function resolveWebhookUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.endsWith('/webhook')) return trimmed;
  const base = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
  return `${base}/webhook`;
}

function buildParsedArgs(argv: string[]): ParsedArgs {
  const urlRaw = readArgValue(argv, '--url') ?? 'http://localhost:8192';
  const url = resolveWebhookUrl(urlRaw);

  const id = readArgValue(argv, '--id') ?? '';
  const receiver = readArgValue(argv, '--receiver') ?? '';
  const receiverType = readArgValue(argv, '--receiver-type') ?? 'group';
  const statusRaw = readArgValue(argv, '--status') ?? 'new';
  const status: WebhookStatus = isWebhookStatus(statusRaw) ? statusRaw : 'new';

  const notifyRequesterNew = parseBoolAsString(readArgValue(argv, '--notify-requester-new'));
  const notifyRequesterUpdate = parseBoolAsString(readArgValue(argv, '--notify-requester-update'));
  const notifyRequesterAssign = parseBoolAsString(readArgValue(argv, '--notify-requester-assign'));
  const notifyTechnician = parseBoolAsString(readArgValue(argv, '--notify-technician'));

  const xForwardedFor = readArgValue(argv, '--x-forwarded-for');

  if (!id || !receiver) {
    const usage =
      [
        'Usage:',
        '  npm run webhook:test -- --id <ticketId> --receiver <phoneOrJid> [options]',
        '',
        'Options:',
        '  --url <baseUrlOrWebhookUrl>           Default: http://localhost:8192',
        '  --status new|updated                  Default: new',
        '  --receiver-type <string>              Default: group',
        '  --notify-requester-new true|false',
        '  --notify-requester-update true|false',
        '  --notify-requester-assign true|false',
        '  --notify-technician true|false',
        '  --x-forwarded-for <ip>                Override client ip for ALLOWED_IPS',
        '',
        'Examples:',
        '  npm run webhook:test -- --id 12345 --receiver 62812xxxxxxx --status new',
        '  npm run webhook:test -- --id 12345 --receiver 1203630@g.us --status updated',
      ].join('\n');
    throw new Error(usage);
  }

  return {
    url,
    id,
    status,
    receiver,
    receiverType,
    notifyRequesterNew,
    notifyRequesterUpdate,
    notifyRequesterAssign,
    notifyTechnician,
    xForwardedFor,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (readArgFlag(argv, '--help') || readArgFlag(argv, '-h')) {
    buildParsedArgs(['--id', '', '--receiver', '']);
    return;
  }

  const args = buildParsedArgs(argv);
  const body: WebhookBody = {
    id: args.id,
    status: args.status,
    receiver: args.receiver,
    receiver_type: args.receiverType,
    notify_requester_new: args.notifyRequesterNew,
    notify_requester_update: args.notifyRequesterUpdate,
    notify_requester_assign: args.notifyRequesterAssign,
    notify_technician: args.notifyTechnician,
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (args.xForwardedFor) {
    headers['x-forwarded-for'] = args.xForwardedFor;
  }

  const res = await fetch(args.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  const statusLine = `${res.status} ${res.statusText}`.trim();
  console.log(`[webhook:test] POST ${args.url}`);
  console.log(`[webhook:test] status: ${statusLine}`);
  console.log(text);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
