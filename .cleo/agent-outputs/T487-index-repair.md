# T487 index.ts Repair Report

**Date**: 2026-04-16
**Scope**: Repair Wave 2 mid-migration crash — wire native citty commands into index.ts

---

## Summary

21 command files were fully migrated to native citty `defineCommand` exports but
`index.ts` still imported their old `register*Command` names, breaking the build.
All 21 are now wired correctly.

---

## Per-File Verified Export Names

### Originally Scoped (11 files)

| File | Verified Export | Status |
|------|----------------|--------|
| `export.ts` | `exportCommand` | Migrated |
| `export-tasks.ts` | `exportTasksCommand` | Migrated |
| `gc.ts` | `gcCommand` | Migrated |
| `history.ts` | `historyCommand` | Migrated |
| `import.ts` | `importCommand` | Migrated |
| `import-tasks.ts` | `importTasksCommand` | Migrated |
| `init.ts` | `initCommand` | Migrated |
| `inject.ts` | `injectCommand` | Migrated |
| `intelligence.ts` | `intelligenceCommand` | Migrated |
| `issue.ts` | `issueCommand` | Migrated |
| `implementation.ts` | N/A — already deprecated/removed (no import in index.ts) | Skipped |

### Additional Wave 2 Crashes Discovered (11 more files)

These were NOT in the original scope but were also migrated to native citty, causing
TS2305 errors on build. Fixed as part of this repair pass.

| File | Verified Export(s) | Status |
|------|-------------------|--------|
| `adapter.ts` | `adapterCommand` | Migrated |
| `add.ts` | `addCommand` | Migrated |
| `adr.ts` | `adrCommand` | Migrated |
| `archive.ts` | `archiveCommand` | Migrated |
| `archive-stats.ts` | `archiveStatsCommand` | Migrated |
| `backfill.ts` | `backfillCommand` | Migrated |
| `briefing.ts` | `briefingCommand` | Migrated |
| `bug.ts` | `bugCommand` | Migrated |
| `chain.ts` | `chainCommand` | Migrated |
| `labels.ts` | `labelsCommand`, `tagsCommand` | Migrated |
| `log.ts` | `logCommand` | Migrated |

---

## Changes Made

### `packages/cleo/src/cli/index.ts`

- Replaced 21 `registerXxxCommand` imports with native export names
- Replaced 21 `registerXxxCommand(rootShim)` calls with comments
- Added 23 `subCommands['key'] = nativeCommand as CommandDef` assignments in the
  native commands section (adapter, add, adr, archive, archive-stats, backfill,
  briefing, bug, chain, export, export-tasks, gc, history, import, import-tasks,
  init, inject, intelligence, issue, labels, tags, log)
- Cast each as `CommandDef` to resolve TypeScript variance mismatch between
  `CommandDef<SpecificArgsDef>` and `Record<string, CommandDef>` — this is a
  widening cast (not `as unknown as X`) consistent with how citty handles typed args

### `packages/cleo/src/cli/help-renderer.ts`

- Added 23 entries to `NATIVE_COMMAND_DESCS` (all 21 commands + tags alias)
- Descriptions sourced directly from each file's `meta.description` field

### `packages/cleo/src/cli/__tests__/startup-migration.test.ts`

- Updated 13 stale `vi.mock` entries to use native export shapes (`{ xyzCommand: {} }`)
- Added 2 previously missing mocks (`adapter.js`, `chain.js`)
- Updated `labels.js` mock to export both `labelsCommand` and `tagsCommand`

### `packages/cleo/src/cli/__tests__/export-tasks.test.ts`

- Fully rewritten: old test asserted `registerExportTasksCommand` shim pattern
  which no longer exists. New test asserts native citty command structure
  (meta name/description, args presence, positional type).

### `packages/cleo/src/cli/__tests__/import-tasks.test.ts`

- Fully rewritten: old test asserted `registerImportTasksCommand` shim pattern
  which no longer exists. New test asserts native citty command structure
  (meta name/description, file positional required, all option args present,
  default values for on-conflict and on-missing-dep).

---

## Files NOT Actually Migrated (flagged)

None. All files in scope had genuine native `defineCommand` exports with no
`register*` shim remaining. `implementation.ts` was already fully deprecated
with no import in `index.ts` — no action needed.

---

## Build/Test Gate Results

```
Gate 1: pnpm biome check --write (index.ts, help-renderer.ts, test files)
  Result: Checked files — No fixes applied. PASS

Gate 2: pnpm --filter @cleocode/cleo run build
  Result: tsc completed with exit 0. PASS

Gate 3: pnpm --filter @cleocode/cleo run test
  Result: 83 passed (83) | 1430 passed | 2 skipped (1432) | ZERO new failures. PASS
```

Pre-repair baseline: build was broken (TS2305 on 11 files from scope + 11 additional
files discovered during repair). Post-repair: clean build + all tests green.
