# T5716 Cleo Facade Implementation

**Task**: T5716
**Epic**: T5701
**Date**: 2026-03-17
**Status**: complete

---

## Summary

Implemented the full `Cleo` facade class in `packages/core/src/cleo.ts` covering all 7 exposed
domains (tasks, sessions, memory, orchestration, lifecycle, release, admin), with static imports
throughout for esbuild compatibility. All 10 smoke tests pass with zero TypeScript errors.

## Content

### Files Modified

- `/mnt/projects/claude-todo/packages/core/src/cleo.ts` — complete rewrite (558 lines)
- `/mnt/projects/claude-todo/packages/core/src/index.ts` — updated with tree-shakeable exports

### Key Decisions

**Static imports only**: All imports use static `import` statements — no dynamic `import()` calls.
esbuild can trace all dependencies at bundle time.

**Dual construction patterns**:
- `Cleo.forProject(root)` — synchronous, `DataAccessor` created lazily per operation
- `Cleo.init(root, opts)` — async, pre-creates `DataAccessor` for efficient multi-operation use

**`projectRoot` is public**: The test at `tests/e2e/core-package-smoke.test.ts:72` accesses
`cleo.projectRoot` — kept as `readonly projectRoot: string`.

**Nullable `_store`**: `forProject()` can't be async (test doesn't await it), so `_store` is
`DataAccessor | null`. Getters pass `store ?? undefined` which means core functions fall back to
creating their own accessor from `cwd`.

### Domains Implemented

| Domain | Methods |
|--------|---------|
| tasks | add, find, show, list, update, complete, delete, archive |
| sessions | start, end, status, resume, list, find, show, suspend, briefing, handoff, gc, recordDecision, recordAssumption, contextDrift, decisionLog, lastHandoff |
| memory | observe, find, fetch, timeline, search, hybridSearch |
| orchestration | start, analyze, readyTasks, nextTask, context, dependencyGraph, epicStatus, progress |
| lifecycle | status, startStage, completeStage, skipStage, checkGate, history, resetStage, passGate, failGate, stages |
| release | prepare, commit, tag, push, rollback, calculateVersion, bumpVersion |
| admin | export, import |

### Index Updates

`packages/core/src/index.ts` now exports:
- All domain API interfaces from `cleo.ts`
- Individual tree-shakeable functions for Pattern 2
- `DataAccessor` type + factory functions for Pattern 3

## References

- Related tasks: T5701, T5713
- Smoke test: `tests/e2e/core-package-smoke.test.ts`
- Domain map: `.cleo/agent-outputs/T5716-domain-map.md`
