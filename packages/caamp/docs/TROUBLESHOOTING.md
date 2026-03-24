# Troubleshooting

## `No target providers found`

- Run `caamp providers detect --project`.
- Use explicit targeting: `--agent <name>` or `--all`.

## Marketplace lookups fail

- Confirm outbound network access.
- Retry command; marketplace requests now fail with explicit network errors.
- Use `--verbose` for additional diagnostic context.

## Skill install succeeds but links are missing

- Run `caamp doctor` to check symlink health.
- Verify provider skill directories exist and are writable.

## MCP install failed for some providers

- Check provider transport support using `caamp providers show <id>`.
- Re-run with compatible transport (`--transport http|sse`) for remote endpoints.

## Lock file appears stale

- Inspect the lock file at `getLockFilePath()` (default `~/.agents/.caamp-lock.json`; override via `AGENTS_HOME`).
- Re-run install/remove command to reconcile state.

## CI coverage fails

- Run `npm run test:coverage` locally.
- Check uncovered modules in the report.
- Add tests for command paths and core modules with low line coverage.

## Where to get more detail

- API: `docs/API-REFERENCE.md`
- Advanced workflows: `docs/ADVANCED-CLI.md`, `docs/ADVANCED-RECIPES.md`
