# Feature Inventory

## Purpose
This document is the canonical inventory of the current repository capabilities.

It answers one practical question:

"What does this system actually do today, and which parts are business features versus transport implementation details?"

This inventory is intended to be the source document for:
- migration planning
- target architecture
- feature specifications
- operator workflows
- user experience documentation

## Scope
This inventory is derived from:
- `src/index.ts`
- `src/features/whatsapp/start.ts`
- `src/features/http/routes/messages.ts`
- `src/features/dispatcher/helpdeskDispatcher.ts`
- integration modules under `src/features/integrations/`
- existing operational docs in `docs/`

## Feature Map

### 1. WhatsApp Channel Runtime
Primary files:
- `src/index.ts`
- `src/features/whatsapp/start.ts`
- `src/features/whatsapp/store.ts`

Capabilities:
- start and maintain a WhatsApp client session
- persist auth state under `auth_info_baileys`
- expose QR login to the web UI through Socket.IO
- optionally request pairing code
- keep a local contact/chat/message store
- normalize sender and chat identifiers, including LID-related resolution behavior
- reconnect and lifecycle handling for disconnects

Why it matters:
- This is the current transport layer.
- It is important operationally, but most business features do not belong here.

Migration sensitivity:
- High
- This is the main area that would change when moving from Baileys to OpenWA.

### 2. Web UI for Session Status
Primary files:
- `src/index.ts`
- `index.html`

Capabilities:
- serve a simple browser UI
- display QR code updates
- display status messages from the WhatsApp runtime

Why it matters:
- Operators use this for pairing and quick runtime visibility.

Migration sensitivity:
- Medium
- The UI can remain, but its event source should move from Baileys events to OpenWA session/webhook events.

### 3. HTTP Messaging API
Primary files:
- `src/features/http/routes/messages.ts`
- `src/features/http/middleware/checkIp.ts`

Capabilities:
- `POST /send-message`
  - send text
  - send image by upload
  - send image by URL
  - send image by base64
- `POST /send-bulk-message`
  - send the same text to many recipients with randomized delay
- `POST /send-group-message`
  - send to group by JID or by group subject lookup
  - support mentions
  - support document upload
  - support image upload
- `POST /webhook`
  - receive ServiceDesk events
  - fetch ticket details
  - notify receiver group, requester, and technician

Why it matters:
- This is the main machine-to-machine contract for external systems and internal automation.

Migration sensitivity:
- Low to medium
- Route contracts can remain mostly the same if the outbound channel is abstracted.

### 4. Inbound Message Classification
Primary files:
- `src/features/whatsapp/start.ts`
- `src/features/integrations/n8n.ts`

Capabilities:
- separate slash commands from normal conversational messages
- support private chat behavior distinct from group behavior
- optionally send non-command content to N8N
- ignore untagged group chatter for AI/N8N-style handling

Why it matters:
- This is the bridge between WhatsApp and internal automation logic.

Migration sensitivity:
- Medium
- Behavior should stay, but inbound event ingestion must be re-mapped.

### 5. Private Reply Gateway
Primary files:
- `src/features/whatsapp/start.ts`

Capabilities:
- decide whether to reply, not reply, or mute a private chat
- support rule-based and AI-assisted decision paths
- persist temporary mute state in memory
- allow `/unmute` to restore replies

Why it matters:
- This protects the bot from sending unwanted automatic replies in private chats.

Migration sensitivity:
- Low
- Logic is channel-agnostic once inbound/outbound message handling is abstracted.

### 6. Built-In User and Admin Commands
Primary file:
- `src/features/whatsapp/start.ts`

#### General commands
- `/hi`
- `/help`
- `/unmute`

#### LDAP / Active Directory commands
- `/finduser <name> [/photo]`
- `/resetpassword <username> <newPassword> [/change]`
- `/unlock <username>`
- `/getbitlocker <hostname>`
- `/getlaps <hostname>`
- `/getlapsdiag <hostname>`
- `/setlaps technician <id> /a|/d`

Supporting files:
- `src/features/integrations/ldap.ts`
- `src/features/integrations/technicianContacts.ts`

Business value:
- daily support operations
- privileged IT support tasks
- device/password recovery flows

#### Snipe-IT asset and license commands
- `/getasset [type]`
- `/licenses [limit] [offset]`
- `/getlicense <license_name_or_id>`
- `/expiring [days]`
- `/licensereport`

Supporting file:
- `src/features/integrations/snipeIt.ts`

Business value:
- asset visibility
- software license monitoring
- capacity and renewal tracking

#### Technician directory commands
- `/technician list`
- `/technician search <query>`
- `/technician view <id>`
- `/technician add ...`
- `/technician update ...`
- `/technician delete <id>`
- `/technician mapleave`

Supporting files:
- `src/features/integrations/technicianContacts.ts`
- leave schedule mapping utilities

Business value:
- technician directory as operational master data
- LAPS authorization support
- dispatcher assignment support
- leave schedule mapping support

Command authorization model:
- general admin list via `ALLOWED_PHONE_NUMBERS`
- LAPS-specific admins via `LAPS_ADMIN_PHONE_NUMBERS`
- technician-level LAPS delegation via `laps_access=true`

Migration sensitivity:
- Low
- The commands are mostly business logic, not transport logic.

### 7. N8N Automation Bridge
Primary file:
- `src/features/integrations/n8n.ts`

Capabilities:
- forward inbound payloads to N8N webhook
- support optional API key authorization
- support timeout control
- support message/media aware payload building
- extract reply text from varied N8N response shapes
- send fallback replies when needed

