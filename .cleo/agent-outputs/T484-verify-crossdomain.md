# T484 Cross-Domain Duplicate & Miscellaneous Command Verification

**Date**: 2026-04-10
**Scope**: All miscellaneous/standalone commands + 13 cross-domain duplicate pairs
**Method**: Live CLI execution of every command; outputs compared directly

---

## Part 1: Miscellaneous/Standalone Commands

| Command | Exit | Status | Description |
|---------|------|--------|-------------|
| `cleo checkpoint` | 0 | LIVE | Git checkpoint for `.cleo/.git` isolated repo |
| `cleo checkpoint status` | 0 | LIVE | Returns `{"checkpointed":1}` — functional |
| `cleo web` | 0 | LIVE | Manage CLEO Web UI server (start/stop/status/open) |
| `cleo docs` | 0 | LIVE | Documentation drift detection and gap validation |
| `cleo generate-changelog` | 0 | LIVE | Platform-specific changelog from CHANGELOG.md |
| `cleo schema` | 0 | LIVE | Introspect operation params/types/enums/gates |
| `cleo code` | 0 | LIVE | Code analysis via tree-sitter AST (outline/search/unfold) |
| `cleo cant` | 0 | LIVE | CANT DSL tooling (parse/validate/list/execute/migrate) |
| `cleo agent` | 0 | LIVE | Agent lifecycle — 24 subcommands, fully functional |
| `cleo agents` | 1 | **DEAD** | "Unknown command `agents`" — shows root help, exits 1 |
| `cleo migrate-claude-mem` | 0 | **GHOST** | Falls through to root help — no actual handler; exits 0 |
| `cleo backfill` | 0 | LIVE | Retroactively add acceptance criteria to existing tasks |
| `cleo bug` | 0 | LIVE | Create bug report task with severity mapping |

### Dead / Ghost Commands

**`cleo agents` (EXIT 1 — DEAD)**
- Behavior: Dumps full root help + "Unknown command `agents`" error
- Root cause: The plural `agents` was never registered as a CLI command. The singular `cleo agent` is the correct command (24 subcommands, all live).
- Recommendation: REMOVE — add a user-friendly error or an alias pointing to `cleo agent`

**`cleo migrate-claude-mem` (EXIT 0 — GHOST)**
- Behavior: Falls through to root help with exit 0 — no dedicated handler exists
- The command appears in no section of the help menu
- Recommendation: Either implement it or delete the registration. Currently it silently does nothing and misleads callers with exit 0.

---

## Part 2: Cross-Domain Duplicate Pair Analysis

### Pair 1: `cleo observe` vs `cleo memory observe`

| Attribute | `cleo observe` | `cleo memory observe` |
|-----------|---------------|----------------------|
| Operation | `memory.observe` | `memory.observe` |
| Exit | 0 | 0 |
| `--title` | yes (`-t`) | yes |
| `--type` | yes (8 types) | NO |
| `--agent` | NO | yes (Wave 8 mental models) |
| Classification | **ACCIDENTAL DUPLICATE with diverged options** |

Both route to the same underlying `memory.observe` operation. However, `cleo observe` exposes `--type` while `cleo memory observe` exposes `--agent`. Neither surface the full option set. This is an API fragmentation bug — two entry points to the same operation with inconsistent flags.

Recommendation: Consolidate into `cleo memory observe` with all options (`--type`, `--agent`, `--title`). Keep `cleo observe` as a registered alias that delegates to `cleo memory observe` with a deprecation notice.

---

### Pair 2: `cleo commands` vs `cleo ops`

| Attribute | `cleo commands` | `cleo ops` |
|-----------|----------------|-----------|
| Exit | 0 | 0 |
| Output | Deprecation notice + `admin.help` tier 0 data | `admin.help` tier 0 data (JSON) |
| Self-identified | "[DEPRECATED] cleo commands now delegates to admin.help. Use: cleo help (CLI)" | No deprecation |
| Tier filtering | `--tier` flag | `-t, --tier` flag |
| Category filtering | `-c, --category`, `-r, --relevance` | none |
| Classification | **INTENTIONAL ALIAS (commands) — deprecated in favor of ops, but diverged** |

