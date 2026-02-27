---
version: 1.0.0
status: proposed
task: T4870
date: 2026-02-25
---

# CLEO Data Integrity Specification

## 1. Git Checkpoint Isolation

CLEO checkpoints MUST be committed to a dedicated `.cleo/.git` repository, isolated from the project git repository.

The checkpoint system MUST NOT stage or commit files using the project's `.git` index.

The checkpoint git environment MUST be configured via `GIT_DIR=<cleoDir>/.git` and `GIT_WORK_TREE=<cleoDir>` environment variables passed to all git subprocesses.

State file paths in git commands MUST be relative to `<cleoDir>` (e.g., `config.json`, not `.cleo/config.json`).

The `initCleoGitRepo()` function MUST be idempotent -- it MUST check for the existence of `.cleo/.git/HEAD` before running `git init`.

The function `makeCleoGitEnv(cleoDir)` MUST return `{ GIT_DIR: join(cleoDir, '.git'), GIT_WORK_TREE: cleoDir }`.

The function `cleoGitCommand(args, cleoDir)` MUST pass the environment from `makeCleoGitEnv()` to all `execFileAsync('git', ...)` calls and MUST set `cwd` to `cleoDir`.

### Acceptance Criteria

- **AC1**: After `cleo init`, the file `.cleo/.git/HEAD` MUST exist.
- **AC2**: Running `git log --oneline` in the project root MUST show no `chore(cleo):` checkpoint commits.
- **AC3**: Pre-staging a project source file and triggering a checkpoint MUST NOT include that file in the `.cleo/.git` commit.

## 2. SQLite State Files in Git

`tasks.db`, `tasks.db-shm`, and `tasks.db-wal` MUST NOT appear in the `STATE_FILES` array in `src/store/git-checkpoint.ts`.

These files MUST be listed in `.cleo/.gitignore` to prevent accidental tracking in the isolated `.cleo/.git` repository.

The `.cleo/.gitignore` MUST contain at minimum:

```
tasks.db
tasks.db-shm
tasks.db-wal
.git/
```

### Acceptance Criteria

- **AC4**: The file `.cleo/.gitignore` MUST contain the entry `tasks.db`.
- **AC5**: The `STATE_FILES` array MUST contain no entries with a `.db` extension.

## 3. VACUUM INTO Backup System

When a SQLite backup is triggered, the system MUST first execute `PRAGMA wal_checkpoint(TRUNCATE)` to flush the WAL file before running `VACUUM INTO`.

The `vacuumIntoBackup()` function MUST obtain the native database handle via `getNativeDb()` from `src/store/sqlite.ts`. If `getNativeDb()` returns `null`, the backup MUST be skipped silently (non-fatal).

The backup directory MUST be `.cleo/backups/sqlite/`.

Snapshot filenames MUST follow the pattern `tasks-YYYYMMDD-HHmmss.db`.

The system MUST retain at most 10 snapshots, deleting the oldest when the limit is exceeded.

Backup failures MUST be non-fatal -- the operation MUST log the error and continue without throwing.

The backup function MUST implement debouncing to avoid excessive I/O during high-write sessions. The debounce interval SHOULD match the git checkpoint debounce (configurable, default 5 minutes).

The `vacuumIntoBackup()` function MUST be called alongside `gitCheckpoint()` at all checkpoint trigger sites:
- `src/store/data-safety.ts:206` via `triggerCheckpoint()`
- `src/store/data-safety-central.ts:125` via `checkpoint()` helper
- `src/store/data-safety-central.ts:393` via `forceSafetyCheckpoint()`
- `src/store/data-safety.ts:396` via `forceCheckpointBeforeOperation()`

### Acceptance Criteria

- **AC6**: After a write operation, a `.db` file MUST exist in `.cleo/backups/sqlite/`.
- **AC7**: After 11 write operations, the number of files in `.cleo/backups/sqlite/` MUST be <=10.
- **AC8**: Any snapshot in `.cleo/backups/sqlite/` MUST be a valid, readable SQLite database.
- **AC9**: Copying a snapshot to `.cleo/tasks.db` and running `cleo dash` MUST succeed without errors.

## 4. Integration Requirements

`cleo init` MUST initialize the `.cleo/.git` repository via `initCleoGitRepo()` if it does not already exist. This step MUST execute after core files are created (step 1 in `initProject()` at `src/core/init.ts:759`) and before all subsequent initialization steps.

`cleo doctor` MUST include a `cleo_git_repo` health check that reports `warn` status if `.cleo/.git/HEAD` does not exist, using the standard check shape: `{ check: string, status: 'ok' | 'warning' | 'error', message: string, details?: Record<string, unknown> }`.

The `shouldCheckpoint()` function MUST include an `isCleoGitInitialized()` guard that returns `false` when `.cleo/.git/HEAD` does not exist, preventing checkpoint attempts before the isolated repo is initialized.

The `vacuumIntoBackup()` function MUST be called alongside `gitCheckpoint()` at all checkpoint trigger sites in `src/store/data-safety.ts` and `src/store/data-safety-central.ts`.

### Acceptance Criteria

- **AC10**: Running `cleo init` on a fresh project MUST create `.cleo/.git/HEAD`.
- **AC11**: Running `cleo doctor` when `.cleo/.git` does not exist MUST produce a check with `status: 'warning'` and `check: 'cleo_git_repo'`.
