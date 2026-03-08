# T5562 — nexus Domain Review

**Task**: T5562
**Epic**: T5517
**Date**: 2026-03-08
**Status**: complete

---

## Summary

Current: 31 ops (14q + 17m) | Target: ≤20 | Projected: 17 ops (10q + 7m)

The nexus domain is a compound domain that accidentally accumulated three distinct concerns: cross-project registry management, dependency analysis across projects, and multi-contributor sharing/git sync. All 31 operations are at tier 2, causing the most damaging UX failure in the entire API: agents hit the tier-2 gate at tier 0 and tier 1 disclosure, fall back to reading `~/.cleo/projects-registry.json` directly from the filesystem, and get ~60+ garbage test entries. The tier-2 monoculture is not a privacy precaution — it is a bug that makes the domain functionally invisible to agents. Three ops should move to tier 1 immediately. The share.* ops are the largest source of bloat: 10 of 31 ops duplicate `git` CLI semantics (remote add/remove, push, pull, gitignore) and belong outside the primary MCP surface. Path/blocker/orphan have three redundant alias pairs that collapse to three ops.

---

## Prior Analysis Summary (T5510)

T5510 identified the same structural problems and proposed 31→23 (-8). Its specific suggestions:

1. Merge `path.show` + `critical-path` → parameterized `path.critical`
2. Merge `blockers.show` + `blocking` → parameterized `blockers.analyze`
3. Merge `orphans.list` + `orphans` → `orphans.find`
4. Review 10 share ops — suggest externalize git collaboration
5. Rename `nexus.query` (deprecated verb) → `nexus.resolve` or `nexus.lookup`

This review goes further: the share.* git-wrapping ops (push, pull, remote.add, remote.remove, sync.gitignore) are not core MCP operations — they are `git` CLI wrappers with no CLEO-specific logic. They should move to plugin or be removed entirely. Snapshot export/import and sharing status are legitimate and stay.

---

## Operation Inventory (31 Registered)

Extracted from `src/dispatch/domains/nexus.ts` `getSupportedOperations()` plus registry.ts alias entries.

### Query Operations (14)

| # | Operation | Tier | Description |
|---|-----------|------|-------------|
| Q1 | `status` | 2 | NEXUS health — initialized?, project count, last updated |
| Q2 | `list` | 2 | List all registered NEXUS projects (paginated) |
| Q3 | `show` | 2 | Show single project by name |
| Q4 | `query` | 2 | Resolve cross-project `project:taskId` reference |
| Q5 | `deps` | 2 | Cross-project dependency analysis for a task |
| Q6 | `graph` | 2 | Global dependency graph across all projects |
| Q7 | `path.show` | 2 | Critical dependency path across projects |
| Q8 | `blockers.show` | 2 | Blocking impact for a task query |
| Q9 | `orphans.list` | 2 | List orphaned cross-project dependencies |
| Q10 | `critical-path` | 2 | Alias for `path.show` — same implementation |
| Q11 | `blocking` | 2 | Alias for `blockers.show` — same implementation |
| Q12 | `orphans` | 2 | Alias for `orphans.list` — same implementation |
| Q13 | `discover` | 2 | Discover related tasks across projects by label/keyword |
| Q14 | `search` | 2 | Pattern search across all registered projects |
| Q15 | `share.status` | 2 | Sharing configuration status for current project |
| Q16 | `share.remotes` | 2 | List configured git remotes for .cleo sharing |
| Q17 | `share.sync.status` | 2 | Sync status between local and remote |

*Note: Q10, Q11, Q12 are legacy aliases handled by the same switch cases as Q7, Q8, Q9. They register separately in getSupportedOperations() but are the same operation. The registry.ts lists them as separate OperationDef entries.*

### Mutate Operations (17 in registry, 14 in handler getSupportedOperations)

*Note: registry.ts and handler getSupportedOperations() differ because of alias variants. Handler lists canonical names; registry has both canonical and alias forms for snapshot export/import and share.sync.gitignore.*

