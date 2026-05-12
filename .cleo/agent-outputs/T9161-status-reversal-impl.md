# T9161 — Status Reversal Lifecycle Invariants

**Status**: complete
**Task**: T9161 (P2 Worker: Epic status reversal leaves stale completedAt)
**Branch**: task/T9161
**Commit**: 06fd95250da38427b4335e2070424cd7e0d095fd

## Summary

Fixed two lifecycle metadata invariants in the task management system:

1. Terminal-status reversal now clears `completedAt`, `cancelledAt`, and resets
   `verification.passed`/`gates`/`evidence` when a task transitions from a terminal
   status (done, cancelled, archived) back to a non-terminal status (pending, active, blocked).

2. The `E_EPIC_HAS_PENDING_CHILDREN` premature-close guard now correctly treats `archived`
   as a terminal status in addition to `done` and `cancelled`. Previously, archived children
   were false-positive blockers preventing parent completion.

## Files Changed

- `packages/core/src/tasks/update.ts` — Added reversal logic that clears lifecycle metadata
  when `TERMINAL_TASK_STATUSES.has(oldStatus) && !TERMINAL_TASK_STATUSES.has(newStatus)`.
  Preserves `round` and `failureLog` for audit history; only clears pass/gate state.

- `packages/core/src/tasks/complete.ts` — Updated `pendingChildren` filter to also exclude
  `archived` status: `c.status !== 'done' && c.status !== 'cancelled' && c.status !== 'archived'`.

- `packages/core/src/tasks/__tests__/t9161-status-reversal.test.ts` — 15 integration tests
  covering all 4 acceptance criteria scenarios.

## Test Results

- 884 tests passed across 307 test files (0 failures)
- 15 new T9161-specific tests all pass
- Biome CI clean on all 3 changed files

## Key Decisions

- Preserved `round` and `failureLog` on verification reset (audit history)
- Used `TERMINAL_TASK_STATUSES` from `@cleocode/contracts` (single source of truth)
- `archived` status is not in `validateStatusTransition` map, so archived tasks cannot be
  directly reverted via `updateTask` (they require the explicit restore/unarchive flow)
