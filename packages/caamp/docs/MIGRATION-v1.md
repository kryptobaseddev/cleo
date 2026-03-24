# Migration Guide to v1.0.0

This guide covers migration from pre-1.0 releases (including v0.3.x) to v1.0.0.

## What Changed

- Stronger error handling for CLI and network operations.
- Explicit network timeout behavior on remote fetch calls.
- Improved CI and security gates.
- Expanded test coverage and coverage reporting workflow.

## Upgrade Steps

1. Update package:

```bash
npm install -g @cleocode/caamp@latest
```

2. Verify installation:

```bash
caamp doctor --json
```

3. Re-run provider detection:

```bash
caamp providers detect --project
```

4. Validate MCP and skill state:

```bash
caamp mcp list
caamp skills list -g
```

## Behavior Notes

- Marketplace/network failures now produce explicit user-facing errors.
- CLI fatal errors are handled consistently with non-zero exit codes.
- Coverage gates are now wired in CI and may fail until target coverage is achieved.

## Troubleshooting

See `docs/TROUBLESHOOTING.md` for common migration issues.
