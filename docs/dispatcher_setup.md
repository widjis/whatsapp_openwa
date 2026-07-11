# Dispatcher Setup (.env)

This document describes the dispatcher environment variables currently used in [.env](file:///Users/widjis/Documents/Projects/whatsapp_api_n8nv2/.env).

## Core Controls

### DISPATCHER_ENABLED
- Type: boolean (`true`/`false`)
- Purpose: Turns the dispatcher on/off.
- Notes:
  - When `false`, the dispatcher prints `Helpdesk dispatcher disabled` and does nothing.

### DISPATCHER_DRY_RUN
- Type: boolean
- Purpose: Safety switch.
- Behavior:
  - `true`: computes routing/assignment decisions and logs output, but does not update ServiceDesk and does not send WhatsApp notifications.
  - `false`: allows real updates/notifications (depending on `DISPATCHER_NOTIFY_MODE`, reminder mode, etc).

### DISPATCHER_RUN_ONCE
- Type: boolean
- Purpose: Controls scheduling mode.
- Behavior:
  - `true`: run exactly one scan, then stop scheduling future scans.
  - `false`: keep running on an interval (`DISPATCHER_SCAN_INTERVAL_SECONDS`).

### DISPATCHER_SCAN_INTERVAL_SECONDS
- Type: integer (seconds)
- Purpose: The scan interval when `DISPATCHER_RUN_ONCE=false`.
- Example:
  - `300` = every 5 minutes.

## Ticket Filtering (Age + Status)

### DISPATCHER_MIN_AGE_HOURS
- Type: number (hours)
- Purpose: Minimum ticket age required before the dispatcher may act.
- Why: Prevents assigning brand-new tickets immediately.
- Example:
  - `6` = only act on tickets created at least 6 hours ago.

### DISPATCHER_MAX_AGE_HOURS
- Type: number (hours)
- Purpose: Maximum ticket age window for dispatcher consideration.
- Why: Avoids acting on very old tickets and limits scan scope.
- Example:
  - `168` = 7 days.

### DISPATCHER_CLOSED_STATUSES
- Type: comma-separated list
- Purpose: Tickets in these statuses are treated as closed and skipped.
- Example:
  - `Resolved,Closed`

## Template Enforcement

If enabled, the dispatcher will set the request template before assigning group/ICT technician. This avoids mismatched UDF fields across templates.

### DISPATCHER_ENFORCE_TEMPLATE
- Type: boolean
- Purpose: Enable/disable template enforcement.
- Default: `true`

### DISPATCHER_REQUIRED_TEMPLATE_NAME
- Type: string
- Purpose: Required request template name.
- Default: `Submit a New Request`

### DISPATCHER_REQUIRED_TEMPLATE_ID
- Type: string
- Purpose: Required request template id.
- Default: `305`

### DISPATCHER_REQUIRED_TEMPLATE_IS_SERVICE
- Type: boolean
- Purpose: Whether the template is a service template.
- Default: `false`

## Scan + Action Limits

### DISPATCHER_MAX_TICKETS_PER_RUN
- Type: integer
- Purpose: Max number of tickets fetched/processed per scan cycle.
- Notes:
  - This limits how many tickets can influence load calculations and routing decisions in that cycle.

### DISPATCHER_MAX_ASSIGNMENTS_PER_RUN
- Type: integer
- Purpose: Hard cap on how many assignments/updates the dispatcher can perform per scan cycle.
- Notes:
  - In `DISPATCHER_DRY_RUN=true`, it still caps the number of planned assignments logged.

## Notifications (Dispatcher → WhatsApp Gateway)

### DISPATCHER_NOTIFY_MODE
- Type: enum: `none` | `direct` | `digest`
- Purpose: Controls whether and how WhatsApp messages are sent.
- Behavior:
  - `none`: no WhatsApp sends.
  - `direct`: send messages immediately to the target group/technician.
  - `digest`: collect and send a digest message (if configured).

### DISPATCHER_NOTIFY_MAX_PER_RUN
- Type: integer
- Purpose: Limits how many WhatsApp messages can be sent per scan cycle (when using direct notifications).

### DISPATCHER_GATEWAY_BASE_URL
- Type: URL
- Purpose: WhatsApp API gateway base URL used by the dispatcher to send messages.
- Example:
  - `http://127.0.0.1:8192`
- Notes:
  - Dispatcher uses `POST {DISPATCHER_GATEWAY_BASE_URL}/send-message`.

## Locking (Prevent Concurrent Scans)

### DISPATCHER_LOCK_TTL_SECONDS
- Type: integer (seconds)
- Purpose: Redis-based scan lock TTL to avoid overlapping scans.
- Notes:
  - If a scan is still running, other scans should not proceed.

## Group Routing Names

These define the ServiceDesk “Group” names that the dispatcher will set on tickets.

### DISPATCHER_GROUP_DOC_CONTROL
- Example: `Document Control`

### DISPATCHER_GROUP_IT_SUPPORT
- Example: `IT Support`

### DISPATCHER_GROUP_IT_FIELD
- Example: `IT Field Support`

### DISPATCHER_GROUP_TRIAGE
- Purpose: Default group used when routing is unclear (“triage”).
- Example: `IT Support`

## Logging / Observability

### DISPATCHER_LOG_ACTIONS
- Type: boolean
- Purpose: Include per-ticket details in dispatcher output logs (assignments/reminders/digest preview).

### DISPATCHER_LOG_ACTIONS_MAX
- Type: integer
- Purpose: Limit how many per-ticket items are included in logs per run.

## Technician Assignment Controls

These settings control which ICT technicians can be selected when the dispatcher assigns `udf_pick_601`.

### DISPATCHER_ICT_EXCLUDE
- Type: comma-separated list of ICT technician names
- Purpose: Prevent specific technicians from receiving dispatcher assignments (example: supervisors).
- Important:
  - Values must match the ticket field value / contact `ict_name` (case-insensitive compare is applied at runtime).
- Example:
  - `DISPATCHER_ICT_EXCLUDE=Supervisor Name (IT Support),Another Supervisor (IT Field Support)`

### DISPATCHER_ICT_MAX_OPEN
- Type: comma-separated map: `Name=Number`
- Purpose: Per-technician cap for “open tickets” load; if current load is >= cap, dispatcher will skip them.
- Example:
  - `DISPATCHER_ICT_MAX_OPEN=Supervisor Name (IT Support)=0,Tech A (IT Support)=12`

### DISPATCHER_ICT_WEIGHTS
- Type: comma-separated map: `Name=Number`
- Purpose: Weighted load balancing; higher weight means the technician can take more load.
- Example:
  - `DISPATCHER_ICT_WEIGHTS=Tech A (IT Support)=2,Tech B (IT Support)=1`

## AI Routing (OpenAI)

### DISPATCHER_AI_ROUTING_ENABLED
- Type: boolean
- Purpose: Enable AI-assisted routing (AI-first, heuristic fallback).
- Requirements:
  - `OPENAI_API_KEY` must be set.

### DISPATCHER_AI_CONFIDENCE_THRESHOLD
- Type: number (0..1)
- Purpose: Minimum confidence required to accept the AI route decision.
- Behavior:
  - If the AI confidence is below this threshold, the dispatcher falls back to heuristic routing.

### DISPATCHER_AI_MODEL
- Type: string
- Purpose: OpenAI model name used for routing.
- Example:
  - `gpt-4o-mini`

## AI Troubleshooting in Docker

If you still see `reason: keyword_match:*` while `DISPATCHER_AI_ROUTING_ENABLED=true`, the dispatcher fell back to heuristic routing.

To debug, check the dispatcher JSON output:
- `aiKeyPresent`: `true` means the running process can see `OPENAI_API_KEY`.
- `reason` values:
  - `ai:<...>` means AI route was used
  - `ai_fallback:missing_key|...` means the container didn’t receive `OPENAI_API_KEY`
  - `ai_fallback:parse_fail|...` means the model response couldn’t be parsed as JSON
  - `ai_fallback:low_conf(<n>)|...` means confidence was below `DISPATCHER_AI_CONFIDENCE_THRESHOLD`
  - `ai_fallback:exception|...` means the OpenAI call failed (network/timeout/etc)
