# Implementation Roadmap

## Status
- Active program: OpenWA rebuild foundation
- Current phase: Phase 1

## Phase 0 - Bootstrap OpenWA-Only Rebuild

### Objective
Start a new root codebase that reproduces the reference project behavior without carrying Baileys code, Baileys runtime assumptions, or Baileys dependencies into the new implementation.

### Source documents
- `docs/openwa-compatibility-matrix.md`
- `docs/openwa-target-architecture.md`
- `docs/openwa-integration-contracts.md`
- `docs/feature-inventory.md`
- `docs/feature-specifications.md`
- `reference/src/**`

### Checklist
- [x] Create a new root application structure under `src/` and supporting project files
- [x] Treat `reference/` as read-only behavioral source, not as the runtime codebase
- [x] Define OpenWA-only channel modules for session, messaging, directory, and webhook ingestion
- [x] Define the initial environment contract around `OPENWA_BASE_URL`, `OPENWA_API_KEY`, and `OPENWA_SESSION_ID` or `OPENWA_SESSION_NAME`
- [x] Exclude Baileys packages, auth folders, store files, and patch scripts from the new runtime plan
- [x] Add onboarding docs that explain the rebuild direction clearly

### Output
- Independent root codebase scaffold
- Documented OpenWA-only implementation direction
- Clear separation between new code and frozen reference

### Challenge / verification
- Root implementation files do not import or depend on Baileys packages
- `reference/` remains unchanged
- Documentation reflects rebuild reality before feature implementation starts
- Verification evidence:
  - `npm run lint` passed
  - `npm run build` passed
  - `GET /health` returned success from the new root server
  - `GET /channel/session/status` returned the active OpenWA session in `ready` state
  - `POST /send-message` succeeded against `OPENWA_NUMBER_TEST`
  - `POST /send-group-message` succeeded against `OPENWA_GROUP_NAME`

## Phase 1 - Validate OpenWA Event Assumptions

### Objective
Confirm the real runtime payloads and operational semantics required before locking the webhook/event design.

### Source documents
- `docs/openwa-integration-contracts.md`
- `docs/open-questions-and-challenges.md`
- `docs/feature-specifications.md`
- `docs/user-and-operator-workflows.md`

### Checklist
- [x] Implement a root webhook ingest endpoint for OpenWA event capture
- [x] Add local capture storage and admin inspection endpoints for payload evidence
- [x] Add webhook registration helper endpoints for the active session
- [ ] Capture real `message.received` webhook payload
- [ ] Capture real `message.reaction` webhook payload
- [ ] Confirm reaction removal representation
- [ ] Confirm outbound `messageId` can be matched against later reaction events
- [ ] Confirm session event payloads for `session.status`, `session.qr`, `session.authenticated`, and `session.disconnected`
- [ ] Confirm webhook signature/header behavior if secret mode is enabled
- [ ] Confirm inbound media payload structure and download strategy

### Output
- Validated OpenWA payload samples
- Updated event normalization rules
- Reduced ambiguity for inbound workflow implementation
- Working capture infrastructure for collecting real OpenWA webhook evidence

### Challenge / verification
- Store or summarize captured payload evidence
- Mark each assumption as confirmed or rejected in `docs/open-questions-and-challenges.md`
- Do not close this phase without real payload evidence
- Infrastructure evidence:
  - `POST /channel/webhooks/openwa` captures headers and payload to `DATA_DIR/webhook-captures`
  - `GET /channel/webhooks/captures` returns stored captures
  - `GET /channel/webhooks/captures/latest?eventType=...` returns the latest capture for a target event
  - `GET /channel/webhooks` lists current OpenWA session webhooks
  - `POST /channel/webhooks/register` can register the current session webhook when `OPENWA_WEBHOOK_URL` or `body.url` is provided
  - local simulated `message.received` capture verified end-to-end
  - local simulated `/resetpassword` event was normalized, routed, and replied through OpenWA successfully

## Phase 2 - Implement Core OpenWA Services and Outbound Routes

