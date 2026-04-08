# ADR-036: CleoOS Database Topology + Lifecycle

**Date**: 2026-04-08
**Status**: accepted
**Accepted**: 2026-04-08
**Related Tasks**: T299, T300, T301, T302, T303, T304, T306, T307, T308, T309, T310, T311
**Related ADRs**: ADR-013
**Keywords**: database, topology, sqlite, backup, xdg, env-paths, walk-up, lifecycle, t5158, vacuum-into, rotation, nexus, signaldock, cleanup, migration, data-loss
**Topics**: database-architecture, lifecycle-management, data-integrity
**Summary**: Establishes the full 4-DB × 2-tier database topology for CleoOS as a first-class architectural concern, closing the work started in ADR-013 §9. Defines walk-up scaffolding rules, VACUUM INTO backup mechanism with rotation, cross-machine portability direction, and signaldock dual-scope direction.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## Context

### What ADR-013 §9 Resolved

ADR-013 was written on 2026-02-25 to address two critical bugs in `src/store/git-checkpoint.ts`: unbounded staging scope and SQLite binary blobs in the commit index (T5158). The chosen solution was a VACUUM INTO rotation mechanism for SQLite snapshots alongside an isolated `.cleo/.git` repo for text-file checkpointing.

ADR-013 §9, resolved 2026-04-07, closed the immediate data-loss vector for the **project tier**. Four files were removed from the project git index via `git rm --cached`:

- `.cleo/tasks.db`
- `.cleo/brain.db`
- `.cleo/config.json`
- `.cleo/project-info.json`

The root `.gitignore` and `.cleo/.gitignore` template were updated to deny these paths. A session-end hook was registered to auto-snapshot via `vacuumIntoBackupAll`. Manual backup via `cleo backup add` was extended to cover all four files using VACUUM INTO for SQLite and atomic tmp-then-rename for JSON.

That resolution was necessary and correct. It was also **insufficient** as a complete topology specification.

### The 9 Remaining Gaps (v2026.4.10 Baseline)

After the v2026.4.10 release (commit `621cb656`, tagged and pushed with GitHub Release), nine concrete gaps remained unaddressed:

1. **Nested `.cleo/` directories tracked in git.** `packages/cleo/.cleo/`, `packages/contracts/.cleo/`, and `packages/lafs/.cleo/` exist inside workspaces packages. These nested directories are tracked by the project git repo — meaning the T5158 data-loss vector is still live within the package subdirectories. WAL sidecar files for any DB that opens inside a nested `.cleo/` can diverge from the committed blob on branch switch.

2. **Auto-create nesting bug.** `getProjectRoot()` does not walk up the directory tree. When `cleo` is invoked from inside a package subdirectory (e.g., `packages/core/`), the path resolution derives the project root as that package directory, not the monorepo root. Consequently, `cleo init` run from within a package creates a NEW `.cleo/` directory at that package level instead of finding and reusing the existing root-level one. This is the direct cause of the nested `.cleo/` directories.

3. **Backup registry missing `signaldock.db` at the project tier.** `sqlite-backup.ts` registers two `SNAPSHOT_TARGETS` — `tasks` and `brain`. `signaldock.db` at the project tier is completely absent from the VACUUM INTO rotation. An agent registry corruption event would leave `signaldock.db` unrecoverable via `cleo restore backup`.

4. **Global `nexus.db` has zero rotating-backup coverage.** `nexus.db` is the cross-project knowledge graph and lives at the global tier. It has no equivalent of the `vacuumIntoBackupAll` mechanism that project-tier DBs use. A corrupted or accidentally-deleted `nexus.db` is unrecoverable via `cleo restore backup`.

5. **No global-tier `signaldock.db` identity story.** Today `signaldock.db` lives only at the project tier (`.cleo/signaldock.db`). There is no canonical agent identity that persists across project switches. When an agent is registered in one project, it does not exist in another. The architecture needs a global identity registry that project-scoped signaldock instances reference by ID.

6. **Legacy files at the global tier are pure cruft.** Three stale files exist at the global CLEO home: `workspace.db`, `workspace.db.bak-pre-rename`, and `nexus-pre-cleo.db.bak`. These are relics of pre-v2026.4.x naming migrations. They consume space, confuse diagnostics, and create the false impression that multiple global DB files are in active use.

