# T481 — nexus domain audit

**Date**: 2026-04-10
**Agent**: Domain Lead / nexus
**Status**: complete

## Summary

All 22 nexus operations verified. 7 issues found and resolved (1 bug fix + 6 missing CLI handlers added).

## Operation Matrix

| Op | Gateway | CLI command | Params match | Status |
|----|---------|-------------|--------------|--------|
| status | query | `nexus status` | OK | PASS |
| list | query | `nexus list` | OK | PASS |
| show | query | `nexus show <name>` | `name` | FIXED (was dispatching to `resolve`) |
| resolve | query | `nexus resolve <taskRef>` | `query` | ADDED (split from broken `show`) |
| deps | query | `nexus deps <taskQuery>` | `query`, `direction` | PASS |
| graph | query | `nexus graph` | — | ADDED |
| path.show | query | `nexus critical-path` | — | PASS |
| blockers.show | query | `nexus blocking <taskQuery>` | `query` | PASS |
| orphans.list | query | `nexus orphans` | — | PASS |
| discover | query | `nexus discover <taskQuery>` | `query`, `method`, `limit` | PASS |
| search | query | `nexus search <pattern>` | `pattern`, `project`, `limit` | PASS |
| transfer.preview | query | `nexus transfer-preview <taskIds...>` | `taskIds`, `sourceProject`, `targetProject`, `mode`, `scope` | ADDED |
| share.status | query | `nexus share-status` | — | ADDED |
| init | mutate | `nexus init` | — | PASS |
| register | mutate | `nexus register <path>` | `path`, `name`, `permission` | PASS |
| unregister | mutate | `nexus unregister <nameOrHash>` | `name` | PASS |
| sync | mutate | `nexus sync [project]` | `name?` | PASS |
| permission.set | mutate | `nexus permission set <name> <level>` | `name`, `level` | ADDED |
| reconcile | mutate | `nexus reconcile` | `projectRoot?` | PASS |
| share.snapshot.export | mutate | `nexus share export` | `outputPath?` | ADDED |
| share.snapshot.import | mutate | `nexus share import <file>` | `inputPath` | ADDED |
| transfer | mutate | `nexus transfer <taskIds...>` | `taskIds`, `sourceProject`, `targetProject`, `mode`, `scope`, `onConflict`, `transferBrain` | ADDED |

**Total: 22/22 ops covered. 13 query + 9 mutate.**

## Issues Fixed

### Bug: `nexus show` dispatched to wrong op

The original `nexus show <taskId>` command dispatched to `query nexus resolve` with param `query`. The dispatch domain has two distinct ops:
- `show`: expects `name` param, returns a single registered project's details via `nexusShowProject(name)`
- `resolve`: expects `query` param, resolves a cross-project task reference via `nexusResolve(query, currentProject?)`

Fix: split into two CLI handlers — `nexus show <name>` (dispatches to `show`) and `nexus resolve <taskRef>` (dispatches to `resolve`). The `query` alias preserved on `resolve` for backward compatibility.

### Added CLI handlers (6 ops previously missing)

| Op | CLI | Notes |
|----|-----|-------|
| `query nexus graph` | `nexus graph` | No params |
| `query nexus share.status` | `nexus share-status` | No params, kebab-case to avoid dot conflict |
| `query nexus transfer.preview` | `nexus transfer-preview <taskIds...>` | `--from` / `--to` required options |
| `mutate nexus transfer` | `nexus transfer <taskIds...>` | `--from` / `--to` required; `--mode`, `--scope`, `--on-conflict`, `--transfer-brain` optional |
| `mutate nexus permission.set` | `nexus permission set <name> <level>` | Nested subcommand under `nexus permission` group |
| `mutate nexus share.snapshot.export` | `nexus share export` | Nested under `nexus share` group; `--output` optional |
| `mutate nexus share.snapshot.import` | `nexus share import <file>` | Nested under `nexus share` group |

Note: `share.snapshot.export` and `share.snapshot.import` are grouped under `nexus share` subcommand alongside `nexus share-status` (flat) to match the naming pattern.

## Classification: agent-only ops

None. All 22 ops are appropriate for CLI exposure.

## Quality Gates

- `pnpm biome check --write packages/cleo/src/cli/commands/nexus.ts`: PASS (no fixes applied)
- `pnpm --filter @cleocode/cleo exec tsc --noEmit --skipLibCheck` (nexus.ts): no errors
- Pre-existing build failures in `@cleocode/cant` (missing `@types/node`) and `@cleocode/cleo` (`@cleocode/caamp` missing declarations) are unrelated to nexus changes and present on the unmodified main branch.

## File Modified

`packages/cleo/src/cli/commands/nexus.ts`
