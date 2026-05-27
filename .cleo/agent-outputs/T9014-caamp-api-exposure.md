# T9014 — B1-api: CAAMP getProviderInstructionReferences API Exposure

**Status**: complete  
**Parent**: T1916 (B1 split — API side)  
**Commit**: 75c72eaf22b60ebf83388948491f491c99f2a04a (task/T9014 worktree)

## What Was Done

### New API: `getProviderInstructionReferences(idOrAlias: string): string[]`

Added to `packages/caamp/src/core/registry/providers.ts`. Returns the `instructionReferences` array from the provider registry (populated by T9013) for any provider ID or alias. Returns `[]` for unknown providers. Returns a fresh copy — mutation-safe.

### `ensureProviderInstructionFile` — registry default fallback

Changed `EnsureProviderInstructionFileOptions.references` from required `string[]` to optional `string[]?`. When the caller omits `references` (or passes `undefined`), the function falls back to `getProviderInstructionReferences(providerId)`. Existing callers with explicit `references` are unchanged.

Same fallback applied to `ensureAllProviderInstructionFiles` on a per-provider basis.

### Barrel export

`packages/caamp/src/index.ts` now exports `getProviderInstructionReferences`.

## Tests

10 new unit tests in `packages/caamp/tests/unit/registry-instruction-references.test.ts`:

- `getProviderInstructionReferences()`: 5 cases (known provider, alias resolution, unknown ID, mutation safety, all 7 T9013 providers)
- `ensureProviderInstructionFile()` registry default: 5 cases (omitted refs, explicit override, explicit `undefined`, throws for unknown provider, correct file path)

All 10 pass. 44/44 existing `registry.test.ts` tests continue to pass.

## Key Files

- `packages/caamp/src/core/registry/providers.ts` — new function
- `packages/caamp/src/core/instructions/injector.ts` — optional references + registry fallback
- `packages/caamp/src/index.ts` — re-export
- `packages/caamp/tests/unit/registry-instruction-references.test.ts` — new tests

## Unblocks

T1919 (B2) — adapter consolidation. Adapters can drop their hardcoded `INSTRUCTION_REFERENCES` const and call `ensureProviderInstructionFile(providerId, dir, {})` to get the registry-default references automatically.
