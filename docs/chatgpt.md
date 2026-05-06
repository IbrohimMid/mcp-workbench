# ChatGPT connector

1. Enable developer mode in ChatGPT.
2. Add a custom connector.
3. Point it to `https://<your-tunnel>/mcp`.
4. Use `Bearer <MCP_TOKEN>` if the connector UI exposes bearer auth.
5. If you intentionally enabled query-token auth in your worker, use `https://<your-tunnel>/mcp?auth_token=<MCP_TOKEN>`.
6. If you use a quick tunnel, expect the URL to change after restart.

The bundled server layer exposes the common tools directly, so you do not need to patch a separate OpenCode repo unless you want to swap in a different backend.

For long-running tasks, prefer the async job flow:

- `bash`
- `bash_status`
- `bash_tail`
- `bash_result`
- `signal`
- `signal_diff`
- `job_retrieve`

If you want batched actions, call `workflow` with either inline steps or a named preset.
Inline workflow steps inherit the current worker capability set by default; use a preset only when you want to narrow the permissions.
If your workspace uses local signal filters, trust them once with `trust_workspace_filters` before expecting them to apply.
Use `signal_filters` to inspect which filters and distillers are active, and `job_retrieve` when you need raw logs again.
