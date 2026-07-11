## [2025-12-29] Add Missing extractMessageContent Function
- Change:
  - Added `extractMessageContent` function to `index.js`.
  - Implemented logic to extract text from `conversation`, `imageMessage`, `videoMessage`, `extendedTextMessage`, `documentMessage`, `buttonsResponseMessage`, `listResponseMessage`, `templateButtonReplyMessage`, and `ephemeralMessage`.
- Reason:
  - The function was referenced in `messages.upsert` handler but was not defined, causing runtime errors.
- Impact:
  - Fixes the `ReferenceError: extractMessageContent is not defined`.
  - Enables correct message content logging and processing for various message types.

## [2025-12-29] Initialize README for API Gateway
- Change:
  - Added `README.md` documenting setup, configuration, endpoints, and inbound handling.
- Reason:
  - Provide clear instructions for installing, configuring, and using the API.
- Impact:
  - Improves onboarding and integration. No runtime changes.

## [2025-12-29] Add /resetpassword Command with LDAP Support
- Change:
  - Implemented `/resetpassword` command in `handleCommand`.
  - Added LDAP client helper and `resetPassword` function.
  - Introduced `ALLOWED_PHONE_NUMBERS` check for admin authorization.
  - Added `ldapjs` dependency.
- Reason:
  - Enable admin-controlled password resets via WhatsApp.
- Impact:
  - Requires `.env` variables: `LDAP_URL`, `BIND_DN`, `BIND_PW`, `BASE_OU`, `ALLOWED_PHONE_NUMBERS`.
  - Security-sensitive; restricted to authorized phone numbers.

## [2026-01-05] Add local lint and typecheck commands
- Change:
  - Added `lint` script to run `node --check` against core files.
  - Added `typescript` dev dependency and `tsconfig.json` for `npx tsc --noEmit`.
  - Updated README with the new check commands.
- Reason:
  - Provide a repeatable local integrity check before running the service.
- Impact:
  - Enables `npm run lint` and `npx tsc --noEmit` for quick verification.

## [2026-01-31] Add Qontak WhatsApp direct-send test script
- Change:
  - Added `qontak.js` for sending a WhatsApp template via Qontak Open API.
  - Updated lint/typecheck coverage to include `qontak.js`.
  - Updated README with environment variables and run command.
- Reason:
  - Enable quick verification of Qontak WhatsApp sending from this repo.
- Impact:
  - Requires Qontak/Mekari credentials and a template/channel integration.

## [2026-02-01] Add Qontak template listing command
- Change:
  - Added `list-templates` command in `qontak.js`.
  - Updated README with the list templates command.
- Reason:
  - Enable discovering template IDs and metadata needed for outbound sends.
- Impact:
  - Uses the same Qontak auth mode as sending (HMAC or Bearer).

## [2026-02-01] Fix Qontak env keys
- Change:
  - Normalized Qontak-related `.env` keys and added missing assignments.
- Reason:
  - Prevent misconfigured environment variables from breaking Qontak commands.
- Impact:
  - Enables `node qontak.js list-templates` to read required env consistently.

## [2026-02-01] Add OAuth refresh support for Qontak bearer auth
- Change:
  - Added optional Mekari OAuth2 refresh-token flow to `qontak.js` when using bearer auth.
  - Added CLI overrides for bearer credentials when running `qontak.js`.
  - Retried OAuth refresh using JSON, form, and basic auth.
- Reason:
  - Reduce 401 errors caused by expired access tokens.
- Impact:
  - Allows `QONTAK_AUTH_MODE=bearer` to work with either a fixed access token or refresh-token settings.

## [2026-02-01] Fix Qontak HMAC signing secret handling
- Change:
  - Updated `qontak.js` to use `MEKARI_API_CLIENT_SECRET` as-is for HMAC signing.
- Reason:
  - Prevent signature mismatches caused by decoding or transforming the secret.
- Impact:
  - Reduces risk of 401 Unauthorized when using HMAC auth.

