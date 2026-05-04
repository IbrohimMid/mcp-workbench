#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/common.sh"

root="$(workbench_root)"
systemd_dir="${HOME}/.config/systemd/user"
config_dir="${HOME}/.config/mcp-workbench"
config_file="${config_dir}/mcp-workbench.env"

mkdir -p "$systemd_dir" "$config_dir"

install_service() {
  local src="$1"
  local dst="$2"
  sed "s#/ABSOLUTE/PATH/TO/mcp-workbench#${root}#g" "$src" >"$dst"
}

install_service "$root/systemd/user/mcp-workbench.service" "$systemd_dir/mcp-workbench.service"
install_service "$root/systemd/user/mcp-workbench-tunnel.service" "$systemd_dir/mcp-workbench-tunnel.service"

if [[ ! -f "$config_file" ]]; then
  cp "$root/.env.example" "$config_file"
fi

log "installed systemd units to ${systemd_dir}"
log "config file: ${config_file}"
log "next:"
log "  systemctl --user daemon-reload"
log "  systemctl --user enable --now mcp-workbench.service mcp-workbench-tunnel.service"

