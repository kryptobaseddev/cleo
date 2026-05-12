# CLEO DB Recovery Handoff — 2026-05-04

## Executive Summary

**What's safe**: All code work shipped to `main`. Task data preserved across multiple snapshots.
**What's broken**: `cleo` CLI from project root throws `E_NOT_INITIALIZED` on every invocation. Cause is **not** the data — it's an init/validation check in cleo that I cannot identify without source-level debugging. My repair attempts (deleting duplicate __drizzle_migrations rows, removing orphan migrations) did not fix it and may have nudged the validation into a worse state.

## Code Preserved (main branch — `1d8f...` ish)

Merged this session (12 substantive commits):
- T1851 — BoundaryContract + validateAbsolutePath + 12 regression tests
- T1841 — 4-language regression infra + bench:nexus
- T1833 — wiki community query 5-line fix
- T1853 — brain_decisions schema +7 ADR-governance columns
- T1852 — git-shim consumes T1851 contract
- T1854 — memory CLI exposes decision flags
- T1860 — ensureColumns band-aid for T1826 multi-statement migration
- T1839 — FTS5 virtual table for nexus search
- T1856 — critical-priority --depends guardrail
- T1814 — SDK Tools audit report

Worker branches NOT yet merged:
- `task/T1836` — DEFINES edges (conflicts with T1841 base)
- `task/T1837` — ACCESSES extractor (conflicts with T1841 base)
- `task/T1865` — combined T1836+T1837 rebase (DEFINES test still fails — T1866 hotfix needed)

## DB Snapshots (best to worst)

```
/mnt/projects/cleocode/.cleo/tasks.db.PRE-DUP-FIX-191036          1879 tasks  (BEST — pre-my-edits)
/mnt/projects/cleocode/.cleo/tasks.db.SECOND-BROKEN-191345         1879 tasks  (post-my-drizzle-edits)
/mnt/projects/cleocode/.cleo/backups/sqlite/tasks-20260504-190405.db  1878 tasks
/mnt/projects/cleocode/.cleo/backups/sqlite/tasks-20260504-185405.db  1878 tasks
... (12 more in /mnt/projects/cleocode/.cleo/backups/sqlite/)
/mnt/projects/cleocode/.cleo/tasks.db.CORRUPTED-2026-05-04-185000  1876 tasks  (pre-restore)
```

Currently `.cleo/tasks.db` is restored to **PRE-DUP-FIX state (1879 tasks)**.

`brain.db` likewise restored from `brain.db.PRE-DUP-FIX-191315` (2806 observations / 51 decisions).

## Root Cause Investigation — What I Found

### The Architectural Bug (filed as **T1864**)

The user's diagnosis was correct: **workers write to dead-end per-worktree `.cleo/tasks.db`**.

```
$ ls /home/keatonhoskins/.local/share/cleo/worktrees/<hash>/T####/.cleo/tasks.db
# Each worktree has its own tasks.db with 0 tasks
```

When workers run `cleo manifest append`, `cleo verify`, etc. from inside their worktree:
1. cleo CLI walks up from cwd looking for `.cleo/`
2. The worktree path `/home/keatonhoskins/.local/share/cleo/worktrees/<hash>/T####/` is NOT under any project root
3. cleo's resolver doesn't follow git worktree linkage (`.git` is a gitdir pointer to `/mnt/projects/cleocode/.git/worktrees/T####`)
4. cleo falls back to creating a fresh `.cleo/` in the worktree
5. Worker's writes go to the new local DB
6. The actual project DB `/mnt/projects/cleocode/.cleo/tasks.db` never receives the worker's gates/manifest entries

This was DEAD-END writes. Worker code commits were preserved (git tracks them) but their gate state and manifest entries are stranded in 6 isolated 0-task DBs.

### The Migration Failure (cause of initial DB lockup)

Earlier in the session, cleo CLI began throwing:
```
"Failed to run the query 'INSERT INTO __new_tasks ... FROM tasks: FOREIGN KEY constraint failed'"
```

