# Feature Specifications

## Purpose
This document turns the canonical feature inventory into structured feature specifications for the highest-priority domains.

This is the next layer after:
- `docs/openwa-compatibility-matrix.md`
- `docs/feature-inventory.md`
- `docs/openwa-target-architecture.md`

The goal is to describe expected behavior clearly enough that architecture, workflow, implementation, and migration planning can all derive from the same source.

## Scope of This Document
This first version covers the three most critical domains:

1. WhatsApp channel and session management
2. Helpdesk notification and ticket claim workflow
3. Command bot and admin operations

Later documents can extend this with:
- dispatcher specifications
- N8N conversational flows
- schedule and leave-data workflows
- asset and license reporting

## Domain 1: WhatsApp Channel and Session Management

### Objective
Provide a reliable operator-facing WhatsApp session runtime that supports authentication, readiness monitoring, inbound event intake, and outbound messaging.

### Primary Actors
- operator
- system runtime
- downstream workflow modules

### Inputs
- environment configuration
- WhatsApp session state
- QR authentication requests
- pairing code requests
- inbound messages
- inbound reactions
- connection state changes

### Outputs
- session status messages to UI
- QR code to UI
- outbound messages to chats/groups
- canonical inbound events for business workflows

### Functional Requirements

#### CH-01 Session bootstrap
The system must be able to initialize a WhatsApp session using configured runtime storage and environment values.

Acceptance:
- session startup can succeed without manual code changes
- the system knows whether the current session is already registered

#### CH-02 QR-based authentication
When a session is not authenticated and QR mode is active, the system must surface a QR code to the operator UI.

Acceptance:
- QR is emitted only when authentication is actually pending
- operator receives an explicit status message when QR is ready

#### CH-03 Optional pairing-code mode
When pairing-code mode is explicitly enabled, the system may request a pairing code instead of relying on QR.

Acceptance:
- pairing mode is opt-in
- pairing mode does not silently override QR expectations without operator visibility

#### CH-04 Session readiness state
The system must expose when the channel is ready for sending and receiving messages.

Acceptance:
- operator UI receives a ready signal
- downstream message workflows are not expected to send before readiness

#### CH-05 Connection loss handling
The system must handle disconnections with bounded reconnect behavior.

Acceptance:
- repeated failures do not create infinite uncontrolled reconnect loops
- terminal or high-risk conditions result in a clear operator-visible message

#### CH-06 Inbound message intake
The system must accept inbound message events and route them to the correct application workflow.

Acceptance:
- slash commands are routed to the command layer
- conversational messages are routed to automation logic
- group and private contexts are preserved

#### CH-07 Inbound reaction intake
The system must accept reaction events for messages that participate in helpdesk claim workflows.

Acceptance:
- claimable reaction events preserve chat identity, message identity, and actor identity
- duplicate reaction processing is prevented

#### CH-08 Number and identity normalization
The system must normalize WhatsApp identity representations, including LID-related identifiers, so authorization and routing are evaluated on stable phone identity.

Acceptance:
- privileged command authorization does not break because of JID format differences
- group/private sender identity remains resolvable to a canonical phone form when possible

### Non-Functional Requirements
- operator status visibility must be human-readable
- reconnect behavior must be bounded
- session-specific storage must remain isolated between numbers

### Migration Notes
This domain is the most transport-sensitive. In OpenWA migration, the business expectation should remain the same, but implementation will move from Baileys event listeners to:
- session endpoints
- webhook ingestion
- canonical event normalization

## Domain 2: Helpdesk Notification and Ticket Claim Workflow

### Objective
Receive ServiceDesk events, notify the correct WhatsApp recipients, and allow technicians to claim tickets directly from message reactions.

### Primary Actors
- ServiceDesk webhook sender
- requester
- technician
- helpdesk group members
- system runtime

### Inputs
- ticket event payload from ServiceDesk
- ticket detail from ServiceDesk API
- previous local ticket state
- reaction events from WhatsApp
- technician master data

### Outputs
- ticket notification messages
- requester update messages
- technician assignment messages
- ServiceDesk assignment/status updates
- persistent claim state

### Functional Requirements

#### HD-01 Ticket event ingestion
The system must receive ticket webhook payloads and enrich them with full request detail from ServiceDesk.

Acceptance:
- invalid payloads are rejected safely
- unknown ticket ids do not produce false notifications

#### HD-02 New-ticket notification
For new tickets, the system must notify the configured receiver with a structured message containing ticket identity and summary context.

Minimum content:
- ticket id
- requester
- status
- priority
- category
- subject
- description summary
- ticket link

#### HD-03 Optional requester notification
For new and updated tickets, the system may notify the requester based on webhook flags and resolvable requester contact information.

Acceptance:
- requester notification is best-effort
- main receiver notification is not blocked by requester notification failure

#### HD-04 Optional technician notification
When a ticket is assigned or reassigned to a technician, the system may notify that technician directly.

Acceptance:
- technician notification uses technician directory data
- failure to notify technician does not fail the entire webhook flow

#### HD-05 Ticket state diffing
For update events, the system must compare previous known ticket state against current state to produce meaningful change summaries.

Acceptance:
- update message includes meaningful changes
- current status, priority, and technician changes are represented clearly

#### HD-06 Auto-enrichment on webhook
When category, priority, or template data is incomplete, the system may enrich the ticket before sending notifications.

Accepted enrichments:
- category suggestion
- default priority
- required template conversion
- status move to `In Progress` under defined assignment conditions