7. **Stray `.cleo/cleo.db` (0-byte) and `.cleo/tasks_test.db`.** A zero-byte `cleo.db` file and a `tasks_test.db` artifact exist at the project `.cleo/` root. Neither belongs in the production layout. `cleo.db` was presumably a name used before `tasks.db` was settled on. `tasks_test.db` is a test artifact that should live in tmp or be cleaned up after test runs.

8. **Stray project-tier `.cleo/nexus.db`.** Code documentation and ADR-006 are clear that `nexus.db` is a **global**-tier resource — the cross-project knowledge graph belongs at `$XDG_DATA_HOME/cleo/nexus.db`, not at `.cleo/nexus.db`. A project-tier `nexus.db` is architecturally incorrect and should not exist.

9. **`paths.ts:5` doc comment is stale.** Line 5 of `packages/core/src/paths.ts` reads `CLEO_HOME - Global installation directory (default: ~/.cleo)`. The actual implementation of `getCleoHome()` delegates to `getPlatformPaths().data`, which uses the `env-paths` npm package for XDG-compliant path resolution. On Linux this resolves to `~/.local/share/cleo`, not `~/.cleo`. The comment is misleading and directly contradicts the code.

### Why These Gaps Matter Now

The T5158 data-loss vector was the critical path issue. Now that the project-tier vector is closed, the remaining gaps shift from "safety-critical" to "architectural-correctness-critical." Unaddressed, they produce:

- Agent registrations lost silently on project switch (gap 5)
- Knowledge-graph data unrecoverable after corruption (gap 4)
- Confusing diagnostics from stray files (gaps 6, 7, 8)
- Correct code documenting the wrong path (gap 9)
- New nested `.cleo/` directories created every time a developer runs `cleo init` from a package subdirectory in the monorepo (gap 2)
- Package-level WAL files still in the index (gap 1)

Closing these gaps in v2026.4.11 establishes a complete, stable topology that future work (T310, T311) can build on without re-opening the safety boundary.

---

## Decision

### Database Topology (4 DBs × 2 Tiers)

The canonical CleoOS database topology after v2026.4.11 consists of exactly four SQLite databases divided across two tiers. JSON configuration files at the project tier are not databases but share the same lifecycle rules.

#### Project Tier (`<project-root>/.cleo/`)

The project tier is scoped to a single initialized CLEO project. All project-tier files MUST be excluded from the project git index. The v2026.4.10 release achieved this exclusion for four files; v2026.4.11 extends it to cover the full set.

| File | Type | Purpose | v2026.4.10 status |
|------|------|---------|-------------------|
| `tasks.db` | SQLite | Task management — all tasks, epics, phases, relationships | Untracked (ADR-013 §9) |
| `brain.db` | SQLite | Memory and observations (BRAIN cognitive layer) | Untracked (ADR-013 §9) |
| `signaldock.db` | SQLite | Agent registry — project-scoped agent definitions and credentials | Active; missing from backup registry |
| `config.json` | JSON | Project-level CLEO configuration overrides | Untracked (ADR-013 §9) |
| `project-info.json` | JSON | Project metadata detected at `cleo init` time | Untracked (ADR-013 §9) |

The following files MUST NOT exist at the project tier after v2026.4.11:

| File | Reason |
|------|--------|
| `nexus.db` | nexus is global-tier only; a project-scoped nexus is architecturally incorrect |
| `cleo.db` | stale zero-byte artifact from pre-`tasks.db` naming; deleted by T303 |
| `tasks_test.db` | test artifact; test harnesses MUST use tmp directories, not the live `.cleo/` directory |
| `workspace.db` | legacy name; never valid at the project tier |

#### Global Tier (`$XDG_DATA_HOME/cleo/` resolved via env-paths)

The global tier is scoped to the current OS user across all projects. Path resolution MUST use the `env-paths` npm package via `getPlatformPaths().data`. CLEO_HOME environment variable overrides the resolved path when set. MUST NOT be hardcoded to `~/.cleo`.

