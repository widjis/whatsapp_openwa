# Deployment and Environment

## Scope

`whatsapp_openwa` is the production-target application gateway. `whatsapp_api_n8nv2` is the behavioral reference. OpenWA server and Redis are external services; this Compose stack does not install or upgrade them.

## Requirements

- Docker daemon and Docker Compose (`docker compose`, or legacy `docker-compose`).
- Bash on the deployment host (Linux/macOS, or WSL with Docker integration).
- Current source checkout, including `tests/`, `package-lock.json` and `Dockerfile`.
- Deployment-specific `.env` in the repository root; do not shell-source it. Comments use `#`.
- OpenWA connection: `OPENWA_BASE_URL`, `OPENWA_API_KEY`, and `OPENWA_SESSION_ID` or `OPENWA_SESSION_NAME`.
- ServiceDesk, technician contacts, allowed IPs, reaction groups and SRF approver numbers configured for the target environment.
- `REDIS_HOST` and `REDIS_PORT` for restart-persistent claim and SRF state. Container `localhost` means that container, not another host/service.

## Deploy

Run on the machine whose Docker daemon will host the application:

```bash
./scripts/docker-deploy.sh check
./scripts/docker-deploy.sh deploy
```

The script resolves paths from its own location, so it can also be invoked by absolute path from another directory. The root `.env` is explicitly used for Compose interpolation. Existing shell environment overrides still follow Compose rules.

Sequence:
1. Validate Compose quietly and validate the selected service.
2. Verify Docker daemon availability.
3. Build the image: dependency installation, isolated helpdesk regression tests, TypeScript compilation, production dependency pruning.
4. Only after build success, recreate the selected containers using the built image.
5. Wait up to 120 seconds for Docker health status to become healthy; return nonzero on timeout or stopped/missing-healthcheck container.

There is no preliminary `down`, volume deletion, image prune or automatic rollback. A build failure leaves running containers untouched. A startup/health failure leaves containers available for diagnosis; the previous container may already have been replaced. Use `logs` and `ps` to investigate.

Health checks call `/health` inside each container using its configured `PORT`. This confirms application HTTP responsiveness only, not OpenWA authentication, Redis connectivity, ServiceDesk updates or WhatsApp delivery. Complete the operator acceptance checklist after deployment.

## Commands

```bash
./scripts/docker-deploy.sh deploy --no-cache
./scripts/docker-deploy.sh deploy --timeout 180
./scripts/docker-deploy.sh build
./scripts/docker-deploy.sh health
./scripts/docker-deploy.sh ps
./scripts/docker-deploy.sh logs --no-follow
./scripts/docker-deploy.sh restart --no-build
./scripts/docker-deploy.sh down
```

- Default action, `deploy`, and `up` build, recreate and wait for health.
- `restart` also builds by default. `--no-build` recreates with the existing image (and reloads environment); it does not include new source changes or rerun image-build tests.
- Existing images without the new healthcheck must be rebuilt before `--no-build` can pass.
- `check`/`config` validate without printing resolved environment values and do not require a running daemon.
- `logs` follows by default; `--no-follow` prints the last 200 lines and exits. Application logs can contain operational data.
- `down` affects the selected Compose project and rejects `--service`; bind-mounted data remains.
- `help` works without Docker or `.env`.

## Single instance

`docker-compose.yml` runs `whatsapp-openwa` on host/container port 8192. `PORT: 8192` is explicit so `.env` cannot accidentally break the fixed port mapping. Data is mounted from `./data` to `/app/data`.

## Multiple instances

```bash
./scripts/docker-deploy.sh check --multi
./scripts/docker-deploy.sh deploy --multi --service whatsapp-openwa-8192
./scripts/docker-deploy.sh deploy --multi --service whatsapp-openwa-8193
./scripts/docker-deploy.sh logs --multi --service whatsapp-openwa-8192 --no-follow
```

Use `--multi` consistently for later status/log/health/down commands. Omitting `--service` selects both services.

- `whatsapp-openwa-8192`: port 8192, data `./data-8192`.
- `whatsapp-openwa-8193`: port 8193, data `./data-8193`; dispatcher and N8N disabled and OpenAI key cleared by the current Compose overrides.
- Both services inherit `.env`. Before running both, configure their intended `OPENWA_SESSION_ID`/`OPENWA_SESSION_NAME` and webhook destinations in the per-service environment. Separate data directories do not automatically select separate WhatsApp sessions.
- Per-service values override `env_file` values. Single and multi modes both expose 8192; do not run them simultaneously on the same host port.

## Persistent data and secrets

Preserve technician contacts, SharePoint token cache, leave workbooks, uploads, logs and webhook captures under each instance's data directory. Claim/SRF state needs external Redis to survive restart. WhatsApp authentication is owned by the OpenWA server; deleting local gateway data does not repair an OpenWA session.

`.env`, `data/`, `data-*`, uploads, logs and the reference tree are excluded from the Docker build context. Source tests are included in the build stage and are not copied into the runtime stage. Never include plaintext credentials in deployment commands or version control.

## Local verification

```bash
bash -n scripts/docker-deploy.sh
python3 tests/test_docker_deploy.py
npm run test:helpdesk
npm run build
```

Deployment tests use a fake Docker CLI and temporary directories; they do not start services. Real image build and container health checks require an available Docker daemon.

## SRF approval recipients and caption

Copy the values in [srf-approval.env.example](srf-approval.env.example) into the deployment host's `.env`:

```env
SRF_APPROVER_PHONES=6282323336511,6285712612218,6289524548777,6281132041331
SRF_APPROVAL_GROUP_ID=120363162455880145@g.us
```

These are the production defaults from `whatsapp_api_n8nv2`. Missing/blank values use those defaults. To change recipients, provide a comma-separated list; numbers normalize to international format and duplicates are removed. Invalid phone entries/group JIDs prevent SRF sending with an attachment error.

The SRF PDF goes to the configured approval group; the main notification and other attachments continue to use the webhook receiver. Changing targets does not automatically resend already recorded SRF attachments. Verify with a new test ticket/attachment, not by clearing production dedupe data.

Caption uses the fixed format `A kind reminder, Pak @number1, @number2, terkait SRF terlampir "[filename]", dengan Ticket ID [id] dari [requester], mengenai [summary]. Mohon bantuannya untuk review dan approval. Terima kasih.` AI only generates the short summary; fallback uses the ticket subject. Full PDF text is extracted for summary input, bounded to 12000 characters; detection still uses first-page evidence. No OCR is introduced.

Run `./scripts/docker-deploy.sh deploy` to install this code and configuration. `restart --no-build` only reloads configuration on an already updated image.
