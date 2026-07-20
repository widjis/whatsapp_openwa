## [2026-07-12] Wire normalized reaction events into root claim flow
- Change:
  - Extended `src/features/inbound/commandService.ts` with normalized `message.reaction` handling for allowed-group gating, duplicate-event suppression, `@lid` actor phone resolution, tracked-message lookup, claim, and unclaim.
  - Connected `src/features/http/routes/webhooks.ts` so normalized reaction events are no longer just logged; they now invoke the root claim/unclaim business flow.
  - Updated roadmap and integration-contract notes to reflect that reaction add/remove normalization is now implemented in the root runtime.
- Reason:
  - Move the rebuild from passive reaction evidence collection into active helpdesk claim/unclaim execution on top of the new OpenWA webhook path.
- Impact:
  - Reaction events in allowed groups can now reach `claimStore` and ServiceDesk update logic in the root app.
  - Full parity is still pending real end-to-end validation against a tracked ticket notification and live ServiceDesk update behavior.
  - Verification completed with `npm run lint`, `npm run build`, and a local smoke check covering group gating, `@lid` resolution, and reaction dedupe.

## [2026-07-12] Port root ServiceDesk webhook scaffolding
- Change:
  - Added `src/features/integrations/serviceDesk.ts` with root helpers for `viewRequest`, `updateRequest`, `assignTechnicianToRequest`, `buildTicketLink`, and `defineServiceCategory`.
  - Added `src/features/tickets/ticketStateStore.ts` with in-memory plus optional Redis-backed ticket state persistence.
  - Extended `src/features/http/routes/messages.ts` with `POST /webhook` to process ServiceDesk new/update notifications, send WhatsApp messages, register claimable outbound message ids, persist ticket state, and perform best-effort requester/technician notifications.
  - Updated `docs/openapi.yaml` to document the new `/webhook` contract.
- Reason:
  - Remove the biggest remaining gap between root runtime behavior and the reference helpdesk notification path so claim/unclaim wiring can proceed on top of real tracked outbound notifications.
- Impact:
  - The root app now has a concrete ServiceDesk ingress route instead of only downstream claim storage.
  - Requester notification currently uses requester mobile from ServiceDesk payload when available; LDAP email-to-mobile fallback is still pending in the root route.
  - Phase 4 checklist is still not checked off because end-to-end operator verification against real ServiceDesk and WhatsApp runtime has not been completed yet.
  - Verification completed with `npm run lint`, `npm run build`, and an Express route-registration smoke check confirming `POST /webhook` is present in the root app.

## [2026-07-12] Confirm reaction removal semantics and port root claim store
- Change:
  - Confirmed from live runtime evidence that OpenWA sends reaction removal on `message.reaction` with `payload.data.reaction = ""`.
  - Updated roadmap and open-questions docs so reaction removal is no longer treated as unknown.
  - Added `src/features/tickets/claimStore.ts` to the root app with in-memory storage plus optional Redis-backed claim persistence and locking.
  - Verified root `claimStore` lifecycle with `store -> claim -> unclaim -> load` in local memory mode.
- Reason:
  - Remove the last major ambiguity around reaction removal before wiring reaction events into the rebuilt helpdesk claim workflow.
- Impact:
  - The root app now has a reusable persistence layer for claim/unclaim state.
  - Full claim/unclaim workflow is still pending because the root ServiceDesk `/webhook` notification path has not yet been ported to create tracked outbound ticket notifications.
  - Verification completed with `npm run lint`, `npm run build`, live runtime capture inspection, and local `claimStore` lifecycle execution.

## [2026-07-12] Implement webhook test injection endpoint in root app
- Change:
  - Added `POST /channel/webhooks/test` to the root webhook routes with IP-allowlist protection.
  - Refactored webhook ingestion so live and test webhook payloads share the same capture, normalization, and command-processing pipeline.
  - Updated `docs/openapi.yaml` to document the new test endpoint contract.
