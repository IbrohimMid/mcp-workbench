# Agent setup guide

This repo is meant to be driven by a local coding agent as much as by hand.

When a user asks to create workers, follow this flow:

1. Create one worker profile per requested client.
2. Write generated env files under `.mcp-workbench/workers/`.
3. Keep `WORKSPACE_DIR` narrow and always keep `MCP_ALLOW_OUTSIDE_WORKSPACE=0`.
4. Use one port per worker.
5. Generate a distinct `MCP_TOKEN` for each worker.
6. Treat `yolo` as write + shell + webfetch enabled, not as an escape from the workspace boundary.
7. Run `make verify` after editing the repo.
8. Run `./scripts/worker-doctor.sh <name>` for each generated worker.
9. Print the final client URL, auth mode, and worker name back to the user.

If the user is asking for the common ChatGPT + Notion pair, prefer `worker-profiles/dual-chatgpt-notion.yaml` and `scripts/generate-worker.mjs --profile ...` instead of generating each worker by hand. Edit the workspace path first if the default example does not match the user's machine.

For multi-worker setups, prefer the helper scripts:

- `scripts/generate-worker.mjs`
- `scripts/worker-up.sh`
- `scripts/worker-doctor.sh`
- `scripts/worker-install-systemd.sh`

If the user gives a natural-language request like:

> buatin 2 worker, 1 untuk chatgpt, satu untuk notion. permission nya keduanya YOLO dan workdir di Documents/project

Interpret it as two worker configs with the same workspace and yolo permissions, then generate them with unique ports and tokens.
