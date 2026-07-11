# OpenWA Compatibility Matrix

## Purpose
This document evaluates whether the behavior present in `reference/` can be reproduced on top of OpenWA API `0.7.17` (`http://10.60.10.59:2785/api/docs#/`) in a new OpenWA-only codebase.

The goal is not only "can OpenWA send messages", but "can the new root implementation reproduce the reference project's operational behavior" across:
- session lifecycle
- inbound event handling
- command execution
- helpdesk and dispatcher flows
- integrations such as LDAP, Snipe-IT, SharePoint, N8N, and OpenAI

## Scope
This matrix is based on:
- reference project behavior in `reference/src/**`
- OpenWA API spec from `/api/docs-json`
- the decision that the new codebase will not include Baileys

## Verdict
OpenWA is a strong fit for rebuilding this project.

The rebuild is realistic because most of the value in the reference project is in:
- command orchestration
- helpdesk workflow logic
- dispatcher rules
- external system integrations
- operational controls

Those parts should be reproduced. The new work is building an OpenWA-native adapter and webhook/event layer that supports the same business behavior.

## Status Legend
- `Native`: OpenWA has direct first-class support.
- `Adapter`: OpenWA supports it, but the new app needs an adapter or mapping layer.
- `Partial`: partly supported, but behavior or payload parity still needs validation.
- `Gap`: no clear support found in the current OpenWA spec.

## Capability Matrix
| Domain | Reference behavior | OpenWA support | Status | Rebuild notes |
| --- | --- | --- | --- | --- |
| Session create/list/delete | Session lifecycle exists as a user/operator concern. | `/api/sessions`, `/api/sessions/{id}` | `Native` | Rebuild session flows directly on the OpenWA session model. |
| Session start/stop/recover | Operators need explicit control over session readiness. | `/start`, `/stop`, `/force-kill` | `Native` | No legacy transport wrapper is needed. |
| QR authentication | Operators need visible QR auth flow. | `/qr` | `Native` | Build UI or endpoint flow directly around OpenWA QR retrieval. |
| Pairing code | Optional alternative auth method. | `/pairing-code` | `Native` | Keep as optional capability. |
| Session state monitoring | Reference behavior exposes readiness and auth state. | session webhooks and session detail endpoints | `Adapter` | Normalize into a stable internal session event model. |
| Send text | Used in commands, helpdesk, dispatcher, and APIs. | `/messages/send-text` | `Native` | Straight mapping. |
| Send image | Used in outbound message routes. | `/messages/send-image` | `Native` | Straight mapping. |
| Send document | Used in group/message workflows. | `/messages/send-document` | `Native` | Straight mapping. |
| Send audio / voice | Needed for richer automation parity. | `/messages/send-audio` | `Native` | PTT support is explicit. |
| Send video | Needed for richer parity and automation. | `/messages/send-video` | `Native` | Straight mapping. |
| Reply to a specific message | Improves UX parity for targeted responses. | `/messages/reply` | `Native` | Useful for future parity and current workflows. |
| React to a message | Needed by ticket claim flow. | `/messages/react` and reactions lookup endpoint | `Native` | Important for helpdesk claim parity. |
| Bulk outbound messaging | Reference behavior sends repeated messages with delay. | `/messages/send-bulk` | `Native` | OpenWA can replace app-side loops where appropriate. |
| Group messaging | Reference behavior supports group id or subject-name lookup. | group messaging via group chat ids + groups list endpoints | `Adapter` | Recreate group subject resolution above the provider layer. |
| Group list and metadata | Needed for subject lookup and admin checks. | `/groups`, `/groups/{groupId}` | `Native` | Useful for cache-driven group resolution. |
| Contact listing | Used indirectly for identity and directory needs. | `/contacts`, `/contacts/{contactId}` | `Native` | Rebuild only the contact reads we actually need. |
| Check whether number exists | Used by outbound validation. | `/contacts/check/{number}` | `Native` | Direct replacement for registered-number checks. |
| Resolve `@lid` to phone | Needed for normalization and authorization. | `/contacts/{contactId}/phone` | `Native` | Key capability for preserving identity-sensitive workflows. |
| Inbound message receive | Needed for commands, N8N, and reply gateway. | `message.received` webhook | `Adapter` | Requires canonical inbound-event mapping. |
| Inbound reaction receive | Needed for claim/unclaim. | `message.reaction` webhook | `Adapter` | Must validate `chatId`, `messageId`, sender, and removal semantics. |
| Delivery/ack events | Helpful for diagnostics. | `message.sent`, `message.ack`, `message.failed`, `message.revoked` | `Partial` | Good observability upside, but payload use still needs validation. |
| History retrieval | Useful for diagnostics and some media follow-up. | `/messages`, `/messages/{chatId}/history` | `Partial` | Need validation for media/history expectations. |
| Inbound media workflows | Needed for N8N/media-aware flows. | webhook + history API | `Partial` | Requires real payload validation. |
| Private reply gateway | Reference behavior chooses reply, skip, or mute. | webhook receive + send-text + contact block/unblock | `Adapter` | Business logic can be rebuilt above the adapter. |
| Slash commands in private/group chat | Core part of reference behavior. | inbound webhooks + outbound sends | `Adapter` | Commands are transport-agnostic once normalized. |
| Helpdesk `/webhook` notification route | Sends ticket updates to group/requester/technician. | OpenWA outbound APIs | `Adapter` | Route behavior can be preserved with a new messaging service. |
| Reaction-based ticket claim | Stores outbound ids and correlates later reactions. | reactions API + reaction webhook | `Adapter` | Highest-risk rebuild item; must be validated early. |
| Helpdesk dispatcher notifications | Dispatcher sends direct messages based on routing decisions. | OpenWA outbound APIs are sufficient | `Adapter` | Dispatcher should call the new internal messaging layer. |
| Auto category suggestion via OpenAI | Business logic only. | Not channel-dependent | `Native` | No transport risk beyond message delivery. |
| N8N conversational automation | Forwards inbound and relays replies. | webhook receive + outbound send endpoints | `Adapter` | Needs stable payload normalization. |
| Technician directory and leave mapping | Local app-owned state. | Not channel-dependent | `Native` | Recreate as app storage. |
| SharePoint token cache / leave schedule download | Independent business support flow. | Not channel-dependent | `Native` | No channel migration risk. |
| LDAP / AD flows | Command-side integrations. | Not channel-dependent | `Native` | No transport risk beyond inbound/outbound plumbing. |
| Snipe-IT flows | Command-side integrations. | Not channel-dependent | `Native` | No transport risk beyond inbound/outbound plumbing. |
| IP/API-key security | Reference behavior protects routes; OpenWA uses API keys. | `X-API-Key`, scoped sessions, IP restrictions | `Native` | Stronger provider-side control is available. |
| Audit logging | Useful for operations. | `/api/audit` | `Native` | Valuable for rebuilt operator visibility. |
| Infra health/ready/status | Useful for operations. | health and infra endpoints | `Native` | Better than transport-local diagnostics. |