`cleo commands` self-announces its deprecation. `cleo ops` is the preferred operational surface (MCP-era operation listing, tier-gated). `cleo commands` adds category/relevance filtering that `cleo ops` lacks.

Recommendation: Migrate the category/relevance filtering into `cleo ops --category / --relevance`. Then remove `cleo commands` entirely after one release cycle.

---

### Pair 3: `cleo phase list` vs `cleo phases list`

| Attribute | `cleo phase list` | `cleo phases list` |
|-----------|------------------|-------------------|
| Operation | `pipeline.phase.list` | `pipeline.phase.list` |
| Exit | 0 | 0 |
| Output | Identical JSON | Identical JSON |
| Parent command scope | `phase`: full lifecycle management (show/list/set/start/complete/advance/rename/delete) | `phases`: read-only view layer (list/show/stats) |
| Classification | **OVERLAPPING — different parent scope, same list subcommand** |

`cleo phase` is the mutating lifecycle command (CRUD + state transitions). `cleo phases` is a read-only stats/view surface. The `list` subcommand on both calls the same operation. The `show` subcommand exists on both but may differ in output. `phases stats` is unique to `cleo phases`.

Recommendation: This overlap is acceptable given the distinct parent scopes. Document explicitly: `cleo phase` = lifecycle mutations, `cleo phases` = read-only views/reporting. Verify `phase show` vs `phases show` produce consistent output.

---

### Pair 4: `cleo next` vs `cleo orchestrate next`

| Attribute | `cleo next` | `cleo orchestrate next` |
|-----------|------------|------------------------|
| Exit | 0 | 0 |
| Operation | `tasks.next` — global suggestion | `orchestrate next` — requires `<EPICID>` argument |
| Scope | Project-wide, priority + dependency scoring | Epic-scoped: finds next task to spawn within an epic |
| Classification | **OVERLAPPING — same concept, different scope** |

These are NOT the same operation. `cleo next` is a global task suggestion for solo workflows. `cleo orchestrate next <EPICID>` is an orchestrator-specific operation that finds the next subtask to dispatch within an epic. The naming overlap is a discoverability hazard.

Recommendation: No consolidation needed. Document the distinction clearly. Consider renaming `orchestrate next` to `orchestrate spawn-next` or `orchestrate ready` to reduce confusion.

---

### Pair 5: `cleo tags` vs `cleo labels list`

| Attribute | `cleo tags` | `cleo labels list` |
|-----------|------------|-------------------|
| Operation | `tasks.label.list` | `tasks.label.list` |
| Exit | 0 | 0 |
| Output | Identical JSON | Identical JSON |
| Self-identified | "Alias for labels command" | Primary command |
| Classification | **INTENTIONAL ALIAS — keep both** |

`cleo tags` is self-documented as an alias for `cleo labels`. The help menu shows `labels (tags)` confirming this is intentional. Both work correctly with identical output.

Recommendation: Keep. No action needed. The alias is correctly registered and documented.

---

### Pair 6: Export variations — `cleo export` vs `cleo export-tasks` vs `cleo snapshot export`

| Attribute | `cleo export` | `cleo export-tasks` | `cleo snapshot export` |
|-----------|--------------|--------------------|-----------------------|
| Exit | 0 | 0 | 0 |
| Purpose | Multi-format output (CSV/TSV/JSON/MD) | Portable `.cleo-export.json` for cross-project transfer with ID remapping | Full state snapshot for multi-contributor sharing |
| Filters | `--status`, `--parent`, `--phase`, `--exportFormat` | `--subtree`, `--filter`, `--includeDeps`, `--dryRun`, specific task IDs | `--output`, `--stdout` |
| ID remapping | No | Yes | No |
| Classification | **OVERLAPPING — distinct purposes, confusing surface area** |

Three export commands with genuinely different use cases but poor discoverability:
- `cleo export`: reporting/analysis output (human-readable formats)
- `cleo export-tasks`: migration package with dependency graph and ID remapping
- `cleo snapshot export`: full DB state dump for multi-contributor sync

The names `export` and `export-tasks` are nearly identical and will confuse users/agents. The help menu lists all three in the same "IMPORT / EXPORT" section without differentiating use cases.