## [2026-02-01] Improve template listing endpoint fallback
- Change:
  - Updated `qontak.js` to try an alternate templates endpoint when the default path is not found.
- Reason:
  - Some Qontak environments expose WhatsApp templates under different chat API paths.
- Impact:
  - Makes `list-templates` more resilient across deployments.

## [2026-02-15 12:29:22 WITA] Convert runtime to modular TypeScript
- Change:
  - Added `src/` TypeScript entrypoint and extracted WhatsApp, HTTP, LDAP, and N8N modules.
  - Updated scripts for dev (`tsx`) and prod build (`tsc` to `dist/`).
- Reason:
  - Improve maintainability and type-safety while keeping the same runtime behavior.
- Impact:
  - Use `npm run dev` for local development and `npm run build && npm start` for production.

## [2026-02-15 12:32:39 WITA] Move legacy JS into reference folder
- Change:
  - Moved prior JS entrypoints/scripts into `reference/`.
- Reason:
  - Keep old implementations for comparison without cluttering the root.
- Impact:
  - Runtime now uses `src/` and `dist/`; legacy JS remains available under `reference/`.

## [2026-02-15 12:48:43 WITA] Copy legacy /help behavior
- Change:
  - Updated `/help` to support `/help` (list) and `/help <command>` (details).
- Reason:
  - Preserve legacy help UX from `reference/index_old.js`.
- Impact:
  - Users can discover available commands and view per-command usage text.

## [2026-02-15 12:56:04 WITA] Port legacy /finduser command
- Change:
  - Added `/finduser <name> [/photo]` command implementation in TypeScript.
  - Added LDAP search helper for CN matching and optional AD photo retrieval.
- Reason:
  - Preserve legacy AD lookup behavior from `reference/index_old.js`.
- Impact:
  - Requires search base DN env: `BASE_DN` (or `LDAP_BASE_DN` / `BASE_OU`).

## [2026-02-15 12:59:12 WITA] Fix /finduser attribute parsing
- Change:
  - Fixed LDAP search entry parsing to use `ldapjs` SearchEntry `pojo.attributes`.
  - Improved field fallbacks (mail/telephoneNumber) and photo extraction.
- Reason:
  - Prevent blank/Unknown results when LDAP returns attributes but entry object parsing was wrong.
- Impact:
  - `/finduser` now renders user fields when returned by LDAP.

## [2026-02-15 13:03:33 WITA] Fix /finduser photo extraction
- Change:
  - Improved photo extraction to handle AD attribute variants (e.g. `thumbnailPhoto;binary`).
  - Added base64 decode fallback when binary buffers are not exposed.
- Reason:
  - Prevent false "No photo available" when photo exists in AD.
- Impact:
  - `/finduser <name> /photo` sends photos more reliably.

## [2026-02-15 13:13:00 WITA] Restore legacy DB photo lookup for /finduser
- Change:
  - Ported `getUserPhotoFromDB` logic from `reference/modules/db.js` into TypeScript.
  - `/finduser ... /photo` now falls back to SQL Server `CardDB.PHOTO` by `StaffNo`.
- Reason:
  - Legacy implementation loads photos from the database (not from LDAP attributes).
- Impact:
  - Uses existing env vars: `DB_USER`, `DB_PASSWORD`, `DB_SERVER`, `DB_DATABASE` (optional `DB_PORT`).

## [2026-02-15 13:24:09 WITA] Convert legacy ticket_handle module to TypeScript
- Change:
  - Ported `reference/modules/ticket_handle.js` into `src/features/integrations/ticketHandle.ts`.
  - Moved ServiceDesk base URL and token to env (`SD_BASE_URL`, `SERVICE_DESK_TOKEN`).
- Impact:
  - Added required dependencies for ServiceDesk + attachment analysis (axios, jsdom, pdf-parse, form-data, openai, tesseract.js, @google/generative-ai).

