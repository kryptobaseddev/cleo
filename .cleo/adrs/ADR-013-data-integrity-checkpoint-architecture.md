# ADR-013: Data Integrity & Checkpoint Architecture

**Date**: 2026-02-25
**Status**: proposed
**Gate**: HITL
**Gate Status**: pending
**Related Tasks**: T4867, T4868, T4869
**Related ADRs**: ADR-006, ADR-010
**Summary**: Addresses two critical bugs in git-checkpoint.ts that pollute the project git history. Proposes isolating .cleo/ checkpoint commits to a dedicated git worktree or orphan branch to prevent history contamination.
**Keywords**: git, checkpoint, data-integrity, atomic, backup, isolation, git-history
**Topics**: storage, security, admin

---

## 1. Context

Two critical bugs exist in `src/store/git-checkpoint.ts` that compromise data integrity and pollute the project's git history. Both stem from the checkpoint system using the project's `.git` repo for `.cleo/` state file commits without adequate isolation.

### Bug 1: Staging Scope -- git commit without path restriction

The `gitCheckpoint()` function at `src/store/git-checkpoint.ts:256-312` builds the commit command at lines 294-297:

```typescript
const commitArgs = ['commit', '-m', commitMsg];
if (config.noVerify) {
  commitArgs.push('--no-verify');
}
```

This issues a bare `git commit` with no `-- <paths>` restriction. While lines 280-283 stage only the changed state files via `git add <file.path>`, any files that were **already staged** by the user or by other processes are swept into the checkpoint commit. The commit captures everything in the index, not just `.cleo/` files.

**Evidence**: Commit `56713c1b` -- a `chore(cleo): auto checkpoint` commit included unrelated files from `packages/` and `protocols/` directories that had been pre-staged by other operations.

### Bug 2: SQLite binary in STATE_FILES

The `STATE_FILES` array at `src/store/git-checkpoint.ts:28-40` includes `tasks.db` (line 30). This is a SQLite binary file:

- Git cannot diff it meaningfully
- WAL/SHM sidecar files (`tasks.db-wal`, `tasks.db-shm`) are not listed in `STATE_FILES`
- Committing `tasks.db` without first running `PRAGMA wal_checkpoint(TRUNCATE)` captures a potentially inconsistent snapshot
- Binary blobs inflate `.git/objects` over time with no diffing benefit and no point-in-time recovery value for LLM-agent workloads

---

## 2. Options Considered

### Option A: Isolated `.cleo/.git` Repo -- SELECTED

Use `GIT_DIR` / `GIT_WORK_TREE` environment variables to create a separate git repo inside `.cleo/`. All checkpoint commits go to this isolated repo, never touching the project's `.git` index.

**Pros**:
- Eliminates the staging scope bug class entirely (structural isolation, not just path restriction)
- Project git log stays clean forever
- State files tracked relative to `cleoDir` (no path confusion)
- Works with existing `execFileAsync`/`gitCommand` pattern
- `.cleo/.gitignore` already exists and can be reused for the isolated repo

**Cons**:
- Two git repos on disk (`.git` for project, `.cleo/.git` for checkpoint state)
- Existing installations need `cleo init` to create the isolated repo

### Option B: Path Restriction Only (`-- <paths>` fix) -- Partial Relief

Keep using the project's `.git` but add `-- <paths>` to the commit command at line 294.

**Pros**: Minimal change, low risk, immediate relief

**Cons**:
- Does NOT fix the root cause (project git still used for `.cleo/` checkpoints)
- Pre-staged project files could still be captured if paths overlap
- `tasks.db` WAL consistency and binary blob issues remain

**Verdict**: Necessary as immediate hotfix (T4871) but insufficient as final solution.

### Option C: Remove Git Checkpointing Entirely -- REJECTED

Rely solely on SQLite VACUUM INTO and JSON atomic writes for data safety.

**Pros**: Simplest, no git dependency for `.cleo/` at all

**Cons**:
- Loses historical point-in-time text file recovery
- `config.json`, `sessions.json` changes become unrecoverable
- Worse than current state for JSON state files

**Verdict**: REJECTED -- text file history has real value.

---

## 3. Decision

Adopt Option A (isolated `.cleo/.git`) with VACUUM INTO rotation for SQLite.

