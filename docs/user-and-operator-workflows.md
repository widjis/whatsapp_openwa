# User and Operator Workflows

## Purpose
This document describes the practical workflows followed by operators and end users when interacting with this system.

It translates the feature specifications into operational paths that can later support:
- UX documentation
- SOPs
- migration validation scenarios
- acceptance testing

## Scope
This version focuses on the workflows tied to the highest-priority domains:
- session authentication and readiness
- helpdesk notification and ticket claim
- command bot usage and authorization

## Actor Types
- `Operator`: person responsible for bot runtime, session auth, and day-2 operations
- `Admin`: person authorized for privileged IT support commands
- `LAPS Admin`: admin with additional LAPS authority
- `Technician`: operational support staff member
- `Requester`: employee/end user who creates or owns a helpdesk ticket

## Workflow 1: Bring a WhatsApp Session Online

### Goal
Authenticate a WhatsApp session and make the bot ready for use.

### Primary actor
- Operator

### Trigger
- new deployment
- re-authentication after logout/session invalidation
- new phone number onboarding

### Happy path
1. Operator opens the local web UI.
2. System initializes session runtime.
3. If the session is not authenticated, the system emits QR state.
4. Operator scans the QR code.
5. System confirms connection open and emits ready state.
6. Bot begins receiving and sending messages.

### Alternative path: pairing mode
1. Operator enables pairing mode intentionally.
2. System requests pairing code.
3. Operator links the session using the code.
4. System transitions to ready state.

### Failure paths
- QR never appears
- repeated disconnect/reconnect loop
- session remains unauthorized
- connection opens then immediately closes

### Operator-visible outputs
- status text
- QR image
- ready confirmation
- reconnect or failure messages

### Migration validation relevance
This workflow must remain functionally identical after OpenWA migration, even if the underlying source of QR and status changes.

## Workflow 2: Send a Direct Message via HTTP API

### Goal
Allow another system or operator script to send a WhatsApp message.

### Primary actor
- external system
- operator

### Trigger
- API call to `/send-message`

### Happy path
1. Caller sends a request with target number and text or image content.
2. System validates caller IP.
3. System validates target number and payload shape.
4. System checks that the target number is registered on WhatsApp.
5. System sends the message.
6. System returns success response.

### Variants
- text message
- image by upload
- image by URL
- image by base64

### Failure paths
- caller IP not allowed
- socket/session not ready
- invalid number
- number not registered
- channel send failure

## Workflow 3: ServiceDesk New Ticket Notification

### Goal
Notify the correct WhatsApp target when a new helpdesk ticket appears.

### Primary actor
- ServiceDesk
- helpdesk group members
- requester

### Trigger
- `POST /webhook` with a new-ticket event

### Happy path
1. ServiceDesk sends webhook payload.
2. System validates payload and loads full ticket detail.
3. System enriches ticket if needed:
   - required template
   - suggested category
   - default priority
4. System renders receiver message.
5. System sends message to configured receiver chat or group.
6. System stores outbound message id for future claim handling.
7. If configured, system notifies requester.
8. System persists ticket state snapshot.

### Operator-visible result
- target group receives a structured ticket notification
- optional requester receives confirmation

### Important side effect
- the notification becomes claimable by reaction when sent to an allowed group

## Workflow 4: ServiceDesk Ticket Update Notification

### Goal
Notify stakeholders when a ticket changes meaningfully after creation.

### Primary actor
- ServiceDesk
- helpdesk group members
- requester
- technician

### Trigger
- `POST /webhook` with update event

### Happy path
1. System receives webhook.
2. System loads current ticket detail.
3. System loads previous ticket state.
4. System computes meaningful changes.
5. System renders update message for receiver.
6. System optionally notifies requester.
7. If technician changed, system may notify assigned technician.
8. System stores refreshed ticket state.

### Example change categories
- status changed
- priority changed
- technician changed

### Failure handling expectation
- optional requester/technician notification failure should not fail the main receiver notification

## Workflow 5: Technician Claims a Ticket by Reaction

### Goal
Allow the first eligible technician to claim a ticket directly from the WhatsApp notification.

### Primary actor
- Technician

### Preconditions
- ticket notification message was stored with ticket id and message id
- reaction happened in an allowed group
- reacting user is recognized as a technician

### Happy path
1. Technician reacts to the ticket message.
2. System receives reaction event.
3. System validates:
   - group is allowed
   - message is tracked
   - actor identity resolves correctly
   - actor is a recognized technician
