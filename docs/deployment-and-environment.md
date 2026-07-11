# Deployment and Environment

## Purpose
This document explains how this project is configured and deployed across local development, single-instance Docker, and multi-instance Docker.

## Runtime Modes

### Local development
Typical command:

```bash
npm install
npm run dev
```

Common local overrides:
- `PORT=8194`
- `DATA_DIR=data-local`

This is useful when port `8192` is already in use or when local auth data should be isolated from server data.

### Single-instance Docker
Typical command:

```bash
docker compose up -d --build
```

Use this when you need one WhatsApp number and one gateway instance.

### Multi-instance Docker
Current reference file:
- `docker-compose.multi.yml`

Typical command:

```bash
docker compose -f docker-compose.multi.yml up -d --build
```

Use this when you need more than one WhatsApp number, or when you want to separate AI chat behavior from operational command behavior.

## Core Environment Variables

### Base runtime
- `PORT`: HTTP port for the running instance
- `DATA_DIR`: writable runtime directory for auth, uploads, store, and related files
- `ALLOWED_IPS`: HTTP allowlist for incoming requests

### WhatsApp behavior
- `WA_VERSION`: optional explicit WhatsApp version override
- `WA_MAX_RECONNECT_ATTEMPTS`: cap reconnect loops
- `WA_PAIRING_PHONE`: optional pairing-code login phone number

Note:
- QR login still relies on normal `connection.update` QR events
- pairing code is optional and should not be enabled unless intentionally used

### N8N / chatbot behavior
- `N8N_ENABLED`
- `N8N_WEBHOOK_URL`
- `N8N_TIMEOUT`
- `REPLY_GATEWAY_ENABLED`
- `REPLY_GATEWAY_AI_ENABLED`
- `REPLY_GATEWAY_MODEL`

### OpenAI / AI behavior
- `OPENAI_API_KEY`
- `SERVICE_CATEGORY_AI_ENABLED`
- `DISPATCHER_AI_ROUTING_ENABLED`
- `DISPATCHER_AI_MODEL`

### Dispatcher behavior
- `DISPATCHER_ENABLED`
- `DISPATCHER_GATEWAY_BASE_URL`
- `DISPATCHER_DRY_RUN`
- `DISPATCHER_RUN_ONCE`
- `DISPATCHER_SCAN_INTERVAL_SECONDS`

Dispatcher-specific detail is documented further in `docs/dispatcher_setup.md`.

### SharePoint / leave schedule behavior
- `LEAVE_SCHEDULE_SHARE_URL`
- `MS_TENANT_ID`
- `MS_CLIENT_ID`
- `MS_GRAPH_SCOPES`
- `SHAREPOINT_TOKEN_CACHE_PATH`
- `DISPATCHER_LEAVE_SCHEDULE_XLSX_PATH`
- `LEAVE_SCHEDULE_AUTO_DOWNLOAD_RUN_ON_STARTUP`

## Data Directory Contract
If `DATA_DIR` is unset, the app falls back to the project root for some runtime files.

Recommended practice:
- always set `DATA_DIR` explicitly in production
- keep `DATA_DIR` unique per instance

Important files inside `DATA_DIR`:
- `auth_info_baileys/`
- `baileys_store.json`
- `uploads/`
- `sharepoint_token_cache.json` or custom token path
- leave schedule XLSX
- `technicianContacts.json`

## Docker Multi-Instance Pattern
Current pattern in `docker-compose.multi.yml`:
- `whatsapp-api-8192` uses `./data-8192:/app/data`
- `whatsapp-api-8193` uses `./data-8193:/app/data`

This pattern should be preserved for every additional instance:

1. unique service name
2. unique `PORT`
3. unique host volume
4. unique WhatsApp number

Example checklist for adding a new instance:
- duplicate a service block
- set `PORT: 8194`
- map `"8194:8194"`
- mount `./data-8194:/app/data`
- adjust feature toggles for the intended role

## Recommended Role-Based Configuration

### AI chatbot instance
Recommended settings:
- `N8N_ENABLED=true`
- `REPLY_GATEWAY_ENABLED=true`
- `REPLY_GATEWAY_AI_ENABLED=true`
- `DISPATCHER_ENABLED=false`

Optional:
- set `OPENAI_API_KEY` if AI-based reply decisioning is needed

### Operations / command instance
Recommended settings:
- `DISPATCHER_ENABLED=true` only if the dispatcher should run in this instance
- `N8N_ENABLED=false`
- `REPLY_GATEWAY_ENABLED=false`
- `REPLY_GATEWAY_AI_ENABLED=false`
- `SERVICE_CATEGORY_AI_ENABLED=false` unless intentionally needed

This keeps the operational bot deterministic and reduces surprise auto-replies.

## Environment Override Rules
In Docker Compose, `env_file: .env` loads the shared baseline for all services.

Per-service `environment:` entries then override or extend that baseline.

That means:
- shared values belong in `.env`
- instance-specific behavior belongs in each service block

Examples of instance-specific values:
- `PORT`
- `DATA_DIR`
- `DISPATCHER_GATEWAY_BASE_URL`
- `WA_PAIRING_PHONE`
- AI toggles

## Secrets Handling
Current repository pattern:
- `.env` is used as the baseline source
- secrets are injected into containers at runtime

Recommendations:
- do not commit plaintext secrets
- use a deployment-specific `.env` outside normal version control where possible
- rotate credentials when troubleshooting access issues that involved copying env values around

## Build and Rebuild Guidance

### Local Node
When dependencies change:

```bash
npm install
```

The repository uses:
- `postinstall` to patch Baileys for QR support on current protocol behavior

### Docker
When code changes but behavior still looks stale:

```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```

This is especially important when:
- dependency patches changed
- authentication flow changed
- the running image seems older than the local source

## Validation Checklist After Deploy
After any deploy, confirm:

1. container starts and binds the expected port
2. `DATA_DIR` is writable
3. `auth_info_baileys` is created under the expected volume
4. the web UI loads
5. WhatsApp status messages are visible in logs or UI
6. the dispatcher only runs on the intended instance

## Common Misconfigurations
- same WhatsApp number used by two active instances
- same host volume reused by two services
- `DISPATCHER_GATEWAY_BASE_URL` left pointing to another port
- leaving AI toggles enabled on a command-only bot
- assuming `SHAREPOINT_TOKEN_CACHE_PATH` also controls the leave schedule XLSX path

## Recommended Deployment Defaults
For production-like setups:
- set explicit `DATA_DIR`
- isolate one volume per service
- set explicit `PORT`
- keep dispatcher disabled on chatbot-only instances
- keep AI disabled on operations-only instances unless intentionally required
- prefer one source of truth for baseline env, then override per service
