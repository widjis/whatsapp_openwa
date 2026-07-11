# Dispatcher Feature Specification

## Purpose
This document defines the expected behavior of the helpdesk dispatcher as a standalone automation domain.

It expands the dispatcher design notes in:
- `docs/helpdesk_dispatcher.md`
- `docs/dispatcher_setup.md`
- `docs/feature-inventory.md`
- `docs/feature-specifications.md`

## Objective
Automatically inspect ServiceDesk tickets, determine whether action is needed, assign the right group and ICT technician when appropriate, and notify the right recipients without creating spam or fighting manual human decisions.

## Primary Actors
- dispatcher runtime
- ServiceDesk
- technician directory
- helpdesk groups
- operators monitoring logs

## Dependencies
- ServiceDesk API integration
- technician contact directory
- optional Redis for lock/state
- optional OpenAI for AI-assisted routing
- optional leave schedule XLSX data
- outbound WhatsApp notification channel

## Inputs
- scheduled scan trigger
- dispatcher environment configuration
- recent ticket ids from ServiceDesk
- full ticket details from ServiceDesk
- technician master data
- leave schedule data
- prior dispatcher state

## Outputs
- group assignment updates in ServiceDesk
- ICT technician assignment updates in ServiceDesk
- optional template enforcement updates
- WhatsApp direct notifications
- digest messages
- reminder messages
- structured operational logs

## Core Responsibilities

### DSP-01 Run on schedule or once
The dispatcher must support:
- single-run execution
- continuous interval-based execution

Acceptance:
- `DISPATCHER_RUN_ONCE=true` runs one scan and stops
- `DISPATCHER_RUN_ONCE=false` schedules repeated scans

### DSP-02 Fail-safe enable/disable
The dispatcher must remain fully disabled unless explicitly enabled.

Acceptance:
- when `DISPATCHER_ENABLED=false`, the process logs disabled state and performs no scan

### DSP-03 Concurrency protection
The dispatcher must prevent overlapping scan executions.

Acceptance:
- Redis lock is preferred when available
- in-memory fallback exists when Redis is unavailable
- a second overlapping run does not process the same cycle concurrently

## Ticket Selection Rules

### DSP-04 Scan scope
The dispatcher must inspect only a bounded ticket set per run.

Acceptance:
- the ticket candidate list is limited by `DISPATCHER_MAX_TICKETS_PER_RUN`
- candidate age is bounded by `DISPATCHER_MIN_AGE_HOURS` and `DISPATCHER_MAX_AGE_HOURS`

### DSP-05 Closed ticket exclusion
The dispatcher must skip tickets already considered closed.

Acceptance:
- status names in `DISPATCHER_CLOSED_STATUSES` are treated as terminal

### DSP-06 Missing-data safe behavior
If the dispatcher cannot determine required ticket context such as creation time or ticket details, it must skip safely instead of guessing.

## Routing and Assignment Rules

### DSP-07 Rules-first routing
The dispatcher must route tickets heuristically before using AI fallback.

Current route families:
- `doc_control`
- `it_support`
- `it_field`
- `triage`

Acceptance:
- deterministic keyword routing is available without AI
- route result includes a human-readable reason

### DSP-08 AI-assisted routing
The dispatcher may call OpenAI only when AI routing is enabled.

Acceptance:
- AI result must parse into structured route decision
- confidence below threshold falls back to heuristic route
- missing API key falls back to heuristic route
- exceptions fall back to heuristic route

### DSP-09 Group assignment behavior
If the effective support group is missing, the dispatcher may assign the target group.

Acceptance:
- if an ICT technician already exists and implies a known group, the group may be inferred from technician mapping
- otherwise the dispatcher computes a route target group

### DSP-10 ICT technician assignment behavior
If the ICT technician field is missing or still in placeholder state, the dispatcher may assign an ICT technician based on load-aware selection.

Acceptance:
- excluded technicians are never selected
- leave schedule may remove unavailable technicians from the candidate set
- `DISPATCHER_ICT_MAX_OPEN` limits over-capacity technicians
- `DISPATCHER_ICT_WEIGHTS` influences weighted load balancing

### DSP-11 Template enforcement
When enabled, the dispatcher may enforce the required ServiceDesk template before or together with assignment changes.

Acceptance:
- template enforcement is configurable
- template mismatch alone may trigger an update even when assignment does not change

## Manual Override Safety

### DSP-12 Respect manual intervention
The dispatcher must not aggressively overwrite recent human changes.

