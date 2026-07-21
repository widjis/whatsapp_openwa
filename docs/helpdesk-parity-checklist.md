# Helpdesk Parity Checklist (Reference vs Root)

## Tujuan
Checklist ini membandingkan fitur domain **Helpdesk (ServiceDesk webhook + notifikasi + claim/unclaim + dispatcher)** antara:
- behavioral reference: `reference/`
- implementasi utama: `src/` (root app)

Status yang dipakai:
- **Implemented**: sudah ada di root dan jalur kodenya jelas.
- **Partial**: ada sebagian, tapi belum parity penuh / ada gap penting.
- **Missing**: belum ada di root.
- **Blocked (Ops)**: kode ada, tapi end-to-end belum bisa jalan karena hambatan operasional (mis. webhook delivery).

## A. ServiceDesk Webhook `/webhook`

| Item | Reference | Root | Status | Catatan |
|---|---|---|---|---|
| Endpoint `POST /webhook` menerima payload minimal `{id,status,receiver,...}` | [messages.ts](file:///c:/Scripts/Projects/whatsapp_openwa/reference/src/features/http/routes/messages.ts#L907-L913) | [messages.ts](file:///c:/Scripts/Projects/whatsapp_openwa/src/features/http/routes/messages.ts#L512-L516) | Implemented | Root sudah validasi payload, load ticket, lalu process. |
| Load ticket detail via ServiceDesk API | `viewRequest()` di reference | `viewRequest()` di root | Implemented | Root ada [serviceDesk.ts](file:///c:/Scripts/Projects/whatsapp_openwa/src/features/integrations/serviceDesk.ts). |
| Render pesan “new ticket” yang human-readable | `renderTicketNewMessage()` | `renderTicketNewMessage()` | Implemented | Style message root sudah setara secara struktur (ticketId, status, priority, category, subject, description, link). |
| Render pesan “ticket updated” + change list | `renderTicketUpdateMessage()` + diff | `renderTicketUpdateMessage()` + diff | Implemented | Root membuat `changes[]` dan mengirim ke receiver. |
| Strip HTML ke text | JSDOM (`stripHtmlToText`) | regex strip | Partial | Root sudah stripping, tapi tidak pakai DOM parser (potensi beda hasil untuk HTML edge case). |
| Truncate description dengan AI fallback | `truncateDescription()` pakai OpenAI bila tersedia | `truncateDescription()` pakai OpenAI bila tersedia | Implemented | Root sudah AI-first bila `OPENAI_API_KEY` ada, fallback truncate biasa. |
| Auto-enrichment ticket baru (template/category/priority) | ada di reference (`template 305`, category suggestion, priority) | ada di root (template 305, defineServiceCategory, priority low) | Implemented | Root sudah melakukan update + refresh dan fallback logic. |
| Auto “In Progress” saat technician berubah (update flow) | ada | ada | Implemented | Root ada `shouldAutoInProgress` dan update status. |
| Store outbound `messageId` untuk claim | `storeTicketNotification({ticketId,remoteJid,messageId})` | `storeTicketNotification({ticketId,remoteJid,messageId})` | Implemented | Root store di [claimStore.ts](file:///c:/Scripts/Projects/whatsapp_openwa/src/features/tickets/claimStore.ts). |
| Save ticket snapshot state untuk diff update | Redis/in-memory di reference | ticketStateStore di root | Implemented | Root: [ticketStateStore.ts](file:///c:/Scripts/Projects/whatsapp_openwa/src/features/tickets/ticketStateStore.ts). |
| Best-effort notify requester (new/update/assign) | ada | ada | Implemented | Root punya fallback requester phone via LDAP email. |
| Notify technician saat assigned | ada | ada | Implemented | Root memanfaatkan `technicianContacts` + send DM. |
| Attachment analysis from ServiceDesk attachments | `handleAndAnalyzeAttachments()` | `handleAndSendAttachments()` | Implemented | Root sudah download+forward attachments + optional image AI analysis + PDF first-page text extraction + SRF dedupe per attachment content_url. |
| Group send precheck (announce/admin/bot membership) | `precheckGroupSend()` | `precheckGroupSend()` | Implemented | Root sudah block send jika bot bukan member / group announce-only dan bot bukan admin. |
| SRF PDF approval (detect SRF document + mention approver + forward PDF) | ada (SRF detector + dedupe + send) | ada (AI-first + heuristic fallback) | Implemented | Root mendeteksi SRF PDF via AI jika `OPENAI_API_KEY` ada dan `SRF_DETECTION_AI_ENABLED=true`, fallback heuristic; mention via `SRF_APPROVER_PHONES`. |

## B. Claim/Unclaim via Reaction (Ticket Claim Workflow)

| Item | Reference | Root | Status | Catatan |
|---|---|---|---|---|
| Persist mapping (ticketId ↔ messageId ↔ remoteJid) | [claimStore.ts](file:///c:/Scripts/Projects/whatsapp_openwa/reference/src/features/tickets/claimStore.ts) | [claimStore.ts](file:///c:/Scripts/Projects/whatsapp_openwa/src/features/tickets/claimStore.ts) | Implemented | Root sudah ada Redis optional + lock + record validation. |
| Allowed-group gating via `TICKET_REACTION_GROUP_IDS` | ada | ada | Implemented | Root: [commandService.ts](file:///c:/Scripts/Projects/whatsapp_openwa/src/features/inbound/commandService.ts#L2009-L2028). |
| Dedupe reaction event (spam protection) | ada (di runtime flow) | ada (15s) | Implemented | Root punya `recentReactionEvents`. |
| Claim: cek ticket closed, reject bila closed | ada | ada | Implemented | Root cek status via ServiceDesk sebelum claim. |
| Claim: update ServiceDesk (ictTechnician, group/technician, status=In Progress, priority) | ada | ada | Implemented | Root update via [serviceDesk.ts](file:///c:/Scripts/Projects/whatsapp_openwa/src/features/integrations/serviceDesk.ts). |
| Unclaim: only claimer can unclaim | ada | ada | Implemented | Root cek `claimedByPhone`. |
| Unclaim: restore prior assignment/status | ada | ada | Implemented | Root menyimpan `previous*` dan restore via updateRequest. |
| Reply ke group pada claim/unclaim | ada | ada | Implemented | Root send text ke group via `sendReactionText`. |
| Correlation stability outbound `messageId` vs reaction `messageId` | dibutuhkan | dibutuhkan | Pending validation | Kirim reaction ke notif ticket lalu cek `GET /channel/webhooks/validate/reaction-latest` untuk lihat apakah `remoteJid+messageId` match ke claimStore. |

## C. Dispatcher (Auto Assignment / Notification / Leave schedule)

| Item | Reference | Root | Status | Catatan |
|---|---|---|---|---|
| Dispatcher scan loop (config-driven) | [helpdeskDispatcher.ts](file:///c:/Scripts/Projects/whatsapp_openwa/reference/src/features/dispatcher/helpdeskDispatcher.ts) | [helpdeskDispatcher.ts](file:///c:/Scripts/Projects/whatsapp_openwa/src/features/dispatcher/helpdeskDispatcher.ts) | Implemented | Root sudah start di [index.ts](file:///c:/Scripts/Projects/whatsapp_openwa/src/index.ts#L191). |
| Routing heuristic (it_support/it_field/doc_control/triage) | ada | ada | Implemented | Root juga punya normalisasi keyword untuk hindari substring false-positive. |
| AI routing optional | ada | ada | Implemented | Root pakai `OpenAI` bila key ada. |
| Leave schedule filtering (xlsx) | ada | ada | Implemented | Root memakai [leaveScheduleCheck.ts](file:///c:/Scripts/Projects/whatsapp_openwa/src/leaveScheduleCheck.ts). |
| SharePoint leave schedule downloader + scheduler | ada | ada | Implemented | Root: [sharepointDownloadLeaveSchedule.ts](file:///c:/Scripts/Projects/whatsapp_openwa/src/sharepointDownloadLeaveSchedule.ts) + scheduler di [index.ts](file:///c:/Scripts/Projects/whatsapp_openwa/src/index.ts#L248-L249). |
| Reminder mode | ada | ada | Implemented | Root punya reminder queue + cooldown. |
| Digest mode | ada | ada | Implemented | Root punya digestNumbers + digestMaxItems. |

## D. Inbound Delivery (Operational Gate)

| Item | Status | Catatan |
|---|---|---|
| OpenWA webhook benar-benar mengirim event ke root app | Implemented (Local) | Sudah terbukti event `session.status` dan `message.received` masuk via webhook lokal. Untuk production tetap butuh URL yang di-allow OpenWA (bukan private IP jika masih diblok). |

## Rekomendasi Prioritas Berikutnya
1. Bereskan **webhook delivery** (tanpa ini, semua inbound helpdesk/claim tidak bisa divalidasi end-to-end).
2. Setelah event masuk real, lakukan verifikasi korelasi `messageId` outbound → reaction inbound.
3. Port gap yang benar-benar penting untuk parity:
   - attachment handling (`handleAndAnalyzeAttachments`)
   - group send precheck (announce/admin/bot membership) bila sering terjadi di operasi.
