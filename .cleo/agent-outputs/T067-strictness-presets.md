# T067: Project-Level Strictness Presets

**Status**: complete
**Date**: 2026-03-21
**Epic**: T056 (Task System Hardening)

## Summary

Implemented three strictness preset profiles (`strict`, `standard`, `minimal`) with full
CLI support for applying them via `cleo config set-preset <preset>`.

## What Was Built

### 1. Preset Definitions (`packages/core/src/config.ts`)

Three presets defined as `STRICTNESS_PRESETS` constant:

| Preset | session.requireNotes | hierarchy.requireAcceptanceCriteria | lifecycle.mode | session.multiSession |
|--------|---------------------|--------------------------------------|----------------|----------------------|
| strict | true | true | strict | false |
| standard | false | false | advisory | true |
| minimal | false | false | off | true |

All presets set `session.autoStart: false`.

### 2. Core Functions

- `applyStrictnessPreset(preset, cwd?, opts?)` — merges preset over existing config, preserves non-preset keys, idempotent
- `listStrictnessPresets()` — returns all presets with names, descriptions, and values
- `STRICTNESS_PRESETS` constant — exported for direct inspection
- Types: `StrictnessPreset`, `PresetDefinition`, `ApplyPresetResult`

All exported from `@cleocode/core` public barrel.

### 3. Engine Layer (`packages/cleo/src/dispatch/engines/config-engine.ts`)

- `configSetPreset(projectRoot, preset)` — validates preset name, delegates to core
- `configListPresets()` — returns all preset metadata

### 4. Dispatch Layer (`packages/cleo/src/dispatch/domains/admin.ts`)

- Query: `config.presets` — lists all available presets
- Mutate: `config.set-preset` — applies a named preset

Both operations registered in `getSupportedOperations()`.

### 5. Registry (`packages/cleo/src/dispatch/registry.ts`)

- Added `admin.config.presets` (query, tier 1, idempotent)
- Added `admin.config.set-preset` (mutate, tier 1, idempotent, requiredParams: ['preset'])

### 6. CLI (`packages/cleo/src/cli/commands/config.ts`)

- `cleo config set-preset <preset>` — applies a preset with inline help text
- `cleo config presets` — lists all presets

### 7. Tests Updated

Count assertions updated in:
- `packages/cleo/src/dispatch/__tests__/parity.test.ts`: query 120→121, mutate 91→92, total 211→213
- `packages/cleo/src/mcp/gateways/__tests__/query.test.ts`: admin 16→17
- `packages/cleo/src/mcp/gateways/__tests__/mutate.test.ts`: admin 16→17 (both count checks)
- `packages/cleo/src/dispatch/domains/__tests__/admin.test.ts`: updated getSupportedOperations() lists

## Acceptance Criteria Verification

- [x] 3 preset profiles defined (strict, standard, minimal)
- [x] CLI command `cleo config set-preset <preset>` works
- [x] Preset application is idempotent (applying twice yields same result)
- [x] Non-preset config keys (e.g. `output.*`, `backup.*`) are preserved
- [x] Invalid preset name returns error with valid options listed

## Files Modified

- `packages/core/src/config.ts` — preset definitions and core functions
- `packages/core/src/index.ts` — export new symbols
- `packages/cleo/src/dispatch/engines/config-engine.ts` — engine functions
- `packages/cleo/src/dispatch/lib/engine.ts` — barrel re-exports
- `packages/cleo/src/dispatch/domains/admin.ts` — domain handler wiring
- `packages/cleo/src/dispatch/registry.ts` — operation registry entries
- `packages/cleo/src/cli/commands/config.ts` — CLI subcommands
- `packages/cleo/src/dispatch/__tests__/parity.test.ts` — count update
- `packages/cleo/src/mcp/gateways/__tests__/query.test.ts` — count update
- `packages/cleo/src/mcp/gateways/__tests__/mutate.test.ts` — count update
- `packages/cleo/src/dispatch/domains/__tests__/admin.test.ts` — supported ops list update
