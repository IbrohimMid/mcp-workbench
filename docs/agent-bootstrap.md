# Agent bootstrap

The fastest setup path is to let a local coding agent create worker profiles for you.

Example prompt:

```text
buatin 2 worker, 1 untuk chatgpt, satu untuk notion. permission nya keduanya YOLO dan workdir di Documents/project
```

Recommended agent behavior:

1. Resolve the workspace path.
2. Generate one worker config per client, or load `worker-profiles/dual-chatgpt-notion.yaml` for the common two-worker case and edit the workspace path if needed.
3. Use unique ports and tokens.
4. Keep `MCP_ALLOW_OUTSIDE_WORKSPACE=0`.
5. Write the configs under `.mcp-workbench/workers/`.
6. Run `make verify`.
7. Tell the user the final URLs and auth mode.

After the workers are created, use `make dashboard` to inspect the worker list, connector URL, auth hint, `workspace_info`, and selected job signal.
In the dashboard, copy `Public connector URL` into ChatGPT or Notion. Use `Local MCP URL` only for localhost debugging.
The dashboard also exposes local-only worker actions for create/start/stop/restart, but those stay guarded by the local action token.
If you edit worker profiles, presets, or filters, run `make validate-config` before starting the worker.

Helper commands:

```bash
node ./scripts/generate-worker.mjs --profile worker-profiles/dual-chatgpt-notion.yaml
node ./scripts/generate-worker.mjs --name chatgpt --client chatgpt --workspace ~/Documents/project --permission yolo --port 3333
node ./scripts/generate-worker.mjs --name notion --client notion --workspace ~/Documents/project --permission yolo --port 3334
./scripts/worker-up.sh chatgpt
./scripts/worker-up.sh notion
```

Worker profiles are stored per repo under `.mcp-workbench/workers/` and can also be installed into `~/.config/mcp-workbench/workers/` for systemd use.

Permission presets:

- `readonly`: file reads only, no write or shell
- `standard`: write and webfetch enabled, shell off
- `yolo`: write, webfetch, and shell enabled, but workspace boundary still enforced
