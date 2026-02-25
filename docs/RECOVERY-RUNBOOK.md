# CLEO Data Recovery Runbook

This runbook covers recovery procedures for `.cleo/` data loss or corruption scenarios.

## Prerequisites

- Active session ended: `ct session end`
- CLEO is not running (no MCP server active)

---

## 1. Restore from SQLite Snapshot

Use when `tasks.db` is corrupted, missing, or you need to roll back to a previous state.

### List Available Snapshots

```bash
ls -lt .cleo/backups/sqlite/
# OR via CLEO CLI:
cleo backup list --sqlite
```

### Restore Procedure

1. End any active CLEO session:
   ```bash
   ct session end --note "Pre-recovery"
   ```

2. Stop any running MCP server.

3. Back up the current (corrupted) database:
   ```bash
   cp .cleo/tasks.db .cleo/tasks.db.pre-recovery
   ```

4. Remove WAL/SHM sidecar files (they belong to the old database):
   ```bash
   rm -f .cleo/tasks.db-wal .cleo/tasks.db-shm
   ```

5. Copy the snapshot:
   ```bash
   cp .cleo/backups/sqlite/tasks-YYYYMMDD-HHmmss.db .cleo/tasks.db
   ```
   Replace `tasks-YYYYMMDD-HHmmss.db` with the snapshot filename you want.

6. Verify recovery:
   ```bash
   cleo doctor
   cleo dash
   ```

---

## 2. Navigate Git Checkpoint History

Use when you need to recover a previous version of a JSON state file (e.g., `config.json`, `sessions.json`).

CLEO checkpoints are stored in an **isolated** `.cleo/.git` repository -- separate from the project git repo.

### View Checkpoint Log

```bash
git --git-dir=.cleo/.git log --oneline
```

### View a State File at a Specific Checkpoint

```bash
git --git-dir=.cleo/.git --work-tree=.cleo show HEAD:config.json
git --git-dir=.cleo/.git --work-tree=.cleo show HEAD~3:sessions.json
```

### Restore a File from a Checkpoint

```bash
# Preview first:
git --git-dir=.cleo/.git --work-tree=.cleo show <COMMIT_SHA>:config.json

# Restore (overwrites current file):
git --git-dir=.cleo/.git --work-tree=.cleo checkout <COMMIT_SHA> -- config.json
```

### List All Tracked State Files

```bash
git --git-dir=.cleo/.git ls-files
```

---

## 3. Full .cleo/ Loss Recovery

Use when the entire `.cleo/` directory is missing or unrecoverable.

### Step 1: Re-initialize CLEO structure

```bash
cleo init
```

This recreates the `.cleo/` directory structure, including `.cleo/.git` (the isolated checkpoint repo).

### Step 2: Restore tasks from latest SQLite snapshot

If `.cleo/backups/sqlite/` was preserved (e.g., on a separate volume or backup):

```bash
cp /path/to/backup/tasks-YYYYMMDD-HHmmss.db .cleo/tasks.db
```

### Step 3: Verify

```bash
cleo doctor
cleo dash
```

---

## 4. Verify Recovery

After any recovery procedure, run the full health check:

```bash
cleo doctor
```

Expected output includes:
- `cleo_git_repo: ok` -- `.cleo/.git` checkpoint repo exists
- `tasks_db: ok` -- SQLite database accessible
- All other checks passing

If `cleo_git_repo` shows `warning`, run `cleo init` to create the isolated checkpoint repo.
