#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Use the external command so lifecycle checks can be exercised with a fake process table.
enable -n kill 2>/dev/null || true

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/backend.sh"
BACKEND_DIR="$ROOT_DIR/backend"
ENV_FILE="$BACKEND_DIR/.env"
RUNTIME_DIR="$ROOT_DIR/.dupert/runtime"
STATE_FILE="$RUNTIME_DIR/backend.state"
LOG_FILE="$RUNTIME_DIR/backend.log"
LOCK_DIR="$RUNTIME_DIR/backend.lock"
EXPECTED_COMMAND="/bin/bash $SCRIPT_PATH run"
STATE_TMP=""
PENDING_PID=""
PENDING_PGID=""
PENDING_BIRTH_TOKEN=""
PENDING_COMMAND_FINGERPRINT=""

fail() {
  echo "$1" >&2
  exit 1
}

read_state() {
  local line
  [[ -f "$STATE_FILE" ]] || return 1
  version=""
  root_dir=""
  pid=""
  pgid=""
  birth_token=""
  command_fingerprint=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      version=*) [[ -z "$version" ]] || return 1; version="${line#version=}" ;;
      root_dir=*) [[ -z "$root_dir" ]] || return 1; root_dir="${line#root_dir=}" ;;
      pid=*) [[ -z "$pid" ]] || return 1; pid="${line#pid=}" ;;
      pgid=*) [[ -z "$pgid" ]] || return 1; pgid="${line#pgid=}" ;;
      birth_token=*) [[ -z "$birth_token" ]] || return 1; birth_token="${line#birth_token=}" ;;
      command_fingerprint=*) [[ -z "$command_fingerprint" ]] || return 1; command_fingerprint="${line#command_fingerprint=}" ;;
      *) return 1 ;;
    esac
  done <"$STATE_FILE"
  [[ "$version" == "1" && "$root_dir" == "$ROOT_DIR" && "$pid" =~ ^[1-9][0-9]*$ \
    && "$pgid" == "$pid" && -n "$birth_token" && "$command_fingerprint" == "$EXPECTED_COMMAND" ]]
}