- Reason:
  - Remove the mismatch between roadmap, implementation, and OpenAPI while keeping a practical local verification path for webhook processing.
- Impact:
  - Admin callers can now inject simulated webhook payloads without bypassing the real webhook processing path.
  - `docs/implementation-roadmap.md`, code, and `docs/openapi.yaml` now agree that `/channel/webhooks/test` exists.

## [2026-07-12] Document current root HTTP contract in OpenAPI
- Change:
  - Expanded `docs/openapi.yaml` from a placeholder into a route-level contract for the current root app.
  - Documented active health, message, session, and webhook endpoints, including request bodies, success envelopes, validation failures, and IP-allowlisted admin routes.
- Reason:
  - Make the new OpenAPI maintenance contract immediately actionable by reflecting the backend surface that already exists today.
- Impact:
  - Future backend work now has a concrete HTTP contract baseline to update instead of an empty placeholder.
  - The documented contract reflects implemented routes only; this exposed that roadmap references to `/channel/webhooks/test` are not currently backed by an active route.

## [2026-07-12] Add explicit OpenAPI maintenance contract
- Change:
  - Strengthened `AGENT.md` so every backend change must review `docs/openapi.yaml` and update it in the same work item when the contract changes.
  - Updated `README.md` to include `docs/openapi.yaml` in the source-of-truth entry list and backend contract rules.
  - Added baseline `docs/openapi.yaml` so the repository has a concrete contract file to keep synchronized.
- Reason:
  - Make OpenAPI synchronization an explicit repository rule instead of an implied habit.
- Impact:
  - Future backend work must now state whether `docs/openapi.yaml` changed and why.

## [2026-07-12] Validate reaction and media webhook payloads from real OpenWA captures
- Change:
  - Confirmed real `message.reaction` webhook captures are present in `data/webhook-captures/32ef5424-31fd-4b02-9508-f846f2a29c7b.json`, `cc5f5de5-5a55-42de-979f-466f168a9390.json`, and `ce56abc3-a1e3-4e5e-bde5-a47c2f793b9b.json`.
  - Added root adapter support to normalize `message.reaction` into a canonical reaction event in `src/features/channel/eventNormalizer.ts`.
  - Updated webhook ingress logging to emit normalized reaction summaries through `src/features/http/routes/webhooks.ts`.
  - Confirmed real inbound image and document payload captures exist and include inline base64 media data plus MIME metadata.
- Reason:
  - Reduce Phase 1 ambiguity using real OpenWA evidence before moving deeper into claim/unclaim workflow rebuild.
- Impact:
  - The rebuild no longer has to guess the current reaction-add payload shape.
  - Current media strategy for captured image/document events can use inline `payload.data.media.data` directly without an extra fetch.
  - Reaction removal semantics, `session.qr`, and `session.disconnected` remain open.
  - Verification completed with `npm run lint`, `npm run build`, and live capture inspection through `/channel/webhooks/captures/latest`.

## [2026-07-12] Add explicit group lookup cache policy to root OpenWA app
- Change:
  - Moved group subject lookup caching into `DirectoryService` instead of keeping ad-hoc cache state inside the HTTP route layer.
  - Added TTL-based group cache behavior controlled by `OPENWA_GROUP_CACHE_TTL_MS` with default five-minute caching.
  - Added refresh-on-miss behavior so a stale cached subject lookup triggers one forced OpenWA group-list refresh before returning not found.
  - Added explicit `invalidateGroupsCache()` hook in the root directory service for future invalidation paths.
- Reason:
  - Close the remaining Phase 2 gap around operator-facing group lookup reliability without waiting on later workflow work.
- Impact:
  - `/send-group-message` now uses a service-level cache policy with explicit refresh behavior instead of route-local transient state.
  - Verification completed with `npm run lint` and `npm run build`.

