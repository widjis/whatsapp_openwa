# OpenWA Target Architecture

## Purpose
This document defines the target architecture for a new OpenWA-based codebase that reproduces the behavior of the project in `reference/` without reusing Baileys runtime pieces.

This architecture is intentionally rebuild-oriented:
- preserve business behavior from the reference project
- rebuild the runtime around OpenWA only
- keep the transport boundary explicit from day one

## Architecture Goal
Build a new repository root implementation that preserves the reference project's business capabilities:
- command logic
- helpdesk workflows
- dispatcher automation
- LDAP, Snipe-IT, SharePoint, N8N, and OpenAI integrations

The new implementation must not include:
- Baileys sockets
- Baileys auth folders
- Baileys store persistence
- Baileys compatibility layers
- Baileys patch scripts

## Design Principle
`reference/` is a behavioral source, not the runtime application.

That means:
- we reproduce features from `reference/`
- we do not turn `reference/` into the live codebase
- we do not carry old transport assumptions forward just to mimic the old internals

## Reference Shape vs Target Shape

### Reference shape
The reference implementation mixes:
- WhatsApp runtime lifecycle
- inbound event handling
- outbound sending
- command routing
- reaction handling
- helpdesk and dispatcher integration

### Target shape
The new root implementation should separate these concerns:
- OpenWA API adapter
- canonical internal event model
- business workflow services
- HTTP/API facade
- operator and session visibility endpoints

## Target Runtime Components

### 1. SessionService
Responsibilities:
- resolve active session id
- query session status
- fetch QR code
- request pairing code
- start and stop sessions when needed

OpenWA mapping:
- `/api/sessions`
- `/api/sessions/{id}`
- `/api/sessions/{id}/start`
- `/api/sessions/{id}/stop`
- `/api/sessions/{id}/qr`
- `/api/sessions/{id}/pairing-code`

### 2. MessagingService
Responsibilities:
- send text
- send image
- send document
- send audio
- send video
- send bulk
- reply to message
- react to message

OpenWA mapping:
- `/messages/send-text`
- `/messages/send-image`
- `/messages/send-document`
- `/messages/send-audio`
- `/messages/send-video`
- `/messages/send-bulk`
- `/messages/reply`
- `/messages/react`

### 3. DirectoryService
Responsibilities:
- check whether a number exists on WhatsApp
- resolve contact ids to phone numbers
- list contacts
- list groups
- support group lookup by subject and explicit alias

OpenWA mapping:
- `/contacts/check/{number}`
- `/contacts/{contactId}/phone`
- `/contacts`
- `/groups`

### 4. EventIngestService
Responsibilities:
- receive OpenWA webhooks
- validate webhook authenticity when enabled
- normalize raw payloads into canonical internal events
- publish canonical events to business workflows

OpenWA mapping:
- session-scoped webhooks under `/api/sessions/{sessionId}/webhooks`

### 5. Workflow Services
Responsibilities:
- slash command execution
- helpdesk outbound notifications
- reaction-based claim and unclaim logic
- N8N forwarding and reply handling
- private reply gateway
- dispatcher delivery integration

These services depend on canonical events and internal service interfaces, not on raw OpenWA payloads.

## Canonical Internal Event Model

### `InboundMessageEvent`
Fields:
- `provider`
- `sessionId`
- `chatId`
- `senderId`
- `senderPhone`
- `isGroup`
- `groupId`
- `messageId`
- `text`
- `mentions`
- `quotedMessageId`
- `hasMedia`
- `mediaMeta`
- `occurredAt`
- `raw`

Used by:
- command router
- N8N bridge
- reply gateway

### `ReactionEvent`
Fields:
- `provider`
- `sessionId`
- `chatId`
- `messageId`
- `senderId`
- `senderPhone`
- `emoji`
- `removed`
- `occurredAt`
- `raw`

Used by:
- claim workflow
- reaction audit/debugging

### `SessionStatusEvent`
Fields:
- `provider`
- `sessionId`
- `status`
- `reason`
- `qrAvailable`
- `occurredAt`
- `raw`

Used by:
- operator visibility
- session monitoring
- QR/status endpoints

## Layer Boundaries

### Layer A: OpenWA Adapter Layer
Owns:
- OpenWA HTTP requests
- API key handling
- session resolution
- provider-level retries
- provider error translation
- webhook payload normalization

