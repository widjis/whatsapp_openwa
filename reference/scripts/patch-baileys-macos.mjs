import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const targetFile = path.join(
  process.cwd(),
  'node_modules',
  '@whiskeysockets',
  'baileys',
  'lib',
  'Utils',
  'validate-connection.js',
);

if (!existsSync(targetFile)) {
  console.warn('[patch-baileys-macos] skipped: validate-connection.js not found');
  process.exit(0);
}

const current = readFileSync(targetFile, 'utf8');
const from = 'platform: proto.ClientPayload.UserAgent.Platform.WEB,';
const to = 'platform: proto.ClientPayload.UserAgent.Platform.MACOS,';

if (current.includes(to)) {
  console.log('[patch-baileys-macos] already patched');
  process.exit(0);
}

if (!current.includes(from)) {
  console.warn('[patch-baileys-macos] skipped: expected WEB platform marker not found');
  process.exit(0);
}

writeFileSync(targetFile, current.replace(from, to), 'utf8');
console.log('[patch-baileys-macos] patched validate-connection.js to use MACOS platform');
