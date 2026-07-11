# OpenWA Validation Plan

## Purpose
This document defines the concrete validation activities needed before the OpenWA adapter can be implemented and trusted for production migration.

It complements:
- `docs/implementation-roadmap.md`
- `docs/openwa-integration-contracts.md`
- `docs/open-questions-and-challenges.md`

## Validation Goals
1. Confirm real webhook payload structure
2. Confirm message id correlation for ticket claim workflow
3. Confirm session lifecycle behavior for operator UX
4. Confirm media handling strategy
5. Confirm security behavior for webhook authenticity

## Validation Environment

### Required setup
- reachable OpenWA instance
- valid OpenWA API key
- at least one active test session
- one test personal chat
- one test group allowed for reaction claim testing
- this repository reachable by OpenWA webhooks

### Recommended controls
- use a dedicated test session, not production
- keep test group membership stable during validation
- use deterministic test messages with visible ticket ids or correlation ids

## Test Set A - Session Lifecycle

### A1 Create and start session
Steps:
1. Create a dedicated test session
2. Start the session
3. Observe initial session status

Expected evidence:
- session id is returned
- status transitions are observable

### A2 QR retrieval
Steps:
1. Request QR for unauthenticated session
2. Compare QR endpoint response with any webhook session events

Expected evidence:
- confirm whether UI should rely on webhook event, QR endpoint polling, or both

### A3 Authenticated transition
Steps:
1. Scan QR
2. Capture session events during auth

Expected evidence:
- event sequence from unauthenticated to ready
- useful fields for operator-facing status messaging

### A4 Disconnect behavior
Steps:
1. Stop session or force disconnect
2. Capture resulting events

Expected evidence:
- disconnected state details
- enough reason/context for operator runbook updates

## Test Set B - Inbound Message Payloads

### B1 Private text message
Steps:
1. Send a private text to the test session
2. Capture raw webhook payload

Expected evidence:
- sender id
- chat id
- message id
- text field
- timestamp

### B2 Group text with mention
Steps:
1. Send a tagged group message
2. Capture raw webhook payload

Expected evidence:
- group chat marker
- mentions representation
- sender identity

### B3 Quoted reply
Steps:
1. Reply to a prior message
2. Capture raw webhook payload

Expected evidence:
- quoted message reference
- enough information for future parity if needed

## Test Set C - Reaction Claim Correlation

### C1 Outbound message id capture
Steps:
1. Send a controlled test notification through OpenWA
2. Record returned `messageId`

Expected evidence:
- stored outbound id format

### C2 Claim reaction
Steps:
1. React to that exact message in allowed group
2. Capture `message.reaction` payload

Expected evidence:
- target message id
- target chat id
- reacting actor id
- reaction content

Success criteria:
- target message id matches or can deterministically map to the outbound id stored earlier

### C3 Unclaim reaction removal
Steps:
1. Remove the same reaction
2. Capture resulting webhook payload

Expected evidence:
- reaction removal representation
- whether the same actor identity is preserved

Success criteria:
- adapter can distinguish claim vs unclaim without guesswork

## Test Set D - Media Handling

### D1 Image inbound
Steps:
1. Send image to session
2. Capture webhook payload

Expected evidence:
- whether webhook contains direct media URL, media id, metadata only, or other retrieval mechanism

### D2 Audio/voice inbound
Steps:
1. Send voice note or audio file
2. Capture webhook payload

Expected evidence:
- enough metadata to preserve current automation expectations

### D3 Document inbound
Steps:
1. Send document
2. Capture webhook payload

Expected evidence:
- filename
- mimetype
- retrieval strategy

## Test Set E - Security and Authenticity

### E1 API key enforcement
Steps:
1. Call OpenWA endpoint with valid key
2. Call OpenWA endpoint with invalid or missing key

Expected evidence:
- adapter can reliably classify auth failures

### E2 Webhook secret behavior
Steps:
1. Register a webhook with secret
2. Capture delivered request headers

Expected evidence:
- signature header name
- signing format
- enough data to implement verifier

## Deliverables
For each completed validation:
- short scenario name
- raw payload sample or summarized field map
- confirmed vs rejected assumptions
- affected internal contract updates

## Completion Criteria
The validation phase is complete only when:
- all open questions tied to webhook payloads have evidence
- claim/unclaim correlation is proven
- session event model is sufficient for current operator UX
- media handling strategy is documented
- security/auth behavior is documented

## Recommended Output Format
For each scenario, record:
- scenario id
- date/time
- session id
- trigger action
- raw or redacted sample
- extracted field map
- conclusion
- impacted docs to update