## [2026-02-15 13:32:59 WITA] Port technicianContacts to TypeScript and wire /technician command
- Change:
  - Added `src/features/integrations/technicianContacts.ts` to manage contacts stored in JSON.
  - Implemented `/technician` CRUD commands in WhatsApp handler.
- Impact:
  - Uses `DATA_DIR` if set; otherwise reads/writes `data/technicianContacts.json`.

## [2026-02-15 13:35:38 WITA] Move technician contacts default storage to data/
- Change:
  - Default technician contacts storage moved from `reference/` to `data/technicianContacts.json`.
- Impact:
  - Keeps reference folder for legacy-only; runtime now uses `data/` unless `DATA_DIR` is set.

## [2026-02-15 13:36:24 WITA] Ignore local technicianContacts.json from git
- Change:
  - Added `data/technicianContacts.json` to `.gitignore`.
- Reason:
  - Keep local operational data out of the repository.

## [2026-02-15 13:48:15 WITA] Port legacy /send-group-message HTTP endpoint
- Change:
  - Added `/send-group-message` route with optional document/image upload and mentions.
- Impact:
  - Supports `id` (group JID) or `name` (search by group subject) and JSON `mention` arrays.

## [2026-02-15 13:53:33 WITA] Fix /resetpassword authorization for group chats
- Change:
  - Updated `/resetpassword` requester detection to use the sender participant when invoked in group chats.
- Reason:
  - Group chat messages use a group JID (`@g.us`), so extracting the phone from the chat ID breaks authorization.
- Impact:
  - `/resetpassword` can be executed from group chats by numbers listed in `ALLOWED_PHONE_NUMBERS`.

## [2026-02-15 14:03:12 WITA] Fix LDAP resetPassword modification payload
- Change:
  - Updated LDAP `Change.modification` for `/resetpassword` to use Attribute-shaped objects (`{ type, values }`).
- Reason:
  - ldapjs `Change` requires `modification` to be an Attribute (or Attribute-shaped object), otherwise it throws `modification must be an Attribute`.
- Impact:
  - `/resetpassword` no longer fails early with the modification format error.

## [2026-02-15 14:05:14 WITA] Resolve resetPassword DN via LDAP search
- Change:
  - Updated `/resetpassword` to resolve the target user's DN by searching LDAP before modifying.
- Reason:
  - Using `CN=<username>` fails when the command input is `sAMAccountName` (e.g. `widji.santoso`), causing `No Such Object`.
- Impact:
  - `/resetpassword <sAMAccountName> ...` now targets the correct DN when `BASE_DN`/`LDAP_BASE_DN`/`BASE_OU` is set.

## [2026-02-15 14:07:21 WITA] Expand resetPassword lookup to match /finduser style
- Change:
  - Expanded `/resetpassword` user lookup to try exact and partial matches across common AD attributes.
- Reason:
  - Operators may provide displayName/CN fragments similar to `/finduser`, and exact `sAMAccountName` may differ from the provided identifier.
- Impact:
  - `/resetpassword` can resolve users via `sAMAccountName`, `userPrincipalName`, `mail`, `cn`, or `displayName` when the match is unique.

## [2026-02-15 14:09:28 WITA] Improve resetPassword lookup for AD email aliases
- Change:
  - Added lookup fallback for mail aliases like `first.last` by searching UPN/mail/proxyAddresses patterns.
  - Tightened search to `objectCategory=person` and `objectClass=user`.
- Reason:
  - Some environments use different `sAMAccountName` formats; operators often know the email alias instead.
- Impact:
  - `/resetpassword widji.santoso ...` can resolve accounts where UPN/mail is `widji.santoso@...`.

## [2026-02-15 14:03:17 WITA] Implement legacy ServiceDesk webhook in TypeScript HTTP server
- Change:
  - Added `/webhook` route to send WhatsApp notifications on new/updated ServiceDesk tickets.
  - Added ticket state storage (Redis when available, otherwise in-memory) to detect technician/status/priority changes.
  - Added ServiceDesk technician assignment helper via `PUT /requests/:id/assign`.