## [2026-07-12] Port technician contacts and /setlaps to root OpenWA app
- Change:
  - Added `src/features/integrations/technicianContacts.ts` to store technician master data in `DATA_DIR/technicianContacts.json`.
  - Added root-app support for `/setlaps technician <id> /a|/d` with `LAPS_ADMIN_PHONE_NUMBERS` enforcement and delegated `laps_access` updates.
  - Added root-app support for `/technician list|search|view|add|update|delete|mapleave`.
  - Added `src/leaveScheduleCheck.ts` and `xlsx` dependency so `/technician mapleave` can resolve leave schedule names from the shared spreadsheet.
  - Synced the root backend dependency baseline by adding `openai` to `package.json` during this backend update.
- Reason:
  - Continue the documented LAPS delegation and technician-directory migration so the root OpenWA runtime can replace the remaining operator command paths from the reference app.
- Impact:
  - LAPS access can now be delegated and revoked from the active root app without falling back to the legacy runtime.
  - Technician master data CRUD and leave-schedule mapping are now available in the active root app.
  - Verification completed with `npm run lint` and `npm run build`.
  - Local runtime verification against a temporary copy of `data/technicianContacts.json` confirmed `/technician list`, `/technician view 3`, and `/setlaps technician 4 /a`, including persisted `laps_access` mutation on the temp copy.

## [2026-07-12] Port /getlaps and /getlapsdiag to root OpenWA app
- Change:
  - Added LDAP-backed `/getlaps <hostname>` support to the root inbound command flow.
  - Added LDAP-backed `/getlapsdiag <hostname>` support to the root inbound command flow.
  - Added LAPS LDAP parsing for `msLAPS-Password`, legacy `ms-Mcs-AdmPwd`, and diagnostics for visible LAPS attributes.
  - Added optional PowerShell bridge fallback support through `LAPS_POWERSHELL_URL` and `LAPS_POWERSHELL_TOKEN`.
  - Added private-chat-only enforcement and LAPS admin allowlist enforcement using `LAPS_ADMIN_PHONE_NUMBERS` with fallback to `ALLOWED_PHONE_NUMBERS`.
- Reason:
  - Continue porting the documented security/admin command set that operators rely on in the legacy runtime.
- Impact:
  - `/getlaps` and `/getlapsdiag` are now available in the active root app for LAPS-admin callers.
  - Technician delegation via `/setlaps` and technician contacts is still pending.

## [2026-07-12] Port Snipe-IT asset and license commands to root OpenWA app
- Change:
  - Added root `src/features/integrations/snipeIt.ts` for Snipe-IT category, asset, and license API access.
  - Added `/getasset [type]`, `/licenses [limit] [offset]`, `/getlicense <license_name_or_id>`, `/expiring [days]`, and `/licensereport` to the root inbound command flow.
  - Updated root command help text so Snipe-IT commands are discoverable from the active runtime.
- Reason:
  - Continue porting the documented command surface from the frozen reference into the active OpenWA-only root app.
- Impact:
  - Root WhatsApp command handling now covers both AD/LAPS flows and Snipe-IT asset/license visibility.
  - Snipe-IT commands require `SNIPEIT_URL` and `SNIPEIT_TOKEN` in the root runtime environment.
  - Verification completed with `npm run build`.

## [2026-07-12] Port /getbitlocker and SQL photo fallback to root OpenWA app
- Change:
  - Added SQL Server photo fallback for `/finduser /photo` using `CardDB.PHOTO` by `employeeID` / `StaffNo`, matching the legacy lookup order after LDAP photo attributes.
  - Added LDAP-backed `/getbitlocker <hostname>` support to the root inbound command flow.
  - Added `mssql` dependency and TypeScript types for the root runtime.
- Reason:
  - Bring `/finduser /photo` behavior closer to the frozen reference and continue porting the documented security command set.