### Objective
Build the new root application services for outbound messaging, session access, and directory lookup using only OpenWA.

### Source documents
- `docs/openwa-target-architecture.md`
- `docs/openwa-integration-contracts.md`
- `docs/feature-specifications.md`
- `docs/dispatcher-feature-specification.md`

### Checklist
- [ ] Implement `OpenwaClient`
- [ ] Implement `SessionService`
- [ ] Implement `MessagingService`
- [ ] Implement `DirectoryService`
- [ ] Implement provider-level error translation into app-level categories
- [ ] Recreate `/send-message`, `/send-bulk-message`, and `/send-group-message` on top of the new services
- [ ] Recreate group lookup caching and subject resolution behavior needed by operators

### Output
- New outbound-capable OpenWA application core
- HTTP outbound routes available from the root codebase

### Challenge / verification
- Typecheck/build passes
- Verify send-text, send-document, send-image, and send-bulk against the real OpenWA session
- Confirm number lookup and group lookup work for the current operational needs

## Phase 3 - Implement Webhook Ingestion and Canonical Event Flow

### Objective
Build inbound processing around OpenWA webhooks and canonical internal events.

### Source documents
- `docs/openwa-integration-contracts.md`
- `docs/openwa-target-architecture.md`
- `docs/feature-specifications.md`
- `docs/user-and-operator-workflows.md`

### Checklist
- [ ] Implement webhook ingress endpoint in this repository
- [ ] Register and manage OpenWA session webhooks
- [ ] Normalize inbound message events into canonical format
- [ ] Normalize reaction events into canonical format
- [ ] Normalize session state events into canonical format
- [ ] Route normalized events into command handling, N8N forwarding, and session visibility flows

### Output
- Inbound workflow path driven by OpenWA webhooks
- Canonical event model available to business features

### Challenge / verification
- Slash commands work in private and group contexts
- Conversational automation reaches N8N with stable payloads
- Session UI or operator status path receives usable status and QR signals

## Phase 4 - Rebuild Sensitive Business Workflows

### Objective
Recreate the most operationally sensitive reference behaviors on top of the new OpenWA-only runtime.

### Source documents
- `docs/feature-specifications.md`
- `docs/dispatcher-feature-specification.md`
- `docs/user-and-operator-workflows.md`
- `docs/openwa-integration-contracts.md`

### Checklist
- [ ] Recreate helpdesk `/webhook` notification behavior
- [ ] Recreate claimable outbound message storage
- [ ] Recreate first-reaction claim workflow
- [ ] Recreate unclaim by reaction removal
- [ ] Recreate dispatcher notification delivery through the new channel services
- [ ] Recreate private reply gateway and mute state behavior as required

### Output
- Helpdesk, claim, and dispatcher workflows preserved in the new codebase

### Challenge / verification
- Capture evidence for claim/unclaim workflow
- Validate dispatcher direct notifications and digest behavior
- Record any remaining gaps explicitly in `docs/open-questions-and-challenges.md`

## Phase 5 - Finalize Operations and Remove Legacy Assumptions

### Objective
Align deployment, runbook, and repository onboarding with the new OpenWA-only implementation.

### Source documents
- `docs/deployment-and-environment.md`
- `docs/operational-runbook.md`
- `docs/architecture-decisions.md`
- `docs/open-questions-and-challenges.md`

### Checklist
- [ ] Remove obsolete Baileys-era operational guidance from active docs
- [ ] Document OpenWA session bootstrap, webhook registration, and recovery flows
- [ ] Document the final root environment contract
- [ ] Confirm the repository onboarding docs match the implemented structure
- [ ] Close resolved open questions

### Output
- Operational docs aligned with production reality
- Repository ready for implementation handoff and continued feature work

### Challenge / verification
- End-to-end operator workflow works from session auth to ticket claim
- Build/typecheck passes
- Runbook matches the implemented OpenWA-only runtime

## Notes
- A phase is not complete just because code exists.
- A phase completes only when its verification evidence is captured and related docs are synchronized.
- `reference/` is a behavioral baseline for reproduction, not the active runtime.
