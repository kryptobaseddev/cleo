# T487 Batch E — Migration Report

## Status: complete

## Files Migrated

| File | From | To |
|------|------|----|
| `commands/add-batch.ts` | `registerAddBatchCommand(program)` shim | `addBatchCommand` native citty |
| `commands/brain.ts` | `registerBrainCommand(program)` shim (6 sub-commands) | `brainCommand` native citty with `subCommands` |

## Already Native (no changes needed)
- `commands/add.ts` — `addCommand` (prior batch)
- `commands/adr.ts` — `adrCommand` (prior batch)
- `commands/archive.ts` — `archiveCommand` (prior batch)
- `commands/archive-stats.ts` — `archiveStatsCommand` (prior batch)

## Supporting Changes

**`cli/index.ts`**
- Replaced `registerAddBatchCommand` import with `addBatchCommand`
- Replaced `registerBrainCommand` import with `brainCommand`
- Added `subCommands['add-batch'] = addBatchCommand` and `subCommands['brain'] = brainCommand`
- Fixed stale shim calls left by previous batches (doctor, deps/tree, claim/unclaim, complexity, cant, compliance, config, dash, reparent, roadmap, detect, detect-drift, daemon)
- Fixed missing native imports for commands migrated in previous batches

**`cli/__tests__/startup-migration.test.ts`**
- Updated `brain.js` mock from `registerBrainCommand: vi.fn()` to `brainCommand: {}`
- Added `add-batch.js` mock: `addBatchCommand: {}`
- Fixed stale `doctor.js` mock from `registerDoctorCommand` to `doctorCommand`
- Fixed `deps.js` mock to include `treeCommand`
- Fixed `claim.js` mock to include `unclaimCommand`

## Quality Gates
- biome check --write: clean
- pnpm --filter @cleocode/cleo run build: exit 0
- pnpm --filter @cleocode/cleo run test: 83 files passed, 1427 tests passed (0 new failures)
- cleo add-batch --help: renders correctly
- cleo brain --help: renders 6 subcommands
