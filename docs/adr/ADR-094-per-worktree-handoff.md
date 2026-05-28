# ADR-094: Per-Worktree Handoff Schema

**Status**: Proposed  
**Date**: 2026-05-12  
**Task**: T1902 (BBTT-W5-1)  
**Authors**: worker-c (BBTT Phase 3)

---

## Context

`cleo session end` writes a single global handoff record that the next orchestrator
session consumes via `cleo briefing`. In multi-worktree deployments (ADR-055, T1140)
multiple agents share a project root; their handoff entries collide — whichever
session ends last overwrites the others. This causes the "handoff-disappear" failure
mode identified in Council Contrarian Finding 2: an agent resumes and finds no
handoff even though a peer session ended minutes earlier.

The root cause: the `session_handoff_entries` table (and equivalent JSON store) has no
disambiguation key that binds a handoff to the actor and worktree that produced it.

---

## Decision

Add three new columns to `session_handoff_entries` (and the corresponding in-memory
representation):

| Column | Type | Description |
|--------|------|-------------|
| `actorId` | `TEXT NOT NULL DEFAULT 'global'` | Identifies the agent/worktree that wrote the handoff. For worktree-spawned sessions this equals the worktree branch (`task/<TID>`); for main-branch sessions it equals `'global'`. |
| `scope` | `TEXT NOT NULL DEFAULT 'global'` | Mirrors the session `scope` field (e.g. `'task:T1234'`, `'epic:T100'`, `'global'`). Enables consumers to filter handoffs relevant to the current scope. |
| `branch` | `TEXT` | Git branch at handoff write time (`git rev-parse --abbrev-ref HEAD`). Nullable; populated best-effort. |

`cleo briefing` selects the most-recent handoff whose `actorId` matches the calling
session's `actorId` (or `'global'` as fallback). This ensures worktree agents resume
their own handoff rather than a peer's.

---

## Migration Plan

### Forward migration

Add columns with safe defaults:

```sql
ALTER TABLE session_handoff_entries ADD COLUMN actorId TEXT NOT NULL DEFAULT 'global';
ALTER TABLE session_handoff_entries ADD COLUMN scope    TEXT NOT NULL DEFAULT 'global';
ALTER TABLE session_handoff_entries ADD COLUMN branch   TEXT;
```

### Backfill strategy

Legacy rows receive `actorId = 'global'` and `scope = 'global'` via the DEFAULT
clause — no explicit backfill query required. `branch` remains NULL for legacy rows,
which callers treat as "unknown".

### Rollback procedure

1. Stop all CLEO sessions.
2. Drop the three columns (SQLite: recreate table without them via `CREATE TABLE … AS SELECT …`).
3. Re-deploy prior package version.

No data loss — the new columns are additive; removing them discards actor/scope
metadata only, not handoff content.

---

## Test Plan

The "handoff-disappear" failure mode (Council Contrarian Finding 2) is addressed by:

1. **Unit test** — Two sessions write handoffs with distinct `actorId` values. Assert
   `getLastHandoff({ actorId: 'task/T1234' })` returns the correct entry and does not
   return the peer's entry.

2. **Integration test** — Simulate two parallel worktree sessions ending concurrently.
   Verify `cleo briefing` in each worktree surfaces its own handoff.

3. **Regression test** — Legacy rows (no `actorId`) are returned when no actor-specific
   handoff exists, preserving backward-compatible behavior.

---

## Implementation Follow-up

A separate implementation task MUST be filed once W1 + W2 + W3 (BBTT) have been
2 weeks stable in production. This ADR is design-only per T1902 scope.

Estimated implementation scope:
- `packages/core/src/sessions/handoff.ts` — write actorId/scope/branch on save
- `packages/core/src/sessions/briefing.ts` — filter on actorId at read time  
- Drizzle migration adding the three columns
- Unit + integration tests per test plan above

---

## Alternatives Considered

**A. Separate handoff table per worktree** — rejected: requires schema changes per
worktree and complicates tooling that scans the global table.

**B. Namespace handoff key in JSON filename** — rejected: CLEO moved to SQLite-backed
handoff; file-based disambiguation is a regression to the deprecated file-bridge model.

**C. Rely on session `id` for disambiguation** — rejected: session IDs are ephemeral;
a new session cannot know a peer's session ID without additional coordination.

---

## References

- ADR-055: Worktree-by-Default Spawn (T1140)
- ADR-062: Worktree merge via `git merge --no-ff`
- T1140: Worktree-by-default orchestration
- Council Contrarian Finding 2: handoff-disappear in multi-worktree deployments
- T1902: This task (design-only)
