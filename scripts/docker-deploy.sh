#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION=deploy
MODE=single
SERVICE=""
BUILD=true
NO_CACHE=false
FOLLOW=true
WAIT_SECONDS=120

usage() {
  cat <<'EOF'
Deploy whatsapp_openwa on the machine running Docker.

Usage: ./scripts/docker-deploy.sh [action] [options]
Actions:
  deploy, up  Build (including helpdesk tests), recreate, wait for health (default)
  restart     Recreate and wait for health; builds unless --no-build
  build       Build and run the Dockerfile's tests without starting containers
  check       Validate Compose configuration without printing environment secrets
  config      Alias for check
  health      Check running containers and wait for health
  ps          Show container status
  logs        Show logs (last 200 lines, follows by default)
  down        Stop/remove this Compose project's containers; preserves data
  help        Show help without requiring Docker or .env
Options:
  --single        docker-compose.yml (default)
  --multi         docker-compose.multi.yml
  --service NAME  Limit action to one service (not supported with down)
  --no-build      Reuse existing image for deploy/up/restart
  --no-cache      Rebuild without Docker build cache
  --timeout SEC   Health wait deadline, 1-3600 seconds (default 120)
  --no-follow     Print logs and exit

Examples:
  ./scripts/docker-deploy.sh check
  ./scripts/docker-deploy.sh deploy
  ./scripts/docker-deploy.sh deploy --no-cache
  ./scripts/docker-deploy.sh deploy --multi --service whatsapp-openwa-8192
  ./scripts/docker-deploy.sh logs --no-follow

Run on the deployment host with its .env and data directories. This deploys the
application gateway, not the separate OpenWA server or Redis. Health verifies
only the app's /health response, not WhatsApp pairing or upstream integrations.
EOF
}
fail() { echo "Error: $*" >&2; exit 1; }

if [[ $# -gt 0 && "$1" != -* ]]; then ACTION="$1"; shift; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --single) MODE=single ;;
    --multi) MODE=multi ;;
    --service)
      [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || fail '--service requires a name'
      SERVICE="$2"; shift ;;
    --timeout)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]{0,3}$ ]] || fail '--timeout requires 1-3600 seconds'
      [[ "$2" -le 3600 ]] || fail '--timeout requires 1-3600 seconds'
      WAIT_SECONDS="$2"; shift ;;
    --no-build) BUILD=false ;;
    --no-cache) NO_CACHE=true ;;
    --no-follow) FOLLOW=false ;;
    --help|-h) ACTION=help ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done
[[ "$ACTION" != help ]] || { usage; exit 0; }
case "$ACTION" in deploy|up|restart|build|check|config|health|ps|logs|down) ;; *) fail "Unknown action: $ACTION" ;; esac
[[ "$ACTION" != down || -z "$SERVICE" ]] || fail 'down affects the entire project; --service is not supported'
[[ "$BUILD" != false || "$NO_CACHE" != true ]] || fail '--no-build cannot be combined with --no-cache'
if [[ "$BUILD" == false ]]; then
  case "$ACTION" in deploy|up|restart) ;; *) fail '--no-build applies only to deploy/up/restart' ;; esac
fi
if [[ "$NO_CACHE" == true ]]; then
  case "$ACTION" in deploy|up|restart|build) ;; *) fail '--no-cache applies only to deploy/up/restart/build' ;; esac
fi

command -v docker >/dev/null 2>&1 || fail 'Docker is not installed or not in PATH'
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  fail 'Docker Compose is not available'
fi
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.yml"
[[ "$MODE" != multi ]] || COMPOSE_FILE="$PROJECT_ROOT/docker-compose.multi.yml"
[[ -f "$PROJECT_ROOT/.env" ]] || fail "Missing $PROJECT_ROOT/.env; configure it on the deployment host"
[[ -f "$COMPOSE_FILE" ]] || fail "Missing $COMPOSE_FILE"
# Keep file interpolation and project selection independent of the caller's directory.
cd "$PROJECT_ROOT"
compose() { "${COMPOSE[@]}" --project-directory "$PROJECT_ROOT" --env-file "$PROJECT_ROOT/.env" -f "$COMPOSE_FILE" "$@"; }
compose config --quiet
AVAILABLE="$(compose config --services)"
TARGETS=()
if [[ -n "$SERVICE" ]]; then
  FOUND=false
  while IFS= read -r item; do [[ "$item" != "$SERVICE" ]] || FOUND=true; done <<< "$AVAILABLE"
  [[ "$FOUND" == true ]] || fail "Unknown service: $SERVICE"
  TARGETS=("$SERVICE")
else
  while IFS= read -r item; do [[ -z "$item" ]] || TARGETS+=("$item"); done <<< "$AVAILABLE"
fi
[[ ${#TARGETS[@]} -gt 0 ]] || fail 'No Compose services selected'
echo "Action: $ACTION | Mode: $MODE | Services: ${TARGETS[*]}"
if [[ "$ACTION" == check || "$ACTION" == config ]]; then
  echo 'Compose configuration is valid (environment values are not printed).'
  exit 0
fi
docker info >/dev/null 2>&1 || fail 'Docker daemon is unavailable; start Docker first'

build_images() {
  local args=(build)
  [[ "$NO_CACHE" != true ]] || args+=(--no-cache)
  compose "${args[@]}" "${TARGETS[@]}"
}
wait_for_health() {
  local deadline=$((SECONDS + WAIT_SECONDS))
  local ready svc ids id state
  while :; do
    ready=true
    for svc in "${TARGETS[@]}"; do
      ids="$(compose ps -a -q "$svc")"
      [[ -n "$ids" ]] || fail "No container exists for $svc"
      while IFS= read -r id; do
        state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$id")"
        case "$state" in
          'running healthy') ;;
          *' missing') fail "$svc has no healthcheck; rebuild the current Dockerfile" ;;
          'exited '*|'dead '*) fail "$svc stopped before becoming healthy; inspect its logs" ;;
          *) ready=false ;;
        esac
      done <<< "$ids"
    done
    if [[ "$ready" == true ]]; then
      compose ps "${TARGETS[@]}"
      echo 'Healthy: application HTTP check passed. Test WhatsApp, Redis and ServiceDesk separately.'
      return
    fi
    if [[ "$SECONDS" -ge "$deadline" ]]; then
      compose ps "${TARGETS[@]}"
      fail "Health check timed out after ${WAIT_SECONDS}s; containers were left for diagnosis. Use the logs action."
    fi
    sleep 2
  done
}

case "$ACTION" in
  deploy|up|restart)
    # Build/tests finish before existing containers are touched.
    [[ "$BUILD" != true ]] || build_images
    if [[ "$MODE" == multi ]]; then
      for svc in "${TARGETS[@]}"; do mkdir -p "$PROJECT_ROOT/data-${svc##*-}"; done
    else
      mkdir -p "$PROJECT_ROOT/data"
    fi
    compose up -d --no-build --force-recreate "${TARGETS[@]}"
    wait_for_health
    ;;
  build) build_images ;;
  health) wait_for_health ;;
  ps) compose ps "${TARGETS[@]}" ;;
  logs)
    ARGS=(logs --tail=200)
    [[ "$FOLLOW" != true ]] || ARGS+=(-f)
    compose "${ARGS[@]}" "${TARGETS[@]}"
    ;;
  down) compose down ;;
esac
