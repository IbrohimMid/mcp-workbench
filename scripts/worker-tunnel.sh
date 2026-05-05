#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/common.sh"

name="${1:-}"
[[ -n "$name" ]] || die "usage: $(basename "$0") <worker-name>"

root="$(workbench_root)"
env_file="$(worker_env_file "$name")"

if [[ ! -f "$env_file" ]]; then
  die "worker env not found: ${env_file}"
fi

export WORKBENCH_ENV_FILE="$env_file"
exec "$root/scripts/start-tunnel.sh"