process_birth_token() {
  ps -o lstart= -p "$1" 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

process_group_matches_identity() {
  local expected_pid="$1" expected_pgid="$2" expected_birth="$3" expected_command="$4"
  local actual_pgid actual_birth actual_command
  [[ "$expected_pid" =~ ^[1-9][0-9]*$ && "$expected_pgid" == "$expected_pid" \
    && -n "$expected_birth" && "$expected_command" == "$EXPECTED_COMMAND" ]] || return 1
  actual_pgid="$(ps -o pgid= -p "$expected_pid" 2>/dev/null | tr -d '[:space:]')" || return 1
  actual_birth="$(process_birth_token "$expected_pid")" || return 1
  actual_command="$(ps -o command= -p "$expected_pid" 2>/dev/null)" || return 1
  [[ "$actual_pgid" == "$expected_pgid" && "$actual_birth" == "$expected_birth" \
    && "$actual_command" == "$expected_command" ]] || return 1
  ps -o pid= -g "$expected_pgid" 2>/dev/null \
    | grep -Eq "^[[:space:]]*${expected_pid}[[:space:]]*$"
}

owned_process_group() {
  process_group_matches_identity "$pid" "$pgid" "$birth_token" "$command_fingerprint"
}

process_exists() {
  ps -o pid= -p "$1" 2>/dev/null | grep -Eq "^[[:space:]]*$1[[:space:]]*$"
}

group_has_processes() {
  local group_id="${1:-$pgid}"
  ps -o pid= -g "$group_id" 2>/dev/null | grep -q '[0-9]'
}

finish_stop() {
  rm -f "$STATE_FILE"
  echo "$1"
}

release_lock() {
  [[ -z "$STATE_TMP" ]] || rm -f "$STATE_TMP"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

clear_pending_launch() {
  PENDING_PID=""
  PENDING_PGID=""
  PENDING_BIRTH_TOKEN=""
  PENDING_COMMAND_FINGERPRINT=""
}

pending_launch_is_published() {
  [[ -n "$PENDING_PID" && -f "$STATE_FILE" ]] || return 1
  read_state || return 1
  [[ "$pid" == "$PENDING_PID" && "$pgid" == "$PENDING_PGID" \
    && "$birth_token" == "$PENDING_BIRTH_TOKEN" \
    && "$command_fingerprint" == "$PENDING_COMMAND_FINGERPRINT" ]]
}

cleanup_pending_launch() {
  [[ -n "$PENDING_PID" ]] || return 0
  if pending_launch_is_published; then
    clear_pending_launch
    return 0
  fi
  if ! process_group_matches_identity \
      "$PENDING_PID" "$PENDING_PGID" "$PENDING_BIRTH_TOKEN" "$PENDING_COMMAND_FINGERPRINT"; then
    echo "Refusing to terminate an unverified pending backend process group (PID $PENDING_PID)." >&2
    return 0
  fi

  kill -TERM -- "-$PENDING_PGID" 2>/dev/null || true
  for _ in {1..30}; do
    if ! group_has_processes "$PENDING_PGID"; then
      clear_pending_launch
      return 0
    fi
    sleep 0.1
  done

  if ! process_group_matches_identity \
      "$PENDING_PID" "$PENDING_PGID" "$PENDING_BIRTH_TOKEN" "$PENDING_COMMAND_FINGERPRINT"; then
    echo "Refusing to send KILL to an unverified pending backend process group (PID $PENDING_PID)." >&2
    return 0
  fi
  kill -KILL -- "-$PENDING_PGID" 2>/dev/null || true
  for _ in {1..10}; do
    if ! group_has_processes "$PENDING_PGID"; then
      clear_pending_launch
      return 0
    fi
    sleep 0.1
  done
  echo "Could not confirm that pending backend process group $PENDING_PGID stopped after KILL." >&2
}

handle_exit() {
  local status=$?
  trap - EXIT
  set +e
  cleanup_pending_launch
  release_lock
  exit "$status"
}

acquire_lock() {
  mkdir -p "$RUNTIME_DIR"
  chmod 700 "$RUNTIME_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null \
    || fail "Another backend lifecycle command is running, or $LOCK_DIR is stale. Remove it only after confirming no startback/stopback command is active."
  trap handle_exit EXIT
}

publish_state() {
  STATE_TMP="$RUNTIME_DIR/backend.state.$$"
  printf 'version=1\nroot_dir=%s\npid=%s\npgid=%s\nbirth_token=%s\ncommand_fingerprint=%s\n' \
    "$ROOT_DIR" "$pid" "$pgid" "$birth_token" "$command_fingerprint" >"$STATE_TMP"
  chmod 600 "$STATE_TMP"
  mv -f "$STATE_TMP" "$STATE_FILE"
  STATE_TMP=""
}

clear_stale_state() {
  if ! read_state; then
    fail "Refusing to use malformed backend state at $STATE_FILE. Remove it only after confirming no backend from this worktree is running."
  fi

  if ! process_exists "$pid"; then
    rm -f "$STATE_FILE"
    return
  fi

  owned_process_group || fail "Refusing to use $STATE_FILE: it does not identify this worktree's backend process group."
}

start() {
  [[ -f "$ENV_FILE" ]] || fail "Missing $ENV_FILE. Copy backend/.env.example to backend/.env and fill in the backend values first."
  [[ -x "$BACKEND_DIR/gradlew" ]] || fail "Missing executable $BACKEND_DIR/gradlew."
  command -v perl >/dev/null 2>&1 || fail "Perl is required to create an isolated backend process group."
  acquire_lock

  if [[ -f "$STATE_FILE" ]]; then
    clear_stale_state
    if [[ -f "$STATE_FILE" ]]; then
      echo "Backend is already running (PID $pid; log: $LOG_FILE)."
      return
    fi
  fi

  touch "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  perl -MPOSIX=setsid -e 'POSIX::setsid() or die "setsid: $!"; exec @ARGV' \
    /bin/bash "$SCRIPT_PATH" run >>"$LOG_FILE" 2>&1 &
  PENDING_PID=$!
  PENDING_PGID="$PENDING_PID"
  PENDING_COMMAND_FINGERPRINT="$EXPECTED_COMMAND"
  PENDING_BIRTH_TOKEN="$(process_birth_token "$PENDING_PID")" || PENDING_BIRTH_TOKEN=""
  pid="$PENDING_PID"
  pgid=""
  birth_token=""
  command_fingerprint=""
  for _ in {1..100}; do
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    birth_token="$(process_birth_token "$pid")"
    command_fingerprint="$(ps -o command= -p "$pid" 2>/dev/null)"
    if [[ -z "$PENDING_BIRTH_TOKEN" && -n "$birth_token" ]]; then
      PENDING_BIRTH_TOKEN="$birth_token"
    fi
    [[ "$pgid" == "$pid" && -n "$birth_token" && "$birth_token" == "$PENDING_BIRTH_TOKEN" \
      && "$command_fingerprint" == "$EXPECTED_COMMAND" ]] && break
    sleep 0.05
  done
  [[ "$pgid" == "$pid" && -n "$birth_token" && "$birth_token" == "$PENDING_BIRTH_TOKEN" \
    && "$command_fingerprint" == "$EXPECTED_COMMAND" ]] \
    || fail "Backend identity could not be verified before publishing state; see $LOG_FILE."
  publish_state
  clear_pending_launch
  echo "Backend started (PID $pid; log: $LOG_FILE)."
}

stop() {
  acquire_lock
  [[ -f "$STATE_FILE" ]] || {
    echo "Backend is not running."
    return
  }
  read_state || fail "Refusing to stop: $STATE_FILE is invalid."
  if ! process_exists "$pid"; then
    rm -f "$STATE_FILE"
    echo "Removed stale backend state."
    return
  fi
  owned_process_group || fail "Refusing to stop: $STATE_FILE does not identify this worktree's backend process group."

  kill -TERM -- "-$pgid" 2>/dev/null || true
  for _ in {1..30}; do
    group_has_processes || { finish_stop "Backend stopped."; return; }
    sleep 0.1
  done

  if ! owned_process_group; then
    group_has_processes || { finish_stop "Backend stopped."; return; }
    fail "Refusing to send KILL: the recorded backend process group is no longer owned by this worktree. State was preserved."
  fi
  kill -KILL -- "-$pgid" 2>/dev/null || true
  for _ in {1..10}; do
    group_has_processes || { finish_stop "Backend stopped after KILL."; return; }
    sleep 0.1
  done
  fail "Could not confirm that the backend process group stopped after KILL. State was preserved."
}

run() {
  cd "$BACKEND_DIR"
  set -a
  set +u
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  export SPRING_PROFILES_ACTIVE="${SPRING_PROFILES_ACTIVE:-local}"
  set -u
  set +a
  "$BACKEND_DIR/gradlew" bootRun &
  wait "$!"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  run) run ;;
  *) echo "Usage: $0 {start|stop}" >&2; exit 1 ;;
esac
