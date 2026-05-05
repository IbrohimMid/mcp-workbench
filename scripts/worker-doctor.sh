#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/common.sh"

name="${1:-}"
shift || true
[[ -n "$name" ]] || die "usage: $(basename "$0") <worker-name> [doctor args...]"

root="$(workbench_root)"
env_file="$(worker_env_file "$name")"

if [[ ! -f "$env_file" ]]; then
  die "worker env not found: ${env_file}"
fi

export WORKBENCH_ENV_FILE="$env_file"
load_env
exec node "$root/scripts/doctor.mjs" "$@"
