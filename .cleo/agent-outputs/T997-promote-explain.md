# T997: cleo memory promote-explain CLI command

**Status**: complete
**Date**: 2026-04-20
**Session**: ses_20260419003330_22e46b
**Epic**: T991 (BRAIN Integrity Write-Path Guardrails)

## Summary

Implemented `memory.promote-explain` as a read-only query operation that surfaces
STDP weights, retrieval log hit count, citation_count, quality_score, and
prune_candidate flag for any brain entry, and returns a tier decision
(promoted / rejected / pending) with a human-readable explanation.

## Files Changed

- `packages/cleo/src/dispatch/domains/memory.ts` — `promote-explain` query case + `getSupportedOperations()`
- `packages/contracts/src/operations/memory.ts` — `MemoryPromoteExplainParams`, `MemoryPromoteExplainResult`, `MemoryStdpWeight`, `MemoryPromoteScoreBreakdown`, `MemoryPromotionTier`
- `packages/cleo/src/dispatch/domains/__tests__/memory-promote-explain.test.ts` — 9 unit tests
- `packages/cleo/src/dispatch/registry.ts` — registered `promote-explain`, `bridge`, `precompact-flush`
- `packages/cleo/src/dispatch/__tests__/parity.test.ts` — updated operation counts (165 query, 116 mutate, 281 total)
- `vitest.config.ts` — added `@cleocode/core/memory/precompact-flush.js` alias
- `packages/cleo/vitest.config.ts` — same alias

## Commits

- `71c2f2ff1` — feat(cleo/T997): cleo memory promote-explain
- `0c417d0ce` — fix(cleo/T997): registry entries + parity counts

## Gates Verified

- implemented: commit:71c2f2ff1 + files
- testsPassed: test-run (9/9 pass)
- qaPassed: tool:biome + tool:tsc

## Key Finding

The `@cleocode/core/memory/precompact-flush.js` subpath export had no vitest alias,
causing all memory dispatch domain tests to fail. Added alias to both root and
package-level vitest configs as a prerequisite fix. This unblocked memory-verify-pending,
memory-llm-status, memory-brain, and memory-legacy-rejection test files in addition
to the new promote-explain suite.