Acceptance:
- dispatcher compares current group/ICT values against previously recorded dispatcher assignments
- within `DISPATCHER_MANUAL_OVERRIDE_BACKOFF_HOURS`, conflicting manual changes are respected and skipped

## Notification Rules

### DSP-13 Direct notification mode
When `DISPATCHER_NOTIFY_MODE=direct`, the dispatcher may send immediate messages to resolved technician phones for the target group.

Acceptance:
- notification count is limited by `DISPATCHER_NOTIFY_MAX_PER_RUN`
- repeated identical notifications are suppressed using notification hash state

### DSP-14 Digest notification mode
When `DISPATCHER_NOTIFY_MODE=digest`, the dispatcher must collect changes and send summary-style digest messages instead of immediate notifications.

Acceptance:
- digest recipients come from `DISPATCHER_DIGEST_NUMBERS`
- digest content is compact and operationally readable

### DSP-15 Reminder workflows
The dispatcher may send reminder notifications for aging tickets in three main situations:
- still unassigned
- group assigned but ICT technician still unpicked
- assigned but still open after configured duration

Acceptance:
- reminder type is explicit
- reminder target is derived from ticket state
- reminder rate is limited by cooldown and per-run caps

### DSP-16 Operational digest
The dispatcher may send operational digest snapshots on configured schedule hours.

Digest content should include:
- total open tickets
- counts by group
- age buckets
- top unassigned or aging items

Acceptance:
- one digest per configured time window
- duplicate send is prevented by digest sent marker

## State Model

### DSP-17 Per-ticket dispatcher state
The dispatcher must track enough state to avoid thrash and duplicate communication.

Tracked state should include:
- `lastActionAtIso`
- `lastAssignedGroupName`
- `lastAssignedIctTechnician`
- `lastNotifiedHash`
- `lastReminderAtIso`
- `lastReminderHash`

Acceptance:
- Redis is preferred when available
- in-memory fallback exists

### DSP-18 Verification after update
After live assignment changes, the dispatcher must re-read the ticket to verify the intended state actually applied.

Acceptance:
- template, group, and ICT technician verification are explicit
- failed verification is logged as an error and not treated as success

## Leave Schedule Integration

### DSP-19 Optional leave-aware selection
When leave schedule filtering is enabled, technician selection must use leave schedule presence data before assignment.

Acceptance:
- unavailable or unresolved technicians may be excluded from auto-selection
- dispatcher continues without leave filtering if the leave file cannot be loaded

## Logging and Observability

### DSP-20 Structured run logs
Each scan should emit a structured summary containing:
- run count
- dry run or live mode
- notification mode
- AI enabled state
- caps and thresholds
- stats
- optional assignment/reminder details

### DSP-21 Heartbeat logs
Between runs, the dispatcher should emit heartbeat data containing:
- current time
- next run time
- scan interval

### DSP-22 Dry-run clarity
Dry-run execution must clearly show what would have happened without mutating ServiceDesk or sending notifications.

## Failure Handling

### DSP-23 Partial resilience
Individual ticket errors must not abort the whole scan run.

### DSP-24 Safe fallback posture
If required external data is unavailable:
- no unsafe assignment guesses should be made
- fallback routing may still happen only where explicitly supported
- notification suppression and rate limiting must remain active

## Non-Functional Requirements
- bounded API usage per run
- bounded notification volume per run
- idempotent behavior over repeated scans
- readable operational logs
- graceful degradation when Redis, AI, or leave schedule is unavailable

## Current Delivery Model
Today the dispatcher sends WhatsApp notifications by calling:
- `POST {DISPATCHER_GATEWAY_BASE_URL}/send-message`

This means the dispatcher is already partially decoupled from the raw WhatsApp engine, which is good for migration.

## OpenWA Migration Implications

### What should remain unchanged
- routing rules
- load balancing rules
- manual override protection
- reminder and digest policy
- Redis state model
- leave schedule filtering

### What should change
- outbound notification channel should target an internal channel adapter rather than assuming Baileys-backed `/send-message`
- session/runtime health checks should use OpenWA-aware channel state if needed

## Acceptance Checklist
The dispatcher domain is considered preserved in migration only if all of the following remain true:

1. unassigned tickets are routed once without thrash
2. technician auto-pick respects exclusions, load, and leave data
3. reminders do not spam
4. digests remain readable and scheduled correctly
5. manual reassignment by humans is respected
6. notification dedupe still works after transport change

## Recommended Next Document
After this spec, the next useful companion is:
- OpenWA integration contract for dispatcher notification delivery and channel event assumptions
