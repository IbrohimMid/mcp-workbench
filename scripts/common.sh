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

worker_env_file() {
  local name="$1"
  local root config_dir repo_file config_file
  root="$(workbench_root)"
  config_dir="${HOME}/.config/mcp-workbench/workers"
  repo_file="${root}/.mcp-workbench/workers/${name}.env"
  config_file="${config_dir}/${name}.env"

  if [[ -f "${WORKBENCH_ENV_FILE:-}" ]]; then
    printf '%s\n' "${WORKBENCH_ENV_FILE}"
    return 0
  fi

  if [[ -f "${config_file}" ]]; then
    printf '%s\n' "${config_file}"
    return 0
  fi

  printf '%s\n' "${repo_file}"
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