- Impact:
  - `/finduser /photo` now checks LDAP photo first, then falls back to SQL Server when an employee identifier is available.
  - `/getbitlocker` can return recovery keys from AD-backed recovery objects through the root app.

## [2026-07-12] Port /finduser and /unlock to root OpenWA app
- Change:
  - Added LDAP-backed `/finduser <name> [/photo]` support to the root inbound command flow.
  - Added LDAP-backed `/unlock <username>` support to the root inbound command flow.
  - Expanded the root LDAP integration with user search, account unlock, and WhatsApp-friendly caption rendering helpers.
  - Updated command reply handling so the root app can send multiple replies and image replies for commands such as `/finduser /photo`.
- Reason:
  - Continue moving documented AD command workflows from `reference/` into the active OpenWA-only root runtime.
- Impact:
  - `/finduser`, `/resetpassword`, and `/unlock` now share the same root LDAP integration path.
  - `/finduser` currently supports LDAP photo delivery when the directory entry exposes `thumbnailPhoto` or `jpegPhoto`.
  - SQL photo fallback from the legacy app is still not ported.

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

## [2026-07-12 17:27:44 WITA] Add direct claim notifications and requester contact fallback
- Change:
  - Added LDAP helper fallback to resolve requester mobile numbers from `requester.email_id` when ServiceDesk payloads omit `requester.mobile`.
  - Updated `POST /webhook` requester notifications to use the LDAP email fallback before skipping requester delivery.
  - Updated reaction-based ticket claim handling to send best-effort direct notifications to the claiming technician and the requester after ServiceDesk assignment succeeds.
  - Verified the backend changes with `npm run lint` and `npm run build`.

## [2026-07-12 17:27:44 WITA] Fix unclaim restore for ICT technician clearing
- Change:
  - Updated ServiceDesk request patching so `udf_pick_601` can be explicitly cleared with `null`, not only set to a non-empty string.
  - Updated reaction-based unclaim handling to restore `previousIctTechnician` exactly, including `null` when the ticket had no prior ICT technician.
  - Verified the backend changes with `npm run lint` and `npm run build`.

## [2026-07-12 17:27:44 WITA] Make claim and ServiceDesk debug logs easier to read
- Change:
  - Reformatted `ticket-reaction` debug output into ordered `key=value` pairs so claim and unclaim troubleshooting is readable directly in Terminal.
  - Reformatted `servicedesk:update_request` and `servicedesk:update_response` debug output into compact one-line summaries focused on the fields that matter during assignment restore checks.
  - Verified the logging changes with `npm run lint` and `npm run build`.

## [2026-07-12 17:27:44 WITA] Make webhook runtime logs easier to scan
- Change:
  - Reformatted `webhook:received`, `webhook:capture_saved`, `webhook:normalized`, `webhook:normalize_skipped`, and `webhook:processed` into compact ordered `key=value` lines.
  - Reduced Terminal noise by logging only the most useful fields for `message.sent`, `message.ack`, and other non-normalized webhook events.
  - Verified the logging changes with `npm run lint` and `npm run build`.

## [2026-07-12 18:20:00 WITA] Force unclaim to flush both technician fields
- Change:
  - Updated reaction-based unclaim handling to send `technicianName: null` and `ictTechnician: null` explicitly after successful unclaim, while still restoring status and preserving the stored group behavior.
  - Added clearer unclaim verification logging so the requested clear action is visible alongside the previously stored technician values.
  - Manually verified against ServiceDesk ticket `6700` that `PUT /requests/6700` with both fields set to `null` clears both `technician` and `udf_fields.udf_pick_601`.

## [2026-07-12 18:45:00 WITA] Add root dispatcher foundation and native channel delivery path
- Change:
  - Added `getAllRequests()` to the root ServiceDesk integration so dispatcher scans can reuse the same Helpdesk API path as the reference app.
  - Added `src/features/dispatcher/helpdeskDispatcher.ts` with guarded dispatcher startup, bounded ticket scanning, candidate detection for tickets missing assigned or ICT technician fields, and direct/digest notification delivery through the root `MessagingService`.
  - Wired dispatcher startup and shutdown into `src/index.ts` under `DISPATCHER_ENABLED`, keeping the runtime idle by default until explicitly enabled.
  - Verified the new dispatcher foundation with `npm run lint` and `npm run build`.

