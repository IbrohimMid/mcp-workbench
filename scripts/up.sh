#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/common.sh"

root="$(workbench_root)"
cd "$root"
load_env

server_log="${MCP_SERVER_LOG:-logs/server.log}"
tunnel_log="${MCP_TUNNEL_LOG:-logs/tunnel.log}"

mkdir -p "$(dirname "$server_log")" "$(dirname "$tunnel_log")"

cleanup() {
  if [[ -n "${server_pid:-}" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

bash "$root/scripts/start-server.sh" >"$server_log" 2>&1 &
server_pid=$!

bash "$root/scripts/start-tunnel.sh" 2>&1 | tee -a "$tunnel_log"
