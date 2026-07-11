# OpenWA Integration Contracts

## Purpose
This document defines the intended contract between this repository and OpenWA API `0.7.17`.

It is not a copy of the OpenWA OpenAPI spec.
Instead, it answers:

- which OpenWA capabilities this repo expects to use
- how OpenWA data should be normalized into internal application contracts
- which assumptions are confirmed from the published spec
- which assumptions still require runtime payload validation

## Scope
This contract covers:
- session lifecycle integration
- outbound messaging integration
- directory lookup integration
- webhook subscription strategy
- canonical event mapping into this repository

## Contract Philosophy
The application should not depend directly on raw OpenWA payloads outside the adapter layer.

All OpenWA interactions should be translated into:
- stable internal service calls
- canonical internal events

This keeps:
- business logic transport-agnostic
- migration risk lower
- future engine changes easier to absorb

## Confirmation Levels
- `Confirmed`: directly supported by the OpenWA published spec
- `Inferred`: strongly suggested by the spec and current repo needs, but exact payload shape is not yet validated
- `Unverified`: requires real sample payloads before implementation is considered safe

## 1. Session Lifecycle Contract

### 1.1 Create session
Internal contract:
- input:
  - `name`
  - optional config/proxy values
- output:
  - `sessionId`
  - `status`
  - timestamps

OpenWA endpoint:
- `POST /api/sessions`

Status:
- `Confirmed`

### 1.2 Start session
Internal contract:
- input:
  - `sessionId`
- output:
  - current session status

OpenWA endpoint:
- `POST /api/sessions/{id}/start`

Status:
- `Confirmed`

### 1.3 Stop session
Internal contract:
- input:
  - `sessionId`
- output:
  - current session status

OpenWA endpoint:
- `POST /api/sessions/{id}/stop`

Status:
- `Confirmed`

### 1.4 Force-kill session
Internal contract:
- input:
  - `sessionId`
- output:
  - terminal or resettable session state

OpenWA endpoint:
- `POST /api/sessions/{id}/force-kill`

Status:
- `Confirmed`

### 1.5 Fetch QR code
Internal contract:
- input:
  - `sessionId`
- output:
  - `qrCodeDataUrl`
  - `status`

OpenWA endpoint:
- `GET /api/sessions/{id}/qr`

Status:
- `Confirmed`

### 1.6 Request pairing code
Internal contract:
- input:
  - `sessionId`
  - `phoneNumber`
- output:
  - `pairingCode`
  - `status`

OpenWA endpoint:
- `POST /api/sessions/{id}/pairing-code`

Status:
- `Confirmed`

## 2. Outbound Messaging Contract

### 2.1 Send text
Internal method:
- `MessagingService.sendText({ sessionId, chatId, text, mentions? })`

OpenWA endpoint:
- `POST /api/sessions/{sessionId}/messages/send-text`

Status:
- `Confirmed`

Expected normalized output:
- `messageId`
- `timestamp`

### 2.2 Send image
Internal method:
- `MessagingService.sendImage({ sessionId, chatId, url|base64, mimetype?, filename?, caption?, mentions? })`

OpenWA endpoint:
- `POST /api/sessions/{sessionId}/messages/send-image`

Status:
- `Confirmed`

### 2.3 Send document
Internal method:
- `MessagingService.sendDocument({ sessionId, chatId, url|base64, mimetype?, filename, caption?, mentions? })`

OpenWA endpoint:
- `POST /api/sessions/{sessionId}/messages/send-document`

Status:
- `Confirmed`

### 2.4 Send audio/video
Internal methods:
- `sendAudio`
- `sendVideo`

OpenWA endpoints:
- `/messages/send-audio`
- `/messages/send-video`

Status:
- `Confirmed`

### 2.5 Reply to message
Internal method:
- `MessagingService.reply({ sessionId, chatId, quotedMessageId, text })`

OpenWA endpoint:
- `POST /api/sessions/{sessionId}/messages/reply`

Status:
- `Confirmed`

### 2.6 React to message
Internal method:
- `MessagingService.react({ sessionId, chatId, messageId, emoji })`

OpenWA endpoint:
- `POST /api/sessions/{sessionId}/messages/react`

Status:
- `Confirmed`

