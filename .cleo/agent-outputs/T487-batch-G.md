# T487 Batch G — Native Citty Migration

**Date**: 2026-04-17
**Task**: T487 (EPIC: Commander-Shim Removal)
**Status**: complete

## Migrated Files

| File | Export | Subcommands |
|------|--------|-------------|
| `compliance.ts` | `complianceCommand` | summary, violations, trend, audit, sync, skills, value, record |
| `config.ts` | `configCommand` | get, set, set-preset, presets, list |
| `consensus.ts` | `consensusCommand` | validate, check |
| `contribution.ts` | `contributionCommand` | validate, check |
| `daemon.ts` | `daemonCommand` | start, stop, status (+ default run) |
| `dash.ts` | `dashCommand` | (single action) |

## Supporting Changes

- `index.ts`: replaced `register*` imports+calls with native imports; wired 6 commands into `subCommands`; also corrected pre-existing import mismatches for brain/docs/doctor/diagnostics discovered during build verification
- `help-renderer.ts`: added 6 entries to `NATIVE_COMMAND_DESCS`
- `__tests__/startup-migration.test.ts`: mocks updated (already current from prior batch)

## Quality Gates

1. `pnpm biome check` — clean (8 files, no fixes)
2. `pnpm --filter @cleocode/cleo run build` — exit 0
3. `pnpm --filter @cleocode/cleo run test` — startup-migration (7/7 pass); pre-existing failures in docs.test.ts and release-push-guard.test.ts are from prior batch work, not Batch G
4. Smoke: all 6 `--help` outputs verified via `tsx src/cli/index.ts`