4. System attempts atomic claim.
5. If the claim succeeds:
   - ticket is assigned in ServiceDesk
   - status may move to `In Progress`
   - claim record is updated
   - confirmation message is sent to the group

### Competing claim path
1. Another technician reacts after a claim already exists.
2. System detects existing claim.
3. System rejects the second claim.
4. System informs the group that the ticket has already been claimed.

### Failure paths
- reaction group not allowed
- actor not recognized as technician
- claim record missing
- ServiceDesk update fails
- storage lock/state error

## Workflow 6: Technician Unclaims a Ticket

### Goal
Allow the original claimer to release a claimed ticket by removing their reaction.

### Primary actor
- Technician who originally claimed the ticket

### Happy path
1. Original claimer removes their reaction.
2. System receives unclaim event.
3. System validates that the actor matches the original claimer.
4. System clears claim state.
5. System restores prior assignment/status context as defined by stored record.
6. System posts confirmation to the group.

### Rejection path
1. A different technician removes their own reaction from a claimed message.
2. System detects actor mismatch.
3. System rejects the unclaim.

## Workflow 7: Admin Resets a User Password

### Goal
Perform an AD password reset from WhatsApp chat.

### Primary actor
- Admin

### Trigger
- `/resetpassword <username> <newPassword> [/change]`

### Happy path
1. Admin sends command.
2. System parses command and requester identity.
3. System verifies requester is in admin allowlist.
4. System resolves target account in LDAP/AD.
5. System performs password reset.
6. System optionally forces password change at next logon.
7. System confirms success in chat.

### Failure paths
- malformed command
- requester identity cannot be normalized
- requester not authorized
- target account cannot be resolved
- LDAP update fails

## Workflow 8: LAPS Admin Retrieves Local Admin Password

### Goal
Allow an authorized actor to retrieve LAPS credentials for a hostname.

### Primary actor
- LAPS Admin
- delegated technician with `laps_access=true`

### Trigger
- `/getlaps <hostname>`

### Preconditions
- command is issued in private chat
- actor identity is authorized

### Happy path
1. Actor sends command in private chat.
2. System normalizes requester identity.
3. System checks LAPS-specific authorization.
4. System performs LDAP lookup.
5. System returns account, password, source, and expiration.

### Rejection paths
- command sent from group chat
- no LAPS admins configured
- actor not allowed
- LDAP account lacks permission to read LAPS data

## Workflow 9: Operator Manages Technician Directory

### Goal
Maintain technician master data used by helpdesk and dispatcher flows.

### Primary actors
- Admin
- LAPS Admin

### Common subflows

#### View list
1. Authorized user sends `/technician list`.
2. System loads technician master data.
3. System returns compact technician table.

#### Search
1. Authorized user sends `/technician search <query>`.
2. System filters by name, phone, email, or role.
3. System returns matched rows.

#### View detail
1. Authorized user sends `/technician view <id>`.
2. System returns detail card for the selected technician.

#### Add/update/delete
1. Elevated actor sends write command.
2. System checks higher-privilege authorization.
3. System validates payload.
4. System persists change.
5. System returns updated detail or confirmation.

#### Map leave schedule
1. Elevated actor runs `/technician mapleave`.
2. System loads leave schedule file.
3. System attempts exact/pattern/fuzzy mapping.
4. System returns updated, skipped, and unresolved results.

## Workflow 10: Conversational Message Routed to Automation

### Goal
Handle normal chat text without treating it as a command.

### Primary actor
- end user
- automation system

### Trigger
- inbound non-command message

### Happy path
1. System receives message.
2. System identifies whether chat is private or group.
3. For group chats, system decides whether bot is tagged and should reply.
4. System applies reply gateway logic.
5. If reply is allowed, the message is forwarded to automation flow such as N8N.
6. System relays the resulting reply back to chat.

### Rejection/skip paths
- group message without tag
- reply gateway chooses `no_reply`
- reply gateway chooses `mute`

## Migration Validation Checklist by Workflow

### Must remain valid after OpenWA migration
- session QR and ready workflow
- ServiceDesk new-ticket notification
- ticket claim by reaction
- ticket unclaim by reaction removal
- privileged command authorization based on normalized identity
- group/private context detection
- conversational automation routing

### Highest-risk workflows
- claim/unclaim by reaction
- session auth/recovery visibility
- conversational inbound payload mapping

## Recommended Next Workflow Documents
The next workflow documents that should be added are:

1. dispatcher operator workflow
2. multi-session operational workflow
3. re-authentication and recovery workflow
4. leave schedule maintenance workflow
