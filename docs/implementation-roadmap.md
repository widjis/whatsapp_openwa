# Implementation Roadmap

## Status
- Active program: OpenWA rebuild foundation
- Current phase: Phase 1

## Execution Notes
- Phase 1 remains the active checklist driver until real OpenWA webhook evidence is captured and documented.
- For helpdesk parity tracking against `reference/`, see `docs/helpdesk-parity-checklist.md`.
- Some later-phase implementation scaffolding already exists in `src/`, but it must be treated as partial progress, not as phase completion.
- Do not mark later-phase checklist items complete until their own challenge/verification evidence is recorded in this roadmap and synchronized docs.
- Before implementing or updating status, review the relevant source-of-truth documents under `docs/` for the current phase.
- Before designing or porting behavior, always review the relevant implementation in `reference/` first. Do not invent replacement behavior when the reference already defines it.
- Break checklist work into the smallest practical verifiable items. Prefer many small checkboxes over one large checkbox that hides multiple assumptions.
- Every completed checklist item must be followed by a challenge/verification step and evidence sync. No item is considered done until verification is recorded.

## Progress Snapshot
- Phase 2 scaffolding already exists in the root runtime:
  - `OpenwaClient`
  - `SessionService`
  - `MessagingService`
  - `DirectoryService`
  - outbound HTTP routes in `src/features/http/routes/**`
  - explicit group lookup cache TTL and refresh-on-miss behavior
- Phase 3 scaffolding already exists in the root runtime:
  - webhook ingress endpoint
  - local webhook capture storage
  - webhook registration helpers
  - event normalization path
  - simulated slash-command routing through the root app
- Phase 4 exploratory command porting has already started in the root runtime:
  - `/resetpassword`
  - `/finduser`
  - `/unlock`
  - `/getbitlocker`
  - `/getasset`
  - `/licenses`
  - `/getlicense`
  - `/expiring`
  - `/licensereport`
  - `/getlaps`
  - `/getlapsdiag`
  - `/setlaps`
  - `/technician` directory commands
- Phase 4 workflow scaffolding already exists in the root runtime:
  - `src/features/tickets/claimStore.ts`
  - `src/features/tickets/ticketStateStore.ts`
  - `POST /webhook` in `src/features/http/routes/messages.ts`
  - reaction claim/unclaim handler in `src/features/inbound/commandService.ts`
  - best-effort direct requester and technician notifications after successful reaction claim
  - requester phone fallback from ServiceDesk email via LDAP lookup
  - `src/features/dispatcher/helpdeskDispatcher.ts` dispatcher foundation with bounded ServiceDesk scanning, leave-aware ICT selection by open-ticket load, assignment updates through ServiceDesk API, reminder/backoff state via `src/features/tickets/ticketStateStore.ts`, actionable direct/digest notification flow with notification-hash dedupe, leave schedule loading from `src/leaveScheduleCheck.ts`, and delivery via root `MessagingService`
