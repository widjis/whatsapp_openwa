#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

MODE="single"
ACTION="up"
SERVICE=""
FOLLOW_LOGS="true"
BUILD_ON_UP="true"

usage() {
  cat <<'EOF'
Docker deployment helper for whatsapp_openwa

Usage:
  ./scripts/docker-deploy.sh [action] [options]

Actions:
  up         Build and start containers in detached mode
  down       Stop and remove containers
  restart    Recreate and restart containers
  logs       Show container logs
  ps         Show container status
  build      Build images only
  config     Validate and render Compose config
  help       Show this help

Options:
  --single        Use docker-compose.yml (default)
  --multi         Use docker-compose.multi.yml
  --service NAME  Target a specific service when supported
  --no-build      Skip build step for up/restart
  --no-follow     Do not follow logs for the logs action
  --help          Show this help

Examples:
  ./scripts/docker-deploy.sh up
  ./scripts/docker-deploy.sh up --multi
  ./scripts/docker-deploy.sh restart --service whatsapp-openwa
  ./scripts/docker-deploy.sh logs --multi --service whatsapp-openwa-8192
  ./scripts/docker-deploy.sh ps --multi
EOF
}

if [[ $# -gt 0 ]]; then
  case "$1" in
    up|down|restart|logs|ps|build|config|help)
      ACTION="$1"
      shift
      ;;
  esac
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --single)
      MODE="single"
      ;;
    --multi)
      MODE="multi"
      ;;
    --service)
      shift
      if [[ $# -lt 1 || -z "${1:-}" ]]; then
        echo "Error: --service requires a value." >&2
        exit 1
      fi
      SERVICE="$1"
      ;;
    --no-build)
      BUILD_ON_UP="false"
      ;;
    --no-follow)
      FOLLOW_LOGS="false"
      ;;
    --help|-h)
      ACTION="help"
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      echo >&2
      usage
      exit 1
      ;;
  esac
  shift
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed or not available in PATH." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_BIN=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_BIN=(docker-compose)
else
  echo "Error: neither 'docker compose' nor 'docker-compose' is available." >&2
  exit 1
fi

if [[ "$MODE" == "multi" ]]; then
  COMPOSE_FILE="${PROJECT_ROOT}/docker-compose.multi.yml"
else
  COMPOSE_FILE="${PROJECT_ROOT}/docker-compose.yml"
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Error: compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

if [[ ! -f "${PROJECT_ROOT}/.env" ]]; then
  echo "Error: .env file not found at ${PROJECT_ROOT}/.env" >&2
  exit 1
fi

compose() {
  "${COMPOSE_BIN[@]}" -f "$COMPOSE_FILE" "$@"
}

ensure_runtime_dirs() {
  if [[ "$MODE" == "multi" ]]; then
    mkdir -p "${PROJECT_ROOT}/data-8192" "${PROJECT_ROOT}/data-8193"
  else
    mkdir -p "${PROJECT_ROOT}/data"
  fi
}

announce_context() {
  echo "Mode        : $MODE"
  echo "Action      : $ACTION"
  echo "Compose file: $COMPOSE_FILE"
  if [[ -n "$SERVICE" ]]; then
    echo "Service     : $SERVICE"
  fi
}

run_up() {
  ensure_runtime_dirs
  if [[ -n "$SERVICE" ]]; then
    if [[ "$BUILD_ON_UP" == "true" ]]; then
      compose up -d --build "$SERVICE"
    else
      compose up -d "$SERVICE"
    fi
  else
    if [[ "$BUILD_ON_UP" == "true" ]]; then
      compose up -d --build
    else
      compose up -d
    fi
  fi
  compose ps
}

run_down() {
  compose down --remove-orphans
}

run_restart() {
  ensure_runtime_dirs
  if [[ -n "$SERVICE" ]]; then
    if [[ "$BUILD_ON_UP" == "true" ]]; then
      compose up -d --build --force-recreate "$SERVICE"
    else
      compose restart "$SERVICE"
    fi
  else
    if [[ "$BUILD_ON_UP" == "true" ]]; then
      compose up -d --build --force-recreate
    else
      compose restart
    fi
  fi
  compose ps
}

run_logs() {
  local args=(logs --tail=200)
  if [[ "$FOLLOW_LOGS" == "true" ]]; then
    args+=(-f)
  fi
  if [[ -n "$SERVICE" ]]; then
    args+=("$SERVICE")
  fi
  compose "${args[@]}"
}

run_ps() {
  if [[ -n "$SERVICE" ]]; then
    compose ps "$SERVICE"
  else
    compose ps
  fi
}

run_build() {
  ensure_runtime_dirs
  if [[ -n "$SERVICE" ]]; then
    compose build "$SERVICE"
  else
    compose build
  fi
}

run_config() {
  compose config
}

announce_context

case "$ACTION" in
  up)
    run_up
    ;;
  down)
    run_down
    ;;
  restart)
    run_restart
    ;;
  logs)
    run_logs
    ;;
  ps)
    run_ps
    ;;
  build)
    run_build
    ;;
  config)
    run_config
    ;;
  help)
    echo
    usage
    ;;
  *)
    echo "Error: unsupported action: $ACTION" >&2
    echo >&2
    usage
    exit 1
    ;;
esac
