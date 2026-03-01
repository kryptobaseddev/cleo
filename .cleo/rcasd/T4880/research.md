# T4880: Multi-Contributor .cleo/ Sharing Strategies -- Research

**Date**: 2026-02-25
**Task**: T4880
**Type**: Research
**Status**: complete

---

## 1. Problem Statement

CLEO currently operates as a single-contributor tool. All `.cleo/` state is local to one developer's machine. When multiple contributors (human or AI agent) work on the same repository, they each have independent `.cleo/` state with no mechanism to share task context, ADRs, research outputs, or configuration.

### Requirements
- Multiple contributors should see shared task context (or at least key decisions)
- Architecture documents (ADRs) and research outputs should be shareable
- Configuration should be consistent across contributors
- Sensitive/local-only data (sessions, metrics, audit logs) must NOT be shared
- SQLite binary (tasks.db) cannot be git-merged; needs special handling
- Must work with existing `.cleo/.git` isolated repo (ADR-013)

---

## 2. Current .cleo/ File Analysis

### File Categories

| File/Dir | Type | Shareable? | Rationale |
|----------|------|-----------|-----------|
| `config.json` | JSON | YES | Project config should be consistent |
| `project-info.json` | JSON | YES | Project metadata shared across team |
| `project-context.json` | JSON | YES | Detection config shared across team |
| `adrs/` | Markdown | YES | Architecture decisions are team artifacts |
| `agent-outputs/` | Mixed | YES | Research outputs are team artifacts |
| `rcsd/` | Mixed | YES | Research/consensus/spec deliverables |
| `templates/` | Mixed | YES | Shared templates (AGENT-INJECTION.md, etc.) |
| `schemas/` | JSON | YES | Schema definitions should be consistent |
| `tasks.db` | SQLite binary | NO | Cannot git-merge, WAL consistency issues |
| `tasks.db-shm` | SQLite WAL | NO | Runtime artifact |
| `tasks.db-wal` | SQLite WAL | NO | Runtime artifact |
| `sessions.json` | JSON | NO | Per-contributor session state |
| `metrics/` | JSONL | NO | Per-contributor telemetry |
| `backups/` | Mixed | NO | Local recovery snapshots |
| `.backups/` | Mixed | NO | Atomic write operational backups |
| `logs/` | JSONL | NO | Per-contributor logs |
| `audit-log*.json` | JSON | NO | Per-contributor audit trail |
| `.context-state.json` | JSON | NO | Per-session context state |
| `.context-alert-state.json` | JSON | NO | Per-session alerts |
| `.git-checkpoint-state` | Text | NO | Local checkpoint debounce |
| `bypass-log.json` | JSON | NO | Local commit bypass log |
| `log.json` | JSON | NO | Legacy log (1.8MB, historical) |
| `todo.json` | JSON | MAYBE | Legacy format, 330KB -- could snapshot |
| `tasks-log.jsonl` | JSONL | NO | Append-only operation log |
| `contributions/` | Dir | MAYBE | Depends on workflow |
| `consensus/` | Dir | YES | Consensus documents are team artifacts |
| `.migration.log` | Text | NO | Local migration history |
| `migrations.json` | JSON | NO | Local migration state |
| `.migration-state.json` | JSON | NO | Local migration state |
| `research.json` | JSON | YES | Research index shared across team |
| `.deps-cache/` | Dir | NO | Local dependency cache |
| `.cache/` | Dir | NO | Local cache |
| `context-states/` | Dir | NO | Per-session context snapshots |
| `sync/` | Dir | NO | Local sync state |
| `qa-log.json` | JSON | NO | Local QA tracking |
| `todo-archive.json` | JSON | NO | Legacy archive |
| `todo-log.jsonl` | JSONL | NO | Legacy log |
| `.sequence` | Text | NO | Local sequence counter |
| `.sequence.json` | JSON | NO | Local sequence counter |
| `.fuse_hidden*` | Binary | NO | OS artifact |
| `INCIDENT-*.md` | Markdown | YES | Incident reports are team artifacts |
| `DATA-SAFETY-*.md` | Markdown | YES | Architecture summaries |

