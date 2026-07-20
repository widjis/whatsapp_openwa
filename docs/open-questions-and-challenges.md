# Open Questions and Challenges

## Purpose
This document records unresolved ambiguity, validation gaps, and delivery risks for the OpenWA-only rebuild.

## Current Open Questions

### OQ-01 Real payload shape for `message.received`
Status:
- Open

Why it matters:
- command routing
- private vs group detection
- mentions
- quoted message handling
- N8N payload normalization

What is still unknown:
- exact field names for sender, chat, text, quoted message, and media metadata

Evidence needed:
- real webhook payload sample captured from OpenWA

### OQ-02 Real payload shape for `message.reaction`
Status:
- Open

Why it matters:
- reaction-based ticket claim
- reaction-based unclaim
- actor identification
- dedupe key generation

What is still unknown:
- exact removal representation when a reaction is removed
- whether sender identity is always directly available outside the currently captured samples

What is now confirmed from runtime evidence:
- OpenWA emits `message.reaction` with `payload.data.messageId`
- OpenWA emits `payload.data.chatId`
- reacting actor is exposed at `payload.data.senderId`
- active reaction emoji is exposed at `payload.data.reaction`
- current actor-to-emoji snapshot is exposed at `payload.data.reactions`
- current captured samples do not include a stable phone field for the reacting actor, so `@lid` actors still require explicit resolution

Evidence needed:
- real webhook payload sample for unclaim / reaction removal scenario
- additional payload samples if actor identity ever appears under a different field shape

Evidence captured so far:
- `data/webhook-captures/32ef5424-31fd-4b02-9508-f846f2a29c7b.json`
- `data/webhook-captures/cc5f5de5-5a55-42de-979f-466f168a9390.json`
- `data/webhook-captures/ce56abc3-a1e3-4e5e-bde5-a47c2f793b9b.json`

### OQ-03 Reaction removal semantics
Status:
- Resolved

Why it matters:
- the rebuilt claim workflow must distinguish claim vs unclaim reliably

Resolved understanding:
- OpenWA represents removed reactions on `message.reaction` as `payload.data.reaction = ""`
- canonical normalization can treat an empty-string reaction as `removed: true`

Confirming evidence:
- terminal runtime log for capture id `be99c563-6ee5-4173-a088-c402bbc832ac`
- normalized event summary showed `emoji: ""` and `removed: true`

Design implication:
- claim and unclaim can share one webhook event family (`message.reaction`) and branch on the normalized `removed` flag

### OQ-04 Outbound `messageId` correlation stability
Status:
- Open

Why it matters:
- helpdesk notifications must store a message identifier that can later be matched to a reaction event

What is still unknown:
- whether OpenWA outbound send response `messageId` matches the identifier later returned by `message.reaction`

Evidence needed:
- send a real notification through OpenWA
- react to the exact notification
- compare stored outbound id vs inbound reaction target id

### OQ-05 Inbound media delivery model
Status:
- Open

Why it matters:
- conversational automation
- future media workflows
- parity with the reference behavior

What is still unknown:
- whether audio and video follow the same inline payload model as the captured image and document samples

What is now confirmed from runtime evidence:
- image webhook payloads can include `payload.data.media.data` inline as base64
- image webhook payloads include `payload.data.media.mimetype`
- document webhook payloads can include inline base64 plus `payload.data.media.filename`
- current image/document samples do not require an additional history fetch to access media bytes

Evidence needed:
- real inbound audio webhook sample
- real inbound video webhook sample

Evidence captured so far:
- image sample: `data/webhook-captures/19d5c9dd-ad1d-46c7-a160-f1fe093f55cc.json`
- document sample: `data/webhook-captures/567f236b-4b8b-4e96-952e-4b3ac08620b7.json`

### OQ-06 Session event payload detail
Status:
- Open

Why it matters:
- operator status visibility
- QR display flow
- disconnect diagnostics

What is still unknown:
- exact payload shape for `session.qr`
- exact payload shape for `session.disconnected`
- whether QR webhook payloads are sufficient directly or whether the app must call `GET /sessions/{id}/qr`

What is now confirmed from runtime evidence:
- `session.status` sample includes `payload.data.sessionId` and `payload.data.status`
- `session.authenticated` sample includes `payload.data.sessionId`, `payload.data.phone`, and `payload.data.pushName`

Evidence needed:
- real captured `session.qr` webhook event
- real captured `session.disconnected` webhook event

Evidence captured so far:
- `session.status`: `data/webhook-captures/281bbe50-94b8-4a89-a43a-34b1e9240d1f.json`
- `session.authenticated`: `data/webhook-captures/d2c89b4b-2b97-4dc8-811b-5fb33d8f1692.json`

### OQ-07 Webhook secret/signature format
Status:
- Open

Why it matters:
- inbound webhook authenticity verification

What is still unknown:
- exact signature header names
- exact signing algorithm and payload canonicalization rules

Evidence needed:
- real OpenWA webhook with secret enabled
- provider documentation or observed headers

### OQ-08 Group subject resolution robustness
Status:
- Open

Why it matters:
- the reference behavior supports sending to groups by subject name
- the rebuilt app must keep routing predictable for operators

What is still unknown:
- whether cached `/groups` data is enough
- whether explicit alias mapping is required for production reliability

Evidence needed:
- validate real group list data and naming consistency

### OQ-09 Session operating model for the rebuilt app
Status:
- Open

Why it matters:
- the new codebase can either assume one active session or expose broader session controls

What is still unknown:
- whether the first implementation should be single-session by configuration or multi-session by design

Evidence needed:
- decide after outbound and webhook flows are working against the real OpenWA session

### OQ-10 Minimum bootstrap scope
Status:
- Open

Why it matters:
- the rebuild must start with the smallest slice that is both verifiable and useful

What is still unknown:
- whether the first executable milestone should stop at outbound routes or include webhook ingestion in the same pass

Evidence needed:
- implementation checkpoint after Phase 0 and Phase 1

## Current Challenges

### CH-01 Helpdesk claim flow is rebuild-critical
Severity:
- High

Risk:
- if claim/unclaim cannot be preserved, one of the most valuable operational workflows regresses

Current posture:
- do not declare the rebuild safe until reaction correlation is proven

### CH-02 Published spec is not enough for inbound design
Severity:
- High

Risk:
- the OpenAPI spec confirms endpoints and DTOs, but not the exact webhook payload fields required by this repository

Current posture:
- event ingestion implementation must be gated by real payload evidence

### CH-03 Do not reintroduce Baileys-era runtime assumptions
Severity:
- High

Risk:
- copying old transport assumptions into the new codebase would undermine the OpenWA-only rebuild goal

Current posture:
- no Baileys dependency, compatibility layer, auth folder, or patch step should appear in the new runtime plan

### CH-04 Preserve behavior without copying structural debt
Severity:
- High

Risk:
- blindly mirroring the reference file structure can preserve coupling that we explicitly want to remove

Current posture:
- reproduce behavior and contracts first, then choose cleaner module boundaries

### CH-05 Operator workflow must remain simple
Severity:
- Medium

Risk:
- a technically correct rebuild may still fail operationally if QR/auth/session workflows become harder to operate

Current posture:
- keep operator-oriented readiness, QR visibility, and troubleshooting clarity as first-class requirements

## Resolution Tracking

When an item is resolved:
- change `Status` from `Open` to `Resolved`
- add the confirming evidence source
- update the affected docs such as:
  - `docs/openwa-integration-contracts.md`
  - `docs/feature-specifications.md`
  - `docs/user-and-operator-workflows.md`
  - `docs/implementation-roadmap.md`
