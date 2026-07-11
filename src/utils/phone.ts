export function phoneNumberFormatter(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('@')) return trimmed;

  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return trimmed;
  if (digits.startsWith('0')) return `62${digits.slice(1)}@c.us`;
  if (digits.startsWith('62')) return `${digits}@c.us`;
  return `${digits}@c.us`;
}

export function ensureMentionJid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('@')) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, '');
  return digits ? `${digits}@c.us` : trimmed;
}

export function normalizePhoneDigits(value: string): string {
  const digits = value.trim().replace(/[^\d]/g, '')
  if (!digits) return ''
  if (digits.startsWith('0')) return `62${digits.slice(1)}`
  return digits
}

export function extractDigitsFromJid(value: string): string {
  const localPart = value.split('@')[0] ?? value
  return localPart.replace(/[^\d]/g, '')
}
