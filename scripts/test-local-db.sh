#!/bin/bash
set -Eeuo pipefail

fake_docker() {
  printf '%s\n' "$*" >>"${FAKE_DOCKER_LOG:?}"

  if [[ "${1:-}" == "context" && "${2:-}" == "inspect" ]]; then
    printf '%s\n' "${FAKE_DOCKER_ENDPOINT:-unix:///var/run/docker.sock}"
  elif [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
    return
  elif [[ "${1:-}" == "compose" && "${2:-}" == "up" && "${3:-}" == "--help" ]]; then
    printf '%s\n' 'Usage: docker compose up'
    if [[ "${FAKE_COMPOSE_WAIT_SUPPORTED:-true}" == "true" ]]; then
      printf '%s\n' '  --wait  --wait-timeout int'
    fi
    return
  elif [[ "${1:-}" == "info" ]]; then
    return
  elif [[ "${1:-}" == "volume" && "${2:-}" == "inspect" ]]; then
    [[ "${FAKE_VOLUME_STATE:-present}" == "present" ]] || return 1
    if [[ "$*" == *"--format"* ]]; then
      printf '%s\n' "${FAKE_VOLUME_LABELS:-dupert-local-db|postgres_data}"
    fi
    return
  elif [[ "${1:-}" == "volume" && "${2:-}" == "rm" ]]; then
    return
  fi
}

if [[ "${0##*/}" == "docker" ]]; then
  fake_docker "$@"
  exit
fi

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_SCRIPT="$ROOT_DIR/scripts/db.sh"
COMPOSE_FILE="$ROOT_DIR/compose.local.yml"
FAKE_BIN="$(mktemp -d "${TMPDIR:-/tmp}/dupert-local-db-test.XXXXXX")"
FAKE_LOG="$FAKE_BIN/docker.log"
trap 'rm -rf "$FAKE_BIN"' EXIT
cp "$ROOT_DIR/scripts/test-local-db.sh" "$FAKE_BIN/docker"
chmod +x "$FAKE_BIN/docker"
: >"$FAKE_LOG"

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq "$expected" "$file" || {
    echo "Expected $file to contain: $expected" >&2
    exit 1
  }
}

assert_output() {
  [[ "$LAST_OUTPUT" == *"$1"* ]] || {
    echo "Expected failure output to contain: $1" >&2
    exit 1
  }
}

capture_failure() {
  set +e
  LAST_OUTPUT="$("$@" 2>&1)"
  LAST_STATUS=$?
  set -e
  [[ $LAST_STATUS -ne 0 ]] || {
    echo "Expected command to fail: $*" >&2
    exit 1
  }
}

db_with_fake() {
  /usr/bin/env -u DOCKER_CONTEXT \
    PATH="$FAKE_BIN" \
    DOCKER_HOST="${TEST_DOCKER_HOST:-unix:///var/run/docker.sock}" \
    DUPERT_POSTGRES_MAJOR="${TEST_POSTGRES_MAJOR:-16}" \
    DUPERT_POSTGRES_PORT="${TEST_POSTGRES_PORT:-5432}" \
    FAKE_DOCKER_LOG="$FAKE_LOG" \
    FAKE_DOCKER_ENDPOINT="${TEST_DOCKER_ENDPOINT:-unix:///var/run/docker.sock}" \
    FAKE_COMPOSE_WAIT_SUPPORTED="${TEST_COMPOSE_WAIT_SUPPORTED:-true}" \
    FAKE_VOLUME_STATE="${TEST_VOLUME_STATE:-present}" \
    FAKE_VOLUME_LABELS="${TEST_VOLUME_LABELS:-dupert-local-db|postgres_data}" \
    /bin/bash "$DB_SCRIPT" "$@"
}

bash -n "$DB_SCRIPT"
assert_contains "$COMPOSE_FILE" 'image: postgres:${DUPERT_POSTGRES_MAJOR:-16}-alpine'
assert_contains "$COMPOSE_FILE" '127.0.0.1:${DUPERT_POSTGRES_PORT:-5432}:5432'
assert_contains "$COMPOSE_FILE" 'name: dupert_local_postgres_${DUPERT_POSTGRES_MAJOR:-16}_data'
assert_contains "$COMPOSE_FILE" 'pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB'
assert_contains "$ROOT_DIR/backend/.env.example" 'DATABASE_URL=postgresql://dupert:dupert_local_dev_password@127.0.0.1:5432/dupert'

capture_failure /usr/bin/env \
  PATH= DUPERT_POSTGRES_MAJOR=16 DUPERT_POSTGRES_PORT=5432 \
  /bin/bash "$DB_SCRIPT" status
assert_output "Docker is required for the local database"