- Impact:
  - Requires `SD_BASE_URL` and `SERVICE_DESK_TOKEN` (already used by ServiceDesk integration).
  - Optional: `REDIS_HOST`/`REDIS_PORT` for persistent state across restarts; falls back to in-memory.

## [2026-02-15 14:14:55 WITA] Fix resetPassword DN extraction from LDAP search entries
- Change:
  - Updated DN extraction for `/resetpassword` lookup to use `ldapjs` SearchEntry `pojo.objectName`.
- Reason:
  - `SearchEntry.objectName` may not be a string in ldapjs, causing DN resolution to return zero matches.
- Impact:
  - `/resetpassword <sAMAccountName> ...` can correctly resolve the target DN and proceed with password reset.

## [2026-02-15 14:19:12 WITA] Add first-reaction ticket claim flow
- Change:
  - Stored the outbound WhatsApp message ID for each new ticket notification.
  - Added reaction handler to let the first technician claim a ticket.
  - Claim updates ServiceDesk status to `In Progress` and assigns the technician.
- Impact:
  - Requires `TICKET_REACTION_GROUP_IDS` (comma-separated group JIDs) to enable claiming.
  - Uses `REDIS_HOST`/`REDIS_PORT` when available for durable claim locking.

## [2026-02-15 14:19:28 WITA] Port legacy /getbitlocker command
- Change:
  - Added `/getbitlocker <hostname>` command to lookup BitLocker recovery keys via LDAP.
- Impact:
  - Requires `LDAP_BASE_DN` (or `BASE_DN` / `BASE_OU`) plus LDAP bind settings.

## [2026-02-15 14:22:18 WITA] Port legacy /getasset command
- Change:
  - Added `/getasset [type]` command backed by Snipe-IT API.
  - Added Snipe-IT integration module and category mapping.
- Impact:
  - Requires `SNIPEIT_URL` and `SNIPEIT_TOKEN`.

## [2026-02-15 14:23:12 WITA] Improve /getbitlocker message formatting
- Change:
  - Reformatted `/getbitlocker` WhatsApp output with clearer headings and key sections.

## [2026-02-24 12:37:03 WIB] Stabilize Baileys connection versioning
- Change:
  - Pinned `@whiskeysockets/baileys` to `6.6.0` (was `latest`).
  - Pinned `pino` to `^7.0.0` to match Baileys logger types.
  - Added optional `WA_VERSION` env override and safe fallback versioning in WhatsApp startup.
  - Normalized `downloadMediaMessage` results to Buffer for stream/Uint8Array returns.
- Reason:
  - Prevent recurring `405 Method Not Allowed` and type mismatches from shifting `latest` dependency updates.
- Impact:
  - Startup becomes deterministic across environments; `WA_VERSION` can be tuned without code changes.

## [2026-02-25 08:15:44 WIB] Add /webhook test utility
- Change:
  - Added `src/webhookTest.ts` and `npm run webhook:test` to POST a webhook payload.
- Reason:
  - Make it easy to verify `/webhook` end-to-end from local/dev environments.
- Impact:
  - Requires a real ServiceDesk ticket ID (`--id`) and a receiver JID/phone (`--receiver`) to exercise the route.

## [2026-02-25 08:28:59 WIB] Prevent /webhook 500 from optional LDAP and notification failures
- Change:
  - Made requester mobile lookup by email return null when LDAP is unavailable/misconfigured.
  - Made requester/technician WhatsApp notifications best-effort to avoid failing the whole webhook.
- Impact:
  - `/webhook` continues sending the main receiver notification even if LDAP or optional notifications fail.

## [2026-02-25 09:06:08 WIB] Add requestId and safe reason to /webhook 500 response
- Change:
  - Included a requestId in `/webhook` 500 responses and logged stack traces server-side.
  - Returned a safe reason when the error is a missing env var message.

## [2026-02-25 09:11:21 WIB] Return 200 even if WhatsApp sendMessage fails
- Change:
  - Made `/webhook` return 200 with `receiverSent`/`receiverError` when Baileys sendMessage fails (e.g. `not-acceptable`).

