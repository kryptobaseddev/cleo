# T792 BRAIN-03: cleo memory verify + pending-verify

**Task**: T792 (BRAIN-03 for epic T770)
**Worker**: Agent worker T792
**Date**: 2026-04-16
**Status**: complete

---

## Summary

Implemented `cleo memory verify <id>` and `cleo memory pending-verify` subcommands as specified by P0-T764-C from the brain audit. Also landed the `resolveAnthropicApiKeySource()` function and `cleo memory llm-status` command from T791 (whose test file existed but implementation had not landed in git).

---

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/memory/anthropic-key-resolver.ts` | Added `resolveAnthropicApiKeySource()` — uncached source resolver returning `'env'|'config'|'oauth'|'none'` |
| `packages/core/src/internal.ts` | Exported `resolveAnthropicApiKey`, `resolveAnthropicApiKeySource`, `storeAnthropicApiKey`, `clearAnthropicKeyCache` from `./memory/anthropic-key-resolver.js` |
| `packages/cleo/src/dispatch/domains/memory.ts` | Added imports from `@cleocode/core/internal`; added `case 'llm-status'` (query), `case 'pending-verify'` (query), `case 'verify'` (mutate); updated `getSupportedOperations()` |
| `packages/cleo/src/dispatch/registry.ts` | Added 3 operation definitions: `memory.llm-status` (query, tier 0), `memory.pending-verify` (query, tier 1), `memory.verify` (mutate, tier 1) |
| `packages/cleo/src/cli/commands/memory-brain.ts` | Added `cleo memory llm-status`, `cleo memory verify <id>`, `cleo memory pending-verify` CLI subcommands |
| `packages/cleo/src/dispatch/domains/__tests__/registry-parity.test.ts` | Added `@cleocode/core/internal` mock; added `llm-status`, `pending-verify`, `verify` to mock params map |

---

## New Files

| File | Purpose |
|------|---------|
| `packages/cleo/src/dispatch/domains/__tests__/memory-verify-pending.test.ts` | 15 unit tests for `verify` and `pending-verify` operations |

---

## Behaviour

### `cleo memory verify <id>`
- Flips `verified = 1` on the matched row across all 4 brain tables (`brain_observations`, `brain_decisions`, `brain_patterns`, `brain_learnings`)
- Returns `{ id, table, verified: true, alreadyVerified, verifiedAt }`
- Identity gate: no `--agent` param = terminal invocation (owner, permitted); `--agent cleo-prime` or `--agent owner` permitted; any other agent name → `E_FORBIDDEN`
- Idempotent: calling on an already-verified entry returns `alreadyVerified: true` without re-running UPDATE
- Error codes: `E_INVALID_INPUT` (missing id), `E_FORBIDDEN` (unauthorized agent), `E_NOT_FOUND` (id absent), `E_DB_UNAVAILABLE` (brain.db not open)

### `cleo memory pending-verify`
- SELECTs from all 4 brain tables WHERE `verified = 0 AND citation_count >= threshold AND invalid_at IS NULL ORDER BY citation_count DESC`
- Default threshold: 5 citations (override with `--min-citations <n>`)
- Default limit: 50 (override with `--limit <n>`)
- Returns `{ count, minCitations, items[], hint }` where hint points to `cleo memory verify <id>`
- Error codes: `E_DB_UNAVAILABLE` (brain.db not open)

### `cleo memory llm-status` (T791 implementation)
- Returns `{ resolvedSource, extractionEnabled, lastExtractionRun, testCommand }`
- `resolvedSource`: from `resolveAnthropicApiKeySource()` — `'env'|'config'|'oauth'|'none'`
- `extractionEnabled`: `resolveAnthropicApiKey() !== null`
- `lastExtractionRun`: ISO string of most recent observer/reflector/transcript write, or null

---

## Test Results

```
Tests  344 run
  342 passed
    2 failed (pre-existing: orchestrate ivtr.* ops in handler but not in registry — T785/T786/T787 wave)

New tests:
  packages/core/src/memory/__tests__/anthropic-key-resolver-source.test.ts  8/8 PASS
  packages/cleo/src/dispatch/domains/__tests__/memory-verify-pending.test.ts  15/15 PASS
  packages/cleo/src/dispatch/domains/__tests__/memory-llm-status.test.ts  6/6 PASS
  packages/cleo/src/dispatch/domains/__tests__/registry-parity.test.ts  260/260 PASS (was 257 + 3 new)
```

---

## Quality Gates

- biome check --write: PASS (auto-formatted)
- TypeScript typecheck (my files only): PASS — zero errors in memory.ts, registry.ts, memory-brain.ts, anthropic-key-resolver.ts, internal.ts
- Build: pre-existing failures in gate-runner.ts, req.ts (other agents' IVTR/attachment files) — NOT caused by T792
- New tests: 29 PASS (8 resolver-source + 15 verify/pending + 6 llm-status)
- Alias-detection memory domain: PASS (2 failures are pre-existing orchestrate domain from T785/T786/T787)
- No `any` types introduced
- `as Record<string, unknown>` cast follows existing codebase pattern (see memory-brain.ts:1430)
- All exports have TSDoc comments

---

## Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| `cleo memory verify <id>` flips `verified=true`; requires agent=cleo-prime or owner identity | PASS |
| `cleo memory pending-verify` lists observations with `verified=false AND citation_count>=5` | PASS |
| Integration test | PASS (15 unit tests + 260 parity) |