- The items above are implementation progress only. They do not change the active phase away from Phase 1, and they must not be used as a substitute for missing payload validation evidence.
- Latest command-port verification evidence:
  - `npm run lint` passed after porting technician contacts, `/setlaps`, and `/technician`
  - `npm run build` passed after porting technician contacts, `/setlaps`, and `/technician`
  - Local runtime verification against a temporary copy of `data/technicianContacts.json` confirmed `/technician list`, `/technician view 3`, and `/setlaps technician 4 /a`
  - `npm run lint` passed after porting root ServiceDesk webhook scaffolding and ticket state persistence
  - `npm run build` passed after porting root ServiceDesk webhook scaffolding and ticket state persistence
  - Express route-registration smoke check confirmed `POST /webhook` is registered in the root app
  - Local reaction smoke check confirmed allowed-group gating, `@lid` actor phone resolution, and duplicate-reaction dedupe in the root reaction handler
  - `npm run lint` passed after adding direct claim notifications and LDAP requester-phone fallback
  - `npm run build` passed after adding direct claim notifications and LDAP requester-phone fallback
  - `npm run lint` passed after fixing unclaim restore so `ICT TECHNICIAN` can be cleared back to `null`
  - `npm run build` passed after fixing unclaim restore so `ICT TECHNICIAN` can be cleared back to `null`
  - `npm run lint` passed after reformatting claim and ServiceDesk troubleshooting logs into compact human-readable lines
  - `npm run build` passed after reformatting claim and ServiceDesk troubleshooting logs into compact human-readable lines
  - `npm run lint` passed after reformatting webhook runtime logs into compact human-readable lines
  - `npm run build` passed after reformatting webhook runtime logs into compact human-readable lines
  - Manual Helpdesk API verification against ticket `6700` confirmed that clearing both `technician` and `udf_fields.udf_pick_601` requires sending both fields explicitly as `null`
  - `npm run lint` passed after adding root dispatcher foundation and native channel notification delivery
  - `npm run build` passed after adding root dispatcher foundation and native channel notification delivery
  - `npm run lint` passed after porting reference leave schedule loading into the root dispatcher foundation
  - `npm run build` passed after porting reference leave schedule loading into the root dispatcher foundation
  - `npm run lint` passed after porting reference-style leave-aware ICT assignment and ServiceDesk update execution into the root dispatcher foundation
  - `npm run build` passed after porting reference-style leave-aware ICT assignment and ServiceDesk update execution into the root dispatcher foundation
  - `npm run lint` passed after extending ticket state persistence and porting reference-style dispatcher reminder/backoff logic
  - `npm run build` passed after extending ticket state persistence and porting reference-style dispatcher reminder/backoff logic
  - `npm run lint` passed after changing dispatcher direct/digest notifications to use actionable queues and notification-hash dedupe
  - `npm run build` passed after changing dispatcher direct/digest notifications to use actionable queues and notification-hash dedupe
  - Dispatcher one-shot dry-run on alternate port (`PORT=8292`, `DISPATCHER_DRY_RUN=true`, `DISPATCHER_RUN_ONCE=true`, `DISPATCHER_NOTIFY_MODE=none`, `DISPATCHER_REMINDER_MODE=none`, `DISPATCHER_LEAVE_SCHEDULE_ENABLED=false`) scanned 69 tickets with `matched=0` before route-decision porting, exposing that no-group tickets still skipped because the reference routing path had not been ported yet
  - After porting reference-style route decision for no-group tickets, the same one-shot dry-run scanned 69 tickets with `matched=2`, `assigned=2`, `errors=0`; ticket `6697` (`Tidak bisa membuka file PDF`) and ticket `6696` (`Internet laptop tidak bisa koneksi`) became actionable instead of being skipped
  - `npm run lint` passed after porting no-group dispatcher routing and expanding dispatcher candidate logs to include target group/ICT fields
  - `npm run build` passed after porting no-group dispatcher routing and expanding dispatcher candidate logs to include target group/ICT fields
  - Follow-up dry-run with target logging exposed a false-positive substring match where keyword `lan` inside normal words (for example `tampilan`) incorrectly pushed ticket `6697` into `IT Field Support`; after changing routing keyword checks to token-based normalized matching, the same dry-run kept `6696` on `IT Field Support` but corrected ticket `6697` to `IT Support` with `Peggy Putra (IT System Support)`
  - `npm run lint` passed after hardening dispatcher heuristic routing against substring false positives
  - `npm run build` passed after hardening dispatcher heuristic routing against substring false positives
  - Real leave workbook audit for `data/leave/leave-schedule.xlsx` confirmed the relevant daily sheet is `Human Resource`; the dispatcher default path was updated to this workbook path and `technicianContacts.json` now carries explicit `leave_schedule_name` mappings for 9 ICT contacts whose Helpdesk/display names differ from the Excel roster names
  - Leave-enabled one-shot dry-run (`DISPATCHER_LEAVE_SCHEDULE_ENABLED=true`, sheet `Human Resource`) loaded successfully with `matched=9`, `onsite=7`, `offsite=2`; the unmatched ICT contact is `Adriana Riska (Document Control)`, because her exact name appears only in `Sheet1` and not in the `Human Resource` daily status grid
  - Direct parser verification against the workbook showed that `DISPATCHER_LEAVE_SCHEDULE_DATE_SHIFT_DAYS=0` matches the actual current-day column (`2026-07-13` -> statuses such as `WIDJI ... = H24`, `REZA ... = FB9`), while shift `1` reads the next-day column; keep the runtime override at `0` for this workbook when current-day leave filtering is desired
  - `npm run lint` passed after wiring leave schedule name mappings and updating the dispatcher default workbook path
  - `npm run build` passed after wiring leave schedule name mappings and updating the dispatcher default workbook path
  - Root app now includes the reference-style SharePoint leave schedule downloader in `src/sharepointDownloadLeaveSchedule.ts` plus startup/scheduled bootstrap in `src/index.ts`; the download target follows `DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH` and falls back to `data/leave/leave-schedule.xlsx`
  - `npm run lint` passed after porting the leave schedule auto-download scheduler and SharePoint token-cache helper into the root app
  - `npm run build` passed after porting the leave schedule auto-download scheduler and SharePoint token-cache helper into the root app

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
- [x] Implement `POST /channel/webhooks/openwa`
- [x] Persist webhook payload captures under `DATA_DIR/webhook-captures`
- [x] Expose `GET /channel/webhooks/captures`
- [x] Expose `GET /channel/webhooks/captures/latest`
- [x] Expose `GET /channel/webhooks`
- [x] Expose `POST /channel/webhooks/register`
- [x] Expose `POST /channel/webhooks/test`
- [x] Verify OpenWA can deliver `test` event to the root webhook endpoint
- [x] Capture real `message.received` webhook payload
- [x] Summarize real `message.received` payload evidence in roadmap verification notes
- [x] Capture real `message.reaction` webhook payload
- [x] Summarize real `message.reaction` payload evidence in roadmap verification notes
- [x] Capture real reaction removal payload
- [x] Confirm canonical representation for reaction removal
- [ ] Capture outbound send evidence with stable `messageId`
- [ ] Match outbound `messageId` against later reaction payloads
- [x] Capture real `session.status` webhook payload
- [ ] Capture real `session.qr` webhook payload
- [x] Capture real `session.authenticated` webhook payload
- [ ] Capture real `session.disconnected` webhook payload
- [ ] Summarize session event payload differences in `docs/open-questions-and-challenges.md`
- [ ] Test webhook registration with secret/signature mode enabled
- [ ] Record actual webhook headers/signature behavior
- [x] Capture real inbound media message payload
- [x] Decide media download strategy from captured evidence

