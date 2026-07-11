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
- exact field names for target `messageId`
- exact field names for target `chatId`
- whether sender identity is always directly available

Evidence needed:
- real webhook payload samples for both claim and unclaim scenarios

### OQ-03 Reaction removal semantics
Status:
- Open

Why it matters:
- the rebuilt claim workflow must distinguish claim vs unclaim reliably

What is still unknown:
- whether OpenWA represents removed reactions as empty string, null, missing field, or a distinct event shape

Evidence needed:
- captured removal payload from a real session

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
- whether webhook payloads include direct media URLs, IDs, metadata only, or require additional history fetches

Evidence needed:
- real inbound image/video/audio/document webhook samples

### OQ-06 Session event payload detail
Status:
- Open

Why it matters:
- operator status visibility
- QR display flow
- disconnect diagnostics

What is still unknown:
- which fields are present on `session.status`, `session.qr`, `session.authenticated`, and `session.disconnected`
- whether QR webhook payloads are sufficient directly or whether the app must call `GET /sessions/{id}/qr`

Evidence needed:
- real captured session webhook events

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
