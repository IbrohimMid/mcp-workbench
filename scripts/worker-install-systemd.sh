#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/common.sh"

name="${1:-}"
[[ -n "$name" ]] || die "usage: $(basename "$0") <worker-name>"

root="$(workbench_root)"
systemd_dir="${HOME}/.config/systemd/user"
config_root="${HOME}/.config/mcp-workbench/workers"
repo_env="${root}/.mcp-workbench/workers/${name}.env"
config_env="${config_root}/${name}.env"
server_unit="${systemd_dir}/mcp-workbench-${name}.service"
tunnel_unit="${systemd_dir}/mcp-workbench-${name}-tunnel.service"

if [[ ! -f "$repo_env" && ! -f "$config_env" ]]; then
  die "worker env not found: ${repo_env} or ${config_env}"
fi

mkdir -p "$systemd_dir" "$config_root"

if [[ -f "$repo_env" ]]; then
  cp "$repo_env" "$config_env"
fi

cat >"$server_unit" <<EOF
[Unit]
Description=mcp-workbench worker ${name} MCP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${root}
Environment=WORKBENCH_ENV_FILE=${config_env}
ExecStart=/usr/bin/env bash ./scripts/worker-server.sh ${name}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=default.target
EOF

cat >"$tunnel_unit" <<EOF
[Unit]
Description=mcp-workbench worker ${name} Cloudflare tunnel
After=network-online.target mcp-workbench-${name}.service
Wants=network-online.target
Requires=mcp-workbench-${name}.service

[Service]
Type=simple
WorkingDirectory=${root}
Environment=WORKBENCH_ENV_FILE=${config_env}
ExecStart=/usr/bin/env bash ./scripts/worker-tunnel.sh ${name}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=default.target
EOF

log "installed worker units for ${name}"
log "  server: ${server_unit}"
log "  tunnel: ${tunnel_unit}"
log "  env:    ${config_env}"
log "next:"
log "  systemctl --user daemon-reload"
log "  systemctl --user enable --now mcp-workbench-${name}.service mcp-workbench-${name}-tunnel.service"
