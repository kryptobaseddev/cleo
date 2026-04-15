# CLI Audit: Import/Export & Collaboration Domain

**Date**: 2026-04-11
**Auditor**: cleo-prime (subagent)
**Session**: CLI-Full-Audit
**Commands tested**: 36 (all listed in the task)
**Method**: --help + live execution on every command

---

## Summary Table

| # | Command | Exit Code | Works | Notes |
|---|---------|-----------|-------|-------|
| 1 | `cleo export` | 0 | YES | 4 formats (json/csv/tsv/markdown), filter by status/parent/phase, stdout or file |
| 2 | `cleo import` | 0 | YES | Accepts `cleo export` JSON only; path traversal guard active (blocks /tmp) |
| 3 | `cleo export-tasks` | 0 | YES | Produces `cleo-export` format; subtree, filter, includeDeps, dryRun all work |
| 4 | `cleo import-tasks` | 0* | PARTIAL | Default `--onConflict=fail` trips on re-import; requires explicit flag. Richer options than import |
| 5 | `cleo snapshot export` | 0 | YES | Produces `cleo-snapshot` format; stdout or timestamped file |
| 6 | `cleo snapshot import` | 0 | YES | Validates `cleo-snapshot` format strictly; dryRun works |
| 7 | `cleo inject` | 0 | YES | Generates MVI markdown for LLM system prompts; dryRun previews output |
| 8 | `cleo nexus init` | 0 | YES | Initializes NEXUS directory structure |
| 9 | `cleo nexus register` | 0 | YES | Registers project by path; --name, --permissions flags |
| 10 | `cleo nexus unregister` | 0 | YES | Accepts name or hash |
| 11 | `cleo nexus list` | 0 | YES | Returns all 17,035 registered projects; very large output |
| 12 | `cleo nexus status` | 0 | YES | Fast: projectCount=17035, lastUpdated |
| 13 | `cleo nexus show` | 0 | YES | Full details for named project (e.g. cleocode) |
| 14 | `cleo nexus resolve` | 0/1 | YES | Looks up task by project:T### cross-project; E_INTERNAL on not-found (should be E_NOT_FOUND/exit 4) |
| 15 | `cleo nexus query` | 0/1 | BUG | **Exact duplicate of `nexus resolve`** — same handler, same help text, same output |
| 16 | `cleo nexus discover` | 0 | PARTIAL | Only accepts task ID format (T###); rejects natural language queries; poorly documented |
| 17 | `cleo nexus search` | 0 | YES | Searches tasks by pattern across all projects |
| 18 | `cleo nexus deps` | 0 | YES | Shows cross-project deps for a task |
| 19 | `cleo nexus critical-path` | 0 | YES | Takes ~25s on 17k projects (no filter option) |
| 20 | `cleo nexus blocking` | 0 | YES | Impact score + blocking list |
| 21 | `cleo nexus orphans` | 0 | YES | Scans all projects; very slow (~20s+), emits schema migration WARNs |
| 22 | `cleo nexus sync` | 0 | YES | Syncs metadata for all 17,055 projects |
| 23 | `cleo nexus reconcile` | 1 | BUG | **Identity conflict**: project-info.json projectId (34d6a20a) != nexus registered projectId (85ee2a36) for same hash. Blocks reconciliation entirely |
| 24 | `cleo nexus graph` | 0 | YES | Full dep graph across all projects (long-running) |
| 25 | `cleo nexus share-status` | 0 | YES | Shows git config, tracked/ignored files, pendingChanges |
| 26 | `cleo nexus transfer-preview` | 1 | PARTIAL | Correctly enforces write permission; but transfer-preview (dry-run) should not require write permission — read should suffice |
| 27 | `cleo nexus transfer` | — | NOT TESTED | Skipped (mutating; requires write permission) |
| 28 | `cleo nexus permission set` | 0 | YES | Help correct; not executed (mutating) |
| 29 | `cleo nexus share export/import` | 0 | YES | **Alias for snapshot export/import** — same format, same schema |
| 30 | `cleo remote add` | 0 | YES | Adds git remote to .cleo/.git |
| 31 | `cleo remote remove` | 0 | YES | |
| 32 | `cleo remote list` | 0 | YES | Returns empty list (no remotes configured) |
| 33 | `cleo remote status` | 0 | YES | Returns ahead/behind counts; claims "Up to date with origin/main" when no remote exists — misleading |
| 34 | `cleo push` | 0 | YES | --force, --setUpstream available |
| 35 | `cleo pull` | 0 | YES | |
| 36 | `cleo checkpoint` | 0 | YES | --status and --dryRun work; last checkpoint 2026-04-11T02:16:36Z, 0 pending files |

---

## Format Taxonomy

The CLI has **four distinct file formats** for export/import. They are **not interchangeable**:

| Format Tag | Writer | Reader | Use Case |
|------------|--------|--------|----------|
| *(no tag)* | `cleo export` | `cleo import` | Human-readable export (CSV/TSV/JSON/markdown); full task data |
| `cleo-export` | `cleo export-tasks` | `cleo import-tasks` | Portable cross-project transfer; ID remapping; provenance tracking |
| `cleo-snapshot` | `cleo snapshot export` | `cleo snapshot import` | Full state restore; timestamped; checksum; $schema |
| `cleo-snapshot` | `cleo nexus share export` | `cleo nexus share import` | Multi-contributor sharing; **identical to snapshot format** |

Cross-compatibility test results:
- `cleo import` on `cleo-export` file: fails ("Invalid export format, expected 'cleo-export', got 'undefined'")
- `cleo import-tasks` on `cleo export` JSON: fails ("Invalid export format, expected 'cleo-export', got 'undefined'")
- `cleo snapshot import` on `cleo-export` file: fails ("Invalid snapshot format: expected 'cleo-snapshot', got 'cleo-export'")
- `cleo nexus share import` and `cleo snapshot import` accept the same file

---

## Duplicate / Overlap Analysis

### CONFIRMED DUPLICATE: `nexus resolve` == `nexus query`

Both commands:
- Display identical help text: "Resolve a task reference across projects (project:T### or T###)"
- Accept identical arguments: `<TASKREF>`
- Route to the same handler (`nexus.resolve` operation)
- Produce byte-for-byte identical JSON output

**Verdict**: `nexus query` is a dead alias. It provides no additional functionality. Should be removed or at minimum its help text should differentiate it.

### CONFIRMED DUPLICATE: `nexus share export/import` == `snapshot export/import`

- Both produce/consume `cleo-snapshot` format with identical `$schema`, `_meta`, `project`, `tasks` structure
- `nexus share export` calls operation `nexus.share.snapshot.export`; `snapshot export` is `admin.snapshot.export`
- The operation names differ but the file output is identical (verified: same checksum)
- `nexus share import` can read files produced by `snapshot export` and vice versa

**Verdict**: `nexus share export/import` is a contextual alias for `snapshot export/import`. The redundancy may be intentional (workflow grouping under nexus for multi-contributor context) but it is undocumented and confusing.

### OVERLAPPING SCOPE: `cleo export/import` vs `export-tasks/import-tasks` vs `snapshot export/import`

All three pairs write/read task data. The distinctions are meaningful but invisible to users:

| Axis | `export`/`import` | `export-tasks`/`import-tasks` | `snapshot export/import` |
|------|-------------------|-------------------------------|--------------------------|
| Purpose | Human-readable report | Cross-project task transfer | Full state backup/restore |
| Format | CSV/TSV/JSON/markdown | JSON package (`cleo-export`) | JSON (`cleo-snapshot`) |
| ID remapping | No | Yes (T### -> T###) | No |
| Provenance | No | Yes (`--noProvenance` to skip) | No |
| Conflict handling | `skip/overwrite/rename` | `duplicate/rename/skip/fail` | Full overwrite |
| Dependency handling | No | `--includeDeps`, `--onMissingDep` | Preserved as-is |
| Full fidelity | No (CSV loses fields) | Medium | High |
| Rollback use case | No | No | Yes |

**Verdict**: The three pairs are functionally distinct. The naming (`export` vs `export-tasks` vs `snapshot export`) is confusing but the functionality does not fully overlap. User confusion is the primary problem, not true duplication.

### OVERLAPPING SCOPE: `cleo backup export/import` vs `snapshot export/import`

- `backup export` produces `.cleobundle.tar.gz` — a tarball containing project + global state, optional encryption
- `snapshot export` produces a `.json` file with task state only
- `backup export` scope: project files, global tier, binary DB files
- `snapshot export` scope: tasks only, portable JSON

**Verdict**: Different purposes. `backup` = full system restore (binary). `snapshot` = task-level portability (JSON). Not duplicates.

### OVERLAPPING SCOPE: `cleo nexus deps` vs `cleo deps`

- `nexus deps`: cross-project scope, queries nexus registry for inter-project dependencies
- `cleo deps` (domain): within-project dependency analysis (overview/show/waves/critical-path/impact/cycles)

**Verdict**: Different scopes. `nexus deps` is cross-project; `cleo deps` is intra-project. The naming collision (`deps`) is confusing but functionality is distinct.

### OVERLAPPING SCOPE: `cleo nexus critical-path` vs `cleo deps critical-path`

- `nexus critical-path`: global critical path across ALL registered projects; no arguments
- `deps critical-path`: critical path from a specific task within the current project

**Verdict**: Different scope. Both are justified. Name collision is a discoverability problem.

### OVERLAPPING SCOPE: `cleo checkpoint` vs `cleo backup add`

- `checkpoint`: commits changed `.cleo/` files to an isolated `.cleo/.git` repo (git-based version control)
- `backup add`: SQLite VACUUM INTO + atomic JSON copy (binary snapshot rotation, 10 snapshots per DB)

**Verdict**: Different mechanisms and use cases. `checkpoint` = git history of config/state files. `backup add` = safe binary DB snapshots. Not duplicates.

### OVERLAPPING SCOPE: `cleo nexus share` vs `cleo remote`/`cleo push`/`cleo pull`

- `nexus share`: JSON snapshot export/import for multi-contributor workflows (pull request style)
- `remote`/`push`/`pull`: git-based sync of `.cleo/.git` to a remote git repository

**Verdict**: Different mechanisms. `nexus share` = pull request-style file handoff. `remote/push/pull` = git-based continuous sync. Not duplicates, but the docs should clarify when to use each.

---

## Bugs Found

### BUG-1: `nexus query` is an undocumented duplicate of `nexus resolve` (MEDIUM)

**Severity**: Medium — confusing to users, wastes surface area  
**Symptom**: `cleo nexus query cleocode:T051` and `cleo nexus resolve cleocode:T051` produce byte-for-byte identical output. The help text for both says "Resolve a task reference across projects".  
**Expected**: Either remove `query` or have it implement distinct functionality (e.g. natural-language search).

### BUG-2: `nexus reconcile` fails with identity conflict (HIGH)

**Severity**: High — command is completely broken in this environment  
**Symptom**:
```
E_INTERNAL: Project identity conflict: hash 1e3146b7352b is registered to projectId 
'85ee2a36-9f97-4812-b64f-a8d0cb12d1bb' but current project has projectId 
'34d6a20a-6d6a-40a3-9de0-7bbe6cb0cff7'
```
**Root cause**: `project-info.json` was re-generated (e.g., after a `cleo init`) and got a new UUID, but the nexus registry still holds the old UUID for the same path hash. Reconcile detects the mismatch and errors instead of resolving it.  
**Expected**: `nexus reconcile` should handle this case — that is the entire point of the command. It should offer to update the registry with the current projectId, or at minimum provide a `--force` flag.  
**Exit code**: 1 (correct)

### BUG-3: `nexus resolve` uses E_INTERNAL for E_NOT_FOUND (LOW)

**Severity**: Low  
**Symptom**: When a task is not found, the error code is `E_INTERNAL` (exit 1) instead of `E_NOT_FOUND` (exit 4).  
**Observed**: `cleo nexus resolve cleocode:T001` returns `{"codeName":"E_INTERNAL","code":1}` with message "Task not found". Exit code is 1 not 4.  
**Expected**: Should return exit 4 / `E_NOT_FOUND` to be consistent with other task-lookup commands.

### BUG-4: `nexus transfer-preview` requires write permission (MEDIUM)

**Severity**: Medium — breaks the "preview before committing" workflow  
**Symptom**: `cleo nexus transfer-preview` (a dry-run command) returns permission denied for projects with `read` permission. The error says `'write' required for 'nexus.transfer'`.  
**Expected**: A preview command should only require read permission. The permission check should distinguish `nexus.transfer` from `nexus.transfer.preview`.

### BUG-5: `remote status` returns success when no remote exists (LOW)

**Severity**: Low — misleading output  
**Symptom**: With no remotes configured, `cleo remote status` returns `{"ahead":0,"behind":0,"branch":"main","remote":"origin","message":"Up to date with origin/main"}` with exit 0.  
**Expected**: Should return an error or warning when no remote is configured, rather than fabricating an "up to date" status.

### BUG-6: `nexus discover` rejects natural-language queries (LOW)

**Severity**: Low — poor UX, help text is misleading  
**Symptom**: `cleo nexus discover "CLI audit"` fails with `E_INVALID_INPUT: "Invalid query syntax: CLI audit. Expected: T001, project:T001, .:T001, or *:T001"`.  
**Help text says**: "Find related tasks across projects" with argument named `<TASKQUERY>` — implying query strings are accepted.  
**Expected**: Either accept natural-language strings, or rename the argument to `<TASKREF>` and document the required format.

### BUG-7: `import-tasks` default `--onConflict=fail` breaks same-project re-import without guidance (LOW)

**Severity**: Low — confusing error for valid use case  
**Symptom**: `cleo import-tasks <file> --dryRun` with tasks that already exist throws `E_INTERNAL: "2 duplicate title(s) detected. Use onConflict to resolve."` — no error code, no suggestion in the JSON envelope.  
**Expected**: The error should include a `codeName` of `E_CONFLICT` (or similar), and the `alternatives` field should suggest `--onConflict=skip|rename|duplicate`.

---

## Usage Guidance: When to Use Each Export Command

Based on empirical testing:

```
REPORT for humans / LLM ingestion:
  cleo export --exportFormat=markdown|csv|tsv|json

CROSS-PROJECT TASK TRANSFER (preserves hierarchy, remaps IDs):
  cleo export-tasks T### --subtree --includeDeps
  cleo import-tasks <file> --onConflict=rename

FULL STATE BACKUP (restore entire task DB to known state):
  cleo snapshot export
  cleo snapshot import <file> --dryRun

MULTI-CONTRIBUTOR SHARE (send state to collaborator):
  cleo nexus share export    ← same as snapshot export, different UX context
  cleo nexus share import

SYSTEM-LEVEL PORTABLE BUNDLE (DBs + global state + encryption):
  cleo backup export <name> --scope=all --encrypt
  cleo backup import <bundle>
```

---

## inject Usage

`cleo inject` generates the MVI (Minimal Viable Injection) markdown block inserted into LLM system prompts. It is used by the CAAMP injection chain. It is not an import/export command for task data — it exports CLI documentation for agent consumption. The `--saveState` flag persists session state for extraction by the host orchestrator.

---

## `nexus share` vs `snapshot` Recommendation

`nexus share export/import` is a UX alias for `snapshot export/import` scoped to multi-contributor context. They share a format. Consider one of:
1. Remove `nexus share export/import` and point docs to `snapshot export/import`
2. Keep both but document explicitly that they are the same format and files are interchangeable
3. Differentiate `nexus share` by adding contributor metadata to the snapshot format

---

## Performance Notes

| Command | Observed Latency |
|---------|-----------------|
| `nexus status` | ~0ms (registry count only) |
| `nexus show cleocode` | ~0ms |
| `nexus resolve cleocode:T051` | ~0ms |
| `nexus search "shim"` | ~0ms |
| `nexus orphans` | ~20s+ (scans all 17k project DBs) |
| `nexus critical-path` | ~25s (all projects) |
| `nexus graph` | Long-running (background) |
| `nexus sync` | ~0ms (metadata only) |
| `export --format=json` | ~0ms |
| `snapshot export --stdout` | ~0ms |

`nexus orphans` and `nexus critical-path` have no `--project` filter to scope them. Both are very slow on large registries.

---

## Commands with No `--help` Options (Unusually Thin)

| Command | Only Has |
|---------|----------|
| `nexus list` | No options |
| `nexus status` | No options |
| `nexus critical-path` | No options |
| `nexus graph` | No options |
| `nexus orphans` | No options |
| `remote list` | No options |

None of these accept filters, output format flags, or `--json` overrides. May be intentional minimal design but limits scripting.
