#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/common.sh"

root="$(workbench_root)"
cd "$root"
load_env

host="${MCP_HOST:-127.0.0.1}"
port="${MCP_PORT:-3333}"
url="${TUNNEL_URL:-http://${host}:${port}}"
mode="${TUNNEL_MODE:-quick}"
timeout="${MCP_STARTUP_TIMEOUT:-60}"
edge_ip_version="${CLOUDFLARED_EDGE_IP_VERSION:-auto}"
cloudflared_image="${CLOUDFLARED_IMAGE:-cloudflare/cloudflared:latest}"

wait_for_port "$host" "$port" "$timeout"

if [[ "$mode" == "named" ]]; then
  require_var CLOUDFLARED_CONFIG
  command -v cloudflared >/dev/null 2>&1 || die "named tunnel mode requires cloudflared on PATH"
  exec cloudflared tunnel --config "$CLOUDFLARED_CONFIG" run
fi

edge_args=()
if [[ "$edge_ip_version" != "auto" ]]; then
  edge_args+=(--edge-ip-version "$edge_ip_version")
fi

if command -v cloudflared >/dev/null 2>&1; then
  exec cloudflared tunnel --protocol http2 "${edge_args[@]}" --url "$url"
fi

if command -v docker >/dev/null 2>&1; then
  exec docker run --rm --network host "$cloudflared_image" tunnel --protocol http2 "${edge_args[@]}" --url "$url"
fi

die "install cloudflared or docker"
