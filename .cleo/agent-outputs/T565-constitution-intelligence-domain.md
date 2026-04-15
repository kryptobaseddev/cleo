# T565 — Constitution Reconciliation: Intelligence Domain

**Task**: T565  
**Date**: 2026-04-14  
**Status**: complete

## Summary

Reconciled `docs/specs/CLEO-OPERATION-CONSTITUTION.md` with the actual codebase. The `intelligence` domain was fully implemented in the registry and handler but entirely absent from the constitution.

## Changes Made

### 1. `docs/specs/CLEO-OPERATION-CONSTITUTION.md`

- **Version**: bumped from `2026.4.24` to `2026.4.42`
- **Date**: updated to `2026-04-14`
- **Task**: added T565 to task reference chain
- **§4 Canonical Domains**: updated "10 canonical domains" to "11 canonical domains"; added `intelligence` row to the domain table; updated the `CANONICAL_DOMAINS` code block to include `'intelligence'`
- **§6 Operation Model**: updated `// One of 10 canonical domains` to 11
- **§6.11 intelligence** (new section): documented all 5 operations with gateway, tier, required params, idempotent flag; documented query-only gateway split rationale; added escalation path note
- **§7 Summary Counts**: added `intelligence | 5 | 0 | 5` row; updated totals from `129/95/224` to `134/95/229`; added T565 update note with registry total 248 and canonical total 229; preserved prior ADR-042 note

### 2. `packages/cleo/src/dispatch/types.ts`

- Updated JSDoc comment `The 10 canonical domain names` to `The 11 canonical domain names`
- Updated `DomainHandler` JSDoc from "9 target domains" to "11 target domains" with full domain list

## Final Counts

| Metric | Value |
|--------|-------|
| Canonical domains | 11 |
| Registry total (all ops) | 248 |
| Experimental (excluded) | 7 (orchestrate.conduit.* x5 + admin.map x2) |
| Constitutional canonical total | 229 |

## Intelligence Domain Details

All 5 operations are query-only, tier 1, read from brain.db + tasks.db.

| Operation | Required Params | Description |
|-----------|-----------------|-------------|
| `predict` | `taskId` | Risk score or stage validation outcome prediction |
| `suggest` | `taskId` | Gate focus recommendation based on failure history |
| `learn-errors` | -- | Extract recurring failure patterns from history |
| `confidence` | `taskId` | Score verification confidence from gate state |
| `match` | `taskId` | Match brain patterns against a task |

Handler: `packages/cleo/src/dispatch/domains/intelligence.ts`  
Registry entries: lines 3394-3482 of `packages/cleo/src/dispatch/registry.ts`

## Quality Gates

- biome check: clean (no fixes applied)
- No code changes — documentation only
