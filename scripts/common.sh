#!/usr/bin/env bash

workbench_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

log() {
  printf '%s\n' "$*"
}

die() {
  log "error: $*"
  exit 1
}

load_env() {
  local root env_file
  root="$(workbench_root)"
  env_file="${WORKBENCH_ENV_FILE:-${root}/.env}"

  if [[ -f "${env_file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
  fi
}

require_var() {
  local name="$1"
  local value="${!name:-}"
  [[ -n "${value}" ]] || die "${name} is required"
}

wait_for_port() {
  local host="$1"
  local port="$2"
  local timeout="${3:-60}"
  local start="${SECONDS}"

  while true; do
    if (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; then
      exec 3>&-
      exec 3<&-
      return 0
    fi

    if (( SECONDS - start >= timeout )); then
      die "timed out waiting for ${host}:${port} after ${timeout}s"
    fi

    sleep 1
  done
}