Recommendation: No merge needed — they do different things. Add `--help` descriptions that explicitly call out when to use each. Consider renaming `export-tasks` to `transfer-tasks` or `package-tasks` to distinguish from generic `export`.

---

### Pair 7: Import variations — `cleo import` vs `cleo import-tasks` vs `cleo snapshot import`

| Attribute | `cleo import` | `cleo import-tasks` | `cleo snapshot import` |
|-----------|--------------|--------------------|-----------------------|
| Exit | 0 | 0 | 0 |
| Purpose | Import from export package | Import from `.cleo-export.json` with ID remapping | Import state snapshot into local DB |
| Options | `--onDuplicate`, `--addLabel`, `--parent`, `--phase` | `--onConflict`, `--noProvenance`, `--resetStatus`, `--onMissingDep`, `--force` | `--dryRun` only |
| Classification | **OVERLAPPING — same naming confusion as export trio** |

Same structural issue as the export trio. `cleo import` and `cleo import-tasks` appear to be counterparts to `cleo export` and `cleo export-tasks` respectively. However, the option names diverge (`--onDuplicate` vs `--onConflict`), suggesting separate implementations rather than a unified import system.

Recommendation: Verify whether `cleo import` consumes the same format as `cleo export-tasks` produces, or whether there is a format mismatch. The `--onDuplicate` vs `--onConflict` divergence suggests these may have been implemented independently. Align option naming. Same renaming suggestion applies: `import-tasks` -> `transfer-import` or `package-import`.

---

### Pair 8: `cleo stats` vs `cleo admin stats`

| Attribute | `cleo stats` | `cleo admin stats` |
|-----------|-------------|-------------------|
| Operation | `admin.stats` | `admin.stats` |
| Exit | 0 | 0 |
| Output | Identical JSON | Identical JSON |
| Options | `--period` (days or named: today/week/month/quarter/year), `--verbose` | `--period` (days only) |
| Subcommands | `compliance` (WF-001 through WF-005 dashboard) | none |
| Classification | **ACCIDENTAL DUPLICATE with diverged options** |

Both call `admin.stats`. `cleo stats` is richer: it supports named period values (today/week/month/quarter/year vs. days-only), has `--verbose`, and includes a `compliance` subcommand. `cleo admin stats` is a stripped-down entry point.

Recommendation: `cleo admin stats` should delegate to `cleo stats` or be removed. The top-level `cleo stats` is the canonical interface. At minimum, align `admin stats --period` to accept the same named values.

---

### Pair 9: `cleo briefing` vs `cleo session handoff`

| Attribute | `cleo briefing` | `cleo session handoff` |
|-----------|----------------|----------------------|
| Operation | `session.briefing.show` | `session.handoff.show` |
| Exit | 0 | 0 |
| Output | Composite: last session + current task + next tasks + bugs + blockers + epics + memory context | Handoff data only: tasks completed, decisions, next suggested, note |
| Classification | **OVERLAPPING — briefing is a superset of handoff** |

These are NOT duplicates. `cleo briefing` is the session-start composite view (pulls from 6+ data sources). `cleo session handoff` is the raw handoff record from the last ended session. `briefing` includes the handoff data embedded within its response plus much more context.

Recommendation: No action needed. The distinction is correct: `session handoff` = raw last-session record; `briefing` = agent-ready session start context. These should be documented together as a pair.

---

### Pair 10: `cleo agents` (dead) vs `cleo agent`

| Attribute | `cleo agents` | `cleo agent` |
|-----------|--------------|-------------|
| Exit | 1 | 0 |
| Output | "Unknown command `agents`" + root help | Full agent domain — 24 subcommands |
| Classification | **DEAD — `agents` is not registered** |

`cleo agents` is dead (EXIT 1, unknown command). `cleo agent` is the canonical live command.

Recommendation: REMOVE — do not attempt to alias `agents` to `agent` without validating that no scripts depend on the plural form. Add an error message: "Did you mean `cleo agent`?"

---

### Pair 11: `cleo --version` vs `cleo version` vs `cleo admin version`

