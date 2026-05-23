# ADR-013: Data Integrity & Checkpoint Architecture

**Date**: 2026-02-25
**Status**: accepted
**Gate**: HITL
**Gate Status**: approved
**Related Tasks**: T4867, T4868, T4869, T5158
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

**Evidence**: Commit `56713c1b` -- a `chore(cleo): auto checkpoint` commit included unrelated files from `packages/` and `src/protocols/` directories that had been pre-staged by other operations.

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

---

## 8. Implementation Notes

### 2026-03-01 — Safety guards applied (T5158)

After two data loss incidents caused by git tracking `.cleo/tasks.db`, the following multi-layer defense was implemented:

1. **Pre-commit hook** (`.cleo/templates/git-hooks/pre-commit`): Added guard 0 that rejects any staged `.cleo/*.db*` files with a clear error message and `git rm --cached` fix suggestion. This is the primary prevention layer.

2. **Runtime detection** (`src/store/sqlite.ts`): On first database open, checks via `git ls-files --error-unmatch` whether `tasks.db` is tracked by the project git repo. If tracked, emits a Pino warning with remediation instructions. Runs once per process via module-level flag.

3. **ADR status**: Updated from "proposed" to "accepted".

4. **Init wiring** (`src/core/init.ts`): Already handled — `initGitHooks()` installs both `commit-msg` and `pre-commit` hooks from `.cleo/templates/git-hooks/`.

---

## 9. Resolution — 2026-04-07 (T5158)

**Status**: RESOLVED. `.cleo/tasks.db`, `.cleo/brain.db`, `.cleo/config.json`, and `.cleo/project-info.json` are no longer tracked in the project git repo.

### Why the 2026-03-01 guards were insufficient

The safety guards documented in §8 caught new *stages* of the DB files but did nothing about the four files that were **already in the index** from pre-T5158 commits. Every `git checkout` between branches whose histories differed still overwrote the live DB with a stale blob, and the runtime logger continued to emit `tasks.db is tracked by project git — this risks data loss on branch switch` on every single command invocation. The nested `.cleo/.gitignore` also retained `!config.json` and `!project-info.json` re-include rules, which overrode any parent-repo deny lines for those two paths.

### What was done

1. **Untracked four files via `git rm --cached`**:
   - `.cleo/tasks.db`
   - `.cleo/brain.db`
   - `.cleo/config.json`
   - `.cleo/project-info.json`

   `git rm --cached` removes the files from the git index while preserving the local on-disk copies — no data is destroyed by this operation.

2. **Updated the root `.gitignore`** to explicitly deny `.cleo/tasks.db*`, `.cleo/brain.db*`, `.cleo/config.json`, `.cleo/project-info.json`, and `.cleo/backups/` with a comment block referencing this ADR section.

3. **Updated `.cleo/.gitignore` and its source template** (`packages/core/templates/cleo-gitignore` + the `CLEO_GITIGNORE_FALLBACK` constant in `packages/core/src/scaffold.ts`) to drop the `!config.json` / `!project-info.json` allow rules and add explicit `config.json` / `project-info.json` deny lines. Git's nested-.gitignore rule makes this critical: a nested `!foo` overrides any parent ignore, so the only safe way to ignore these files at the project repo level is to NOT re-include them in the nested file.

4. **Extended `sqlite-backup.ts`** to snapshot both `tasks.db` AND `brain.db` via `VACUUM INTO`. New exports:
   - `vacuumIntoBackupAll({ cwd?, force? })` — snapshots all registered SQLite databases (currently tasks.db + brain.db) with independent 30s debounce per target.
   - `listBrainBackups(cwd?)` — lists `brain-YYYYMMDD-HHmmss.db` snapshots newest-first.
   - `listSqliteBackupsAll(cwd?)` — aggregated listing keyed by prefix.