Should not own:
- command authorization
- helpdesk business rules
- dispatcher decisions
- LDAP or ServiceDesk logic

### Layer B: Application Workflow Layer
Owns:
- command routing
- helpdesk notification orchestration
- ticket claim state flow
- reply gateway behavior
- N8N orchestration

Should depend only on internal services and canonical events.

### Layer C: Integration Layer
Owns:
- LDAP / AD
- Snipe-IT
- ServiceDesk
- SharePoint / Graph
- OpenAI
- N8N contract integration

This layer should be reproduced from the reference behavior with as little semantic change as possible.

## Recommended HTTP Shape for the New Codebase
The new implementation may preserve the external route shape from the reference project for compatibility and operator familiarity.

Primary business routes:
- `POST /send-message`
- `POST /send-bulk-message`
- `POST /send-group-message`
- `POST /webhook`

Recommended operator/channel routes:
- `GET /channel/session`
- `GET /channel/session/status`
- `GET /channel/session/qr`
- `POST /channel/session/start`
- `POST /channel/session/stop`
- `POST /channel/webhooks/openwa`

## Group and Contact Resolution Strategy
Reference behavior includes sending to groups by subject name.

Recommended strategy:
1. maintain a cached group directory per session
2. allow explicit alias mapping for operationally critical groups
3. use partial subject matching only as a fallback

Why:
- group subjects can change
- operational sends need predictability
- a rebuild is a good time to separate "friendly lookup" from "stable routing"

## State and Persistence Strategy

### Keep
- `technicianContacts.json`
- SharePoint token cache
- leave schedule XLSX
- ticket claim store
- Redis-backed locks and dedupe state where useful
- upload/media working directory as needed

### Avoid carrying forward
- Baileys auth directories
- Baileys message stores
- transport-specific filesystem state that belongs inside OpenWA

### Add
- session metadata needed by the root app
- webhook registration tracking if useful
- optional cached group/contact snapshots
- canonical event debug capture for validation phases

## Security Model

### Between this app and OpenWA
- use `X-API-Key`
- scope API keys to allowed sessions where possible
- optionally restrict caller IPs at the OpenWA side too

### For this app's own HTTP surface
- keep `ALLOWED_IPS` for inbound route protection
- keep phone-based authorization for privileged commands
- keep LAPS-specific authorization checks

## Observability Model
Recommended evidence sources:
- application logs from this repository for workflow decisions
- OpenWA audit/session status for provider-side evidence

Recommended logging additions:
- attach `sessionId` to every outbound and inbound workflow log
- log canonical event type and message ids
- log webhook event correlation identifiers where available

## Delivery Sequence

### Phase 0: Bootstrap new root codebase
- create new project structure under root
- define OpenWA-only service boundaries
- keep `reference/` read-only

### Phase 1: Validate real webhook payloads
- capture message, reaction, and session event samples
- lock normalization rules before wider feature build-out

### Phase 2: Rebuild outbound flows
- `/send-message`
- `/send-bulk-message`
- `/send-group-message`
- helpdesk outbound notifications
- dispatcher delivery channel

### Phase 3: Rebuild inbound flows
- command handling
- N8N forwarding
- reply gateway
- operator session status visibility

### Phase 4: Rebuild sensitive reaction workflows
- claimable outbound message storage
- first-reaction claim
- reaction-removal unclaim

### Phase 5: Finalize operations
- deployment docs
- runbook
- environment contract
- operator workflows

## Early Acceptance Criteria
The target architecture is ready only when all of the following are true:

1. A ticket notification sent via the new app can still be claimed by reaction.
2. Slash commands behave the same in private and group contexts as the reference behavior.
3. N8N receives stable inbound payloads with sender/chat/message identity preserved.
4. Operators can authenticate a session using OpenWA session flows without any Baileys-era steps.
5. Dispatcher and helpdesk flows can send notifications without direct transport coupling.

## Final Recommendation
The cleanest target is not:
"keep the old transport alive while we imitate the new one."

The cleanest target is:
"rebuild the app around an OpenWA boundary while preserving the reference behavior."

That architecture gives the project:
- cleaner implementation boundaries
- less historical transport debt
- clearer documentation
- a direct path to OpenWA-only operations
