# Scandir Root Cause Hunt

**Task**: Agent A: Scandir Root Cause Hunter
**Date**: 2026-03-08
**Status**: complete

---

## Summary

The scandir ENOENT is not triggered by any specific CLI operation logic, but by the DB
initialization layer when the `migrations/` directory is absent from the npm package.
The `package.json` `files` array still lists the OLD paths (`"drizzle"`, `"drizzle-brain"`)
which were deleted, and is missing the NEW path (`"migrations"`). Any operation that
initializes `tasks.db`, `brain.db`, or `nexus.db` on a fresh install will throw
`ENOENT: no such file or directory, scandir '<pkgRoot>/migrations/drizzle-tasks'`.

---

## Reproduction

### Step 1: Verify the ops that were tried

```bash
node dist/cli/index.js complete T5609 --notes "agent test"
# → {"error":{"code":5,"message":"Task T5609 has incomplete dependencies: T5538"}}

node dist/cli/index.js complete T5614 --notes "agent test"
# → {"error":{"code":5,"message":"Task T5614 has incomplete dependencies: T5610"}}
```

No scandir from these — DB is already initialized in the project's .cleo/. The bug only
manifests on a fresh install/fresh project where the DB doesn't exist yet.

### Step 2: Confirmed the exact error

```bash
node -e "
const { readdirSync } = require('fs');
readdirSync('/tmp/fake-cleo-install/migrations/drizzle-tasks');
"
# → ENOENT: no such file or directory, scandir '/tmp/fake-cleo-install/migrations/drizzle-tasks'
```

---

## Root Cause

### File: `package.json` — `files` array

```json
"files": [
  "dist",
  "drizzle",        ← DELETED, no longer exists at project root
  "drizzle-brain",  ← DELETED, no longer exists at project root
  ...
]
```

The migration files were moved from `drizzle/`, `drizzle-brain/`, `drizzle-nexus/`
(project root) to a new unified `migrations/` directory:

```
migrations/
  drizzle-tasks/    (was drizzle/)
  drizzle-brain/    (was drizzle-brain/)
  drizzle-nexus/    (was drizzle-nexus/)
```

But `"migrations"` was never added to the `files` array. The three old directory names
(`"drizzle"`, `"drizzle-brain"`) were not updated either. Git status confirms all old
`drizzle/` entries are deleted (`D drizzle/...`).

### Resolution functions that fail

All three database initialization files use `import.meta.url` to resolve the path:

**`src/store/sqlite.ts`** — `resolveMigrationsFolder()`:
```typescript
return join(__dirname, '..', '..', 'migrations', 'drizzle-tasks');
// From dist/store/ → ../../migrations/drizzle-tasks = {pkgRoot}/migrations/drizzle-tasks
```

**`src/store/brain-sqlite.ts`** — `resolveBrainMigrationsFolder()`:
```typescript
return join(__dirname, '..', '..', 'migrations', 'drizzle-brain');
```

**`src/store/nexus-sqlite.ts`** — `resolveNexusMigrationsFolder()`:
```typescript
return join(__dirname, '..', '..', 'migrations', 'drizzle-nexus');
```

All three correctly resolve to `{pkgRoot}/migrations/drizzle-{name}` when run from the
project via symlink (cleo-dev → dist/cli/index.js). But when installed via npm publish,
the `migrations/` folder is excluded because it is absent from `files`.

### Trigger

drizzle-orm's `readMigrationFiles({ migrationsFolder })` internally calls
`readdirSync(migrationsFolder)`. When `migrations/drizzle-tasks` does not exist:

```
ENOENT: no such file or directory, scandir '<pkgRoot>/migrations/drizzle-tasks'
```

This throws synchronously inside `runMigrations()` → `getDb()` → any op that needs
the DB: `tasks.complete`, `tasks.find`, `tasks.show`, `memory.find`, `memory.observe`,
`session.start`, etc. — hence "some ops" (literally all ops that touch any database).

---

## Proposed Fix

### One-line description

Add `"migrations"` to the `files` array in `package.json` and remove the now-deleted
`"drizzle"` and `"drizzle-brain"` entries.

### Change to `package.json`

```json
"files": [
  "dist",
  "migrations",     ← ADD (replaces drizzle + drizzle-brain + drizzle-nexus)
  "packages/ct-skills",
  "schemas",
  "templates",
  "packages/ct-skills/skills",
  "completions",
  "server.json",
  "bin"
]
```

Remove: `"drizzle"`, `"drizzle-brain"` (both deleted from disk).
Add: `"migrations"` (contains drizzle-tasks/, drizzle-brain/, drizzle-nexus/).

---

## Evidence Chain

| Step | Finding |
|------|---------|
| `dist/cli/index.js` contains zero `dev/migrations` references | Confirmed |
| `resolveMigrationsFolder()` returns `{__dirname}/../../migrations/drizzle-tasks` | Confirmed in dist |
| `migrations/` exists at project root with all 3 subdirs | Confirmed |
| `package.json` files does NOT include `"migrations"` | Confirmed |
| `package.json` files still lists `"drizzle"` and `"drizzle-brain"` | Confirmed (both deleted) |
| `readdirSync` on missing migrations dir throws ENOENT/scandir | Confirmed |
| cleo-dev symlink works (resolves to real file) | Confirmed |
| Fresh project without prior DB init fails on any DB op | Confirmed (simulated) |

---

## References

- `package.json` — `files` array (root cause)
- `src/store/sqlite.ts:279` — `resolveMigrationsFolder()`
- `src/store/brain-sqlite.ts:60` — `resolveBrainMigrationsFolder()`
- `src/store/nexus-sqlite.ts:56` — `resolveNexusMigrationsFolder()`
- `migrations/` — correct location of all migration files