capture_failure /usr/bin/env \
  PATH="$FAKE_BIN" DUPERT_POSTGRES_MAJOR='16;unexpected' DUPERT_POSTGRES_PORT=5432 \
  FAKE_DOCKER_LOG="$FAKE_LOG" /bin/bash "$DB_SCRIPT" status
assert_output "DUPERT_POSTGRES_MAJOR must be a positive whole number"

capture_failure /usr/bin/env \
  PATH="$FAKE_BIN" DUPERT_POSTGRES_MAJOR=0 DUPERT_POSTGRES_PORT=5432 \
  FAKE_DOCKER_LOG="$FAKE_LOG" /bin/bash "$DB_SCRIPT" status
assert_output "DUPERT_POSTGRES_MAJOR must be a positive whole number"

capture_failure /usr/bin/env \
  PATH="$FAKE_BIN" DUPERT_POSTGRES_MAJOR=16 DUPERT_POSTGRES_PORT=65536 \
  FAKE_DOCKER_LOG="$FAKE_LOG" /bin/bash "$DB_SCRIPT" status
assert_output "DUPERT_POSTGRES_PORT must be a whole number from 1 to 65535"

capture_failure /usr/bin/env \
  PATH="$FAKE_BIN" DUPERT_POSTGRES_MAJOR=16 DUPERT_POSTGRES_PORT='5432;unexpected' \
  FAKE_DOCKER_LOG="$FAKE_LOG" /bin/bash "$DB_SCRIPT" status
assert_output "DUPERT_POSTGRES_PORT must be a whole number from 1 to 65535"

capture_failure /usr/bin/env -u DOCKER_CONTEXT \
  PATH="$FAKE_BIN" DOCKER_HOST=ssh://developer@example.test \
  DUPERT_POSTGRES_MAJOR=16 DUPERT_POSTGRES_PORT=5432 \
  FAKE_DOCKER_LOG="$FAKE_LOG" /bin/bash "$DB_SCRIPT" status
assert_output "Refusing to use a remote Docker endpoint"

capture_failure /usr/bin/env -u DOCKER_HOST -u DOCKER_CONTEXT \
  PATH="$FAKE_BIN" DUPERT_POSTGRES_MAJOR=16 DUPERT_POSTGRES_PORT=5432 \
  FAKE_DOCKER_LOG="$FAKE_LOG" FAKE_DOCKER_ENDPOINT=tcp://127.0.0.1:2375 \
  /bin/bash "$DB_SCRIPT" status
assert_output "Refusing to use a remote Docker endpoint"

capture_failure /usr/bin/env \
  PATH="$FAKE_BIN" DOCKER_CONTEXT=remote-context DOCKER_HOST=unix:///var/run/docker.sock \
  DUPERT_POSTGRES_MAJOR=16 DUPERT_POSTGRES_PORT=5432 \
  FAKE_DOCKER_LOG="$FAKE_LOG" FAKE_DOCKER_ENDPOINT=ssh://developer@example.test \
  /bin/bash "$DB_SCRIPT" status
assert_output "Refusing to use a remote Docker endpoint"

TEST_COMPOSE_WAIT_SUPPORTED=false capture_failure db_with_fake status
assert_output "must support 'up --wait'"

capture_failure /usr/bin/env \
  PATH= DUPERT_POSTGRES_MAJOR=16 DUPERT_POSTGRES_PORT=5432 \
  /bin/bash "$DB_SCRIPT" reset </dev/null
assert_output "Refusing to reset without an interactive terminal"

: >"$FAKE_LOG"
TEST_VOLUME_LABELS='another-project|postgres_data' capture_failure db_with_fake reset --force
assert_output "is not this project's Compose volume"
if grep -Eq 'compose .* down|volume rm' "$FAKE_LOG"; then
  echo "Mismatched reset touched Compose resources before refusing." >&2
  exit 1
fi

: >"$FAKE_LOG"
TEST_VOLUME_STATE=absent db_with_fake reset --force >/dev/null
grep -Eq 'compose .* up .*--wait' "$FAKE_LOG" || {
  echo "No-volume reset did not start a fresh database." >&2
  exit 1
}
if grep -Eq 'compose .* down|volume rm' "$FAKE_LOG"; then
  echo "No-volume reset stopped or deleted resources." >&2
  exit 1
fi

: >"$FAKE_LOG"
db_with_fake reset --force >/dev/null
[[ "$(grep -c 'volume inspect dupert_local_postgres_16_data .*--format' "$FAKE_LOG")" -eq 2 ]] || {
  echo "Reset did not validate the selected major's volume twice." >&2
  exit 1
}
grep -Fq 'volume rm dupert_local_postgres_16_data' "$FAKE_LOG" || {
  echo "Reset did not delete the selected major's volume." >&2
  exit 1
}

echo "Local database configuration contracts passed."
