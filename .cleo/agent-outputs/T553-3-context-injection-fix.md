# T553-3: Context Pull + Nexus-Bridge Injection Fix

**Date**: 2026-04-13
**Status**: complete
**Task**: T553 (JIT Agent Integration)
**Subagent attempt**: 3

## Summary

Fixed two bugs from T553 acceptance criteria:

1. `cleo context pull <id>` returning empty `relevantMemory`
2. `nexus-bridge.md` presence in AGENTS.md

## Bug 1: Empty relevantMemory

### Root Cause

`escapeFts5Query()` in `packages/core/src/memory/brain-search.ts` was joining all tokens with
implicit spaces (AND semantics in FTS5). Task titles like `"EPIC: T553 JIT Agent Integration — Make
Agents Just Know"` contain non-word tokens such as em dashes (`—`) and punctuation-tailed tokens
(`EPIC:`). FTS5's default unicode61 tokenizer cannot index these as word tokens, so the AND query
required all tokens to match — guaranteeing zero results whenever any non-word token was present.

The FTS5 query did not throw an error, so the LIKE fallback was never triggered.
Result: `retrieveWithBudget()` returned an empty candidate map and `relevantMemory: []`.

### Fix

**File**: `packages/core/src/memory/brain-search.ts`
**Function**: `escapeFts5Query`

Changed the escaping strategy:
- Strip leading/trailing non-word punctuation from each token (`"EPIC:" → "EPIC"`, `"—" → ""`).
- Discard tokens shorter than 2 chars or with no word characters.
- Deduplicate case-insensitively.
- Join surviving tokens with `OR` instead of implicit AND.

OR semantics ensure that partial matches still return ranked results (BM25 orders by relevance),
while dropping non-word tokens prevents the "all-or-nothing" failure mode.

**Verification** (before/after on brain.db):

| Query | Before | After |
|-------|--------|-------|
| `cleo context pull T234` | `relevantMemory: []` | 5 entries returned |
| `cleo context pull T553` | `relevantMemory: []` | 5 entries returned |

## Bug 2: nexus-bridge.md in AGENTS.md

**Status**: Already resolved prior to this session.

- `.cleo/nexus-bridge.md` exists (1525 bytes, Apr 13)
- `AGENTS.md` already contained `@.cleo/nexus-bridge.md` inside the CAAMP block
- `cleo upgrade` confirmed injection is current: `injection_refresh: applied (AGENTS.md updated)`

No code change required for this bug.

## Quality Gates

All gates passed:

```
pnpm biome check --write  → Checked 1 file. No fixes applied.
pnpm run build            → Build complete (all packages)
pnpm run test             → 396 passed, 7130 tests, 0 new failures
cleo upgrade              → injection_refresh: applied, memory_bridge: applied
```

## File Changed

- `packages/core/src/memory/brain-search.ts` — `escapeFts5Query` rewrite
