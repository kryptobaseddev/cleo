# Hotfix: Migration Paths Consolidated to dev/migrations/

**Commit**: 78bf8c7d
**Date**: 2026-03-07
**Status**: complete

---

## Summary

CI was failing on all 3 platforms because `drizzle-brain/` migrations were
untracked (the root `drizzle-brain` was a symlink to `dev/migrations/drizzle-brain/`
which was never committed). This commit consolidates all migration directories
under `dev/migrations/`, removes root-level symlinks, renames `drizzle/` to
`drizzle-tasks/` for clarity, and updates all runtime path references.

## Files Changed

### Migration directories (renames + new tracking)
- `drizzle/` (23 migrations) → `dev/migrations/drizzle-tasks/` (rename, R100)
- `drizzle-nexus/` (1 migration) → `dev/migrations/drizzle-nexus/` (rename, R100)
- `dev/migrations/drizzle-brain/` (5 migrations) — newly tracked (was untracked, root was a dangling symlink)
- `drizzle-brain` symlink at root — deleted from git index

### drizzle-kit config files updated (out paths)
- `/mnt/projects/claude-todo/drizzle.config.ts`: `out: './drizzle'` → `out: './dev/migrations/drizzle-tasks'`
- `/mnt/projects/claude-todo/drizzle-brain.config.ts`: `out: './drizzle-brain'` → `out: './dev/migrations/drizzle-brain'`
- `/mnt/projects/claude-todo/drizzle-nexus.config.ts`: `out: './drizzle-nexus'` → `out: './dev/migrations/drizzle-nexus'`
- `/mnt/projects/claude-todo/dev/migrations/drizzle.config.ts`: `out: './drizzle'` → `out: './drizzle-tasks'`

### Runtime migration path resolution updated
- `/mnt/projects/claude-todo/src/store/sqlite.ts` line 279: `join(__dirname, '..', '..', 'drizzle')` → `join(__dirname, '..', '..', 'dev', 'migrations', 'drizzle-tasks')`
- `/mnt/projects/claude-todo/src/store/brain-sqlite.ts` line 60: `join(__dirname, '..', '..', 'drizzle-brain')` → `join(__dirname, '..', '..', 'dev', 'migrations', 'drizzle-brain')`
- `/mnt/projects/claude-todo/src/store/nexus-sqlite.ts` line 56: `join(__dirname, '..', '..', 'drizzle-nexus')` → `join(__dirname, '..', '..', 'dev', 'migrations', 'drizzle-nexus')`

### Test hardcoded path fixed
- `/mnt/projects/claude-todo/src/store/__tests__/lifecycle-schema-parity.test.ts`: `join(projectRoot, 'drizzle')` → `join(projectRoot, 'dev', 'migrations', 'drizzle-tasks')`

## Results

| Check | Result |
|-------|--------|
| Build (`npm run build`) | PASS |
| TypeScript (`npx tsc --noEmit`) | Pre-existing errors only (adrs/list.ts), not introduced here |
| Store tests (`npx vitest run src/store/__tests__/`) | PASS — 446/446 |
| CLI smoke test (`dist/cli/index.js list`) | PASS — tasks.db initialized and returned data |
| Commit | `78bf8c7d` |
| Push to main | PASS |

## Root Cause

T5650 created `dev/migrations/drizzle-brain/` as the canonical location but
replaced the root `drizzle-brain` with a symlink pointing there. The
`dev/migrations/` directory itself was never committed to git (`??` in status).
On a clean CI checkout, the symlink target did not exist, causing ENOENT on
database initialization.

The same approach (root symlink + untracked target) was not applied to
`drizzle/` and `drizzle-nexus/` — those remained as real directories at root.
This commit resolves the inconsistency by moving everything to `dev/migrations/`
and using direct paths.
