# T1830 — decision_category Column: AGT-* Dispatch / Architectural Separation

## Summary

Added `decision_category` TEXT column (NOT NULL DEFAULT 'architectural') to
`brain_decisions` to separate AGT-* agent execution dispatch outcomes from
genuine architectural/technical decisions.

## Files Changed

| File | Change |
|------|--------|
| `packages/core/migrations/drizzle-brain/20260505000001_t1830-decision-category/migration.sql` | New migration: ALTER TABLE + CREATE INDEX + backfill AGT-* |
| `packages/core/src/store/memory-schema.ts` | BRAIN_DECISION_CATEGORIES const + decisionCategory column + index |
| `packages/core/src/store/memory-accessor.ts` | findDecisions gains includeAgentDispatch param |
| `packages/core/src/agents/execution-learning.ts` | recordAgentExecution passes decisionCategory:'agent_dispatch'; getAgentPerformanceHistory opts in |
| `packages/core/src/memory/engine-compat.ts` | memoryDecisionFind supports includeAgentDispatch with SQL category filter |
| `packages/cleo/src/cli/commands/memory.ts` | decisionFindCommand gains --include-agent-dispatch flag |
| `packages/cleo/src/dispatch/domains/memory.ts` | Passes includeAgentDispatch to engine |
| `packages/contracts/src/operations/memory.ts` | MemoryDecisionFindParams + MemoryDecisionEntry updated |
| `packages/core/src/store/__tests__/t1830-decision-category.test.ts` | 9 tests: schema, recordAgentExecution, filter, opt-in |

## Migration Strategy

- Option B (column-based separation) as specified
- NOT NULL DEFAULT 'architectural' — backward compatible
- Backfill UPDATE: all existing AGT-prefixed rows → 'agent_dispatch'
- `-->statement-breakpoint` markers between SQL statements (required by Drizzle session.run)
- Index: `idx_brain_decisions_decision_category` for query performance

## Behavior Change

- `cleo memory decision-find` now excludes `decision_category='agent_dispatch'` by default
- Pass `--include-agent-dispatch` to surface AGT-* execution history
- `recordAgentExecution()` explicitly tags new rows as `agent_dispatch`
- `getAgentPerformanceHistory()` opts-in via `includeAgentDispatch: true`

## Test Results

- 35 tests passed, 0 failed
- Covers: schema column presence, index existence, default value, recordAgentExecution tagging, default filter, opt-in filter
- Existing execution-learning.test.ts: 26 tests, all pass

## QA

- biome check: 0 errors (8 modified files)
- typecheck (tsc -b): exit 0
- lint: Checked 2127 files, 0 errors (6 pre-existing warnings unrelated to T1830)

## Commit

Branch: task/T1830
SHA: c9f4ac39dab448b333161619e8fa14bc5901b467

## Gate Status

- testsPassed: true (35/35)
- qaPassed: true (lint + typecheck exit 0)
- documented: true
- securityPassed: true (additive change, no network surface)
- cleanupDone: true
- implemented: BLOCKED — worktree commit not yet merged to HEAD; orchestrator must merge task/T1830 then re-run cleo complete
