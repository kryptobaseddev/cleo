# T791 BRAIN-02: Resolver Coverage Audit + cleo memory llm-status

**Task**: T791 (BRAIN-02 for epic T770)
**Worker**: Agent worker T791
**Date**: 2026-04-16

---

## Part 1: Resolver Coverage Audit

### Findings

All 5 memory code paths audited. **Zero raw `process.env.ANTHROPIC_API_KEY` access in production code paths.** All code correctly uses `resolveAnthropicApiKey()`.

| File | Status | Notes |
|------|--------|-------|
| `observer-reflector.ts` | CLEAN | Uses `resolveAnthropicApiKey()` at lines 241, 575, 709 |
| `llm-extraction.ts` | CLEAN | Imports and uses `resolveAnthropicApiKey()` at module level |
| `llm-backend-resolver.ts` | CLEAN | Uses `resolveAnthropicApiKey()` in `tryAnthropic()` |
| `auto-extract.ts` | CLEAN | Delegates to `llm-extraction.ts` |
| `sleep-consolidation.ts` | CLEAN | Imports `resolveAnthropicApiKey()` at module level |
| `transcript-extractor.ts` | CLEAN | Uses `resolveLlmBackend()` which internally calls resolver |

### Fixes Applied

**JSDoc corrections only** — 7 JSDoc comments across 4 files were corrected to replace
misleading references to raw `ANTHROPIC_API_KEY` with accurate descriptions of the
3-source resolver chain. No behavioral changes:

- `observer-reflector.ts`: 4 JSDoc blocks corrected (module-level, `callAnthropicLlm`, `runObserver`, `runReflector`)
- `llm-backend-resolver.ts`: 2 JSDoc blocks corrected (module header, `tryAnthropic`)
- `auto-extract.ts`: 1 JSDoc block corrected (behavior description)
- `transcript-extractor.ts`: 1 type comment corrected

---

## Part 2: cleo memory llm-status Command

### New Function: `resolveAnthropicApiKeySource()`

Added to `packages/core/src/memory/anthropic-key-resolver.ts`:
- Returns `'env' | 'config' | 'oauth' | 'none'` indicating which source resolved the key
- Does NOT cache (unlike `resolveAnthropicApiKey()`) so status checks are always fresh
- Mirrors the exact priority order of the main resolver

Exported from `packages/core/src/internal.ts` alongside the existing resolver exports.

### New Operation: `memory.llm-status`

**Dispatch handler**: `packages/cleo/src/dispatch/domains/memory.ts` — `case 'llm-status'`
- Calls `resolveAnthropicApiKeySource()` for resolved-source
- Calls `resolveAnthropicApiKey() !== null` for extraction-enabled boolean
- Queries `brain_observations` for most recent extraction event (tombstone/observer/reflector)
- Returns LAFS envelope: `{ success, data: { resolvedSource, extractionEnabled, lastExtractionRun, testCommand }, meta }`

**Registry entry**: `packages/cleo/src/dispatch/registry.ts` — tier 0, query, idempotent

**CLI command**: `packages/cleo/src/cli/commands/memory-brain.ts` — `cleo memory llm-status`
- Plain description: "Report LLM backend resolution status and extraction readiness."

---

## Tests

### New test files

1. `packages/core/src/memory/__tests__/anthropic-key-resolver-source.test.ts`
   - 8 tests covering env, config-file, priority ordering, cache coherence, and safety

2. `packages/cleo/src/dispatch/domains/__tests__/memory-llm-status.test.ts`
   - 6 integration tests: envelope shape, extractionEnabled true/false, lastExtractionRun
     ISO normalization, getSupportedOperations() parity, no-params call

### Test results

All 14 new tests: PASS
Existing tests: no regressions (registry-parity 258 pass, memory-brain 35 pass)

---

## Quality Gates

- biome check --write: PASS (4 files auto-fixed for formatting)
- Core build: pre-existing failure in `tasks/add.ts` (AcceptanceItem type mismatch) — unrelated to this task
- New tests: 14 PASS, 0 FAIL
- No `any`/`unknown` types introduced
- All exports TSDoc'd