5. **Rewrote `packages/core/src/system/backup.ts`** to use `VACUUM INTO` via `getNativeDb()` / `getBrainNativeDb()` for SQLite files (replacing the unsafe `readFileSync/writeFileSync` pattern) and atomic tmp-then-rename for JSON files. This makes `cleo backup add` produce WAL-consistent snapshots of all four files in a single call.

6. **Registered an auto-snapshot hook** in `packages/core/src/hooks/handlers/session-hooks.ts`:
   ```
   backup-session-end (priority 10) → vacuumIntoBackupAll({ force: true })
   ```
   Runs on every `cleo session end` AFTER the brain/memory-bridge handler (priority 100) has written the SessionEnd observation into `brain.db`. This guarantees a fresh recovery point at every session boundary.

7. **Updated the runtime tracking warning** in `packages/core/src/store/sqlite.ts` to reference the new workflow (`cleo backup add`, `.cleo/backups/sqlite/`) and added a comment block explaining that the warning is retained as a regression guard.

8. **Added regression tests**:
   - `packages/core/src/store/__tests__/sqlite-backup.test.ts` — now covers brain.db snapshots, per-prefix rotation, `vacuumIntoBackupAll`, and `listSqliteBackupsAll`.
   - `packages/core/src/system/__tests__/backup.test.ts` (new) — validates VACUUM INTO call ordering, atomic JSON writes, sidecar metadata, and restore behavior.
   - `packages/cleo/src/cli/commands/__tests__/init-gitignore.test.ts` — asserts the template NEVER re-includes `config.json` / `project-info.json` and DOES explicit-deny them.

### Recovery story (for users affected by corruption or rollback)

All four runtime files are now recoverable via out-of-band mechanisms instead of git:

| File                       | Recovery mechanism                                                                 |
|----------------------------|------------------------------------------------------------------------------------|
| `tasks.db`                 | `.cleo/backups/sqlite/tasks-YYYYMMDD-HHmmss.db` (auto-snapshotted every session end, rotated to 10 copies) |
| `brain.db`                 | `.cleo/backups/sqlite/brain-YYYYMMDD-HHmmss.db` (same rotation)                    |
| `config.json`              | Regenerated from defaults by `cleo init`; captured in `cleo backup add` snapshots  |
| `project-info.json`        | Regenerated from defaults by `cleo init`; captured in `cleo backup add` snapshots  |

CLI verbs:
- `cleo backup add` — creates a full 4-file snapshot under `.cleo/backups/snapshot/` with a `.meta.json` sidecar
- `cleo backup list` — lists all known snapshots (snapshot, safety, migration types)
- `cleo restore backup --file <name>` — restores a single file from its most recent operational backup
- Automatic: `vacuumIntoBackupAll` runs on `SessionEnd` and also on every safe task mutation via `data-safety.ts` → `triggerCheckpoint`

