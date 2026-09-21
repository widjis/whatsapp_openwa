import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { InboundCommandService } from '../src/features/inbound/commandService.ts';
import { normalizeReactionEvent } from '../src/features/channel/eventNormalizer.ts';
import { storeTicketNotification, claimTicketNotification, loadTicketNotification } from '../src/features/tickets/claimStore.ts';

test('ticket reaction regression scenarios (isolated, no external services)', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ticket-reaction-test-'));
  const env = { ...process.env };
  const adapter = axios.defaults.adapter;
  delete process.env.REDIS_HOST;
  delete process.env.REDIS_PORT;
  process.env.SD_BASE_URL = 'https://servicedesk.invalid/api/v3';
  process.env.SERVICE_DESK_TOKEN = 'test-only';
  process.env.DATA_DIR = tmp;
  process.env.TICKET_REACTION_GROUP_IDS = 'test@g.us';
  const owner = '628111111111';
  const other = '628222222222';
  await fs.writeFile(path.join(tmp, 'technicianContacts.json'), JSON.stringify([
    { id: 1, name: 'Test Owner', ict_name: 'Test Owner', phone: owner, technician: 'IT Support' },
    { id: 2, name: 'Test Other', ict_name: 'Test Other', phone: other, technician: 'IT Support' },
  ]));
  const sent = [];
  const updates = [];
  let onRead;
  let lookups = 0;
  axios.defaults.adapter = async (config) => {
    if (config.method === 'get') {
      if (onRead) { const callback = onRead; onRead = undefined; await callback(); }
      return { data: { request: { id: 'TEST', status: { name: 'Open' }, priority: { name: 'Low' } } }, status: 200, statusText: 'OK', headers: {}, config };
    }
    assert.equal(config.method, 'put', 'unexpected external request');
    updates.push(config.data);
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
  };
  const service = new InboundCommandService(
    { sendText: async (message) => { sent.push(message.text); return {}; } },
    { resolvePhone: async (id) => { lookups++; return id === '999@lid' ? owner : null; } },
    {}, []
  );
  service.notifyClaimParticipants = async () => {};
  const event = (id, overrides = {}) => ({ provider: 'openwa', eventType: 'message.reaction', sessionId: 'test', chatId: 'test@g.us', messageId: id, senderId: `${owner}@c.us`, senderPhone: owner, emoji: '👍', removed: false, occurredAt: new Date().toISOString(), raw: {}, ...overrides });
  const seed = async (id) => storeTicketNotification({ ticketId: 'TEST', remoteJid: 'test@g.us', messageId: id });
  const claim = async (id, phone = owner) => claimTicketNotification({ remoteJid: 'test@g.us', messageId: id, claimantPhone: phone, claimantName: phone === owner ? 'Test Owner' : 'Test Other' });
  try {
    await t.test('initial claim sends one confirmation; same owner repeats remain silent beyond dedupe', async () => {
      await seed('initial');
      const before = updates.length;
      await service.processReactionEvent(event('initial'));
      assert.equal(updates.length, before + 1);
      assert.match(sent.at(-1), /claimed\./);
      const count = sent.length;
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 16_000;
        await service.processReactionEvent(event('initial'));
      } finally { Date.now = realNow; }
      await service.processReactionEvent(event('initial', { emoji: '😂' }));
      assert.equal(sent.length, count);
      assert.equal(updates.length, before + 1);
    });
    await t.test('different technician still receives Already Claimed', async () => {
      await service.processReactionEvent(event('initial', { senderId: `${other}@c.us`, senderPhone: other }));
      assert.match(sent.at(-1), /Ticket Already Claimed/);
    });
    await t.test('same-owner race is silent; different-owner race still reports conflict', async () => {
      for (const [id, phone] of [['race-self', owner], ['race-other', other]]) {
        await seed(id);
        onRead = () => claim(id, phone);
        const count = sent.length;
        const before = updates.length;
        await service.processReactionEvent(event(id));
        assert.equal(updates.length, before);
        if (phone === owner) assert.equal(sent.length, count);
        else assert.match(sent.at(-1), /Ticket Already Claimed/);
      }
    });
    await t.test('claim, remove, same-emoji reclaim works immediately; non-owner cannot unclaim', async () => {
      await seed('cycle');
      await service.processReactionEvent(event('cycle'));
      await service.processReactionEvent(event('cycle', { removed: true, emoji: '' }));
      assert.equal((await loadTicketNotification({ remoteJid: 'test@g.us', messageId: 'cycle' })).claimed, false);
      await service.processReactionEvent(event('cycle'));
      assert.equal((await loadTicketNotification({ remoteJid: 'test@g.us', messageId: 'cycle' })).claimed, true);
      await service.processReactionEvent(event('cycle', { removed: true, emoji: '', senderId: `${other}@c.us`, senderPhone: other }));
      assert.equal((await loadTicketNotification({ remoteJid: 'test@g.us', messageId: 'cycle' })).claimedByPhone, owner);
    });
    await t.test('LID is resolved to real owner, unresolved LID ignored, aliases deduplicated', async () => {
      await seed('lid');
      const normalized = normalizeReactionEvent({ event: 'message.reaction', sessionId: 'test', data: { chatId: 'test@g.us', messageId: 'lid', senderId: '999@lid', reaction: '👍' } });
      assert.equal(normalized.senderPhone, null);
      await service.processReactionEvent(normalized);
      assert.ok(lookups > 0);
      const count = sent.length;
      await service.processReactionEvent(event('lid'));
      assert.equal(sent.length, count);
      assert.equal((await service.processReactionEvent(event('unknown', { senderId: '888@lid', senderPhone: null }))).handled, false);
      assert.equal(sent.length, count);
    });
    await t.test('disallowed groups ignored', async () => {
      const count = sent.length;
      assert.equal((await service.processReactionEvent(event('initial', { chatId: 'elsewhere@g.us' }))).handled, false);
      assert.equal(sent.length, count);
    });
  } finally {
    axios.defaults.adapter = adapter;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