| # | Operation | Tier | Description |
|---|-----------|------|-------------|
| M1 | `init` | 2 | Initialize NEXUS (creates registry, directories) |
| M2 | `register` | 2 | Register a project in NEXUS |
| M3 | `unregister` | 2 | Remove a project from NEXUS |
| M4 | `sync` | 2 | Sync project metadata (task count, labels) for one project |
| M5 | `sync.all` | 2 | Sync all registered projects |
| M6 | `permission.set` | 2 | Set read/write/execute permission for a project |
| M7 | `reconcile` | **1** | Reconcile local project identity with global registry |
| M8 | `share.snapshot.export` | 2 | Export task snapshot to file |
| M9 | `share.snapshot.import` | 2 | Import task snapshot from file |
| M10 | `share.sync.gitignore` | 2 | Sync .gitignore for .cleo git sharing |
| M11 | `share.remote.add` | 2 | Add git remote for .cleo sharing |
| M12 | `share.remote.remove` | 2 | Remove git remote for .cleo sharing |
| M13 | `share.push` | 2 | Push .cleo data to remote git |
| M14 | `share.pull` | 2 | Pull .cleo data from remote git |

*reconcile is the single exception — already tier 1 in registry.ts*

**True canonical op count (deduplicating alias triples)**: 11q + 14m = **25 unique operations** in handler logic. Registry registers 31 OperationDef entries because aliases each get a separate entry.

---

## Decision Matrix

### Query Operations

| Operation | Current Tier | Proposed Tier | Decision | Reason |
|-----------|-------------|--------------|----------|--------|
| `status` | 2 | **1** | KEEP + PROMOTE | Agents need to check if NEXUS is initialized before any cross-project op. Tier-2 gate causes filesystem fallback to `projects-registry.json`. Must be tier 1 to break the fallback loop. |
| `list` | 2 | **1** | KEEP + PROMOTE | Primary discovery op — same role as `tasks.find` for the cross-project domain. Agents cannot discover registered projects without it. Tier-2 gate is the root cause of the filesystem fallback. |
| `show` | 2 | 2 | KEEP | Specific project detail after discovery via `list`. Tier 2 is appropriate here — agents find the project first (tier 1), then drill in. |
| `query` | 2 | 2 | KEEP + RENAME | Resolves `project:T001` cross-project references. Verb `query` violates VERB-STANDARDS (non-canonical). Rename to `nexus.resolve`. |
| `deps` | 2 | 2 | KEEP | Cross-project dependency chain for a specific task. Unique value, no equivalent. |
| `graph` | 2 | 2 | KEEP | Global dependency graph — large result, correctly tier 2 (progressive disclosure). |
| `path.show` | 2 | 2 | KEEP (canonical) | Critical path analysis — rename consolidation (see below). |
| `blockers.show` | 2 | 2 | KEEP (canonical) | Blocking impact analysis — rename consolidation (see below). |
| `orphans.list` | 2 | 2 | KEEP (canonical) | Orphan detection — rename consolidation (see below). |
| `critical-path` | 2 | — | REMOVE (alias) | Alias for `path.show`. Same switch case, same implementation. Remove the alias; callers use `path.show`. |
| `blocking` | 2 | — | REMOVE (alias) | Alias for `blockers.show`. Same switch case, same implementation. Remove. |
| `orphans` | 2 | — | REMOVE (alias) | Alias for `orphans.list`. Same switch case, same implementation. Remove. |
| `discover` | 2 | 2 | KEEP | Unique cross-project semantic similarity matching (label + keyword). Not replaceable by `search`. |
| `search` | 2 | 2 | KEEP | Pattern-based cross-project text search. Distinct from `discover` (semantic vs literal). |
| `share.status` | 2 | 2 | KEEP | Sharing configuration status is a legitimate read op for agents managing collaboration. |
| `share.remotes` | 2 | — | REMOVE | Git remote list is available via `git remote -v`. This is a git CLI wrapper with no CLEO-specific value. Callers who need remotes invoke git directly. |
| `share.sync.status` | 2 | — | REMOVE | Git ahead/behind status is `git status` or `git rev-list`. No CLEO-specific logic. Remove. |

**Query result: 10 ops** (removed 3 aliases + share.remotes + share.sync.status)

### Mutate Operations

