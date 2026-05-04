#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/common.sh"

root="$(workbench_root)"
cd "$root"
load_env

command -v node >/dev/null 2>&1 || die "node is required for the bundled MCP server"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 20 )); then
  die "node 20+ is required. Current version: $(node -v)"
fi

if [[ -n "${MCP_SERVER_CMD:-}" ]]; then
  exec bash -lc "${MCP_SERVER_CMD}"
fi

exec node "$root/server/workbench-server.mjs"
