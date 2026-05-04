# Notion connector

1. Enable custom MCP support in the workspace if required.
2. Add `https://<your-tunnel>/mcp` to the allowed list if your workspace uses URL restrictions.
3. Connect the custom MCP server from the Notion UI.
4. If the UI only accepts one URL field, use `https://<your-tunnel>/mcp?auth_token=<MCP_TOKEN>` only when you intentionally enabled query-token auth in the worker.

The bundled server layer in this repo exposes the common coding tools directly, and `workflow` can batch several actions into one call.
The `signal` tool gives you a distilled version of noisy job output without replacing the raw logs.

If you use a quick tunnel, update the allowlist when the URL changes.

Notion AI default may still prompt for approval per action. Custom agents are the better fit if you want to use `workflow` and the async job flow with fewer interruptions.