| Operation | Current Tier | Proposed Tier | Decision | Reason |
|-----------|-------------|--------------|----------|--------|
| `init` | 2 | 2 | KEEP | One-time setup op. Tier 2 is appropriate — only run once, not part of normal agent flow. |
| `register` | 2 | 2 | KEEP | Register new project. Infrequent admin op. Tier 2 correct. |
| `unregister` | 2 | 2 | KEEP | Remove project. Infrequent admin op. Tier 2 correct. |
| `sync` | 2 | 2 | KEEP | Sync single project metadata. Useful after task changes in another project. |
| `sync.all` | 2 | 2 | MERGE → `sync` with `all: true` | Same underlying logic; `nexusSyncAll` is a loop over `nexusSync`. PARAMETERIZE into `sync` via `name` optional: when omitted, sync all. Saves one op. |
| `permission.set` | 2 | 2 | KEEP | Access control for cross-project reads. Required for multi-project setups. |
| `reconcile` | **1** | **1** | KEEP | Already correctly tier 1. Self-registration when a project first uses NEXUS. Agents need this available before tier-2 discovery. |
| `share.snapshot.export` | 2 | 2 | KEEP | Task export to JSON file for cross-team sharing. Legitimate CLEO-specific operation. |
| `share.snapshot.import` | 2 | 2 | KEEP | Import shared snapshot. Symmetric with export. Keep. |
| `share.sync.gitignore` | 2 | — | REMOVE | Writes entries to `.gitignore`. This is a filesystem text-append operation with no CLEO-specific logic that cannot be done with `echo >> .gitignore`. Remove. |
| `share.remote.add` | 2 | — | REMOVE | Wraps `git remote add`. No CLEO-specific logic. Callers invoke git directly. |
| `share.remote.remove` | 2 | — | REMOVE | Wraps `git remote remove`. Same rationale. Remove. |
| `share.push` | 2 | — | REMOVE | Wraps `git push`. No CLEO-specific logic. Remove. |
| `share.pull` | 2 | — | REMOVE | Wraps `git pull`. No CLEO-specific logic. Remove. |

**Mutate result: 7 ops** (removed sync.all via merge, share.sync.gitignore, share.remote.add, share.remote.remove, share.push, share.pull)

---

## Projected Count

| Gateway | Before | After |
|---------|--------|-------|
| Query | 14 (+ 3 registered aliases = 17) | 10 |
| Mutate | 14 (+ 3 registered alias forms = 17) | 7 |
| **Total** | **31** | **17** |

17 ops is well within the ≤20 ceiling. The reductions come from:
- Alias deduplication: -3 (critical-path, blocking, orphans)
- Git-wrapper ops: -7 (share.remotes, share.sync.status, share.sync.gitignore, share.remote.add, share.remote.remove, share.push, share.pull)
- sync.all merge: -1

---

## Tier Reclassification Plan

**The critical problem**: Every nexus op except `reconcile` is tier 2. No nexus operation is surfaced at tier 0 or tier 1 except `reconcile`. This means:

1. An agent at tier 0 or tier 1 sees zero nexus query ops in the capability matrix.
2. The agent cannot check if NEXUS is initialized, cannot list projects, cannot run `reconcile` without knowing the verb.
3. With no tier-1 discovery path, agents fall back to reading `~/.cleo/projects-registry.json` from the filesystem — which contains ~60 garbage test entries (T5656).

**Required tier changes**:

| Operation | From | To | Justification |
|-----------|------|----|---------------|
| `nexus.status` | 2 | 1 | Prerequisite check — "is NEXUS active?" — must be discoverable before any cross-project op |
| `nexus.list` | 2 | 1 | Primary project discovery op; equivalent to `tasks.find` tier — the entry point for the domain |
| `nexus.reconcile` | 1 | 1 | Already correct — keep |

All other nexus ops remaining at tier 2 are correct: they require knowing a specific project name or task reference, which presupposes the agent already did discovery (tier 1 → tier 2 progressive disclosure pattern).

The tier-0/1 progressive disclosure contract for nexus after reclassification:
- **Tier 1**: `nexus.status`, `nexus.list`, `nexus.reconcile` — discover, enumerate, self-register
- **Tier 2**: everything else — analyze, sync, share, drill into specific project

---

## Alias Consolidation

Three operation pairs are exact duplicate switch cases in the handler — same function, different name routed to identical code:

| Canonical | Remove | Handler evidence |
|-----------|--------|-----------------|
| `path.show` | `critical-path` | `case 'path.show': case 'critical-path':` — same case block |
| `blockers.show` | `blocking` | `case 'blockers.show': case 'blocking':` — same case block |
| `orphans.list` | `orphans` | `case 'orphans.list': case 'orphans':` — same case block |

The canonical names (`path.show`, `blockers.show`, `orphans.list`) follow the VERB-STANDARDS dot-noun pattern. The legacy aliases (`critical-path`, `blocking`, `orphans`) should be removed from the registry. The handler switch cases can keep the fallthrough for a single release cycle then drop them.

---

## Share.* Consolidation

After removal of git-wrapping ops, the share surface reduces to 3 ops:

| Operation | Gateway | Decision |
|-----------|---------|----------|
| `share.status` | query | KEEP — CLEO-specific sharing config read |
| `share.snapshot.export` | mutate | KEEP — task snapshot for cross-team distribution |
| `share.snapshot.import` | mutate | KEEP — task snapshot ingestion |

