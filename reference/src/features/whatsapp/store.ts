import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export type StoreContact = {
  id: string;
} & Record<string, unknown>;

type ContactsUpsertHandler = (newContacts: StoreContact[]) => void;
type ContactsUpdateHandler = (updates: Array<Partial<StoreContact> & Pick<StoreContact, 'id'>>) => void;

export type MinimalBaileysEventEmitter = {
  on(event: 'contacts.upsert', handler: ContactsUpsertHandler): void;
  on(event: 'contacts.update', handler: ContactsUpdateHandler): void;
};

export type InMemoryStore = {
  chats: Record<string, unknown>;
  messages: Record<string, unknown>;
  contacts: Record<string, StoreContact>;
  bind: (ev: MinimalBaileysEventEmitter) => void;
  writeToFile: (filePath: string) => void;
  readFromFile: (filePath: string) => void;
};

export type StoreLogger = {
  error: (obj: { error: unknown }, msg?: string) => void;
};

export function makeInMemoryStore({ logger }: { logger?: StoreLogger }): InMemoryStore {
  const chats: Record<string, unknown> = {};
  const messages: Record<string, unknown> = {};
  const contacts: Record<string, StoreContact> = {};

  const bind = (ev: MinimalBaileysEventEmitter) => {
    ev.on('contacts.upsert', (newContacts) => {
      for (const contact of newContacts) {
        contacts[contact.id] = { ...(contacts[contact.id] ?? {}), ...contact };
      }
    });

    ev.on('contacts.update', (updates) => {
      for (const update of updates) {
        if (!contacts[update.id]) continue;
        contacts[update.id] = { ...contacts[update.id], ...update };
      }
    });
  };

  const writeToFile = (filePath: string) => {
    try {
      writeFileSync(filePath, JSON.stringify({ chats, contacts, messages }, null, 2));
    } catch (error) {
      logger?.error({ error }, 'failed to save store');
    }
  };

  const readFromFile = (filePath: string) => {
    try {
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, { encoding: 'utf-8' });
      const dataUnknown: unknown = JSON.parse(raw);
      if (!dataUnknown || typeof dataUnknown !== 'object') return;

      const data = dataUnknown as {
        chats?: Record<string, unknown>;
        contacts?: Record<string, StoreContact>;
        messages?: Record<string, unknown>;
      };

      Object.assign(chats, data.chats);
      Object.assign(contacts, data.contacts);
      Object.assign(messages, data.messages);
    } catch (error) {
      logger?.error({ error }, 'failed to read store');
    }
  };

  return {
    chats,
    contacts,
    messages,
    bind,
    writeToFile,
    readFromFile,
  };
}