#### HD-07 Claimable notification registration
When the main receiver notification is sent for a new ticket, the system must store the outbound message identity so later reactions can be correlated to the ticket.

Acceptance:
- stored record includes ticket id, remote JID, and message id
- state survives process restarts when Redis is available

#### HD-08 First-claim behavior
When an eligible technician reacts to a tracked message, the system must allow the first valid claim and reject later conflicting claims.

Acceptance:
- the claim is idempotent
- concurrent claim attempts do not produce multiple accepted owners
- response message explains whether claim succeeded or was already taken

#### HD-09 Unclaim behavior
When the original claimer removes their reaction, the system must allow the claim to be removed and ticket ownership to revert according to stored previous state.

Acceptance:
- only the original claimer may unclaim their own claim
- the system does not silently unclaim from a different actor's reaction removal

#### HD-10 Allowed-group constraint
Reaction-based claim flow must only operate in explicitly allowed WhatsApp groups.

Acceptance:
- reactions outside allowed groups are ignored
- debugging or audit logs can explain why a reaction was ignored

### Non-Functional Requirements
- helpdesk notification delivery should be resilient to partial downstream failures
- claim state should prefer Redis when available and fall back to memory otherwise
- operator-facing message text should remain concise and readable in chat context

### Migration Notes
This is the highest-risk workflow in transport migration because it depends on:
- outbound message id stability
- inbound reaction payload fidelity
- accurate participant identity resolution

An OpenWA migration is only acceptable for this domain if those three guarantees are proven.

## Domain 3: Command Bot and Admin Operations

### Objective
Provide operational commands over WhatsApp for IT support workflows, while enforcing authorization and context-aware restrictions.

### Primary Actors
- support admin
- LAPS admin
- technician
- regular chat participant

### Command Families

#### CB-01 General commands
- `/hi`
- `/help`
- `/unmute`

Expected behavior:
- lightweight interaction and discoverability
- no privileged data exposure

#### CB-02 Active Directory and support account commands
- `/finduser`
- `/resetpassword`
- `/unlock`

Expected behavior:
- locate or modify AD-backed user/account data
- enforce phone-based authorization for privileged actions
- preserve friendly response text in chat

#### CB-03 Device and security recovery commands
- `/getbitlocker`
- `/getlaps`
- `/getlapsdiag`
- `/setlaps`

Expected behavior:
- retrieve secure support information only for authorized users
- enforce private-chat-only rules where required
- distinguish LAPS admin rights from broader admin rights

#### CB-04 Asset and license commands
- `/getasset`
- `/licenses`
- `/getlicense`
- `/expiring`
- `/licensereport`

Expected behavior:
- expose Snipe-IT asset and license visibility in WhatsApp-friendly format
- support overview and detail paths

#### CB-05 Technician directory commands
- `/technician list`
- `/technician search`
- `/technician view`
- `/technician add`
- `/technician update`
- `/technician delete`
- `/technician mapleave`

Expected behavior:
- treat technician directory as operational master data
- allow read access more broadly than write access
- restrict destructive or policy-affecting operations to higher-privilege actors

### Functional Requirements

#### CB-06 Command routing
The system must detect slash-prefixed messages and route them to command handlers.

Acceptance:
- command parsing preserves required arguments
- unknown or incomplete commands return actionable usage guidance

#### CB-07 Authorization model
The system must enforce phone-based authorization before executing privileged commands.

Authorization layers:
- admin allowlist via `ALLOWED_PHONE_NUMBERS`
- LAPS admin list via `LAPS_ADMIN_PHONE_NUMBERS`
- delegated technician LAPS access via `laps_access=true`

Acceptance:
- unauthorized users get clear denial
- authorization logic is based on normalized requester identity

#### CB-08 Context-aware restrictions
Some commands must only work in private chats.

Current examples:
- `/getlaps`
- `/getlapsdiag`
- `/setlaps`
- `/unmute`

Acceptance:
- group execution returns a clear instruction instead of partial execution

#### CB-09 Friendly and structured responses
Commands must respond in formats suitable for WhatsApp reading.

Acceptance:
- overview commands use compact tabular or line-based text
- detail commands include essential context only
- failures explain the problem in operator-friendly wording

#### CB-10 Technician data governance
Technician master data operations must be scoped by role.

Acceptance:
- list/search/view are available to allowed operational users
- add/update/delete/mapleave require elevated authority
- changes are persisted immediately

### Non-Functional Requirements
- command responses should fit mobile chat reading
- privileged operations must fail closed
- command parsing should tolerate common operator input styles where possible

### Migration Notes
This domain should migrate cleanly as long as inbound and outbound message handling preserves:
- sender identity
- chat type
- plain-text command payload

Most of the business logic here is already transport-independent.

## Cross-Domain Rules

### X-01 Stable identity resolution
All privileged workflows must rely on normalized actor identity rather than raw chat identifiers.

### X-02 Partial failure isolation
Failure in an optional side-notification must not destroy the main workflow result.

### X-03 Human-readable chat UX
Messages are operational tools and must stay readable in mobile chat.

### X-04 Adapter-first migration
Any engine migration must preserve these feature contracts before replacing the existing transport implementation.

## Recommended Next Specifications
The next documents that should be added after this one are:

1. dispatcher feature specification
2. N8N conversational workflow specification
3. leave schedule and technician availability specification
4. integration contracts for OpenWA webhook payload mapping