The removed share ops all wrap native git operations:
- `share.remotes` → `git remote -v`
- `share.sync.status` → `git fetch && git status`
- `share.sync.gitignore` → text append to `.gitignore`
- `share.remote.add` → `git remote add`
- `share.remote.remove` → `git remote remove`
- `share.push` → `git push`
- `share.pull` → `git pull`

CLEO is not a git host. These ops have zero CLEO-specific logic and duplicate the git CLI that agents already use. If CLEO-managed git workflows are needed in the future, they belong in a `workspaces` plugin (T5164).

---

## Deprecated Verb Fix

`nexus.query` uses the `query` verb, which is prohibited by VERB-STANDARDS (query = MCP gateway name, not an operation verb). The operation resolves a cross-project `project:taskId` reference.

**Decision**: Rename `nexus.query` → `nexus.resolve`

This is the only naming violation in the nexus domain. The implementation in `src/core/nexus/query.ts` is named `resolveTask` — the public operation name should match.

---

## Sync Merge

`nexus.sync` and `nexus.sync.all` differ only in scope:
- `sync` requires `name` param (single project)
- `sync.all` calls the same underlying loop without a filter

**Decision**: PARAMETERIZE — merge into `nexus.sync` with `name` optional. When `name` is omitted, sync all. This matches the pattern used in `tasks.archive` (which handles both single and bulk modes via optional `taskId`).

---

## The Tier Gate Problem

**Root cause**: The tier-2 monoculture on nexus creates a silent degradation path:

```
Agent at tier 0/1 → sees 0 nexus ops → cannot use MCP → reads filesystem
→ projects-registry.json (stale, garbage entries) → incorrect state
```

This is not a theoretical concern — T5563 confirmed it is happening in production sessions. The T5656 fix (wire nexus.db as canonical, delete projects-registry.json) is necessary but not sufficient. Even after T5656, if `nexus.status` and `nexus.list` remain tier 2, agents running at tier 1 will still see no nexus ops and have no MCP path to check initialization.

**The rule** (from T5517): "No tier-2 gate may exist without an explicit escalation path surfaced at tier 0." The nexus domain violates this for all 31 ops. Promoting `status` and `list` to tier 1 creates the minimal escalation path.

**After fix**: Agent at tier 1 sees `nexus.status` (is it initialized?), `nexus.list` (what projects exist?), `nexus.reconcile` (register me). These three ops are the complete first-contact surface. Everything else escalates to tier 2 with enough context to ask the right questions.

---

## Note on T5563

T5563 (nexus inventory: map agent workflows to operations) is blocked on T5656 (wire nexus.db as canonical store). That task exists to clean up the data corruption before an inventory can produce accurate coverage analysis. This review is based on gateway file analysis and does not depend on T5563 completing. The decisions here are structurally sound regardless of whether projects-registry.json or nexus.db is the live store — the operation semantics are the same.

T5564 (challenge against LAFS/MVI) and T5565 (keep/remove decisions) are addressed within this combined review document since this task was authorized to proceed without T5563.

---

## Migration Notes

| Removed Operation | Migration Path |
|-------------------|---------------|
| `nexus.critical-path` | Use `nexus.path.show` |
| `nexus.blocking` | Use `nexus.blockers.show` |
| `nexus.orphans` | Use `nexus.orphans.list` |
| `nexus.query` | Use `nexus.resolve` (rename) |
| `nexus.sync.all` | Use `nexus.sync` with no `name` param |
| `nexus.share.remotes` | Use `git remote -v` |
| `nexus.share.sync.status` | Use `git fetch && git status` |
| `nexus.share.sync.gitignore` | Edit `.gitignore` directly |
| `nexus.share.remote.add` | Use `git remote add <name> <url>` |
| `nexus.share.remote.remove` | Use `git remote remove <name>` |
| `nexus.share.push` | Use `git push <remote>` |
| `nexus.share.pull` | Use `git pull <remote>` |

The handler alias switch cases (`critical-path`, `blocking`, `orphans`) can remain for one release cycle then be removed. The registry entries should be removed immediately so they are not surfaced in capability discovery.

---

## References

- Task: T5562
- Epic: T5517
- Subtasks: T5563 (blocked/T5656), T5564, T5565, T5656
- Prior analysis: T5510
- Dependency: T5609 (synthesis)
- Source: `src/dispatch/domains/nexus.ts`, `src/dispatch/registry.ts` (lines 2471-2790)
- Bug blocking inventory: T5656 (projects-registry.json → nexus.db migration)
