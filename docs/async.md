# Async workflow model

This template supports a job-based MCP workflow pattern for long-running actions.

## What changes

- The tool returns quickly with a `job_id`
- The actual work continues in the background
- Status and final output are fetched later
- Existing jobs are not interrupted when you deploy a new version

## Recommended tool shape

- `workflow`: validate input, create a job, return immediately
- `workflow_presets`: list or inspect named presets
- `signal`: return a distilled summary for a job
- `workflow_status`: poll progress by `job_id`
- `workflow_result`: fetch the final output by `job_id`
- `workflow_cancel`: stop a queued or running job when supported

Workflow permissions should default to a safe boundary:

- filesystem read: on
- filesystem write: off unless explicitly enabled
- shell: off unless explicitly enabled
- network: off unless explicitly enabled

## Why this avoids transport failures

Long-running MCP calls keep the HTTP request open. That is fragile with browser clients and tunnels.
Returning a job id early keeps the transport short-lived and moves the expensive work into a background process.

## Zero-downtime cutover

1. Start a new async-capable worker on a new port or service name.
2. Leave the current worker running until its active jobs finish.
3. Point the client to the new URL.
4. Once traffic has moved over, retire the old worker.

## Notes for client behavior

- Notion AI default still decides when to prompt for approval.
- Custom agents can usually work better with an async job model.
- The server can reduce prompt pressure by batching work into one job.
- The `signal` layer is useful when the raw shell output is noisy but the agent only needs the important lines.

## Presets

If your server exposes workflow presets, keep them in a dedicated directory such as `workflow-presets/`.

Example:

```yaml
name: code-review-readonly
description: Read-only scan preset for review and inspection flows.
permissions:
  filesystem:
    read: true
    write: false
  shell:
    enabled: false
  network:
    enabled: false
steps:
  - tool: grep
    arguments:
      pattern: TODO|FIXME
      glob: "*.md"
      ignoreCase: true
      literal: false
```
