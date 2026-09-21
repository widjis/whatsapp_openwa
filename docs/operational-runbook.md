# Operational Runbook

## Deploy and inspect the application gateway

Use the script on the target Docker host:

```bash
./scripts/docker-deploy.sh check
./scripts/docker-deploy.sh deploy
./scripts/docker-deploy.sh ps
./scripts/docker-deploy.sh logs --no-follow
```

Build and helpdesk tests finish before container replacement. Deploy then waits for application HTTP health. Build failure preserves the running container; startup failure returns an error and leaves the replacement container for diagnosis. There is no automatic rollback.

For multi-instance operations append `--multi --service whatsapp-openwa-8192` (or `whatsapp-openwa-8193`). Use `--timeout 180` for a longer health deadline and `--no-cache` for a fresh build. `restart --no-build` recreates from the existing image and reloads environment; it does not deploy new source changes.

See [deployment-and-environment.md](deployment-and-environment.md) for prerequisites, data mounts, session selection and all commands.

## Separate process health from integration health

- Healthy container means `/health` returned HTTP success and `status: true`.
- OpenWA owns session authentication. Inspect `/channel/session/status` and `/channel/session/qr` through an allowed client or use the OpenWA dashboard. Do not delete gateway data to reset WhatsApp authentication.
- For API authorization errors, check the OpenWA API key permissions and configured session.
- For attachment HTTP 400, check the provider payload and server logs. Main `/webhook` success does not prove every attachment was sent.
- For claim persistence, verify external Redis availability and configuration; application health does not test it.
- To disable dispatcher temporarily, set `DISPATCHER_ENABLED=false` for the intended service and run `restart --no-build` for that service.
- Preserve data directories and external Redis records during routine deployments.

## Combined claim and attachment acceptance — 2026-09-22

After deploying the reviewed build to the intended instance, use test tickets and an agreed test group. Verify Redis is configured for persistence checks. Offline regression command: `npm run test:helpdesk`.

1. New ticket with a readable SRF PDF: main notification plus one PDF carrying approval caption; approver mentions work, document opens, no separate approval-only message and no HTTP 400.
2. Same ticket with a neutral diagnostic PDF: it is forwarded as a regular attachment, even when ticket subject/category says SRF.
3. PDF with neutral filename and Service Request Form text on page one: recognized as SRF.
4. Image and another document: forwarding works. URL-image send also works without invalid-field rejection.
5. Repeat the new-ticket event sequentially: the successful SRF attachment is not sent again. Main notification duplication is a separate existing behavior.
6. In an isolated test environment, simulate document rejection then retry: no approval-only message on failure; success state remains unset until retry succeeds.
7. On the main ticket notification, run claim A, change emoji A, competing claim B, removal B, removal A, immediate reclaim A. Only real ownership transitions produce confirmations; B cannot unclaim A.
8. Restart after successful claim/SRF delivery with Redis enabled; repeat A's reaction and attachment event. Verify owner recognition and SRF duplicate suppression persist.

Capture the running build/version, timestamp, ticket id, provider error details from server logs (without keys or document data), WhatsApp result and ServiceDesk assignment. Do not equate HTTP 200 from `/webhook` with successful delivery of every attachment.