This is the t1408 archive-reason-enum migration's COPY step. It runs as a table-rebuild for adding a CHECK constraint. The migration begins with `PRAGMA foreign_keys = OFF;` so FK violations during copy *should* be impossible — but the runner triggered the FK check somewhere.

In `__drizzle_migrations`, t1408's hash `ee2753f101c5cc55...` was present TWICE (IDs #15 and #18). Likely from a corrupted prior run that double-applied the entry.

I attempted to clean up by:
1. `DELETE FROM __drizzle_migrations WHERE id = 18` (dup removal)
2. `DELETE FROM __drizzle_migrations WHERE id = 20` (orphan t1718 not in published cleo)
3. `UPDATE __drizzle_migrations SET id = 18 WHERE id = 19` (renumber to fill gap)

After step 3, error mode shifted from migration-FK to plain `E_NOT_INITIALIZED`. Restoring the PRE-DUP-FIX-191036 snapshot did NOT recover. Either the cleo CLI is caching state somewhere (unlikely) OR my previous direct-SQL touched something I cannot see (possible — there may be additional internal indexes/triggers).

## Recommended Recovery Path

In **priority order** for next session:

### Path A — Rebuild local cleo from source (likely cleanest)
```bash
cd /mnt/projects/cleocode
pnpm install
pnpm run build
pnpm link --global    # or use ./packages/cleo/bin/cleo.js directly
```
This builds cleo with the LOCAL migration set (which includes the May-3 t1718 trigger fix and the T1826 brain decisions migration that the published v2026.5.20 doesn't have). Local-build cleo will recognize all migrations the project DB has applied.

### Path B — Reinstall a clean published version
```bash
npm install -g @cleocode/cleo@2026.5.20
```
But this is what's currently broken, so unlikely to help.

### Path C — drizzle-kit reset
```bash
pnpm --filter @cleocode/core exec drizzle-kit drop
# Then re-apply migrations from fresh
pnpm --filter @cleocode/core exec drizzle-kit migrate
```
Risk: drops user data. NOT recommended without backup verification first.

### Path D — Manual schema realignment (if A/B/C all fail)
Examine cleo's init code at `packages/core/src/store/db.ts` to find what triggers `E_NOT_INITIALIZED`. Grep returns:
```
packages/core/src/store/__tests__/database-topology-integration.test.ts
```
But the actual init code throwing it is in production paths I didn't trace.

## Permanent Fixes Filed

- **T1864** — P0: cleo project-root resolution must follow git worktree linkage (parent T1855 Guardrails, depends T1856)
- **T1865** — Rebase T1836+T1837 onto T1841 base (worker delivered, has DEFINES test failure)
- **T1866** — Hotfix DEFINES emission wire-up (filed, not dispatched)

## What I Did NOT Do (Per User's Rules)

- Did **not** push any tag (release pipeline not green)
- Did **not** modify code (orchestrator only)
- Did **not** delete any backups (kept all `tasks.db.*` safety copies)
- Did **not** force any worker through the broken DB

## What the User Should Verify

1. `git log --oneline main` shows the 12 commits from this session
2. `sqlite3 .cleo/tasks.db.PRE-DUP-FIX-191036 "SELECT COUNT(*) FROM tasks;"` returns `1879`
3. Worker branches `task/T1836`, `task/T1837`, `task/T1865` exist locally
4. `.cleo/backups/sqlite/` contains 14+ snapshots
5. Graphify research at `.cleo/agent-outputs/graphify-architecture-research.md`
6. SDK tools audit at `.cleo/rcasd/T1768/architecture/sdk-tools-audit.md`

## Lessons for Cleo Architecture (T1864 acceptance criteria)

1. cleo MUST use `git rev-parse --show-toplevel` to find project root when cwd is in a git worktree
2. cleo MUST refuse to auto-create `.cleo/` in worktree paths
3. cleo MUST detect duplicate `__drizzle_migrations` rows on startup and self-heal (or refuse with actionable error)
4. cleo MUST surface migration errors with the exact failing row's `parent_id` (the FK violator) for fast diagnosis
5. `cleo backup add` should run automatically before any migration attempt
6. Workers' spawn prompts MUST set `CLEO_PROJECT_ROOT` env var that cleo binary respects unconditionally