### Summary: Safe-to-Share Set

```
config.json
project-info.json
project-context.json
adrs/
agent-outputs/
rcsd/
templates/
schemas/
consensus/
research.json
INCIDENT-*.md
DATA-SAFETY-*.md
```

### Must-Not-Share Set

```
tasks.db, tasks.db-shm, tasks.db-wal
sessions.json
metrics/
backups/, .backups/
logs/, audit-log*.json
.context-state.json, .context-alert-state.json
.git-checkpoint-state
.migration*, migrations*
.sequence*, .deps-cache/, .cache/, context-states/, sync/
bypass-log.json, qa-log.json, log.json
tasks-log.jsonl, todo-log.jsonl, todo-archive.json
.fuse_hidden*
```

---

## 3. Strategy Analysis

### Strategy A: Config-Driven Commit Allowlist + Project Git

**Approach**: Define a `sharing.commitAllowlist` in `config.json` with glob patterns. A `cleo sharing status` command shows which `.cleo/` files are tracked. Auto-manage the project `.gitignore` to exclude everything except allowlisted paths.

**How it works**:
1. `config.json` gets a `sharing` section with `commitAllowlist: string[]`
2. Default allowlist: `["config.json", "project-info.json", "project-context.json", "adrs/**", "templates/**", "schemas/**"]`
3. `cleo sharing status` diffs the allowlist against current `.cleo/` contents
4. `cleo sharing sync` updates `.gitignore` to match the allowlist
5. Shared files are committed to the PROJECT's git repo (not `.cleo/.git`)

**Pros**:
- Simple mental model: allowlisted files go in project git
- No extra git repos or remotes
- Config itself is shareable (in the allowlist)
- Works with any git workflow (PRs, branches, etc.)
- Leverages existing `.gitignore` management

**Cons**:
- Mixes CLEO state with project commits (noise in `git log`)
- Contributors may accidentally commit sensitive files
- No isolation between project and CLEO git histories
- Merge conflicts on shared JSON files (config.json race conditions)

**Verdict**: Good baseline, easy to implement, but mixing concerns with project git.

---

### Strategy B: Snapshot Export/Import

**Approach**: `cleo snapshot export` produces a clean JSON file containing shareable state (tasks, config, ADRs manifest). `cleo snapshot import` consumes it. The snapshot is a point-in-time capture designed for git commit.

**How it works**:
1. `cleo snapshot export` writes `.cleo/snapshots/snapshot-YYYYMMDD-HHmmss.json`
2. Snapshot contains: task list (from tasks.db as JSON), config, metadata
3. The snapshot file is committed to project git
4. `cleo snapshot import` reads a snapshot and merges into local state
5. Merge strategy: last-write-wins with conflict report

**Pros**:
- Clean, auditable point-in-time state
- Human-readable JSON (diffable in PRs)
- Decouples from SQLite binary format
- Contributors can review task state changes in PRs
- Import can be selective (only take config, or only take tasks)

**Cons**:
- Stale by definition (snapshot != live state)
- Merge conflicts when two contributors snapshot simultaneously
- Duplicates data (tasks.db + snapshot.json)
- Import merge strategy is complex (ID conflicts, status races)
- Large snapshots for projects with many tasks

**Verdict**: Good for task state visibility in PRs but complex merge semantics.

---

### Strategy C: Isolated .cleo/.git with Remote Push/Pull

**Approach**: The existing `.cleo/.git` isolated repo (from ADR-013) gets a remote. `cleo push` and `cleo pull` operate on this remote, sharing `.cleo/` state files independently of the project repo.

