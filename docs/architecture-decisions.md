# Architecture Decisions

## Purpose
This document captures the active engineering decisions for the new root implementation of this repository.

It complements:
- `README.md` for repository onboarding
- `docs/openwa-target-architecture.md` for target system shape
- `docs/openwa-integration-contracts.md` for provider contracts
- `docs/implementation-roadmap.md` for execution order

## ADR-01 Reference is behavioral source, not runtime
Decision:
- `reference/` is read-only
- new implementation lives in the repository root
- work should reproduce observable behavior from `reference/`, not extend `reference/` itself

Why:
- the user explicitly wants a rebuild, not a modification of the reference project
- keeping `reference/` frozen reduces confusion during verification

Implication:
- diffs and implementation progress should happen in the new root codebase only

## ADR-02 OpenWA is the only WhatsApp transport in the new codebase
Decision:
- the new implementation uses OpenWA API as its transport boundary
- no Baileys socket, auth state, store persistence, or patch script will be introduced into the new runtime

Why:
- the target direction is OpenWA-only
- carrying Baileys forward would reintroduce the exact coupling we are trying to leave behind

Implication:
- every channel-facing feature must be expressed in terms of OpenWA services and webhook events

## ADR-03 Preserve behavior, not old internals
Decision:
- reproduce the business behavior from the reference project
- do not preserve transport-specific implementation details unless they are externally observable requirements

Examples of behavior to preserve:
- outbound route semantics
- helpdesk webhook behavior
- dispatcher notification behavior
- command authorization and replies
- reaction-based claim workflow

Examples of internals that should not be preserved automatically:
- Baileys auth folders
- Baileys message store files
- socket lifecycle code
- Baileys patch scripts

## ADR-04 Start with explicit service boundaries
Decision:
The root codebase should be organized around these channel-facing services:
- `OpenwaClient`
- `SessionService`
- `MessagingService`
- `DirectoryService`
- `EventIngestService`

Why:
- the rebuild should start from a clean boundary instead of recreating a monolithic WhatsApp runtime file

Implication:
- business workflows call internal services
- raw OpenWA payloads stay isolated near the adapter layer

## ADR-05 Canonical internal events are required
Decision:
Business workflows may not consume raw OpenWA webhook payloads directly.

Canonical event families:
- inbound message events
- reaction events
- session status events

Why:
- payload fields still need validation
- canonical events let us protect business logic from provider payload churn

Implication:
- event normalization is a mandatory part of the implementation, not optional cleanup

## ADR-06 Root runtime remains an orchestration layer
Decision:
The new app remains responsible for:
- HTTP endpoints
- business orchestration
- external system integrations
- operator visibility

OpenWA remains responsible for:
- session engine lifecycle
- WhatsApp transport execution
- low-level provider state

Why:
- this matches the user's goal of reproducing the existing project behavior while simplifying channel responsibilities

## ADR-07 Reference route shape may be preserved
Decision:
The new implementation may keep the familiar route shape from the reference project:
- `POST /send-message`
- `POST /send-bulk-message`
- `POST /send-group-message`
- `POST /webhook`

Why:
- this reduces operational change for callers and dependent systems

Implication:
- external compatibility can be preserved even though the internal implementation is fully rebuilt

## ADR-08 Session bootstrap is OpenWA-native
Decision:
Session auth and readiness must use OpenWA-native capabilities:
- session create/list/get
- QR retrieval
- pairing code
- webhook-driven session status

Why:
- operator workflows should not depend on deleted transport-era concepts

Implication:
- active docs and future runbooks should stop referring to local transport auth folders as part of normal operations

## ADR-09 State is application-owned only where necessary
Decision:
The root app should persist only the state it truly owns, such as:
- ticket claim mapping
- dispatcher dedupe/lock state
- technician contact data
- leave schedule/cache files
- uploaded temporary files

The root app should not persist provider engine state that OpenWA already owns.

Why:
- that keeps application state understandable and reduces transport leakage into the repo

## ADR-10 Validation before lock-in
Decision:
Webhook payload assumptions must be validated with real runtime samples before we lock the inbound event model.

Highest-risk areas:
- `message.received`
- `message.reaction`
- reaction removal semantics
- message id correlation
- session status webhook payloads

Why:
- the published OpenAPI spec confirms endpoints and DTOs, but not the exact webhook event structure we need

Implication:
- Phase 1 validation is a hard gate, not optional research

## Current Target Runtime Shape
The intended root application is composed of:

### 1. HTTP/API layer
Responsibilities:
- request validation
- route compatibility with the reference behavior
- operator/session endpoints

### 2. Channel adapter layer
Responsibilities:
- OpenWA API access
- provider error translation
- session resolution
- group/contact lookup

### 3. Event ingestion layer
Responsibilities:
- webhook ingress
- signature validation
- canonical event normalization

### 4. Workflow layer
Responsibilities:
- commands
- helpdesk notifications
- claim/unclaim logic
- N8N forwarding
- reply gateway
- dispatcher delivery orchestration

### 5. Integration layer
Responsibilities:
- LDAP / AD
- Snipe-IT
- ServiceDesk
- SharePoint / Graph
- OpenAI
- N8N

## Known Constraints
- OpenWA webhook payload fidelity is still partially unverified
- reaction-based claim flow is the highest-risk operational workflow
- group-by-subject sending needs stable lookup behavior, not naive live search every time
- the repository currently has no active root runtime, so bootstrap documentation must stay synchronized with implementation as it appears

## Recommended Near-Term Documents
The most important active documents for implementation are:
- `docs/implementation-roadmap.md`
- `docs/openwa-target-architecture.md`
- `docs/openwa-integration-contracts.md`
- `docs/open-questions-and-challenges.md`
- `docs/feature-specifications.md`