### 2.7 Bulk send
Internal method:
- `MessagingService.sendBulk({ sessionId, messages, options })`

OpenWA endpoint:
- `POST /api/sessions/{sessionId}/messages/send-bulk`

Status:
- `Confirmed`

## 3. Directory and Lookup Contract

### 3.1 Check number on WhatsApp
Internal method:
- `DirectoryService.checkNumber({ sessionId, number })`

OpenWA endpoint:
- `GET /api/sessions/{sessionId}/contacts/check/{number}`

Status:
- `Confirmed`

Use in this repo:
- replacement for Baileys `onWhatsApp` style checks in outbound routes

### 3.2 Resolve contact id to phone
Internal method:
- `DirectoryService.resolvePhone({ sessionId, contactId })`

OpenWA endpoint:
- `GET /api/sessions/{sessionId}/contacts/{contactId}/phone`

Status:
- `Confirmed`

Use in this repo:
- LID-safe requester normalization
- identity normalization for privileged flows

### 3.3 List groups
Internal method:
- `DirectoryService.listGroups({ sessionId, limit?, offset? })`

OpenWA endpoint:
- `GET /api/sessions/{sessionId}/groups`

Status:
- `Confirmed`

Use in this repo:
- group subject lookup
- group cache refresh
- operational mapping

### 3.4 List contacts
Internal method:
- `DirectoryService.listContacts({ sessionId, limit?, offset? })`

OpenWA endpoint:
- `GET /api/sessions/{sessionId}/contacts`

Status:
- `Confirmed`

## 4. Webhook Subscription Contract

## 4.1 Webhook registration
Internal method:
- `WebhookRegistry.ensureSessionWebhook({ sessionId, url, events, secret?, headers?, filters?, retryCount? })`

OpenWA endpoints:
- `POST /api/sessions/{sessionId}/webhooks`
- `GET /api/sessions/{sessionId}/webhooks`
- `PUT /api/sessions/{sessionId}/webhooks/{id}`
- `DELETE /api/sessions/{sessionId}/webhooks/{id}`

Status:
- `Confirmed`

### 4.2 Recommended subscribed events
Minimum events recommended for this repository:
- `message.received`
- `message.reaction`
- `session.status`
- `session.qr`
- `session.authenticated`
- `session.disconnected`

Optional visibility events:
- `message.sent`
- `message.ack`
- `message.failed`
- `message.revoked`

Status:
- `Confirmed` as available event names

### 4.3 Filtering strategy
Recommended first implementation:
- avoid complex filters during initial migration
- receive full event set for the session and normalize centrally

Reason:
- this repository has varied behavior across private chats, groups, commands, and claims
- central filtering keeps logic visible inside this repo rather than split across two systems

## 5. Canonical Internal Event Contracts

These are the internal events the rest of the app should consume.

## 5.1 Canonical `InboundMessageEvent`
Internal shape:

```ts
type InboundMessageEvent = {
  provider: 'openwa';
  sessionId: string;
  chatId: string;
  senderId: string;
  senderPhone: string | null;
  isGroup: boolean;
  messageId: string;
  text: string;
  mentions: string[];
  quotedMessageId: string | null;
  hasMedia: boolean;
  mediaMeta: {
    kind: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'unknown';
    mimetype?: string;
    filename?: string;
    mediaUrl?: string;
  } | null;
  rawEventType: string;
  occurredAt: string;
  raw: unknown;
};
```

OpenWA source event:
- `message.received`

Status:
- event name is `Confirmed`
- payload field mapping is `Unverified`

Required validations:
- message id field name
- sender id field name
- quoted message presence
- mentions representation
- media representation
- group/private context markers

## 5.2 Canonical `ReactionEvent`
Internal shape:

```ts
type ReactionEvent = {
  provider: 'openwa';
  sessionId: string;
  chatId: string;
  messageId: string;
  senderId: string;
  senderPhone: string | null;
  emoji: string | null;
  removed: boolean;
  rawEventType: string;
  occurredAt: string;
  raw: unknown;
};
```

OpenWA source event:
- `message.reaction`

Status:
- event name is `Confirmed`
- payload field mapping is `Unverified`