**How it works**:
1. `cleo remote add <url>` configures a git remote for `.cleo/.git`
2. `cleo push` pushes `.cleo/.git` to the remote
3. `cleo pull` pulls and merges from the remote
4. `.cleo/.gitignore` controls what gets tracked (already excludes tasks.db)
5. STATE_FILES in git-checkpoint.ts defines the tracked set
6. Merge conflicts resolved by git (text files are diffable)

**Pros**:
- Complete isolation from project git history
- Leverages existing `.cleo/.git` infrastructure (ADR-013)
- STATE_FILES already curated: config.json, project-info.json, project-context.json, adrs/, agent-outputs/
- Standard git push/pull semantics (familiar workflow)
- Can use any git remote (GitHub, GitLab, private)
- Per-file merge resolution (not all-or-nothing like snapshots)

**Cons**:
- Two git repos to manage (project + .cleo)
- Extra remote configuration per contributor
- Git conflicts in .cleo/.git require understanding of CLEO state
- `.cleo/.git` is a nested git repo (some tools handle this poorly)
- CI/CD integration needs special handling

**Verdict**: Most flexible and leverages existing infrastructure. ADR-013 already chose this direction.

---

### Strategy D: Hybrid (Allowlist in Project Git + Remote for Full State)

**Approach**: Combine Strategy A and C. Critical shared files (ADRs, templates, config) go in the project git via allowlist. Full state sync (including agent-outputs, research) goes through `.cleo/.git` remote for teams that want it.

**How it works**:
1. `sharing.mode` in config: `"project"` (allowlist only), `"remote"` (.cleo/.git only), `"hybrid"` (both)
2. In `project` mode: allowlisted files committed to project git
3. In `remote` mode: .cleo/.git push/pull for everything
4. In `hybrid` mode: critical files in project git, full state in .cleo/.git remote
5. `cleo sharing status` shows state across both channels

**Pros**:
- Maximum flexibility
- Teams can start with project-git-only and upgrade to remote later
- ADRs always visible in project PRs regardless of mode
- Progressive complexity (simple start, advanced later)

**Cons**:
- Most complex to implement and document
- Risk of state drift between two channels
- Confusing which files go where
- More configuration surface area

**Verdict**: Theoretical ideal but implementation complexity may not be justified initially.

---

## 4. Existing Art

### Linear
- Server-side sync, not git-based
- Teams share via cloud API
- No local-first capability
- Not applicable to CLEO's architecture

### GitHub Projects / Issues
- Server-side, API-based sharing
- Task state lives on GitHub, not locally
- Bi-directional sync would require API integration
- Possible future integration but orthogonal to file-based sharing

### Jira
- Server-side, centralized
- Not relevant to CLEO's local-first design

### Taskwarrior (taskd)
- Sync protocol for distributed task databases
- Uses a custom sync server (taskd)
- Conflict resolution via UUID-based merge
- Most relevant precedent but adds server dependency

### Git-based tools (ticgit, git-bug, Fossil)
- Store issues/tasks as git objects or files
- Merge via git's standard text merge
- Closest precedent to CLEO's approach
- Key lesson: text-based formats merge better than binary

### Obsidian Git Plugin
- Syncs markdown vault via git remote
- Uses automatic push/pull with conflict detection
- `.obsidian/` directory has shareable config vs local-only split
- Very similar pattern to CLEO's `.cleo/` sharing problem
- Key lesson: explicit shareable-vs-local classification works well

---

## 5. SQLite Multi-User Strategies

### Why tasks.db Cannot Be Git-Shared
1. Binary format -- git cannot diff or merge
2. WAL mode -- concurrent access creates .wal and .shm sidecars
3. Page-level changes -- even one task update rewrites multiple pages
4. Merge is impossible -- two diverged .db files cannot be combined

### Alternatives for Task State Sharing

#### A: JSON Snapshot Export
- Export tasks.db to JSON periodically
- Share the JSON file instead of the binary
- Import merges JSON into local tasks.db
- Pros: human-readable, diffable, mergeable
- Cons: stale, complex merge semantics