Default paths by OS:
- **Linux**: `~/.local/share/cleo/`
- **macOS**: `~/Library/Application Support/cleo/`
- **Windows**: `%LOCALAPPDATA%\cleo\Data\`

| File | Type | Purpose | v2026.4.10 status |
|------|------|---------|-------------------|
| `nexus.db` | SQLite | Cross-project knowledge graph; survives project switches | Active; zero backup coverage |
| `signaldock.db` | SQLite | Canonical agent identity registry; project instances reference by ID (after T310) | Not yet global; deferred to T310 |
| `machine-key` | text | Machine identity for backup provenance and cross-machine fingerprinting | Existing |

The following legacy files MUST be deleted at the global tier during v2026.4.11 migration (T304):

| File | Reason for deletion |
|------|-------------------|
| `workspace.db` | Stale relic from pre-nexus naming; no current code references this path |
| `workspace.db.bak-pre-rename` | Safety copy created during a rename migration that has long since landed |
| `nexus-pre-cleo.db.bak` | Pre-migration backup of nexus from before CLEO took ownership; migration completed |

These three files are **pure cruft** — no code path reads or writes them. Deletion is idempotent via existence check. The deletion logic lives in `cleanup-legacy.ts` (T304).

### Walk-up Scaffolding Rule

CLEO commands MUST be invocable from any subdirectory of a project without creating nested `.cleo/` directories. The rule is: **walk up to the nearest ancestor containing `.cleo/` or `.git/` and stop at the first hit.**

#### Algorithm

When `getProjectRoot()` is called without the `CLEO_ROOT` environment variable set:

```
Input: cwd (defaults to process.cwd())

1. If CLEO_ROOT env var is set → return CLEO_ROOT immediately (env override)
2. Walk ancestor directories from cwd toward filesystem root:
   a. For each candidate directory D:
      - If D/.cleo/ exists → return D (project found via .cleo/)
      - If D/.git/ exists → return D (project root found via .git/)
   b. If D is the filesystem root → STOP (no project found)
