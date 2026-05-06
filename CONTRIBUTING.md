# Contributing

Thanks for helping improve `mcp-workbench`.

## Before you open a PR

- Run `make verify`
- Run `make validate-config`
- If you touched worker generation or runtime behavior, run `make smoke-test`
- Keep changes scoped and avoid unrelated formatting churn

## Suggested workflow

1. Fork or branch from `main`
2. Make the smallest useful change
3. Update docs when behavior changes
4. Add or update tests where practical
5. Open a pull request with a clear summary and verification notes

## Local checks

```bash
make verify
make validate-config
make smoke-test
```

## Security-sensitive changes

If your change touches auth, workspace boundaries, shell execution, or tunnel handling, explain the risk and the guardrails in the PR description.