| Attribute | `cleo --version` | `cleo version` | `cleo admin version` |
|-----------|-----------------|---------------|---------------------|
| Exit | 0 | 0 | 0 |
| Output | `2026.4.25` (raw string) | `{"success":true,"data":{"version":"2026.4.25"},...}` | `{"success":true,"data":{"version":"2026.4.23"},...}` |
| **Version reported** | **2026.4.25** | **2026.4.25** | **2026.4.23** |
| Classification | **BUG: `admin version` reports stale version** |

`cleo --version` and `cleo version` agree at `2026.4.25`. `cleo admin version` reports `2026.4.23` — two releases behind. This is an active bug: `admin.version` reads from a different source (likely a hardcoded constant or a stale config value) than the binary's own version string.

Recommendation: **CRITICAL BUG FIX** — `admin version` must read from the same source as `cleo --version`. The discrepancy will cause agents using `admin version` to report incorrect build metadata. File as a bug task immediately.

---

### Pair 12: `cleo doctor` vs `cleo admin health`

| Attribute | `cleo doctor` | `cleo admin health` |
|-----------|--------------|-------------------|
| Operation | `admin.health` | `admin.health` |
| Exit | 0 | 0 |
| Output | Identical JSON | Identical JSON |
| Options | `--detailed`, `--comprehensive`, `--full`, `--fix`, `--coherence`, `--hooks` | `--detailed` only |
| Classification | **ACCIDENTAL DUPLICATE with diverged options** |

Both route to `admin.health`. `cleo doctor` is the richer entry point with 6 flags; `cleo admin health` exposes only `--detailed`. The `--full`, `--fix`, `--coherence`, and `--hooks` flags on `doctor` are not surfaced through `admin health`.

Recommendation: `cleo admin health` should delegate to `cleo doctor` (or become a thin alias). The canonical interface is `cleo doctor`. Align `admin health` to accept the same flags or redirect users to `cleo doctor --help`.

---

### Pair 13: `cleo tree` vs `cleo deps list`

| Attribute | `cleo tree` | `cleo deps list` |
|-----------|------------|-----------------|
| Exit | 0 | 0 (shows deps help, not list) |
| Purpose | Hierarchical parent-child tree of all tasks | Dependency analysis — separate concept |
| Output | Full task hierarchy JSON | `deps` has no `list` subcommand; shows usage: overview/show/waves/critical-path/impact/cycles |
| Classification | **NOT DUPLICATES — distinct concepts** |

`cleo tree` shows the parent-child task hierarchy. `cleo deps` manages inter-task dependencies (blocking relationships). These are orthogonal. `cleo deps list` does not exist as a subcommand — calling it shows the `deps` usage help with exit 0.

Recommendation: No merge needed. Note that `deps list` silently falls through to help (exit 0) — callers expecting a list will get help output, which could confuse agents. Consider exit 1 for unknown subcommands.

---

## Part 3: Master Duplicate/Alias Classification Table

| Pair | Command A | Command B | Classification | Action |
|------|-----------|-----------|----------------|--------|
| 1 | `cleo observe` | `cleo memory observe` | ACCIDENTAL DUPLICATE (diverged options) | Consolidate into `memory observe`; alias `observe` |
| 2 | `cleo commands` | `cleo ops` | INTENTIONAL ALIAS (deprecated) | Remove `commands` after migrating category/relevance filters to `ops` |
| 3 | `cleo phase list` | `cleo phases list` | OVERLAPPING (different parent scope) | Document scope distinction; verify `phase show` vs `phases show` |
| 4 | `cleo next` | `cleo orchestrate next` | OVERLAPPING (different scope) | Document; consider rename of `orchestrate next` |
| 5 | `cleo tags` | `cleo labels list` | INTENTIONAL ALIAS | Keep both — correctly documented |
| 6 | `cleo export` | `cleo export-tasks` | OVERLAPPING (distinct purposes) | Rename `export-tasks` to reduce confusion |
| 6b | `cleo export` | `cleo snapshot export` | OVERLAPPING (distinct purposes) | Document when to use each |
| 7 | `cleo import` | `cleo import-tasks` | OVERLAPPING (option name divergence = possible separate implementations) | Audit format compatibility; align option names |
| 7b | `cleo import` | `cleo snapshot import` | OVERLAPPING (distinct purposes) | Document |
| 8 | `cleo stats` | `cleo admin stats` | ACCIDENTAL DUPLICATE (stripped-down admin variant) | Remove `admin stats`; defer to `cleo stats` |
| 9 | `cleo briefing` | `cleo session handoff` | OVERLAPPING (briefing is superset) | Keep both; document as a pair |
| 10 | `cleo agents` | `cleo agent` | DEAD | Remove or add friendly error for `agents` |
| 11a | `cleo version` | `cleo admin version` | BUG (version mismatch: 2026.4.25 vs 2026.4.23) | Fix `admin version` source — critical bug |
| 11b | `cleo --version` | `cleo version` | INTENTIONAL ALIAS | Keep both — raw string vs JSON envelope |
| 12 | `cleo doctor` | `cleo admin health` | ACCIDENTAL DUPLICATE (stripped-down admin variant) | Remove or alias `admin health` to `doctor` |
| 13 | `cleo tree` | `cleo deps list` | NOT DUPLICATES | No action; note `deps list` silently falls to help (exit 0) |