3. If no hit found → emit error E_NO_PROJECT and exit non-zero
```

The walk MUST stop at the **first** hit. It MUST NOT continue walking after finding either sentinel. This ensures that a monorepo root (which has `.git/`) is found correctly even when invoked from a deep nested directory that also happens to have an inner `.git/`.

#### Precedence of Sentinels

Both `.cleo/` and `.git/` are valid stopping conditions because:
- `.cleo/` signals an initialized CLEO project at that directory
- `.git/` signals the version-controlled project root (where `cleo init` should have placed `.cleo/`)

The `.cleo/` check runs first so that projects with a non-root `.cleo/` (unusual but valid for single-package projects) are found without requiring a `.git/` at the same level.

#### Auto-Create Prohibition

`getProjectRoot()` MUST NOT auto-create a `.cleo/` directory. Project initialization is an explicit opt-in operation (`cleo init`). The walk-up rule means that `cleo init` invoked from any subdirectory of an already-initialized project will find the existing `.cleo/` at the project root rather than creating a nested one.

If `cleo init` is invoked in a directory that genuinely has no ancestor `.cleo/` or `.git/`, it creates `.cleo/` at the current directory level — which is correct behavior for bootstrapping a new project from that directory.

#### Error Messages

| Condition | Error code | Message |
|-----------|-----------|---------|
| No `.cleo/` or `.git/` found in any ancestor | `E_NO_PROJECT` | `No CLEO project found. Run 'cleo init' in your project root to initialize.` |
| `.git/` found but no `.cleo/` inside it | `E_NOT_INITIALIZED` | `Git repository found at <path> but CLEO is not initialized here. Run 'cleo init' to set up CLEO for this project.` |

#### CLEO_ROOT Environment Variable

`CLEO_ROOT` MUST bypass the walk-up entirely and return the specified path without modification. This is the escape hatch for:

- CI environments where `cwd` may be a tmpdir unrelated to the project
- Monorepo scripts that need to target a specific sub-project
- Test harnesses that set up isolated project roots in tmp directories

When `CLEO_ROOT` is set, no ancestor scanning occurs. The path is trusted as-is. If the path does not contain `.cleo/`, commands that require an initialized project will fail at the point of database access rather than at path resolution.

### Backup Mechanism

#### Scope and Storage Locations

Two separate backup registries operate independently:

| Scope | Storage location | DBs covered |
|-------|-----------------|-------------|
| Project | `<project-root>/.cleo/backups/sqlite/` | `tasks.db`, `brain.db`, `signaldock.db` |
| Global | `$XDG_DATA_HOME/cleo/backups/sqlite/` | `nexus.db`, `signaldock.db` (after T310) |

Each scope's backup directory is created on first use via `mkdirSync({ recursive: true })`.

#### VACUUM INTO Mechanism

All SQLite backups use SQLite's `VACUUM INTO` command, which produces a clean, WAL-free, fully defragmented copy of the database at the destination path. The sequence for each database snapshot is:

1. Call `PRAGMA wal_checkpoint(TRUNCATE)` to flush all WAL frames into the main database file and truncate the WAL to zero bytes. This guarantees the snapshot reflects all committed data without relying on the WAL sidecar.
2. Call `VACUUM INTO '<dest>'` where `<dest>` is the absolute path to the snapshot file.
3. The destination is an atomic SQLite write — `VACUUM INTO` creates the file and writes it in a single operation; no partial states are visible to readers.

#### Snapshot Filename Pattern

All snapshot filenames follow the pattern: `<prefix>-YYYYMMDD-HHmmss.db`

Examples:
- `tasks-20260408-143022.db`
- `brain-20260408-143022.db`
- `signaldock-20260408-143022.db`
- `nexus-20260408-143022.db`

The timestamp is formatted from local time. Rotation logic matches filenames against the regex `^<prefix>-\d{8}-\d{6}\.db$` to find snapshots for a given prefix.

#### Rotation

Each prefix maintains a maximum of **10 snapshots**. When a new snapshot would exceed this limit, the oldest file (lowest `mtime`) for that prefix is deleted before the new snapshot is written. Rotation is per-prefix — `tasks.db` snapshots and `brain.db` snapshots each maintain their own 10-file window independently.

Rotation MUST be non-fatal: filesystem errors during rotation are swallowed and do not prevent the new snapshot from being written.

#### Debounce

Snapshot requests are debounced per prefix with a 30-second window. Within any 30-second window, at most one snapshot per prefix is written. This prevents rapid successive saves (e.g., a session that closes and reopens multiple times within a session) from filling the rotation window unnecessarily.

The `force: true` option bypasses the debounce. It is used by:
- `cleo session end` — always force-snapshots before exit to guarantee a fresh recovery point
- `cleo backup add` — manual snapshots are always forced

#### Triggers

Automatic snapshot triggers (non-exhaustive):
- Every `cleo session end` via the `backup-session-end` hook registered at priority 10 in `session-hooks.ts`
- Every safe task mutation via `data-safety.ts` → `triggerCheckpoint` (30s debounce applies)
- Before any destructive migration step in cleanup scripts

Manual trigger:
- `cleo backup add` — creates a 4-file snapshot of all project-tier files (tasks.db, brain.db, signaldock.db, config.json, project-info.json) plus global-tier nexus.db

### Recovery Procedures

#### `cleo restore backup` Command

```
cleo restore backup --file <filename> [--scope project|global] [--db <prefix>]
```

Restore behavior:
1. Locate the snapshot file in the appropriate backup directory (`--scope` determines which directory; defaults to `project`)
2. Run `PRAGMA integrity_check` on the snapshot before restoring. If the integrity check returns anything other than `ok`, abort with `E_CORRUPT_BACKUP` and display which checks failed.
3. Stop any active database connections to the target DB (drain pending writes via the debounce flush mechanism)
4. Copy the snapshot file to the live database path using atomic tmp-then-rename:
   - Write to `<dest>.tmp`
   - `rename(<dest>.tmp, <dest>)`
5. Delete any stale WAL sidecar files (`<dest>-wal`, `<dest>-shm`) that may conflict with the restored snapshot
6. Emit a structured log entry recording the restore operation, source snapshot, and timestamp

#### JSON File Recovery

`config.json` and `project-info.json` are recovered via `cleo backup add` snapshots rather than the VACUUM INTO pipeline. The `cleo restore backup --file config.json` command restores the JSON file from the most recent `cleo backup add` snapshot sidecar.

If no snapshot exists, `cleo init` regenerates both files from code defaults — accepting the loss of any customizations since the last snapshot.

#### Integration Tests

T308 implements a 9-scenario integration test suite covering the full topology:
1. Fresh `cleo init` from project root — produces exactly one `.cleo/`, no nested dirs
2. `cleo init` from a package subdirectory — walks up to existing project root, does not create nested `.cleo/`
3. Walk-up finds `.git/` but no `.cleo/` — returns `E_NOT_INITIALIZED`
4. `CLEO_ROOT` override bypasses walk-up
5. Project-tier snapshot via `vacuumIntoBackupAll` — produces correct filenames, rotation enforced
6. Global-tier snapshot of `nexus.db` — produces correct filenames in XDG path
7. Restore from project-tier snapshot — integrity check passes, WAL sidecars cleared
8. Restore from corrupt snapshot — integrity check fails, no file modified
9. Legacy global file cleanup — `workspace.db`, `workspace.db.bak-pre-rename`, `nexus-pre-cleo.db.bak` deleted idempotently; `nexus.db` untouched

### Cross-Machine Portability (Future Direction — T311)

**v2026.4.11 does not ship cross-machine export/import.** This section documents the intended architecture as the target for T311 (deferred to v2026.4.13+).

The problem: VACUUM INTO snapshots are local-machine artifacts. Restoring a `tasks.db` snapshot from machine A on machine B works for the data content, but loses the provenance chain (which machine created which snapshot). For teams sharing task state across machines or CI environments, a structured export format is needed.

The planned solution is a self-contained tarball format:

```
cleo-backup-export-<timestamp>.tar.gz
├── manifest.json          # metadata: machine fingerprint, export timestamp, schema versions
├── tasks-<timestamp>.db   # VACUUM INTO snapshot of tasks.db
├── brain-<timestamp>.db   # VACUUM INTO snapshot of brain.db
├── signaldock-<timestamp>.db
├── nexus-<timestamp>.db
├── config.json            # atomic-copy
├── project-info.json      # atomic-copy
└── checksums.sha256       # SHA-256 hash of each included file
```

`manifest.json` structure:
```json
{
  "version": 1,
  "exportedAt": "2026-04-08T14:30:22Z",
  "machineFingerprint": "<sha256-of-machine-key>",
  "schemaVersions": {
    "tasks": "<drizzle-migration-hash>",
    "brain": "<drizzle-migration-hash>",
    "signaldock": "<drizzle-migration-hash>",
    "nexus": "<drizzle-migration-hash>"
  }
}
```

Import sequence:
1. Verify checksums against `checksums.sha256`
2. Check `schemaVersions` against current codebase migration hashes — warn on mismatch, error on major version gap
3. Stop active connections
4. Restore each DB via atomic tmp-then-rename
5. Run `PRAGMA integrity_check` on each restored DB
6. Emit structured log with import provenance

CLI verbs (T311):
- `cleo backup export [--scope project|global|all] [--output <path>]`
- `cleo backup import <tarball> [--scope project|global|all] [--force]`

This functionality is **not in scope for v2026.4.11**. The local backup mechanism ships first; cross-machine portability is a follow-on with its own RCASD-IVTR pipeline.

### Signaldock Dual-Scope (Future Direction — T310)

**v2026.4.11 does not ship the signaldock global/project split.** This section documents the intended architecture as the target for T310 (deferred to v2026.4.12+).

The problem: today, `signaldock.db` exists only at the project tier. An agent registered in project A (`/mnt/projects/alpha/.cleo/signaldock.db`) is invisible to project B (`/mnt/projects/beta/.cleo/signaldock.db`). There is no canonical agent identity that persists when a developer switches projects.

The intended solution is a two-tier signaldock architecture:

**Global `signaldock.db`** at `$XDG_DATA_HOME/cleo/signaldock.db`:
- Holds canonical agent identity: agent ID (UUID), name, type, capabilities, credential references
- Survives across project switches; represents agents as first-class user-level resources
- Backed up by the global-tier VACUUM INTO rotation

**Project `signaldock.db`** at `<project-root>/.cleo/signaldock.db`:
- Holds project-specific agent configuration: which global agents are active in this project, project-scoped overrides, agent-task linkages
- References global agents by UUID; does not duplicate identity data
- Backed up by the project-tier VACUUM INTO rotation (added as part of T301/T306)

Migration plan (T310):
- Schema additions to both global and project signaldock.db (new columns for `global_agent_id` foreign key at project tier)
- One-shot migration script that reads existing project `signaldock.db` agents, writes them to global `signaldock.db` with new UUIDs, and populates project-tier reference rows
- RCASD-IVTR lifecycle pipeline to validate before shipping

This functionality is **not in scope for v2026.4.11**. v2026.4.11 adds `signaldock.db` to the project-tier backup registry (T306) and documents the dual-scope architecture. The actual schema split and migration ship in T310.

---

## Consequences

### Positive

- **Single mental model for database placement.** After v2026.4.11, every CLEO developer and agent can answer "where does file X live?" by consulting this ADR's topology table. There are no exceptions, legacy special cases, or undocumented paths.

- **Explicit data-loss boundary closed at both tiers.** v2026.4.10 closed the project-tier T5158 vector for `tasks.db` and `brain.db`. v2026.4.11 closes the remaining surface: nested package `.cleo/` directories, missing `signaldock.db` backup coverage, and zero global-tier backup coverage for `nexus.db`.

- **Walk-up rule makes `cleo` safe to invoke from any subdirectory.** Developers working in `packages/core/` or `packages/lafs/` no longer risk creating rogue nested `.cleo/` directories. The first-hit bounded walk is deterministic and always finds the correct project root.

- **Pre-untrack snapshots prevent data loss during nested cleanup.** T302 creates `VACUUM INTO` snapshots of any databases found in `packages/{cleo,contracts,lafs}/.cleo/` before removing those directories from the git index. No data is destroyed during the migration.

- **XDG path resolution via env-paths is now explicit contract, not implementation detail.** The stale `paths.ts:5` comment implied `~/.cleo`; this ADR makes the XDG behavior an official architectural commitment. Users who rely on `~/.cleo` behavior can set `CLEO_HOME=~/.cleo` to preserve it.

- **Legacy global file cleanup eliminates diagnostic confusion.** Removing `workspace.db`, `workspace.db.bak-pre-rename`, and `nexus-pre-cleo.db.bak` means `cleo doctor` and `cleo backup list` reflect only files that are actually in active use.

### Negative

- **One-shot migration required for existing installations.** All three tasks in the migration wave (T302 for nested package cleanup, T303 for stray file deletes, T304 for legacy global cleanup) require running cleanup scripts. Fresh clones do not need this migration; only existing developer installations running on the v2026.4.10 baseline.

- **Signaldock global identity (T310) is a substantial follow-on.** The schema change to split global and project signaldock instances touches every agent registration path. T310 has its own RCASD-IVTR pipeline and is estimated large. Shipping the topology framework now does not remove this cost — it only clarifies what the target state is.

- **Cross-machine portability (T311) is also a follow-on.** The tarball export/import format adds new failure modes (checksum validation, schema version mismatch handling, partial-import recovery). T311 is scoped to v2026.4.13+ and requires its own RCASD-IVTR pipeline.

- **Integration test suite scope is broader than previous unit tests.** T308's 9-scenario suite exercises filesystem interactions, walk-up behavior, backup rotation, and restore integrity — these tests are slower than pure unit tests and require careful cleanup between scenarios. They belong in a dedicated `integration/` directory to avoid polluting fast-test runs.

---

## Alternatives Considered

### Alternative 1: Flat Single-Tier (Everything in Project)

All four databases and all JSON config live in the project tier. Global tier is abolished.

**Why rejected**: `nexus.db` is the cross-project knowledge graph by design — placing it in the project tier means it disappears on project switch, which defeats its purpose. Similarly, the planned global `signaldock.db` (T310) needs to persist across project switches to serve as a canonical agent identity registry. A single-tier architecture collapses these two distinct concerns into a constraint violation.

### Alternative 2: Always Global (Everything in XDG_DATA_HOME)

All databases live at the global tier. Project tier is abolished.

**Why rejected**: `tasks.db` is inherently per-project — mixing tasks from project A and project B in a single global database creates multi-tenancy complexity (namespace collisions, query scoping, per-project backup granularity loss). `brain.db` is similarly project-scoped in its memory associations. `config.json` overrides need to be project-specific to avoid one project's configuration bleeding into another. The two-tier split is a direct consequence of the different scoping requirements of the four databases.

### Alternative 3: SQL Dump Instead of VACUUM INTO for Backups

Use `sqlite3 <db> .dump > backup.sql` or the Node.js equivalent to produce text-format backups.

**Why rejected**: `VACUUM INTO` is atomic, produces a clean defragmented binary copy, preserves indexes, triggers, views, and all metadata, and is implemented natively in SQLite without requiring an external `sqlite3` binary or additional npm dependencies. SQL dumps produce text-format files that are multiple times larger than the binary source, require re-parsing and re-executing on restore, and do not preserve auto-increment sequences reliably across SQLite versions. ADR-013 selected `VACUUM INTO` for v2026.4.10 and that decision is correct; this ADR extends it to cover the additional databases at both tiers.

### Alternative 4: Amend ADR-013 Instead of Writing ADR-036

Extend ADR-013 §9 with additional subsections covering the new decisions.

**Why rejected**: ADR-013 is a point-in-time document describing a specific historical bug and its fix. Its §9 is already a resolution note rather than a forward-looking design. Amending it further would mix the historical record with new architectural decisions, making it harder to understand what was decided in response to T5158 versus what is being decided now as part of v2026.4.11. ADR-036 as a standalone document gives the full topology its own canonical home with its own frontmatter, related-tasks list, and lifecycle metadata.

### Alternative 5: Walk-up With Auto-Create Fallback

If the walk-up finds no `.cleo/` or `.git/`, auto-create `.cleo/` at the current directory rather than returning an error.

**Why rejected**: Silent auto-creation is the root cause of the nested `.cleo/` bug this ADR fixes. If a developer runs `cleo` from inside `packages/core/` and the walk-up encounters the filesystem root without finding a sentinel, auto-creating `.cleo/` at `packages/core/` would silently initialize a second project that would immediately start diverging from the monorepo root's `tasks.db`. The explicit error (`E_NO_PROJECT`) forces the developer to consciously run `cleo init` at the correct location, which is the correct behavior for bootstrapping a new project.

---

## Implementation Tasks

The v2026.4.11 epic (T299) dispatches the following 12 child tasks across 5 waves:

| Task | Wave | Title | Description |
|------|------|-------|-------------|
| T300 | 0 | This ADR | Architectural anchor document (current task; complete) |
| T301 | 1 | Walk-up algorithm in paths.ts | Implement bounded ancestor scan in `getProjectRoot()` |
| T302 | 1 | Nested package `.cleo/` snapshot + untrack | Safety-snapshot then `git rm -r` the three nested `.cleo/` dirs |
| T303 | 1 | `paths.ts:5` comment fix + stray file deletes | Correct the `CLEO_HOME` doc comment; delete `cleo.db` and `tasks_test.db` |
| T304 | 1 | Legacy global file cleanup | Idempotent `cleanup-legacy.ts` deletes three cruft files at global tier |
| T306 | 2 | Global-tier backup mechanism | VACUUM INTO rotation for `nexus.db`; extend `cleo backup add` to global tier |
| T307 | 2 | Stray project `nexus.db` cleanup + guard | Delete stray `.cleo/nexus.db`; add runtime guard in nexus accessor |
| T308 | 3 | 9-scenario integration test suite | Full topology validation across all walk-up and backup scenarios |
| T309 | 4 | v2026.4.11 release mechanics | CalVer bump, changelog generation, npm publish, GitHub Release |

Wave 1 tasks (T301, T302, T303, T304) are the critical path: T306 and T307 depend on T301 being correct, and T308 depends on all implementation tasks being complete.

### Follow-on Epics (Outside v2026.4.11 Scope)

Two substantial follow-ons are designed but deferred:

**T310 — Conduit + Signaldock Separation**
- Scope: Global `signaldock.db` identity registry + project reference schema + one-shot migration
- Target release: v2026.4.12+
- Lifecycle: Full RCASD-IVTR pipeline required before implementation

**T311 — Cross-Machine Backup Export/Import**
- Scope: Tarball format with `manifest.json`, SHA-256 checksums, schema-version validation, `cleo backup export/import` verbs
- Target release: v2026.4.13+
- Lifecycle: Full RCASD-IVTR pipeline required before implementation

Both epics MUST NOT be started until their respective RCASD research phases are complete. The topology and lifecycle framework shipped in v2026.4.11 provides the foundation they build on but does not pre-commit to any implementation details within those epics.

---

## References

- **ADR-013 §9** — Origin ADR; project-tier untrack resolution landed in v2026.4.10 (T5158)
- **ADR-006** — Canonical SQLite storage decision (foundational)
- **ADR-010** — Node-sqlite engine choice and zero-native-npm-dependencies mandate
- **T5158** — Original data-loss bug that motivated ADR-013 and ADR-013 §9
- **T299** — Parent epic: CleoOS Database Topology + Lifecycle (v2026.4.11)
- **`packages/core/src/paths.ts`** — Path resolution implementation; `getCleoHome()`, `getProjectRoot()`
- **`packages/core/src/store/sqlite-backup.ts`** — VACUUM INTO implementation; `vacuumIntoBackupAll()`, rotation, debounce
- **`packages/core/src/system/platform-paths.ts`** — `getPlatformPaths()` delegating to `env-paths` npm package
- **env-paths npm package** — XDG-compliant path resolution across Linux, macOS, Windows
- **ADR-017** — Frontmatter schema and verb standards governing this document's structure