## [2026-07-12 18:55:00 WITA] Add process rule to always consult reference before inventing behavior
- Change:
  - Updated `docs/implementation-roadmap.md` execution notes to require reviewing the relevant implementation under `reference/` before designing or porting behavior.
  - Explicitly documented that new behavior must not be invented when the reference already defines the expected flow.

## [2026-07-12 19:05:00 WITA] Port leave schedule loading into root dispatcher foundation
- Change:
  - Added reference-aligned leave schedule config and loader to `src/features/dispatcher/helpdeskDispatcher.ts` using `src/leaveScheduleCheck.ts`.
  - Dispatcher now reads the daily leave schedule file, resolves leave entries by ICT technician name, and includes a compact load summary in dispatcher scan logs.
  - This change only ports leave schedule reading and observability; leave-aware assignment filtering still depends on the future assignment engine port.
  - Verified with `npm run lint` and `npm run build`.

## [2026-07-12 19:20:00 WITA] Port leave-aware ICT assignment into root dispatcher
- Change:
  - Added reference-style ICT technician picker to `src/features/dispatcher/helpdeskDispatcher.ts` using current open-ticket load plus leave schedule filtering.
  - Added action planning so dispatcher can infer group from existing ICT technician, mirror ServiceDesk group into assigned technician, and fill missing `ICT TECHNICIAN` with the lowest-load onsite contact.
  - Added guarded assignment execution through `updateRequest()` with `DISPATCHER_DRY_RUN` and `DISPATCHER_MAX_ASSIGNMENTS_PER_RUN`.
  - Verified with `npm run lint` and `npm run build`.

## [2026-07-12 19:35:00 WITA] Port dispatcher reminder/backoff state into root runtime
- Change:
  - Extended `src/features/tickets/ticketStateStore.ts` so dispatcher and `/webhook` can share richer ticket state fields such as `lastActionAtIso`, assigned group/ICT snapshots, and reminder/notified hashes.
  - Added reference-style reminder planning to `src/features/dispatcher/helpdeskDispatcher.ts` for `unassigned`, `unpicked_ict`, and `assigned_open` cases with cooldown checks and Redis-backed state persistence.
  - Added manual override backoff handling so dispatcher does not immediately overwrite group or ICT values that diverge from its last recorded assignment.
  - Verified with `npm run lint` and `npm run build`.

## [2026-07-12 19:50:00 WITA] Align dispatcher notification flow with actionable state and dedupe
- Change:
  - Changed dispatcher direct notifications to use an explicit actionable queue instead of broadcasting every raw candidate.
  - Changed dispatcher digest mode to summarize only actionable assignment items, not skipped candidates.
  - Added notification-hash dedupe persistence so repeated dispatcher runs can suppress duplicate direct notifications when the action payload has not changed.
  - Expanded dispatcher scan logs with reminder mode, assignment caps, backoff config, and Redis-state behavior.
  - Verified with `npm run lint` and `npm run build`.

## [2026-07-12 20:10:00 WITA] Close dispatcher no-group routing gap with dry-run evidence
- Change:
  - Ran a one-shot dispatcher dry-run on alternate port `8292` with notifications, reminders, and leave filtering disabled to gather non-destructive runtime evidence from real Helpdesk data.
  - The first dry-run scanned 69 tickets with `matched=0`, exposing that tickets `6697` and `6696` were still skipped because the no-group route-decision path from the reference dispatcher had not been ported.
  - Ported reference-style `routeTicketHeuristic()` plus optional AI fallback into `src/features/dispatcher/helpdeskDispatcher.ts`, then re-ran the same dry-run.
  - The second dry-run scanned 69 tickets with `matched=2`, `assigned=2`, and `errors=0`, proving that those no-group tickets now become actionable.
  - Expanded dispatcher candidate logs to include `targetGroupName` and `targetIctTechnician` for clearer runtime verification.
  - Verified with `npm run lint` and `npm run build`.

