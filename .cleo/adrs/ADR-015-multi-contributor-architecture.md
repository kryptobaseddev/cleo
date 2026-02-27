# ADR-015: Multi-Contributor .cleo/ Architecture

**Date**: 2026-02-25
**Status**: accepted
**Accepted**: 2026-02-25
**Gate**: HITL
**Gate Status**: passed
**Related Tasks**: T4880, T4881, T4882, T4883, T4884
**Related ADRs**: ADR-013

---

## 1. Context

CLEO currently operates as a single-contributor tool. All `.cleo/` state is local to one developer's machine. When multiple contributors work on the same repository, they each maintain independent `.cleo/` state with no mechanism to share configuration, architecture decisions, or research outputs.

The T4880 research identified that 23 of ~40 `.cleo/` files/directories are NOT shareable (sessions, metrics, logs, SQLite binary, caches). The safe-to-share set is well-defined:

**Shareable**: `config.json`, `project-info.json`, `project-context.json`, `adrs/`, `agent-outputs/`, `rcsd/`, `templates/`, `schemas/`, `consensus/`, `research.json`, `INCIDENT-*.md`

**Not shareable**: `tasks.db` (SQLite binary), `sessions.json`, `metrics/`, `backups/`, `logs/`, `audit-log*.json`, migration state, sequence counters, caches, WAL files

### Constraints

- `tasks.db` (SQLite) cannot be git-merged -- binary format, WAL sidecars, page-level changes
- ADR-013 already established an isolated `.cleo/.git` repo for checkpoint commits
- The `STATE_FILES` array in `git-checkpoint.ts` already has a TODO for config-driven allowlist
- Must be incrementally adoptable (no breaking changes to single-contributor setups)

---

## 2. Options

### Option A: Project Git Allowlist -- SIMPLEST

Allowlisted `.cleo/` files are committed directly to the **project's** git repo. Everything else stays in `.gitignore`. A new `sharing` config section controls which paths are committed.

**Implementation**:
1. Add `sharing.commitAllowlist: string[]` to `config.json` schema
2. Default allowlist: `["config.json", "project-info.json", "project-context.json", "adrs/**", "templates/**", "schemas/**"]`
3. New `cleo sharing status` command shows which files are tracked vs ignored
4. `cleo sharing sync` auto-updates project `.gitignore` to match allowlist
5. Shared files committed via normal `git add .cleo/config.json && git commit`

**Pros**:
- Zero additional infrastructure (no extra git repos, no remotes)
- Works with any existing git workflow (PRs, branches, CI/CD)
- Shared files visible in project PRs and diffs
- ADRs naturally appear in project git history
- Config is self-documenting (allowlist in config.json)

**Cons**:
- Mixes CLEO state with project commits (some `git log` noise)
- Risk of accidentally committing sensitive files if allowlist misconfigured
- JSON merge conflicts on `config.json` when contributors edit simultaneously
- No isolation between project and CLEO git histories

**Scope**: T4883 (config-driven allowlist) + partial T4882 (snapshot export as optional add-on)

---

### Option B: .cleo/.git Remote Push/Pull -- ISOLATED

The existing `.cleo/.git` isolated repo (ADR-013) gets a configurable remote. `cleo push` and `cleo pull` share state via this dedicated remote, completely separate from the project git.

**Implementation**:
1. `cleo remote add <url>` configures git remote for `.cleo/.git`
2. `cleo push` pushes `.cleo/.git` to remote (only STATE_FILES tracked)
3. `cleo pull` pulls and merges from remote
4. STATE_FILES already curated: `config.json`, `project-info.json`, `project-context.json`, `adrs/`, `agent-outputs/`
5. Make STATE_FILES config-driven (the existing TODO in git-checkpoint.ts)
6. Merge conflicts handled by standard git text merge