## [2026-02-25 13:39:54 WIB] Add group precheck for admin-only posting before webhook send
- Change:
  - Added a group metadata precheck to detect admin-only groups and return `group-admin-only` instead of Baileys `not-acceptable`.
  - Added `receiverMeta` fields to `/webhook` response for easier troubleshooting.

## [2026-02-25 13:58:51 WIB] Improve bot membership detection for group precheck
- Change:
  - Improved group participant matching to handle multi-device JIDs and alternate user identifiers.

## [2026-02-25 14:02:28 WIB] Log structured Baileys error details for webhook sends
- Change:
  - Logged structured error details from Baileys send failures to help diagnose `not-acceptable`.

## [2026-02-25 14:21:58 WIB] Remove admin-only blocking from webhook group precheck
- Change:
  - Removed `group-admin-only` blocking logic; webhook always attempts send and reports actual Baileys result.

## [2026-02-25 14:49:11 WIB] Upgrade Baileys to latest
- Change:
  - Upgraded `@whiskeysockets/baileys` to `7.0.0-rc.9` and updated lockfile.

## [2026-03-13 22:58:10 WITA] Ignore data directory from git
- Change:
  - Updated `.gitignore` to ignore `data/`.

## [2026-03-14 19:44:48 WITA] Fix /resetpassword requester phone parsing across JID formats
- Change:
  - Updated requester extraction to reuse shared JID digit parser instead of hardcoded `@s.whatsapp.net` regex.
  - Expanded JID digit extraction fallback to parse local-part digits for alternate WhatsApp JID variants.
- Reason:
  - `/resetpassword` could fail with `Invalid phone number format.` when sender JID did not match the strict legacy pattern.
- Impact:
  - `/resetpassword` authorization resolves requester phone consistently across group and private message JID formats.

## [2026-03-14 19:56:59 WITA] Implement license command handlers in current WhatsApp project
- Change:
  - Added Snipe-IT license integration functions for list, lookup, expiring, and utilization report flows.
  - Implemented `/licenses`, `/getlicense`, `/expiring`, and `/licensereport` command handlers in `src/features/whatsapp/start.ts`.
  - Connected command handlers to typed Snipe-IT responses with user-facing validation and error messages.

## [2026-03-15 21:40:43 WITA] Add secure LAPS lookup command for hostname
- Change:
  - Added LDAP LAPS retrieval function that reads modern (`msLAPS-Password`) and legacy (`ms-Mcs-AdmPwd`) attributes.
  - Added `/getlaps <hostname>` command with private-chat enforcement and allowlist authorization checks.
  - Updated help text and command details to include `/getlaps`.

## [2026-03-15 21:52:56 WITA] Improve LAPS troubleshooting visibility
- Change:
  - Added detection for "expiration present but password hidden" condition in LDAP LAPS lookup.
  - Updated `/getlaps` backend error to clearly indicate bind account read-permission gap for password attributes.
  - Verified lookup for `MTI-NB-373` now returns explicit permission-related diagnostics.

## [2026-03-15 21:57:41 WITA] Add optional PowerShell bridge fallback for encrypted LAPS
- Change:
  - Added optional fallback in `getLapsInfo` to call external bridge when LDAP cannot read plaintext password attributes.
  - Added env-based bridge config support: `LAPS_POWERSHELL_URL` and optional `LAPS_POWERSHELL_TOKEN`.
  - Kept current LDAP-first behavior and retained explicit diagnostics when no bridge is configured.

## [2026-03-15 22:02:45 WITA] Add /getlapsdiag command for live LDAP permission checks
- Change:
  - Added `getLapsDiagnostics` in LDAP integration to report safe LAPS attribute visibility without exposing secrets.
  - Added `/getlapsdiag <hostname>` command with private chat and allowlist authorization checks.
  - Verified diagnostics for `MTI-NB-373` show encrypted LAPS path visibility (`msLAPS-EncryptedPassword=true`) while plaintext attributes remain hidden.

