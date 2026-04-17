# T487 Batch C — map, next, ops, plan, refresh-memory

**Status**: complete  
**Date**: 2026-04-17

## Files Changed

### Migrated (ShimCommand → defineCommand)
- `packages/cleo/src/cli/commands/map.ts` — `mapCommand`
- `packages/cleo/src/cli/commands/next.ts` — `nextCommand`
- `packages/cleo/src/cli/commands/ops.ts` — `opsCommand`
- `packages/cleo/src/cli/commands/plan.ts` — `planCommand`
- `packages/cleo/src/cli/commands/refresh-memory.ts` — `refreshMemoryCommand`

### Updated
- `packages/cleo/src/cli/index.ts` — 5 imports + registration comments + subCommands wiring. Also fixed pre-existing Batch B stale register calls for analyze, blockers, cancel, checkpoint, current, docs, doctor, plan, refresh-memory.
- `packages/cleo/src/cli/help-renderer.ts` — Added 5 descriptions to NATIVE_COMMAND_DESCS
- `packages/cleo/src/cli/__tests__/startup-migration.test.ts` — Updated 5 vi.mock entries to native exports

## Quality Gates
- biome CI: clean
- build: exit 0
- startup-migration.test.ts: 7/7 pass
- Smoke `--help`: all 5 commands render correctly
