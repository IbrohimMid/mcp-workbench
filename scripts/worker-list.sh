#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/common.sh"

root="$(workbench_root)"
repo_dir="${root}/.mcp-workbench/workers"
config_dir="${HOME}/.config/mcp-workbench/workers"

read_value() {
  local file="$1"
  local key="$2"
  local raw
  raw="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  raw="${raw#\'}"
  raw="${raw%\'}"
  printf '%s' "$raw"
}

print_worker() {
  local file="$1"
  local name
  name="$(basename "$file" .env)"
  printf '%s\n' "worker: ${name}"
  printf '  file: %s\n' "$file"
  printf '  client: %s\n' "$(read_value "$file" WORKBENCH_WORKER_CLIENT)"
  printf '  permission: %s\n' "$(read_value "$file" WORKBENCH_WORKER_PERMISSION)"
  printf '  port: %s\n' "$(read_value "$file" MCP_PORT)"
  printf '  workspace: %s\n' "$(read_value "$file" WORKSPACE_DIR)"
  printf '\n'
}

found=0
for dir in "$config_dir" "$repo_dir"; do
  [[ -d "$dir" ]] || continue
  for file in "$dir"/*.env; do
    [[ -e "$file" ]] || continue
    found=1
    print_worker "$file"
  done
done

if [[ "$found" -eq 0 ]]; then
  log "no worker env files found"
fi