Cross-machine sync of `brain.db` via git is no longer supported (and was always a misuse of git — binary files don't diff). Users who relied on this should use `cleo observe` + `cleo memory find` across machines, or export/import via `cleo export` + the `restore` CLI.

### Related tasks

- **T5158** — this resolution (backup extension, session-end hook, ADR update)
- **T4867** — parent epic
- **T4873, T4874** — original VACUUM INTO implementation
- **T5188** — runtime detection warning

### Legacy backup retention (T10309 — Saga T10281 SG-BRAIN-DB-RESILIENCE / Epic T10282)

Beyond the four currently-tracked runtime files, the historical migration pipeline left ~40 legacy backup artefacts on disk across:

- `<projectRoot>/.cleo/quarantine/` — timestamped quarantine sweeps (`lafs-*`, `studio-*`, `adapters-*`, `runtime-*`, `core-*`, `cleo-os-*`, `brain-malformed-*`)
- `<projectRoot>/.cleo/backups/safety/` — T5158 pre-untrack siblings (`*.pre-untrack-*`)
- `<projectRoot>/.cleo/backups/snapshot/` — `cleo backup add` snapshot overflow (`*.snapshot-*`)
- `<projectRoot>/.cleo/backups/sqlite/` — `vacuumIntoBackupAll` rotation overflow (older than the 10-snapshot cap)
- `<cleoHome>/` — pre-cleo→cleo SDK migration backups (`tasks-pre-cleo.db.bak`, `brain-pre-cleo.db.bak`, `nexus-pre-cleo.db.bak`)
- `<cleoHome>/nexus/` — nested-nexus duplicates of the global-tier pre-cleo backups

#### Retention policy

| Path / pattern                                              | Soft window (≤ N days) | Hard window (≥ N days) | Auto-prune behaviour                            |
|-------------------------------------------------------------|------------------------|------------------------|-------------------------------------------------|
| `*-pre-cleo.db.bak`                                         | 30 (keep)              | 90 (delete)            | `cleo doctor legacy-backups --prune --no-dry-run` |
| `brain.db.PRE-DUP-FIX-*`                                    | 30 (keep)              | 90 (delete)            | same                                            |
| `*.pre-untrack-*`                                           | 30 (keep)              | 90 (delete)            | same                                            |
| `.cleo/backups/sqlite/<prefix>-<timestamp>.db` (overflow)   | 30 (keep)              | 90 (delete)            | same                                            |
| `.cleo/backups/snapshot/*.snapshot-*`                       | 30 (keep)              | 90 (delete)            | same                                            |
| `.cleo/quarantine/**`                                       | always keep            | always keep            | NEVER auto-pruned — operators must run quarantine sweep manually |
| `.cleo/quarantine/brain-malformed-*/**`                     | always keep            | always keep            | NEVER auto-pruned — forensic incident evidence  |

Files in the 30-90 day range are reported as `compress` candidates — the verb does not yet compress, but the recommendation surfaces so a future task can add the compressor without re-walking the tree.

#### CLI surface

```bash
# Read-only scan — reports path, sizeBytes, mtimeMs, originHint, recommendation.
cleo doctor legacy-backups

# Preview prune — exactly the files that --no-dry-run would delete.
cleo doctor legacy-backups --prune

# Actually delete delete-recommended files. --dry-run defaults to TRUE; this
# flag is required to physically remove anything.
cleo doctor legacy-backups --prune --no-dry-run

# Override retention thresholds (must be positive integers).
cleo doctor legacy-backups --soft-retention-days 14 --hard-retention-days 60
```

The verb writes a LAFS envelope under `doctor.legacy-backups.run`. Quarantine artefacts are always carried in `entries` but never in `pruned`. Operator confirmation for hard-window deletions is enforced via the `--no-dry-run` opt-in — the verb defaults to dry-run under all conditions, matching the ADR-013 §1 safety posture.

#### Related tasks

- **T10309** — this subsection (`cleo doctor legacy-backups` walker + retention policy)
- **T10282** — parent epic (E1-DB-INVENTORY)
- **T10281** — parent saga (SG-BRAIN-DB-RESILIENCE)
- **T10307** — sibling DB-substrate walker (`cleo doctor db-substrate`)

---

## 10. Canonical Backup Path — 2026-05-23 (T10315 · Saga T10281 · Epic T10284)

**Status**: RATIFIED. `.cleo/backups/sqlite/` is the SINGLE canonical destination
for ALL SQLite backups, auto-snapshot AND manual snapshot alike. The legacy
`.cleo/backups/snapshot/` directory is DEPRECATED for writes — readers MUST
fall through to it for one (1) release as a deprecation window.

### Why this decision

The T9685 + T10286 audits surfaced two parallel SQLite backup directories
produced by two separate write paths:

| Producer                                                    | Trigger                          | Directory                  | Filename shape                                   |
|-------------------------------------------------------------|----------------------------------|----------------------------|--------------------------------------------------|
| `vacuumIntoBackupAll` in `packages/core/src/store/sqlite-backup.ts` | Auto session-end hook + safety   | `.cleo/backups/sqlite/`    | `tasks-YYYYMMDD-HHmmss.db` / `brain-YYYYMMDD-HHmmss.db` |
| `createBackup` in `packages/core/src/system/backup.ts`      | `cleo backup add` (manual)       | `.cleo/backups/snapshot/`  | `tasks.db.<backupId>` + `<backupId>.meta.json`    |

This was the canonical example of the T10316 "missing brain snapshots" class
of bug: on a fresh project both producers exist independently, but the
recovery pipeline in `packages/core/src/store/recover-brain-db.ts` enumerates
both dirs and ranks the freshest validated candidate — meaning recovery
behaviour drifts whenever the producers disagree. AGENTS.md §"Runtime Data
Safety" already documents `.cleo/backups/sqlite/` as the auto path, and the
recovery code already treats it as a first-class snapshot source.

### What the canonical state looks like

1. **Writers**: Both `vacuumIntoBackupAll` and `createBackup` write to
   `.cleo/backups/sqlite/`.
2. **Filename shapes coexist**:
   - VACUUM INTO snapshots match `^(tasks|brain|conduit)-\d{8}-\d{6}\.db$` —
     rotated independently by `vacuumIntoBackup{,All}`'s per-prefix rotation
     (`MAX_SNAPSHOTS = 10`).
   - System-backup snapshots match `^<file>\.<backupId>$` plus a
     `<backupId>.meta.json` sidecar — rotated by `createBackup`'s
     `rotateBackupDir(...)` against the same directory.
   - The two rotation algorithms are scoped by filename pattern so they NEVER
     collide on each other's files.
3. **`createBackup` filename timestamp**: uses the same `YYYYMMDD-HHmmss`
   local-time format as `sqlite-backup.ts:formatTimestamp` so all backup
   filenames inside `.cleo/backups/sqlite/` use a single timestamp convention.
4. **`listSystemBackups` (the backing surface for `cleo backup list`)**:
   enumerates both `.cleo/backups/sqlite/` (canonical) AND
   `.cleo/backups/snapshot/` (legacy). Entries from the legacy directory are
   marked with `legacy: true` so the CLI surface can warn the operator.
5. **`restoreBackup`**: looks in `.cleo/backups/sqlite/` first, then falls
   through to `.cleo/backups/snapshot/` (read-only). A one-time
   `process.emitWarning('DeprecationWarning', 'CLEO_BACKUP_LEGACY_SNAPSHOT_DIR')`
   fires when the legacy directory is consulted.
6. **`recoverMalformedBrainDb`**: unchanged — already enumerates both
   directories, ranks by timestamp, prefers fresher. With this ratification
   the `system-snapshot` source class collapses into the same physical dir as
   `vacuum-snapshot` over time; both terms remain in the diagnostic-source
   taxonomy for forensic clarity.
7. **Deprecation window**: ONE release. The next major after T10315 deletes
   the read-side fallthrough; `.cleo/backups/snapshot/` files written before
   then remain on disk but become inert.

### Migration semantics for existing installs

No on-disk migration is performed automatically. Existing
`.cleo/backups/snapshot/*.meta.json` files remain readable by `cleo backup
list` and `cleo restore backup` for the deprecation window. Operators MAY
delete the directory by hand once they have confirmed they no longer need
historical pre-T10315 snapshots; CLEO never touches the legacy dir other
than to read from it.

### CI/lint enforcement

This decision is non-enforceable at lint-time because the legacy path is
referenced from the existing recover-brain-db pipeline and the integration
tests' fixtures. Forward-only enforcement lands in the deprecation-window
follow-up task that deletes the read-side fallthrough.

### Related tasks

- **T10315** — this decision (canonical-path ratification + refactor)
- **T10316** — sibling: brain snapshot was missing entirely (closed in parallel)
- **T10286** — parent epic (E3-BACKUP-RECOVERY)
- **T10281** — saga (SG-BRAIN-DB-RESILIENCE)