## [2026-03-16 09:09:08 WITA] Add LAPS admin + technician access management
- Change:
  - Added `LAPS_ADMIN_PHONE_NUMBERS` for LAPS admin authorization (falls back to `ALLOWED_PHONE_NUMBERS` when unset).
  - Added `laps_access` flag to technician contacts and displayed it in `/technician list` and `/technician view`.
  - Updated `/getlaps` and `/getlapsdiag` to allow LAPS admins and technicians with `laps_access=true`.
  - Restricted technician contact write operations (`add`, `update`, `delete`, `mapleave`) to LAPS admins.

## [2026-03-16 09:33:26 WITA] Add /setlaps command for admin LAPS access toggling
- Change:
  - Added `/setlaps technician <id> /a|/d` command for LAPS admins to grant/revoke technician `laps_access`.
  - Updated command help and README to document `/setlaps`.

## [2026-03-16 11:09:47 WITA] Add DEBUG_LAPS_AUTH logging for authorization troubleshooting
- Change:
  - Added `DEBUG_LAPS_AUTH=true` support to log masked authorization decisions for `/getlaps`, `/getlapsdiag`, and `/setlaps`.

## [2026-07-01 15:58:00 WITA] Restore WhatsApp QR generation on latest protocol
- Change:
  - Added runtime instrumentation for WhatsApp connection lifecycle to capture socket init, `connection.update`, QR emission, and close code `428`.
  - Confirmed local `@whiskeysockets/baileys@7.0.0-rc.9` still used `UserAgent.Platform.WEB` internally, which prevented QR generation.
  - Added `postinstall` patch script to rewrite Baileys validate-connection platform to `MACOS` so QR generation survives fresh installs and Docker builds.

## [2026-07-10 11:20:00 WITA] Add supporting docs for architecture, deployment, and operations
- Change:
  - Added `docs/architecture-decisions.md` to capture runtime components, storage model, multi-instance design, and integration boundaries.
  - Added `docs/deployment-and-environment.md` to document runtime modes, key env groups, per-service overrides, and Docker multi-instance guidance.
  - Added `docs/operational-runbook.md` to document daily operations, re-auth steps, QR troubleshooting, and container verification commands.

## [2026-07-10 15:05:00 WITA] Add OpenWA migration planning docs
- Change:
  - Added `docs/openwa-compatibility-matrix.md` to map current repository capabilities against OpenWA API `0.7.17`.
  - Added `docs/feature-inventory.md` as the canonical feature inventory grouped by product domain and migration impact.
  - Added `docs/openwa-target-architecture.md` to define the recommended adapter-based migration boundary from Baileys to OpenWA.

## [2026-07-10 15:35:00 WITA] Add feature specs and workflow docs for migration foundation
- Change:
  - Added `docs/feature-specifications.md` to define feature requirements for session management, helpdesk notification and claim flow, and command bot operations.
  - Added `docs/user-and-operator-workflows.md` to describe operator and user flows for session auth, helpdesk ticket handling, claim/unclaim behavior, and privileged command usage.

## [2026-07-10 16:05:00 WITA] Add dispatcher spec and OpenWA integration contracts
- Change:
  - Added `docs/dispatcher-feature-specification.md` to formalize dispatcher scheduling, routing, assignment, reminder, digest, and safety behavior.
  - Added `docs/openwa-integration-contracts.md` to define the adapter contract between this repository and OpenWA for sessions, outbound messaging, directory lookups, and webhook event normalization.

## [2026-07-10 16:25:00 WITA] Add migration roadmap and validation planning docs
- Change:
  - Added `docs/implementation-roadmap.md` to define phased OpenWA migration work from payload validation through cutover.
  - Added `docs/open-questions-and-challenges.md` to track unresolved payload and migration ambiguities that must not be assumed away.
  - Added `docs/openwa-validation-plan.md` to define scenario-based evidence collection for session lifecycle, inbound events, reactions, media, and webhook security.