## [2026-07-12 20:20:00 WITA] Harden dispatcher heuristic routing against substring false positives
- Change:
  - Ran a follow-up one-shot dry-run after adding `targetGroupName` and `targetIctTechnician` to dispatcher candidate logs.
  - The evidence showed ticket `6697` (`Tidak bisa membuka file PDF`) was wrongly routed to `IT Field Support` because simple substring matching allowed keyword `lan` to match inside ordinary words such as `tampilan`.
  - Replaced raw substring keyword checks with normalized token-based routing text in `src/features/dispatcher/helpdeskDispatcher.ts`.
  - Re-ran the same dry-run and confirmed ticket `6697` now routes to `IT Support` with `Peggy Putra (IT System Support)`, while ticket `6696` remains correctly routed to `IT Field Support` with `Arief Putro (IT Field Support)`.
  - Verified with `npm run lint` and `npm run build`.

## [2026-07-13 14:40:00 WITA] Validate real leave workbook and map dispatcher roster names
- Change:
  - Audited the real workbook at `data/leave/leave-schedule.xlsx` and confirmed the daily status grid relevant to the ICT dispatcher is on sheet `Human Resource`, not the earlier monthly-looking `Sep-SA-MTI` / `Oct-SA-MTI` tabs.
  - Compared ICT contacts against the workbook and found multiple display-name mismatches (`Peggy Putra` vs `PEGGY LEKSANA PUTRA MANGERA`, `Arief Putro` vs `ARIEF PUTRO PRAKOSO`, `Widji Santoso` vs `WIDJI SANTOSO (B2B)`, etc.).
  - Added explicit `leave_schedule_name` mappings to `data/technicianContacts.json` for the 9 ICT contacts that can be tied to `Human Resource`, and updated the dispatcher default workbook path to `data/leave/leave-schedule.xlsx`.
  - Ran leave-enabled dispatcher dry-runs and direct parser checks against the workbook. The workbook loads successfully with `matched=9`, `onsite=7`, `offsite=2`.
  - Verified that `DISPATCHER_LEAVE_SCHEDULE_DATE_SHIFT_DAYS=0` matches the actual current-day column in this workbook (`2026-07-13` -> `WIDJI ... = H24`, `REZA ... = FB9`), while `1` reads the next-day column.
  - Confirmed `Adriana Riska (Document Control)` still has no daily-status row in `Human Resource`; her exact full name appears only in `Sheet1`, so dispatcher leave filtering cannot make a daily on/off decision for her from this workbook yet.
  - Verified with `npm run lint` and `npm run build`.

## [2026-07-13 15:05:00 WITA] Port leave schedule auto-download scheduler from reference
- Change:
  - Reviewed the reference startup flow and ported the SharePoint / OneDrive leave-schedule downloader into the root app as `src/sharepointDownloadLeaveSchedule.ts`.
  - Added root-app scheduler bootstrap in `src/index.ts` with the same behavior pattern as the reference: optional startup download, once-per-day success guard, scheduled local-time execution, SharePoint token cache reuse, and atomic XLSX writes.
  - Aligned the fallback download target with the active dispatcher workbook path: `data/leave/leave-schedule.xlsx`.
  - Updated `docs/deployment-and-environment.md` and `docs/dispatcher_setup.md` so the new env contract is documented (`LEAVE_SCHEDULE_AUTO_DOWNLOAD_ENABLED`, schedule hour/minute, tz offset, token cache, and startup download toggle).
  - Verified with `npm run lint` and `npm run build`.
