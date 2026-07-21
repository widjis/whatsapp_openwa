# WhatsApp OpenWA Rebuild

This repository is a fresh OpenWA-based rebuild of the behavior captured in `reference/`.

## Direction
- `reference/` is read-only and acts as a behavioral baseline
- the active implementation will be created in the repository root
- the new codebase is OpenWA-only
- Baileys is not part of the new runtime plan

## Source of Truth
Start here before implementing:
- `docs/implementation-roadmap.md`
- `docs/openwa-target-architecture.md`
- `docs/openwa-integration-contracts.md`
- `docs/open-questions-and-challenges.md`
- `docs/feature-specifications.md`
- `docs/openapi.yaml`

Backend contract rule:
- every backend change must review `docs/openapi.yaml`
- if the backend contract changes, update `docs/openapi.yaml` in the same task

## Current Phase
See `docs/implementation-roadmap.md`.

At the moment, the repository is in the bootstrap and validation stage for the OpenWA-only rebuild.

## Repository Structure
- `docs/` — source-of-truth planning, architecture, contracts, workflows, and roadmap
- `reference/` — frozen reference implementation used to reproduce behavior
- `src/` — new implementation target location once coding begins

## Working Rule
Reproduce the reference behavior, but do not copy transport-specific debt into the new codebase.

## Docker
- Single instance:
  - `docker compose up --build`
  - Exposes `http://localhost:8192/health`
  - Persists state under `./data` (mounted to `/app/data`)
- Multi instance (separate data dirs):
  - `docker compose -f docker-compose.multi.yml up --build`
  - Exposes `8192` and `8193`
