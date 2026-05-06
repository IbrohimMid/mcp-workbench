# Security Policy

## Supported versions

The `main` branch is the active development target.

## Reporting a vulnerability

If you find a security issue in `mcp-workbench`, please report it privately through GitHub Security Advisories for this repository.

Do not open a public issue for:

- auth bypasses
- workspace boundary escapes
- shell execution issues
- token leakage
- tunnel exposure problems

## What to include

- A short summary of the issue
- The impact you observed
- The version or commit you tested
- Reproduction steps, if safe to share privately

## High-risk areas

Treat these as sensitive:

- `MCP_TOKEN`
- workspace path handling
- `bash` execution
- `apply_patch`
- tunnel startup and URL discovery
- dashboard mutating actions