Critical validations:
- how reaction removal is represented
- whether the event contains the original target `messageId`
- whether the event contains target `chatId`
- whether sender identity resolves consistently

This event is a migration blocker for the helpdesk claim workflow until validated.

## 5.3 Canonical `SessionStatusEvent`
Internal shape:

```ts
type SessionStatusEvent = {
  provider: 'openwa';
  sessionId: string;
  status: 'created' | 'initializing' | 'qr_ready' | 'authenticating' | 'ready' | 'disconnected' | 'failed';
  qrAvailable: boolean;
  reason: string | null;
  rawEventType: string;
  occurredAt: string;
  raw: unknown;
};
```

OpenWA source events:
- `session.status`
- `session.qr`
- `session.authenticated`
- `session.disconnected`

Status:
- event names are `Confirmed`
- merged internal mapping is `Inferred`

## 6. Repository-to-OpenWA Mapping Table
| Repository need | Internal service/event | OpenWA source | Confidence |
| --- | --- | --- | --- |
| Show QR in web UI | `SessionStatusEvent` + `getQrCode()` | `/sessions/{id}/qr`, `session.qr` | `Confirmed/Inferred` |
| Know bot is ready | `SessionStatusEvent` | `session.status` or authenticated/disconnected events | `Inferred` |
| Send command reply | `MessagingService.sendText()` | `send-text` | `Confirmed` |
| Send helpdesk notification | `MessagingService.sendText()` | `send-text` | `Confirmed` |
| Store message id for claim flow | normalized outbound send result | `MessageResponseDto.messageId` | `Confirmed` |
| Receive reaction for claim flow | `ReactionEvent` | `message.reaction` | `Unverified` |
| Normalize LID/requester identity | `DirectoryService.resolvePhone()` | `/contacts/{contactId}/phone` | `Confirmed` |
| Check registered number before send | `DirectoryService.checkNumber()` | `/contacts/check/{number}` | `Confirmed` |
| Group-by-name resolution | `DirectoryService.listGroups()` + cache | `/groups` | `Confirmed` |
| Inbound message to command parser | `InboundMessageEvent` | `message.received` | `Unverified` |

## 7. Error Handling Contract

### 7.1 Adapter boundary rule
Raw OpenWA HTTP errors must be translated into app-level error categories, for example:
- `not_ready`
- `not_found`
- `invalid_request`
- `auth_failed`
- `rate_limited`
- `provider_error`

The rest of the app should not need to parse raw OpenWA error payloads.

### 7.2 Retry rule
The adapter may retry transient OpenWA HTTP failures, but workflow layers should remain idempotent and not assume retry success.

## 8. Security Contract

### 8.1 Provider authentication
Every call from this repository to OpenWA must send:
- `X-API-Key`

Status:
- `Confirmed`

### 8.2 Session scoping
Preferred OpenWA API keys should be scoped to only the sessions this repository component needs.

Status:
- `Confirmed` as a platform capability

### 8.3 Webhook authenticity
If OpenWA webhook secret/HMAC validation is enabled, this repository should validate webhook signatures before processing business events.

Status:
- secret support is `Confirmed`
- exact header/signature format is `Unverified`

## 9. Validation Tasks Before Implementation Lock

These are mandatory before the OpenWA adapter is considered production-safe:

1. capture real `message.received` payload samples
2. capture real `message.reaction` payload samples
3. verify reaction removal semantics
4. verify outbound `messageId` correlation against later reaction events
5. verify session lifecycle webhook payload content
6. verify webhook secret signature format, if used
7. verify media payload/download strategy for inbound messages

## 10. Recommended Adapter Modules

Recommended files or logical modules:
- `src/features/channel/sessionService.ts`
- `src/features/channel/messagingService.ts`
- `src/features/channel/directoryService.ts`
- `src/features/channel/openwaClient.ts`
- `src/features/channel/openwaWebhookIngest.ts`
- `src/features/channel/eventNormalizer.ts`

The exact file names may differ, but the separation of responsibilities should remain.

## Final Rule
No business workflow should consume raw OpenWA webhook payloads directly.

All business workflows should depend on:
- canonical events
- canonical service methods
- normalized identity values

That rule is what keeps the migration from becoming another tightly coupled transport implementation.