---

## Part 4: Priority Findings

### CRITICAL — Fix Immediately

1. **`admin version` version mismatch bug** — reports `2026.4.23` while binary is `2026.4.25`. Any agent or tooling using `cleo admin version` gets wrong build metadata. Root cause: likely reads from a stale constant rather than the binary version.

### HIGH — Clean Up

2. **`cleo agents` is dead (EXIT 1)** — unknown command, shows root help. Remove the reference from any documentation. Add a user-friendly "did you mean `cleo agent`?" error or register an alias.

3. **`cleo migrate-claude-mem` is a ghost (EXIT 0)** — no handler, falls to root help, exits cleanly. Misleads callers into thinking it succeeded. Either implement it or delete the registration.

4. **`observe` vs `memory observe` option divergence** — `--type` (8 observation types) is only on `cleo observe`; `--agent` (Wave 8 mental models) is only on `cleo memory observe`. Same underlying operation, split option surface.

5. **`cleo stats` vs `cleo admin stats`** — `admin stats --period` accepts days-integer only; `cleo stats --period` accepts named values (today/week/month/quarter/year). Same operation ID, inconsistent interface.

6. **`cleo doctor` vs `cleo admin health`** — `admin health` exposes only `--detailed`; `doctor` adds `--comprehensive`, `--full`, `--fix`, `--coherence`, `--hooks`. Agents hitting `admin health` miss the richer diagnostics.

### MEDIUM — Document or Rename

7. **`cleo commands` self-deprecated** — emits a deprecation notice on every invocation. Remove after one release cycle; first migrate `--category` and `--relevance` filtering to `cleo ops`.

8. **`export` / `export-tasks` / `snapshot export` naming** — three exports in the same help section with overlapping names. Rename `export-tasks` to `transfer-tasks` or `package-tasks`.

9. **`import` / `import-tasks` option name divergence** — `--onDuplicate` vs `--onConflict` suggests independent implementations. Audit format compatibility between the two command chains.

10. **`deps list` falls to help (exit 0)** — `cleo deps` has no `list` subcommand. Unknown subcommands should exit 1 for clean agent error handling.

---

## Part 5: Verified-Live Miscellaneous Commands (No Issues)

The following standalone commands are functional, clearly scoped, and have no duplicate concerns:

- `cleo checkpoint` / `cleo checkpoint status` — isolated `.cleo/.git` operations
- `cleo web` — Web UI server management
- `cleo docs` — Documentation drift/gap detection
- `cleo generate-changelog` — Platform changelog generation
- `cleo schema` — Operation introspection
- `cleo code` — Tree-sitter AST analysis
- `cleo cant` — CANT DSL tooling
- `cleo agent` — Agent lifecycle (24 subcommands, all live)
- `cleo backfill` — Retroactive acceptance criteria
- `cleo bug` — Bug report task creation
- `cleo brain` — Brain maintenance (distinct from `memory` — optimization only)
- `cleo briefing` vs `cleo session handoff` — correctly distinct (superset vs raw)
- `cleo tags` alias for `cleo labels` — correctly registered and documented