Why it matters:
- This is the main extensibility path for conversational automation outside the repo.

Migration sensitivity:
- Medium
- N8N behavior should stay, but webhook input payload shape may need normalization after transport migration.

### 8. Helpdesk Webhook and Ticket Notification Flow
Primary files:
- `src/features/http/routes/messages.ts`
- `src/features/integrations/ticketHandle.ts`
- `src/features/tickets/claimStore.ts`

Capabilities:
- receive ServiceDesk webhook payloads
- load full ticket detail from ServiceDesk API
- notify a WhatsApp group or direct recipient
- optionally notify requester
- optionally notify assigned technician
- keep previous ticket state for change detection
- auto-suggest service category when missing
- set default priority when missing
- convert template for new tickets when needed
- auto-move ticket to `In Progress` under certain assignment conditions

Why it matters:
- This is one of the most business-critical flows in the repository.

Migration sensitivity:
- Low to medium
- The business workflow should survive intact if outbound messaging and message-id correlation remain stable.

### 9. Reaction-Based Ticket Claim Flow
Primary files:
- `src/features/whatsapp/start.ts`
- `src/features/tickets/claimStore.ts`
- `src/features/integrations/ticketHandle.ts`

Capabilities:
- store outbound notification message IDs
- listen for reactions on those messages
- let the first technician claim a ticket
- remove claim on reaction removal
- update ServiceDesk assignment/status
- prevent duplicate claims

Why it matters:
- This is a distinctive operational workflow, not just a generic chat feature.

Migration sensitivity:
- High
- This is the highest-risk business feature during channel migration because it depends on event fidelity and message-id stability.

### 10. Helpdesk Dispatcher
Primary files:
- `src/features/dispatcher/helpdeskDispatcher.ts`
- `src/dispatcher.ts`
- `docs/helpdesk_dispatcher.md`
- `docs/dispatcher_setup.md`

Capabilities:
- scheduled scanning of ServiceDesk tickets
- identify unassigned or partially assigned tickets
- rules-first routing to support groups
- optional AI-assisted routing
- assign group and ICT technician
- skip technicians based on leave schedule
- apply max-open and weight-based balancing
- send direct notifications or digest-style notifications
- reminder workflows for stale tickets
- Redis-backed state and locking, with in-memory fallback

Why it matters:
- This is a full operational automation subsystem, not a small feature.

Migration sensitivity:
- Low
- Dispatcher logic is mostly independent from WhatsApp transport.
- Only its notification adapter should change.

### 11. ServiceDesk Attachment Analysis
Primary file:
- `src/features/integrations/ticketHandle.ts`

Capabilities:
- inspect ticket attachments
- analyze SRF-related content
- extract text from images and PDFs
- use AI/Gemini/OpenAI-assisted classification paths
- trigger group notifications for approval-relevant content

Why it matters:
- This extends ticket triage beyond plain text fields.

Migration sensitivity:
- Low
- Not transport-specific.

### 12. SharePoint Leave Schedule Download
Primary files:
- `src/index.ts`
- `src/sharepointDownloadLeaveSchedule.ts`

Capabilities:
- acquire Graph token using device flow
- cache and refresh token
- download leave schedule XLSX from SharePoint
- store cache path and XLSX path under configurable locations
- support scheduled daily auto-download

Why it matters:
- Dispatcher assignment quality depends on current leave schedule data.

Migration sensitivity:
- None
- This is independent from the WhatsApp channel layer.

### 13. Security and Access Controls
Primary files:
- `src/features/http/middleware/checkIp.ts`
- `src/features/whatsapp/start.ts`
- route and command-level authorization helpers

Capabilities:
- IP allow-list for HTTP routes
- phone-based authorization for privileged commands
- LAPS-specific access model
- optional alert on denied IP access

Why it matters:
- This protects administrative surfaces in both HTTP and chat channels.

Migration sensitivity:
- Low
- Existing controls should remain, though channel credentials may improve with OpenWA API keys.

### 14. Storage and Persistence Model
Primary files:
- `src/index.ts`
- `src/features/integrations/technicianContacts.ts`
- `src/sharepointDownloadLeaveSchedule.ts`

Current persisted artifacts:
- `auth_info_baileys/`
- `baileys_store.json`
- `uploads/`
- `technicianContacts.json`
- SharePoint token cache
- leave schedule XLSX
- optional Redis state for webhook/dispatcher/ticket claim flows

Why it matters:
- This determines operational recovery, multi-instance isolation, and migration complexity.

Migration sensitivity:
- Medium
- Baileys auth storage becomes less important under OpenWA, but the rest remains relevant.

## Feature Classification by Migration Impact

### Mostly unchanged in an OpenWA migration
- LDAP and AD operations
- Snipe-IT asset and license operations
- technician directory management
- SharePoint leave schedule download
- ServiceDesk API integration
- dispatcher logic
- AI category suggestion
- N8N business workflow

### Requires an adapter boundary
- session lifecycle
- QR and pairing UX
- send message operations
- registered number checks
- group lookup and contact lookup
- inbound message ingestion
- reaction ingestion

### Requires early proof before migration commitment
- reaction-based claim correlation
- inbound media payload handling
- group-subject lookup parity
- session recovery semantics

## Recommended Canonical Product Domains
This repo can now be described as six product domains:

1. WhatsApp channel gateway
2. inbound automation and conversational routing
3. IT support command bot
4. helpdesk notification and claim workflow
5. dispatcher and technician assignment automation
6. operational data and schedule management

This domain model should be reused in future feature specifications and architecture documents.