### Output
- Validated OpenWA payload samples
- Updated event normalization rules
- Reduced ambiguity for inbound workflow implementation
- Working capture infrastructure for collecting real OpenWA webhook evidence

### Challenge / verification
- Store or summarize captured payload evidence
- Mark each assumption as confirmed or rejected in `docs/open-questions-and-challenges.md`
- Do not close this phase without real payload evidence
- For every newly checked item above, record:
  - command or endpoint used
  - event type or artifact captured
  - where the evidence is stored or summarized
- Infrastructure evidence:
  - `POST /channel/webhooks/openwa` captures headers and payload to `DATA_DIR/webhook-captures`
  - `GET /channel/webhooks/captures` returns stored captures
  - `GET /channel/webhooks/captures/latest?eventType=...` returns the latest capture for a target event
  - `GET /channel/webhooks` lists current OpenWA session webhooks
  - `POST /channel/webhooks/register` can register the current session webhook when `OPENWA_WEBHOOK_URL` or `body.url` is provided
  - real `message.received` payload captured from OpenWA and verified end-to-end
  - real `message.reaction` payload captured from OpenWA and summarized from `data/webhook-captures/32ef5424-31fd-4b02-9508-f846f2a29c7b.json`, `cc5f5de5-5a55-42de-979f-466f168a9390.json`, and `ce56abc3-a1e3-4e5e-bde5-a47c2f793b9b.json`
  - current reaction evidence confirms `payload.data.messageId`, `chatId`, `senderId`, `reaction`, and `reactions`
  - reaction removal is now confirmed from live runtime evidence as `payload.data.reaction = ""`, which normalizes to `removed: true`
  - real inbound media payloads captured for image and document messages from `data/webhook-captures/19d5c9dd-ad1d-46c7-a160-f1fe093f55cc.json` and `567f236b-4b8b-4e96-952e-4b3ac08620b7.json`
  - current media strategy: use inline `payload.data.media.data` base64 plus `mimetype` and optional `filename` directly when present; no extra download step is needed for the captured image/document cases
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
- [x] Implement `OpenwaClient`
- [x] Implement base request helpers for `GET` and `POST`
- [x] Implement provider-level error translation into app-level categories
- [x] Implement `SessionService`
- [x] Implement session status lookup
- [x] Implement session start / webhook registration helpers used by routes
- [x] Implement `MessagingService`
- [x] Implement text send path
- [x] Implement image send path
- [x] Implement document send path
- [x] Preserve `@lid` reply targets for outbound replies
- [x] Implement `DirectoryService`
- [x] Implement `@lid -> phone` resolution
- [x] Implement group lookup caching policy explicitly
- [x] Implement group subject refresh / invalidation rules explicitly
- [x] Recreate `/send-message` on top of the new services
- [x] Recreate `/send-bulk-message` on top of the new services
- [x] Recreate `/send-group-message` on top of the new services
- [ ] Verify all outbound routes against current operator needs

