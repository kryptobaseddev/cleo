# T9013: B1-data — CAAMP registry instructionReferences

## Summary

Added `instructionReferences` field to the CAAMP provider registry schema and populated it for all 7 registry providers that manage instruction files.

## Changes

### packages/caamp/src/core/registry/types.ts
- Added `instructionReferences?: string[]` to `RegistryProvider` interface (optional for backwards compat)

### packages/caamp/src/types.ts
- Added `instructionReferences: string[]` to resolved `Provider` interface (always populated, defaults to `[]`)

### packages/caamp/src/core/registry/providers.ts
- `resolveProvider()` now copies `instructionReferences` from raw registry entry (copy semantics, empty-array default when absent)

### packages/caamp/providers/registry.json
- Added `instructionReferences` array to 7 active providers:
  - `claude-code`: `["@~/.cleo/templates/CLEO-INJECTION.md", "@.cleo/memory-bridge.md"]`
  - `cursor`: `["@~/.cleo/templates/CLEO-INJECTION.md", "@.cleo/memory-bridge.md"]`
  - `codex`: `["@~/.cleo/templates/CLEO-INJECTION.md", "@.cleo/memory-bridge.md"]`
  - `gemini-cli`: `["@~/.cleo/templates/CLEO-INJECTION.md", "@.cleo/memory-bridge.md"]`
  - `kimi`: `["@~/.cleo/templates/CLEO-INJECTION.md", "@.cleo/memory-bridge.md"]`
  - `opencode`: `["@~/.cleo/templates/CLEO-INJECTION.md", "@.cleo/memory-bridge.md"]`
  - `pi`: `["@~/.cleo/templates/CLEO-INJECTION.md", "@.cleo/memory-bridge.md"]`

## Notes

- `openai-sdk` and `claude-sdk` are SDK-only adapters with no entries in registry.json; `claude-sdk` has a no-op installer without INSTRUCTION_REFERENCES
- Values sourced directly from each adapter's `INSTRUCTION_REFERENCES` constant — all use the same two paths (T911 tilde path resolution: `@~/.cleo/templates/CLEO-INJECTION.md`)
- 1334 caamp tests pass; biome CI clean; tsup build green

## Commit

`adb43535918e0c9e04f9b42463f7f79460307940` on branch `task/T9013`

## Unblocks

- T9014 (B1-api): expose `instructionReferences` via CAAMP public API
- T1919: remove per-adapter `INSTRUCTION_REFERENCES` const duplicates (9 adapters)
