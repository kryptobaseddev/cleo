# T837 Wave 1 Cleanup — Results

**Date**: 2026-04-17
**Task**: T837 (parent: T487)
**Worker**: Wave 1 Cleanup Worker

## Summary

All four Wave 1 cleanup items completed successfully. All quality gates passed.

## Files Modified

1. `packages/cleo/src/cli/commands/detect-drift.ts`
   - Removed: `import type { ShimCommand as Command } from '../commander-shim.js'`
   - Added: `import { defineCommand } from 'citty'`
   - Changed: `export function registerDetectDriftCommand(program: Command): void` → `export const detectDriftCommand = defineCommand({...})`
   - Pattern: Standard Pattern A (single action, no subcommands, no args)
   - TSDoc added on exported constant

2. `packages/cleo/src/cli/index.ts`
   - Added import: `import { conduitCommand } from './commands/conduit.js'`
   - Changed import: `registerDetectDriftCommand` → `detectDriftCommand` from `detect-drift.js`
   - Removed: `registerDetectDriftCommand(rootShim)` registration call
   - Added: `subCommands['detect-drift'] = detectDriftCommand`
   - Added: `subCommands['conduit'] = conduitCommand`

3. `packages/cleo/src/cli/help-renderer.ts`
   - Added 21 entries to `NATIVE_COMMAND_DESCS`: current, detect, plan, refresh-memory, stop, analyze, blockers, cancel, checkpoint, exists, generate-changelog, grade, map, next, ops, promote, roadmap, show, start, validate, detect-drift
   - All descriptions sourced from each command's `meta.description` field

4. `packages/cleo/src/cli/__tests__/startup-migration.test.ts`
   - Line 165: changed `{ registerDetectDriftCommand: vi.fn() }` → `{ detectDriftCommand: {} }`

## Quality Gate Results

### Gate 1: Biome check --write
```
Checked 4 files in 24ms. Fixed 3 files.
```
PASS (biome reformatted indentation in detect-drift.ts run body, import ordering in index.ts, and long line wraps in help-renderer.ts)

### Gate 2: Biome CI
```
Checked 293 files in 231ms. No fixes applied.
Found 16 errors.
```
PASS — at baseline (16 errors, unchanged from prior Wave 1)

### Gate 3: Build
```
> @cleocode/cleo@2026.4.76 build /mnt/projects/cleocode/packages/cleo
> tsc
[exit 0]
```
PASS

### Gate 4: Tests
```
Test Files  83 passed (83)
      Tests  1430 passed | 2 skipped (1432)
```
PASS — zero new failures

### Gate 5: Smoke Tests
- `cleo detect-drift --help`: PASS — renders "Detect documentation drift against TypeScript source of truth"
- `cleo conduit --help`: PASS — renders full subcommand listing (status/peek/start/stop/send)
- `cleo --help | grep -E "detect-drift|conduit"`: PASS — both appear in root help with correct descriptions

### Gate 6: ShimCommand Count
- Before: 84 files
- After: 83 files
- Delta: -1 (detect-drift.ts migrated)

## NATIVE_COMMAND_DESCS Before/After

- Before: 12 entries (version, code, conduit, complete, done, delete, rm, find, list, ls, reparent, add-batch)
- After: 33 entries (added all 21 Wave 1 migrated commands + detect-drift)

## Notes

- `conduit.ts` was already exported as native citty but was missing from `index.ts` subCommands registry — now wired
- `detect-drift.ts` had no CLI args/options (Pattern A pure action) — straightforward migration
- All existing shim commands continue working via shimToCitty() bridge
