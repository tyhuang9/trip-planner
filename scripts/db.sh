#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/compose.local.yml"
PROJECT_NAME="dupert-local-db"
POSTGRES_MAJOR="${DUPERT_POSTGRES_MAJOR:-16}"
POSTGRES_PORT="${DUPERT_POSTGRES_PORT:-5432}"
VOLUME_NAME="dupert_local_postgres_${POSTGRES_MAJOR}_data"
COMPOSE_SUPPORTS_WAIT_TIMEOUT="false"

usage() {
  cat <<'EOF'
Usage: npm run db:<command> [-- --force]

Commands:
  up       Start PostgreSQL and wait until it is healthy.
  down     Stop PostgreSQL, preserving its data volume.
  status   Show the local PostgreSQL container status.
  logs     Follow local PostgreSQL logs.
  reset    Delete only Dupert's local PostgreSQL data volume, then start a fresh database.

Set DUPERT_POSTGRES_MAJOR (default: 16) or DUPERT_POSTGRES_PORT (default: 5432)
before running a command to override the local image major or host port.
EOF
}

fail() {
  echo "$1" >&2
  exit 1
}

validate_configuration() {
  [[ "$POSTGRES_MAJOR" =~ ^[1-9][0-9]*$ ]] \
    || fail "DUPERT_POSTGRES_MAJOR must be a positive whole number (for example, 16)."
  [[ "$POSTGRES_PORT" =~ ^[0-9]{1,5}$ ]] \
    && (( 10#$POSTGRES_PORT >= 1 && 10#$POSTGRES_PORT <= 65535 )) \
    || fail "DUPERT_POSTGRES_PORT must be a whole number from 1 to 65535."
}

require_docker_compose() {
  local docker_endpoint
  local compose_up_help

  if ! command -v docker >/dev/null 2>&1; then
    fail "Docker is required for the local database. Install and start Docker Desktop, then run npm run db:up."
  fi

  # Docker's DOCKER_CONTEXT takes precedence over DOCKER_HOST when both are set.
  if [[ -n "${DOCKER_CONTEXT:-}" ]]; then
    docker_endpoint="$(docker context inspect "$DOCKER_CONTEXT" --format '{{ (index .Endpoints "docker").Host }}' 2>/dev/null)" \
      || fail "Could not resolve DOCKER_CONTEXT. Select a local Docker context, then run npm run db:up."
  elif [[ -n "${DOCKER_HOST:-}" ]]; then
    docker_endpoint="$DOCKER_HOST"
  else
    docker_endpoint="$(docker context inspect --format '{{ (index .Endpoints "docker").Host }}' 2>/dev/null)" \
      || fail "Could not resolve the current Docker context. Select a local Docker context, then run npm run db:up."
  fi

  case "$docker_endpoint" in
    unix://*|npipe://*) ;;
    *)
      fail "Refusing to use a remote Docker endpoint for the local database. Unset DOCKER_CONTEXT and DOCKER_HOST, then select a local unix:// or npipe:// Docker context."
      ;;
  esac

  if ! docker compose version >/dev/null 2>&1; then
    fail "Docker Compose v2 is required. Update Docker Desktop or install the Docker Compose plugin, then run npm run db:up."
  fi

  compose_up_help="$(docker compose up --help 2>&1)" \
    || fail "Could not inspect Docker Compose capabilities. Update Docker Compose v2, then run npm run db:up."
  [[ "$compose_up_help" == *"--wait"* ]] \
    || fail "Docker Compose must support 'up --wait'. Update Docker Desktop or Docker Compose v2, then run npm run db:up."
  [[ "$compose_up_help" == *"--wait-timeout"* ]] && COMPOSE_SUPPORTS_WAIT_TIMEOUT="true"

  if ! docker info >/dev/null 2>&1; then
    fail "Docker is installed but not running. Start Docker Desktop, wait for it to finish starting, then run npm run db:up."
  fi
}

compose() {
  docker compose --project-name "$PROJECT_NAME" --file "$COMPOSE_FILE" "$@"
}

start_database() {
  local args=(up --detach --wait)
  [[ "$COMPOSE_SUPPORTS_WAIT_TIMEOUT" == "true" ]] && args+=(--wait-timeout 60)
  compose "${args[@]}"
}

confirm_reset() {
  if [[ "${1:-}" == "--force" ]]; then
    return
  fi

  if [[ -n "${1:-}" ]]; then
    fail "Unknown reset option: $1. Use --force for non-interactive reset."
  fi

  if [[ ! -t 0 ]]; then
    fail "Refusing to reset without an interactive terminal. Re-run npm run db:reset -- --force only if you intend to delete Dupert's local database."
  fi

  echo "This permanently deletes the local Dupert PostgreSQL volume ($VOLUME_NAME)."
  read -r -p "Type RESET to continue: " confirmation
  [[ "$confirmation" == "RESET" ]] || fail "Reset cancelled."
}

reset() {
  if ! docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
    echo "No Dupert PostgreSQL $POSTGRES_MAJOR volume exists; skipping explicit teardown and deletion before starting a fresh database."
    start_database
    return
  fi

  validate_volume
  compose down >/dev/null
  validate_volume
  docker volume rm "$VOLUME_NAME" >/dev/null
  echo "Deleted Dupert's local PostgreSQL $POSTGRES_MAJOR data."
  start_database
}

validate_volume() {
  local labels

  labels="$(docker volume inspect "$VOLUME_NAME" --format '{{ index .Labels "com.docker.compose.project" }}|{{ index .Labels "com.docker.compose.volume" }}' 2>/dev/null || true)"
  [[ "$labels" == "$PROJECT_NAME|postgres_data" ]] \
    || fail "Refusing to delete $VOLUME_NAME because it is not this project's Compose volume."
}

command="${1:-help}"
shift || true

case "$command" in
  help|-h|--help)
    usage
    ;;
  reset)
    [[ $# -le 1 ]] || fail "Usage: npm run db:reset -- --force"
    validate_configuration
    confirm_reset "${1:-}"
    require_docker_compose
    reset
    ;;
  up)
    [[ $# -eq 0 ]] || fail "Usage: npm run db:up"
    validate_configuration
    require_docker_compose
    start_database
    ;;
  down)
    [[ $# -eq 0 ]] || fail "Usage: npm run db:down"
    validate_configuration
    require_docker_compose
    compose down
    ;;
  status)
    [[ $# -eq 0 ]] || fail "Usage: npm run db:status"
    validate_configuration
    require_docker_compose
    compose ps
    ;;
  logs)
    [[ $# -eq 0 ]] || fail "Usage: npm run db:logs"
    validate_configuration
    require_docker_compose
    compose logs --follow --tail=100
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
