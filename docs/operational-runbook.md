# Operational Runbook

## Purpose
This runbook is for operators maintaining the WhatsApp gateway in local or Docker environments.

It focuses on:
- start and stop procedures
- multi-instance operations
- WhatsApp re-authentication
- QR and connection troubleshooting
- safe dispatcher handling

## Daily Commands

### Start single-instance Docker

```bash
docker compose up -d --build
```

### Start multi-instance Docker

```bash
docker compose -f docker-compose.multi.yml up -d --build
```

### View logs

```bash
docker compose -f docker-compose.multi.yml logs -f --tail=200
```

### View one service only

```bash
docker compose -f docker-compose.multi.yml logs -f --tail=200 whatsapp-api-8192
docker compose -f docker-compose.multi.yml logs -f --tail=200 whatsapp-api-8193
```

### Restart one service

```bash
docker compose -f docker-compose.multi.yml restart whatsapp-api-8192
```

## Service Roles
Recommended operational split:

- `whatsapp-api-8192`
  - operational bot
  - command handling
  - dispatcher if needed

- `whatsapp-api-8193`
  - AI or alternate bot role
  - dispatcher usually disabled

The exact role depends on `docker-compose.multi.yml`.

## Re-Authentication Procedure
WhatsApp auth state is stored in:
- `/app/data/auth_info_baileys` inside the container
- mapped from the host service data folder

Examples:
- `./data-8192/auth_info_baileys`
- `./data-8193/auth_info_baileys`

### Re-auth one instance

1. Stop the service:

```bash
docker compose -f docker-compose.multi.yml stop whatsapp-api-8192
```

2. Delete only the auth folder:

```bash
rm -rf ./data-8192/auth_info_baileys
```

On PowerShell:

```powershell
Remove-Item -Recurse -Force .\data-8192\auth_info_baileys
```

3. Start the service again:

```bash
docker compose -f docker-compose.multi.yml up -d --build whatsapp-api-8192
```

4. Check the web UI and logs for QR or connection events.

### Re-auth both instances
Repeat the same procedure for each service, one at a time if possible.

## QR Troubleshooting

### Expected healthy behavior
When auth is empty and the environment is healthy:
- the web UI should receive a QR event
- logs should indicate QR reception

### If QR does not appear
Check these in order:

1. `DATA_DIR` points to the intended folder
2. `auth_info_baileys` is really empty
3. no second instance is using the same number
4. the running image contains the Baileys MACOS patch
5. the service was rebuilt after code changes

## Connection Error Guide

### `428 Connection Terminated`
Meaning:
- WhatsApp closed the connection during or before normal login flow

Common causes:
- protocol sensitivity
- unstable session bootstrap
- number conflict across instances
- environment-specific rejection before QR can stabilize

Actions:
- confirm the service is using its own volume
- ensure the number is not used by another active instance
- clear auth and retry
- compare behavior between local and server environments

### `401 Unauthorized` / `Connection Failure`
Meaning:
- WhatsApp rejected the current client/session as unauthorized

If auth folder is not empty:
- clear the auth folder and retry

If auth folder is already empty:
- this points more strongly to environment-level rejection rather than stale local files
- compare local versus server behavior with the same build

### `Connection Closed` during sends
Meaning:
- the HTTP server is alive, but the WhatsApp socket is not connected

Symptoms:
- `/send-message` fails
- group metadata lookups fail
- dispatcher notifications fail

Actions:
- restore WhatsApp connectivity first
- consider disabling the dispatcher temporarily to reduce noisy failures

## Verifying the Running Container

### Check mounts

```bash
docker inspect whatsapp-api-multi-whatsapp-api-8192-1 --format '{{json .Mounts}}'
```

### Check data directory from inside the container

```bash
docker exec -it whatsapp-api-multi-whatsapp-api-8192-1 sh -lc 'echo DATA_DIR=$DATA_DIR && ls -la /app/data && find /app/data -maxdepth 2 -type f | sort'
```

### Check Baileys patch

```bash
docker exec -it whatsapp-api-multi-whatsapp-api-8192-1 sh -lc "grep -n 'platform:' /app/node_modules/@whiskeysockets/baileys/lib/Utils/validate-connection.js"
```

Expected patched line:

```text
platform: proto.ClientPayload.UserAgent.Platform.MACOS,
```

## Dispatcher Safety Mode
If WhatsApp is down but the dispatcher is still running, it may keep logging failed notifications.

Temporary mitigation:
- set `DISPATCHER_ENABLED=false` for that instance
- restart the service

Use this when:
- WhatsApp connectivity is being repaired
- you want to avoid repeated failed send attempts

## Local Development Runbook

### Start local dev on an alternate port

```bash
$env:PORT=8194
$env:DATA_DIR="data-local"
npm run dev
```

### Why this is useful
- avoids clashing with Docker on `8192`
- keeps local auth isolated from server-like data
- makes it easier to compare local QR behavior against server behavior

## When to Use Force Rebuild
Use a no-cache rebuild when:
- QR behavior changed after Baileys patch updates
- Docker seems to be running old logic
- env changes alone did not explain the behavior

Commands:

```bash
docker compose -f docker-compose.multi.yml down
docker compose -f docker-compose.multi.yml build --no-cache
docker compose -f docker-compose.multi.yml up -d
```

## Safe Cleanup Rules
Prefer deleting only:
- `auth_info_baileys`

Do not casually delete the whole data folder unless intended, because it may also contain:
- `baileys_store.json`
- uploads
- SharePoint token cache
- technician contact mappings
- leave schedule files

## Practical Escalation Notes
Escalate to deeper investigation when all of the following are true:
- auth folder is empty
- volume mount is correct
- patched image is confirmed
- local test behaves differently from server

That pattern usually points to:
- server environment differences
- egress IP reputation
- protocol rejection outside normal file-based troubleshooting