#### B: Append-Only JSONL Log
- Every task operation appends to a shared JSONL file
- Each contributor replays the log to build local state
- Similar to event sourcing / CRDT
- Pros: no conflicts (append-only), complete audit trail
- Cons: log grows unbounded, replay performance, ordering issues

#### C: Don't Share Tasks at All
- Each contributor has independent task state
- Share only config, ADRs, and research outputs
- Tasks are private to each contributor's workflow
- Pros: simplest, no conflict possible
- Cons: no shared task visibility

#### D: External Task Store (future)
- Use GitHub Issues, Linear, or custom API as shared task backend
- Local tasks.db is a cache/replica
- Pros: proper multi-user semantics, conflict resolution
- Cons: server dependency, API integration, significant effort

### Recommendation
Start with **Option C** (don't share tasks) combined with **JSON Snapshot** for opt-in visibility. ADRs, config, and research outputs provide the critical shared context. Task sharing can be added later via external API integration.

---

## 6. Conflict Resolution Strategies

### For Text Files (config.json, ADRs, research)
- Standard git merge with manual conflict resolution
- For JSON files: use `jq`-based merge or structured JSON merge tool
- ADRs are append-mostly (new files, not edits) -- conflicts are rare
- config.json conflicts: last-modifier-wins with diff review

### For Directories (adrs/, agent-outputs/, rcsd/)
- New files rarely conflict (unique task IDs in filenames)
- Parallel ADR creation: sequential numbering handles naturally
- Agent outputs: task-scoped directories prevent overlap

### For tasks.db
- Do not share via git
- Snapshot export/import with explicit merge step
- Future: CRDT or external store

---

## 7. Recommendations

### Immediate (v1 -- T4882 + T4883)

1. **Config-driven allowlist** (T4883): Add `sharing.commitAllowlist` to config.json. Default to safe-to-share set. Auto-manage `.gitignore`. No new git repos needed.

2. **Snapshot export** (T4882): `cleo snapshot export` produces a clean JSON snapshot of task state for PR visibility. Optional, not required for sharing.

### Near-term (v2 -- T4884, after ADR approval)

3. **Remote push/pull for .cleo/.git**: Leverage ADR-013's isolated repo with a configurable remote. `cleo push` / `cleo pull` for full state sync. This builds on the existing checkpoint infrastructure.

### Future (v3+)

4. **External task store integration**: GitHub Issues or Linear API as shared task backend with local tasks.db as cache.

### Architecture Decision Needed (T4881)

The ADR must decide between three primary architectures:

**Option 1: Project Git Only (Strategy A)**
- Allowlisted `.cleo/` files committed to project repo
- Simplest, works today
- Drawback: mixes CLEO state with project history

**Option 2: .cleo/.git Remote Only (Strategy C)**
- All sharing via isolated `.cleo/.git` remote
- Clean separation, leverages ADR-013
- Drawback: requires extra remote setup per contributor

**Option 3: Hybrid (Strategy D)**
- Critical files in project git, full state in .cleo/.git remote
- Most flexible
- Drawback: most complex, risk of state drift

**Recommendation**: Start with **Option 1** (project git allowlist) as the default mode. It is the simplest to implement, requires no extra infrastructure, and provides immediate value. Add **Option 2** (.cleo/.git remote) as an advanced feature for teams that need full isolation. This is a phased approach, not an either/or decision.

---

## 8. Key Findings

1. **23 of ~40 .cleo/ files/dirs are NOT shareable** -- the safe-to-share set is well-defined and small
2. **ADR-013's .cleo/.git isolation is a natural foundation** for remote push/pull sharing
3. **STATE_FILES in git-checkpoint.ts already has a TODO** for config-driven allowlist
4. **tasks.db cannot be git-shared** -- snapshot export is the pragmatic compromise
5. **Obsidian's pattern** (explicit shareable-vs-local classification) is the closest precedent
6. **Phased approach is recommended**: allowlist first, remote later, external API future
