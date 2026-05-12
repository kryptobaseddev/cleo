# T9017 — B2: claude-code + claude-sdk + cursor adapters to caamp.ensureProviderInstructionFile

**Status**: complete  
**Parent**: T1919 (B2 split — claude family + cursor)  
**Epic**: T1910  
**Commit**: 88f70d73c524c4f25f87ea1c3745ec7f478a3166 on task/T9017

## Summary

Refactored 3 of 9 adapters (claude-code, claude-sdk, cursor) to consume the canonical CAAMP API for instruction file management.

## Changes

### claude-code/install.ts
- Removed `INSTRUCTION_REFERENCES` const
- Removed private `updateInstructionFile()` method
- `install()` now awaits `ensureProviderInstructionFile('claude-code', projectDir, {})` — instructFile (`CLAUDE.md`) and references sourced from CAAMP registry (T9013/T9014)
- `ensureInstructionReferences()` delegates to same CAAMP call

### claude-sdk/install.ts
- Already a no-op (SDK-only, not in registry per T9013 decision)
- No changes required; acceptance criteria already met (no INSTRUCTION_REFERENCES, no writeFileSync for instruction files)

### cursor/install.ts
- Removed `INSTRUCTION_REFERENCES` const
- `install()` now calls `ensureProviderInstructionFile('cursor', projectDir, {})` for the registry instructFile (`AGENTS.md`)
- cursor-specific MDC (`.cursor/rules/cleo.mdc`) and legacy `.cursorrules` formats remain for cursor IDE compatibility; references now computed via `getCleoTemplatesTildePath()` (OS-aware path) rather than a removed local const
- `isInstalled()` updated to use `getCleoTemplatesTildePath()` instead of removed const

### Test changes
- `claude-code/__tests__/adapter.test.ts`: added `@cleocode/caamp` mock + `node:fs/promises` mkdir/readFile mocks
- `cursor/__tests__/adapter.test.ts`: same CAAMP mock + `node:fs/promises` mocks
- `adapters/vitest.config.ts`: added source aliases for `@cleocode/caamp` and `@cleocode/paths`
- `src/__tests__/claude-code-adapter.test.ts`: integration test updated — "dedup" test becomes idempotency test (CAAMP manages block-level dedup, not plain-text dedup)
- `src/__tests__/cursor-adapter.test.ts`: integration test "does not duplicate references" updated to idempotency check

## Prerequisites Merged
- Merged `task/T9014` (which includes T9013 + T9014): instructionReferences field in registry.json + optional references in ensureProviderInstructionFile

## Verification
- 301 adapter tests pass (14 test files)
- biome CI clean on changed files
- tsc build passes for @cleocode/adapters
- `implemented` gate: commit 88f70d73c on task/T9017 branch (not yet merged to main — orchestrator merges after complete)
