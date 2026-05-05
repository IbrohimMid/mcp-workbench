#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/common.sh"

name="${1:-}"
[[ -n "$name" ]] || die "usage: $(basename "$0") <worker-name>"

root="$(workbench_root)"
env_file="$(worker_env_file "$name")"
runtime_root="${MCP_RUNTIME_DIR:-${root}/.mcp-workbench/runtime}"
runtime_dir="${runtime_root}/workers/${name}"

if [[ ! -f "$env_file" ]]; then
  die "worker env not found: ${env_file}"
fi

mkdir -p "$runtime_dir"
printf '%s\n' "$$" >"${runtime_dir}/tunnel.pid"
printf '%s\n' "$env_file" >"${runtime_dir}/tunnel.env"

export WORKBENCH_ENV_FILE="$env_file"
export MCP_RUNTIME_DIR="$runtime_root"
exec "$root/scripts/start-tunnel.sh"
