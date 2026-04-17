# T487 Wave 1 Worker B — Commander-Shim Removal

**Date**: 2026-04-16
**Task**: T487 Wave 1 Sub-tier B
**Session**: ses_20260416230443_5f23a3
**Status**: complete

---

## Summary

Migrated 14 CLI command files from commander-shim to native citty `defineCommand` pattern.
Updated `packages/cleo/src/cli/index.ts` to wire all migrated commands as native subCommands.
Fixed pre-existing broken imports for Worker A/C commands (add-batch, complete, delete, find, list, reparent).
Updated `checkpoint.test.ts` to use new `checkpointCommand` native export.

---

## Files Migrated (Worker B — 14 commands)

| File | Export | Dispatch |
|------|--------|----------|
| `blockers.ts` | `blockersCommand` | `query tasks.blockers` |
| `cancel.ts` | `cancelCommand` | `mutate tasks.cancel` |
| `checkpoint.ts` | `checkpointCommand` | CLI-only (git ops) |
| `exists.ts` | `existsCommand` | Core direct call (dispatch bypass) |
| `generate-changelog.ts` | `generateChangelogCommand` | CLI-only (file generation) |
| `grade.ts` | `gradeCommand` | `query check.grade` / `check.grade.list` |
| `map.ts` | `mapCommand` | `query`/`mutate admin.map` |
| `next.ts` | `nextCommand` | `query tasks.next` |
| `ops.ts` | `opsCommand` | `query admin.help` |
| `promote.ts` | `promoteCommand` | `mutate tasks.reparent` |
| `roadmap.ts` | `roadmapCommand` | `query admin.roadmap` |
| `show.ts` | `showCommand` | `query tasks.show` |
| `start.ts` | `startCommand` | `mutate tasks.start` |
| `validate.ts` | `validateCommand` | `query check.schema` (deprecated) |

---

## index.ts Changes

- Updated 14 imports from `register*Command` to native exports
- Removed 13 `register*Command(rootShim)` calls (validate was already removed)
- Added 14 `subCommands['name'] = command` entries in native wiring block
- Also fixed 6 pre-existing broken Worker A/C imports (add-batch, complete, delete, find, list, reparent)
- Added Worker A/C native subCommands wiring (complete with `done` alias, delete with `rm` alias, list with `ls` alias)

---

## Test Fix

`packages/cleo/src/cli/__tests__/checkpoint.test.ts` — updated from `registerCheckpointCommand` to `checkpointCommand` native citty export. Tests validate `checkpointCommand.meta.name` and `checkpointCommand.args` shape.

---

## Quality Gates

```
pnpm biome check --write [14 files]: Fixed 13 files (import sorting), no errors
pnpm biome ci .: 1434 files checked, 0 errors, 1 warning (pre-existing symlink)
pnpm --filter @cleocode/cleo run build: Success (0 errors)
pnpm --filter @cleocode/cleo run test: 83 test files passed, 1430 tests, 0 failures
smoke test (cleo show T487 --json): {"success":true,...} ✓
smoke test (cleo blockers --json): {"success":true,...} ✓
smoke test (cleo next --json): {"success":true,...} ✓
```

---

## Key Decisions

1. **grade.ts**: `sessionId` is `required: false` (optional positional) matching `[sessionId]` in shim — when absent or `--list` flag given, routes to `grade.list`
2. **map.ts**: `gateway` derived from `args.store` boolean at runtime (query vs mutate)
3. **generate-changelog.ts**: `--limit` arg kept as `string` type with default `'15'` — converted to `Number()` in `run()` to match shim behavior
4. **show.ts**: `--ivtr-history` arg name (kebab-case in citty) maps to `ivtrHistory` in dispatch payload
5. **checkpoint.ts**: `'dry-run'` arg name (kebab-case) accessed via `args['dry-run']`
6. **exists.ts**: `'task-id'` positional (kebab-case matching shim `<task-id>`) accessed via `args['task-id']`
7. **validate.ts**: Re-enabled as native citty command (was DEPRECATED/removed comment in index.ts) — command still outputs deprecation warning but is functional
8. **Worker A/C fixes**: Fixed pre-existing build breakage from add-batch, complete, delete, find, list, reparent already being migrated to native citty but index.ts still importing old register* names
