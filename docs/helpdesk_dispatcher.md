## Helpdesk Dispatcher (ManageEngine ServiceDesk Plus)

### Goal
Build a background dispatcher that continuously:
- Detects tickets that are still “unassigned” (no group / no owner / no technician; status still open).
- Auto-routes tickets to the correct group (Document Control / IT Support / IT Field) based on rules (and later AI).
- Sends structured WhatsApp notifications and periodic reminders/digests to each team.
- (Later) Auto-assigns to a specific technician using load/portion rules.

### Non-Goals (for early phases)
- No SLA policy enforcement (we’ll add later).
- No “auto-resolve” or changing ticket content without clear guardrails.
- No replacing existing human triage; dispatcher should assist, not fight.

### Why Keep in Same Repo (but separate process)
This repo already contains:
- ManageEngine SDP API integration: [ticketHandle.ts](file:///Users/widjis/Documents/Projects/whatsapp_api_n8nv2/src/features/integrations/ticketHandle.ts)
- WhatsApp notification capabilities via Baileys.
- Optional Redis usage patterns for state/locking.

We should run dispatcher as a separate entrypoint/process to isolate:
- scheduling and polling
- AI calls / attachment analysis
- retry storms if SDP is unstable

Deployment options:
- Two Node processes (PM2) on same host
- Two containers (recommended) sharing the same repo image but different start commands

### Definitions
**Unassigned ticket (Phase 1):**
- status is “Open”/“New”/not resolved/closed
- AND at least one of:
  - group is empty
  - technician is empty
  - owner is empty

We will implement this as configurable filters so it can match your exact SDP fields.

**Group routing (Phase 1):**
- Output is a target group only: Document Control / IT Support / IT Field
- The dispatcher assigns the ticket to that group
- WhatsApp notification goes to the mapped WA group JID

**Technician routing (Phase 3+):**
- After group assignment is stable, select technician based on:
  - current workload (open tickets per technician)
  - your defined “portion/weight” per technician
  - optional skill tags (network/apps/document control)

### Key Principles (Guardrails)
- Idempotent: never reassign/spam the same ticket repeatedly.
- Deterministic first: rules-first routing; AI only as fallback when ambiguous.
- Observable: log every decision with ticketId + reason + action.
- Safe defaults: if uncertain, do not assign; instead send to a “triage” group or ask for manual routing.

### Data & State
We need “dispatcher memory” so repeated scans don’t spam.

**Preferred**: Redis (already used optionally in repo)
- Key: `dispatcher:ticket:<id>`
- Fields:
  - `lastSeenStatus`
  - `assignedGroupName`
  - `assignedAt`
  - `lastNotifiedAt`
  - `lastReminderAt`
  - `decisionHash` (prevents duplicate message sends)
- Lock key for scan runs:
  - `dispatcher:scan:lock` with short TTL (e.g., 60–120 seconds)

**Fallback**: in-memory map (works but resets on restart)

### Configuration (Env + JSON)
Dispatcher should be configuration-driven.

Required:
- `SD_BASE_URL`
- `SERVICE_DESK_TOKEN`

Recommended new envs:
- `DISPATCHER_ENABLED=true|false`
- `DISPATCHER_SCAN_INTERVAL_SECONDS=300`
- `DISPATCHER_REMINDER_INTERVAL_MINUTES=120`
- `DISPATCHER_DIGEST_CRON=0 9,16 * * *` (example; shift-based)
- `DISPATCHER_REDIS_ENABLED=true|false` (or reuse existing Redis envs)

Mappings (JSON in env or a config file):
- Group name mapping:
  - `DISPATCHER_SDP_GROUPS_JSON={"doc_control":"ICT Document Controller","it_support":"ICT System and Support","it_field":"ICT Network and Infrastructure"}`
- WhatsApp group JIDs:
  - `DISPATCHER_WA_GROUPS_JSON={"doc_control":"<jid>","it_support":"<jid>","it_field":"<jid>","triage":"<jid>"}`
- Routing rules:
  - `DISPATCHER_RULES_JSON=[{"match":{"keywords":["srf","approval","document"]},"route":"doc_control"},{"match":{"keywords":["network","switch","ap","cabling","cctv"]},"route":"it_field"},{"match":{"keywords":["email","outlook","excel","laptop","password"]},"route":"it_support"}]`

Phase 3+ tech allocation:
- `DISPATCHER_TECH_PORTIONS_JSON={"it_support":[{"name":"Peggy Putra","weight":3},{"name":"Andre Febrian","weight":2}]}`

### WhatsApp Message Format (Professional + Consistent)
Message goals:
- short summary
- the action taken (assigned group)
- the ask (please pick up)
- link to ticket

Example (assignment):
- Title: `*New Unassigned Ticket Routed*`
- Key fields:
  - `*ID:* 12345`
  - `*Group:* ICT System and Support`
  - `*Priority (suggested):* High`
  - `*Subject:* ...`
  - `*Requester:* ...`
  - `*Created:* ...`
  - `*Link:* <url>`

Example (digest):
- Title: `*Ticket Digest (Shift)*`
- Sections:
  - `Unassigned: X`
  - `Open: Y`
  - `Aging > 24h: Z`
  - `Top 5 oldest: ...`

### ManageEngine SDP API Notes (Reuse Existing Integration)
Existing integration already supports:
- `viewRequest(id)` to fetch ticket details
- `updateRequest(id, { groupName, technicianName, status, priority, ... })`
- `assignTechnicianToRequest({ requestId, groupName, technicianName })`
- `getAllRequests(days)` for ID listing

Dispatcher will likely need one additional capability:
- List tickets by filter (unassigned/open) without scanning “all recent”
  - either:
    - implement a “search/list with criteria” function using SDP list API filtering
    - or maintain incremental scan using `getAllRequests(days)` then `viewRequest` and filter client-side (ok for low volume)

### Phase-by-Phase Implementation Plan

#### Phase 0 — Foundation (safe skeleton)
Deliverables:
- New dispatcher entrypoint (separate process) that can run on a schedule.
- Redis lock + per-ticket memory (fallback to in-memory).
- Config parsing and validation (fail fast if required env is missing).
- Dry-run mode to print decisions without writing to SDP.

Acceptance:
- Dispatcher runs without affecting WhatsApp gateway.
- Logs show how many tickets scanned and what would be done.

#### Phase 1 — Group routing for “unassigned”
Deliverables:
- Unassigned detection logic (status + missing owner/group/technician).
- Rules-first routing into 3 groups (doc control / it support / it field).
- Perform group assignment in SDP.
- Send WhatsApp message to the appropriate WA group JID.
- Idempotency: do not reassign if already assigned by dispatcher.

Acceptance:
- A truly unassigned ticket is assigned to the correct group once.
- No repeated notifications on subsequent scans.

#### Phase 2 — Reminders and operational digests
Deliverables:
- Reminder rules:
  - If still unassigned after X minutes, send reminder to triage/team group.
  - If assigned but still open after Y hours without status change, send follow-up.
- Digest:
  - Shift-based summary (scheduled cron)
  - Counts by group and age buckets

Acceptance:
- Reminders are rate-limited and non-spammy.
- Digest is readable and consistent.

#### Phase 3 — Technician assignment (load/portion based)
Deliverables:
- Define technician pool per group via config.
- Compute load per technician from SDP (open tickets count).
- Select technician:
  - weighted round-robin adjusted by current load
  - respect caps (max open tickets) and exclusions (manual override)
- Assign technician using SDP assign endpoint.
- Notify group + optionally mention tech.

Acceptance:
- Assignment is stable and does not thrash.
- Manual reassignment by human is respected (dispatcher backs off).

#### Phase 4 — AI-assisted routing and prioritization
Deliverables:
- AI classification fallback when rules uncertain:
  - returns route + suggested priority + short reason
- Safe guardrails:
  - only apply AI when confidence threshold is met
  - store decision trace for review
- Optionally: extract signal from description/attachments (existing attachment analysis can be reused carefully)

Acceptance:
- AI improves routing accuracy without increasing wrong assignments.

#### Phase 5 — Advanced capabilities (optional)
Options:
- Duplicate detection / incident clustering
- Escalation ladder (lead/manager escalation)
- Auto-clarification (ask requester for missing info)
- Handover summary
- Analytics dashboard export (CSV/JSON)

### Operational Considerations
- Rate limits:
  - cap SDP API calls per scan
  - cap WhatsApp notifications per window
- Backoff:
  - exponential backoff on SDP failures
- Observability:
  - structured logs per ticket action
  - “dry-run” and “live” modes

### Open Items to Confirm (before Phase 1 coding)
- Exact SDP group names (3 target groups) and their WA group JIDs.
- Exact meaning of “unassigned” in your SDP fields (group/owner/technician/status).
- Scan cadence (e.g., every 5 minutes) and reminder cadence (e.g., every 2 hours).