### Output
- New outbound-capable OpenWA application core
- HTTP outbound routes available from the root codebase

### Challenge / verification
- Typecheck/build passes
- Verify send-text, send-document, send-image, and send-bulk against the real OpenWA session
- Confirm number lookup and group lookup work for the current operational needs
- For each completed service or route item, record the concrete verification path:
  - build/lint evidence
  - real API request used
  - real OpenWA response or observable side effect

## Phase 3 - Implement Webhook Ingestion and Canonical Event Flow

### Objective
Build inbound processing around OpenWA webhooks and canonical internal events.

### Source documents
- `docs/openwa-integration-contracts.md`
- `docs/openwa-target-architecture.md`
- `docs/feature-specifications.md`
- `docs/user-and-operator-workflows.md`

### Checklist
- [x] Implement webhook ingress endpoint in this repository
- [x] Register and manage OpenWA session webhooks
- [x] Normalize inbound `message.received` events into canonical format
- [ ] Normalize inbound media message events into canonical format
- [x] Normalize reaction add events into canonical format
- [x] Normalize reaction removal events into canonical format
- [x] Normalize `session.status` into canonical format
- [ ] Normalize `session.qr` into canonical format
- [x] Normalize `session.authenticated` into canonical format
- [ ] Normalize `session.disconnected` into canonical format
- [x] Route normalized slash commands into command handling
- [ ] Route normalized conversational messages into N8N forwarding
- [ ] Route normalized session events into operator/session visibility flows

### Output
- Inbound workflow path driven by OpenWA webhooks
- Canonical event model available to business features

### Challenge / verification
- Slash commands work in private and group contexts
- Conversational automation reaches N8N with stable payloads
- Session UI or operator status path receives usable status and QR signals
- For every checked routing item, capture one concrete example payload and one observable downstream result.

## Phase 4 - Rebuild Sensitive Business Workflows

### Objective
Recreate the most operationally sensitive reference behaviors on top of the new OpenWA-only runtime.

### Source documents
- `docs/feature-specifications.md`
- `docs/dispatcher-feature-specification.md`
- `docs/user-and-operator-workflows.md`
- `docs/openwa-integration-contracts.md`

### Checklist
- [ ] Recreate helpdesk `/webhook` notification endpoint contract
- [ ] Recreate helpdesk message formatting and group routing behavior
- [ ] Recreate claimable outbound message persistence model
- [ ] Recreate lookup path from outbound message to claim record
- [ ] Recreate first-reaction claim workflow
- [ ] Recreate duplicate-claim rejection behavior
- [ ] Recreate unclaim by reaction removal
- [ ] Recreate dispatcher notification delivery through the new channel services
- [ ] Recreate dispatcher digest behavior
- [ ] Recreate private reply gateway behavior
- [ ] Recreate mute / pause state behavior required by operators

### Output
- Helpdesk, claim, and dispatcher workflows preserved in the new codebase

### Challenge / verification
- Capture evidence for claim/unclaim workflow
- Validate dispatcher direct notifications and digest behavior
- Record any remaining gaps explicitly in `docs/open-questions-and-challenges.md`
- Every completed item in this phase must include one end-to-end operator scenario, not just unit-level verification.

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
- [ ] Review `README.md` against actual root runtime behavior
- [ ] Document OpenWA session bootstrap flow
- [ ] Document webhook registration flow
- [ ] Document webhook recovery / re-registration flow
- [ ] Document the final root environment contract
- [ ] Confirm onboarding docs match the implemented structure
- [ ] Close resolved open questions
- [ ] Archive or clearly mark still-open risks and missing parity items

### Output
- Operational docs aligned with production reality
- Repository ready for implementation handoff and continued feature work

### Challenge / verification
- End-to-end operator workflow works from session auth to ticket claim
- Build/typecheck passes
- Runbook matches the implemented OpenWA-only runtime
- Do not close this phase until the docs alone are sufficient for a new engineer to operate and extend the root app.

## Notes
- A phase is not complete just because code exists.
- A phase completes only when its verification evidence is captured and related docs are synchronized.
- `reference/` is a behavioral baseline for reproduction, not the active runtime.