**Pros**:
- Complete isolation from project git history
- Leverages existing `.cleo/.git` infrastructure (ADR-013)
- Standard git push/pull semantics (familiar to all developers)
- Can use any git remote (GitHub, GitLab, self-hosted)
- Per-file merge resolution (not all-or-nothing)
- STATE_FILES curation prevents sensitive data leaks

**Cons**:
- Requires extra remote setup per contributor (`cleo remote add`)
- Two git repos to understand (project + .cleo)
- Nested `.git` directory can confuse some tools (IDEs, file watchers)
- More complex onboarding for new contributors

**Scope**: T4884 (remote push/pull) + T4883 (config-driven allowlist for STATE_FILES)

---

### Option C: Phased Hybrid -- SELECTED

Start with **Option A** (project git allowlist) as the default sharing mode. Add **Option B** (.cleo/.git remote) as an advanced mode for teams that want full isolation. The `sharing.mode` config controls which is active.

**Implementation**:
1. Phase 1 (immediate): Config-driven allowlist + project git sharing (Option A)
2. Phase 2 (after ADR approval): .cleo/.git remote push/pull (Option B)
3. `sharing.mode: "project" | "remote" | "none"` in config.json (default: `"none"`)
4. Snapshot export always available regardless of mode (T4882)
5. Upgrade path: `"none"` -> `"project"` -> `"remote"`

**Pros**:
- Incremental adoption (start simple, add complexity when needed)
- Single-contributor setups unaffected (mode defaults to `"none"`)
- Teams can choose the right level of sharing
- All three tasks (T4882, T4883, T4884) fit naturally into phases
- Option A and B implementations are additive, not conflicting

**Cons**:
- More code paths to maintain (two sharing modes)
- Documentation must cover both modes
- Testing surface area increases
- Contributors may be confused about which mode to use

**Scope**: T4882 (snapshot) + T4883 (allowlist/project mode) + T4884 (remote mode)

---

## 3. Task State Sharing (All Options)

Regardless of which option is chosen, `tasks.db` (SQLite binary) cannot be git-shared. The approach for task visibility:

1. **Don't share tasks via git** -- each contributor maintains independent task state
2. **Snapshot export** (T4882) provides opt-in task state visibility:
   - `cleo snapshot export` writes a JSON snapshot of current tasks
   - Snapshot committed to project git for PR visibility
   - `cleo snapshot import` merges a snapshot into local state
   - Last-write-wins merge strategy with conflict report
3. **Future**: External task store (GitHub Issues, Linear API) for real-time shared tasks

---

## 4. Recommendation

**Option C (Phased Hybrid)** is recommended for the following reasons:

1. **Incremental risk**: Phase 1 (project git) is low-risk and immediately useful. Phase 2 (remote) is additive.
2. **No breaking changes**: Default mode is `"none"`, preserving current behavior.
3. **Leverages existing work**: ADR-013's `.cleo/.git` becomes the foundation for Phase 2.
4. **Natural task decomposition**: T4882 (snapshot), T4883 (allowlist), T4884 (remote) map 1:1 to implementation phases.
5. **Precedent**: Obsidian's plugin uses the same explicit shareable-vs-local classification pattern successfully.

---

## 5. Decision

**Option C (Phased Hybrid) was approved** via HITL gate on 2026-02-25.

### Implementation Phases

| Phase | Task | Deliverable | Status |
|-------|------|-------------|--------|
| 1 | T4882 | Snapshot export/import | Done |
| 1 | T4883 | Config-driven allowlist + project git sharing | Done |
| 2 | T4884 | .cleo/.git remote push/pull | In progress |

### Configuration

```json
{
  "sharing": {
    "mode": "none | project | remote",
    "commitAllowlist": ["config.json", "adrs/**", ...],
    "denylist": ["tasks.db", "sessions.json", ...]
  }
}
```

### Upgrade Path

`"none"` (default, single-contributor) -> `"project"` (allowlist in project git) -> `"remote"` (.cleo/.git with dedicated remote)