1. `.cleo/.git` initialized by `cleo init` via `initCleoGitRepo()` (idempotent -- `existsSync` guard on `.cleo/.git/HEAD`)
2. All git subprocess calls in `src/store/git-checkpoint.ts` use `{ GIT_DIR: join(cleoDir, '.git'), GIT_WORK_TREE: cleoDir }` env (via new `makeCleoGitEnv()` + `cleoGitCommand()` helpers)
3. `tasks.db` removed from `STATE_FILES` array in `src/store/git-checkpoint.ts:28-40`
4. New `src/store/sqlite-backup.ts` module: `vacuumIntoBackup()` + `listSqliteBackups()` functions
5. SQLite snapshots stored at `.cleo/backups/sqlite/tasks-YYYYMMDD-HHmmss.db`
6. Maximum 10 snapshots retained (rotation deletes oldest when limit exceeded)
7. `PRAGMA wal_checkpoint(TRUNCATE)` runs before every `VACUUM INTO` to flush the WAL
8. `.cleo/.gitignore` gains entries: `tasks.db`, `tasks.db-shm`, `tasks.db-wal`, `.git/`

---

## 4. Rationale

- **Structural isolation permanently eliminates the staging scope bug class.** Path restriction (Option B) is a band-aid that reduces but does not eliminate the risk. With an isolated `.cleo/.git`, there is no possibility of checkpoint commits capturing project files regardless of what is in the project's staging area.

- **VACUUM INTO via `node:sqlite` `DatabaseSync` adds zero npm dependencies.** The `getNativeDb()` function at `src/store/sqlite.ts:254` already exposes the underlying `DatabaseSync` instance. Using `nativeDb` to run `VACUUM INTO '/path/backup.db'` produces a clean, defragmented, consistent snapshot. This complies with ADR-010's zero-native-npm-dependencies mandate.

- **Litestream was refuted in T4877.** It requires a long-running sidecar process (incompatible with CLI tool model), external object storage (S3/GCS/Azure -- incompatible with local-first architecture), and would add a Go binary dependency (violates ADR-010). VACUUM INTO is the correct solution for CLEO's architecture.

- **Removing git checkpointing entirely (Option C) was rejected** because text file history has genuine value. Configuration changes to `config.json`, metrics files, and `project-context.json` benefit from git-tracked point-in-time recovery. Only `tasks.db` (binary, WAL-inconsistent, bloaty) should be excluded from git tracking.

---

## 5. Consequences

### Positive

- Checkpoint commits permanently isolated from project git history
- Clean SQLite point-in-time snapshots via VACUUM INTO
- Zero new npm dependencies (uses existing `node:sqlite` infrastructure)
- `.cleo/.gitignore` properly excludes SQLite files from the isolated repo
- Consistent snapshots (WAL flushed before VACUUM INTO)

### Negative

- Two `.git` directories on disk (project root `.git` + `.cleo/.git`)
- Existing installations require running `cleo init` to create `.cleo/.git`
- `.cleo/.git` adds disk overhead (mitigated by only tracking text state files)

---

## 6. Downstream Impact

All files modified by this decision, mapped to implementation tasks:

1. **`src/store/git-checkpoint.ts`** -- T4871 (immediate path fix hotfix), T4872 (`cleoGitCommand` refactor with `GIT_DIR`/`GIT_WORK_TREE` env), T4873 (remove `tasks.db` from `STATE_FILES`)
2. **`src/store/sqlite-backup.ts`** -- T4874 (new module: `vacuumIntoBackup()` + `listSqliteBackups()`)
3. **`src/store/__tests__/sqlite-backup.test.ts`** -- T4874 (new test suite)
4. **`src/core/init.ts`** -- T4875 (`initCleoGitRepo()` step after step 1 at line 759)
5. **`src/core/system/health.ts`** -- T4872 (`cleo_git_repo` doctor check using `{ check: string, status: 'ok'|'warning'|'error', message: string, details?: Record<string, unknown> }` shape)
6. **`src/store/data-safety.ts`** -- T4874 (`vacuumIntoBackup()` integration at checkpoint call sites: line 206, line 396)
7. **`src/store/data-safety-central.ts`** -- T4874 (`vacuumIntoBackup()` integration at checkpoint call sites: line 125, line 393)
8. **`.cleo/.gitignore`** -- T4873 (add `tasks.db`, `tasks.db-shm`, `tasks.db-wal`, `.git/` entries)

---

## 7. HITL Gate

The Orchestrator MUST present this ADR to the human operator and await explicit approval before spawning Wave 1 implementation agents (T4871, T4872, T4873/T4874). No implementation work may proceed until the human confirms the architectural decision.