## What Can Stay Conceptually Unchanged
These domains should remain mostly unchanged in behavior:
- Express route semantics
- command handlers and business rules
- LDAP, Snipe-IT, ServiceDesk, SharePoint, OpenAI, N8N integrations
- dispatcher decision logic
- technician contact storage
- LAPS authorization model

## What Must Be Rebuilt
The following must be implemented fresh in the root codebase:
- OpenWA API client
- session access layer
- outbound messaging layer
- directory/group lookup layer
- webhook ingress and canonical event normalization
- operator/session visibility endpoints

## Best Rebuild Strategy
1. Treat `reference/` as a behavioral specification and source of requirements.
2. Build a new root codebase around explicit OpenWA service boundaries.
3. Recreate outbound routes first so the app can send through the real session quickly.
4. Recreate inbound workflows through OpenWA webhooks and canonical events.
5. Recreate the highest-risk operational workflows only after payload validation is captured.

## What Not To Do
- do not turn `reference/` into the active app
- do not build a Baileys compatibility layer
- do not preserve old transport files just because the reference used them

## Highest-Risk Items To Validate Early
1. `message.reaction` webhook payload fidelity
2. inbound message payload parity
3. message id correlation
4. group subject resolution
5. media download path
6. session persistence and restart behavior

## Recommended Conclusion
The project is reproducible on top of OpenWA, including the helpdesk-oriented features, with one important condition:

Treat the work as a clean rebuild from the reference behavior, not as a staged coexistence with the old transport.

That means the implementation order should derive from:
1. capability matrix
2. target architecture
3. integration contracts
4. rebuild roadmap
5. workflow verification
