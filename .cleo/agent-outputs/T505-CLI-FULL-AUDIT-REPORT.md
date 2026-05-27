# CLEO CLI Full Audit Report

**Date**: 2026-04-11
**Session**: ses_20260411021235_a9f15b
**Method**: 12 parallel agents, each testing every command in their domain live
**Coverage**: ~250 commands/subcommands across 12 domains
**Version**: cleo v2026.4.29

---

## Executive Summary

| Metric | Count |
|--------|-------|
| Total commands tested | ~250 |
| PASS | ~180 |
| PARTIAL (works with caveats) | ~35 |
| FAIL (broken) | ~15 |
| UNWIRED (dead code) | 2 |
| Bugs found | 55+ |
| P0/HIGH severity | 12 |
| Confirmed true duplicates | 8 |
| Confirmed aliases (intentional) | 7 |
| Distinct but confusingly named | 10 |

---

## P0 / HIGH Severity Bugs

These are broken right now and affect agent workflows:

| # | Domain | Command | Bug | Impact |
|---|--------|---------|-----|--------|
| 1 | Task CRUD | `cleo bug` | Creates `type:"task"` instead of `type:"bug"` | Core invariant broken — bug tracking useless |
| 2 | Memory | `cleo observe` (top-level) | Dead registration — never wired to entrypoint | Protocol docs tell agents to use this; it shows global help |
| 3 | Research | `cleo research links <taskId>` | Calls `manifest.find` (wants query string) instead of `manifest.list` (wants taskId) | EXIT 2 always — completely broken |
| 4 | Research | `cleo research link <researchId> <taskId>` | Calls `manifest.append` (upsert), overwrites entry with stub | Destroys existing research data on "link" |
| 5 | Lifecycle | All `cleo lifecycle` subcommands | `contribution` listed as valid stage in all help text but engine rejects at runtime | Doc-to-implementation mismatch across entire domain |
| 6 | Tooling | `cleo restore backup` | Only accepts `tasks.db` and `config.json`; rejects `brain.db` and `project-info.json` | 2 of 4 backup files permanently unrestorable via CLI |
| 7 | Sessions | `cleo session show --include debrief` | Returns `"data": null` silently | Debrief inclusion is non-functional |
| 8 | Sessions | `cleo context check` | Exits non-zero (54) when state file is stale at 6% usage | Conflates staleness with threshold-exceeded; breaks exit-code gating |
| 9 | System | `cleo self-update --status` | Performs live install despite flag implying read-only | Dangerous — altered system state during audit |
| 10 | System | `cleo admin context-inject` | Always fails — search paths don't match project structure | Completely non-functional |
| 11 | Task Org | `cleo labels show ""` | Empty string bypasses filter, returns ALL tasks | Data leak / agent confusion |
| 12 | Import/Export | `cleo nexus reconcile` | Identity conflict — project-info UUID vs nexus UUID mismatch | Cannot reconcile project state |

---

## P1 / MEDIUM Severity Bugs

| # | Domain | Command | Bug |
|---|--------|---------|-----|
| 1 | Task CRUD | `cleo claim`/`cleo unclaim` | Returns E_INTERNAL (1) for not-found instead of E_NOT_FOUND (4) |
| 2 | Task CRUD | `cleo add-batch` | Silently drops `parentId` from per-task JSON objects |
| 3 | Task CRUD | `cleo complete --force` | Does not bypass verification gates despite implying it |
| 4 | Research | `cleo research update` | Hardcodes `linked_tasks: []`, silently stripping links |
| 5 | Research | `cleo research manifest --agent-type` | Filter silently ignored (key mismatch) |
| 6 | Lifecycle | `cleo phase show` | Double envelope wraps inner `success:false` in outer `success:true` — exit 0 on failure |
| 7 | Lifecycle | `cleo lifecycle guidance` | Fails with E_INVALID_INPUT when epic has no active stage; help implies auto-resolution |
| 8 | Lifecycle | `cleo release rollback` | Accepts `prepared` releases (never shipped); should require `shipped` |
| 9 | Lifecycle | `cleo release ship --dryRun` | Step 0 writes a release record before dry-run guard kicks in |
| 10 | Analysis | `cleo testing run` | Exits 0 even when vitest fails; real exit code buried in `data.exitCode` |
| 11 | Analysis | `cleo check task <id>` | Always triggers "duplicate ID" violation — doesn't exclude self from check |
| 12 | Sessions | `cleo session status` | Returns ALL historical session notes, not just current session's |
| 13 | System | `cleo config get` | Fails on default-only keys; inconsistent with `config list` which merges defaults |
| 14 | System | `cleo upgrade --status` vs `--dryRun` | Identical output — one is redundant |
| 15 | Memory | `cleo memory decision-find` | Multi-word phrase search returns 0 results (FTS5 tokenization bug) |
| 16 | Memory | `cleo brain maintenance --json` | Returns bare JSON, not ADR-039 envelope |
| 17 | Memory | `cleo reason impact <taskId>` | Returns E_NOT_INITIALIZED (3) instead of E_NOT_FOUND (4) |
| 18 | Task Org | `cleo tags show/list/stats` | Subcommands not proxied — always returns label list |
| 19 | Task Org | `cleo reorder` | Help says "zero-based" but positions are 1-based |
| 20 | Task Org | `cleo blockers --analyze` | Flag does nothing — output identical to bare command |
| 21 | Task Org | `cleo deps impact` | Not implemented — calls `deps show` with no actual impact analysis |
| 22 | Code/Docs | `cleo detect-drift` | 4 bugs: wrong schema path, regex for exit codes fails, wrong template path, Drizzle/CREATE TABLE mismatch |
| 23 | Code/Docs | `cleo docs sync --quick` | Dead flag — registered but never read |
| 24 | Code/Docs | `cleo docs gap-check --epic` vs `--task` | Functionally identical — both become `filterId` substring match |
| 25 | Import/Export | `cleo nexus transfer-preview` | Dry-run requires write permission — should be read-only |
| 26 | Import/Export | `cleo remote status` | Fabricates "Up to date" when no remote configured |
| 27 | Agent | `cleo agent health --id` | Searches daemon runtime only, not credential registry; help implies any registered ID |

---

## Missing Features (Gaps)

| # | Domain | Gap | Impact |
|---|--------|-----|--------|
| 1 | Task Org | `cleo relates remove` doesn't exist | Relationships can only be added, never deleted |
| 2 | Task Org | `cleo blockers` ignores `relates.type=blocks` | Only reads `depends` field; `relates add --type blocks` invisible to blocker analysis |
| 3 | Analysis | 5 compliance subcommands are stubs (`trend`, `audit`, `skills`, `value`, `violations`) | All route to `compliance.summary` — no differentiated logic |
| 4 | Analysis | `cleo archive-stats` `byReason` always shows `{unknown: 421}` | Tasks never tagged with archive reason |
| 5 | Analysis | `cleo history work` claims time-tracked but returns only timestamps | No duration data |
| 6 | Code/Docs | `cleo code outline/search/unfold` require tree-sitter | No help text warning about dependency; exits 7 |
| 7 | Code/Docs | `cleo map --focus architecture` | Always returns empty `{layers:[], entryPoints:[], patterns:[]}` |

---

## Confirmed TRUE Duplicates (Remove One)

These are byte-for-byte or functionally identical — one should be removed:

| # | Command A | Command B | Evidence |
|---|-----------|-----------|----------|
| 1 | `cleo deps waves` | `cleo orchestrate waves` | Same internal function, identical output (confirmed by 3 agents) |
| 2 | `cleo stats` | `cleo admin stats` | Same backend operation (`admin.stats`) |
| 3 | `cleo doctor` | `cleo admin health` | Same operation |
| 4 | `cleo doctor --full` | `cleo admin smoke` | Byte-for-byte identical output |
| 5 | `cleo testing validate <id>` | `cleo check protocol testing --taskId <id>` | Same dispatch path, same output |
| 6 | `cleo nexus resolve` | `cleo nexus query` | Identical help text, identical handler |
| 7 | `cleo reason impact <taskId>` | `cleo deps impact <taskId>` | Both call `tasks.depends action=impact` |
| 8 | `cleo version` | `cleo admin version` | Identical output (acceptable shortcut) |

### Recommendation
**Keep**: `deps waves`, `stats`, `doctor`, `testing validate`, `nexus resolve`, `reason impact`, `version`
**Remove**: `orchestrate waves`, `admin stats`, `admin health`, `admin smoke`, `check protocol testing`, `nexus query`, `deps impact`, `admin version`

---

## Confirmed Intentional Aliases (Keep, but fix help leaks)

| Alias | Canonical | Status |
|-------|-----------|--------|
| `cleo ls` | `cleo list` | Clean |
| `cleo done` | `cleo complete` | Clean |
| `cleo rm` | `cleo delete` | Clean |
| `cleo tags` | `cleo labels` | Broken — subcommands don't proxy |
| `cleo pipeline` | `cleo phase` | Clean — byte-for-byte alias |
| `cleo session stop` | `cleo session end` | Leaks `(session end)` in its own help |
| `cleo backup create` | `cleo backup add` | Clean — documented |
| `cleo skills enable` | `cleo skills install` | Clean — documented |
| `cleo skills disable` | `cleo skills uninstall` | Clean — documented |
| `cleo sticky jot` | `cleo sticky add` | Clean |
| `cleo sticky ls` | `cleo sticky list` | Clean |

---

## Commands That Should Be Relocated

| Current Location | Recommended Location | Reason |
|-----------------|---------------------|--------|
| `cleo observe` (top-level, dead) | Wire to `cleo memory observe` or delete file | Dead code; protocol docs reference it |
| `cleo brain maintenance` | `cleo memory maintenance` | `brain` has 1 subcommand; it's memory housekeeping |
| `cleo refresh-memory` (top-level) | `cleo memory refresh` | Should be under memory domain |
| `cleo detect-drift` (top-level) | Keep but differentiate from `docs sync` in help | Names are confusing but scopes differ |

---

## Cross-Domain Overlap Analysis

### Distinct Despite Confusing Names (Keep Both)

| Pair | Why Distinct |
|------|-------------|
| `cleo phase start/complete` vs `cleo lifecycle start/complete` | Phase = project milestone, lifecycle = per-epic RCASD stage |
| `cleo briefing` vs `cleo session handoff` | Briefing is superset (handoff + tasks + bugs + memory) |
| `cleo dash` vs `cleo plan` | Dash = project health snapshot, plan = prioritized work queue |
| `cleo safestop` vs `cleo session end` | Safestop = workflow (commit + handoff + end) |
| `cleo context` vs `cleo session context-drift` | Context = token budget, context-drift = task scope fidelity |
| `cleo memory decision-store` vs `cleo session record-decision` | Different DBs (brain.db permanent vs tasks.db session audit) |
| `cleo memory timeline` vs `cleo reason timeline` | Brain observation window vs task audit log |
| `cleo sticky` vs `cleo memory` | Ephemeral scratchpad vs permanent knowledge; `convert` bridges them |
| `cleo agent send` vs `cleo orchestrate conduit-send` | Different transports (cloud vs local queue) |
| `cleo export` vs `cleo export-tasks` vs `cleo snapshot export` vs `cleo backup export` | Four genuinely different formats/purposes |

### Overlapping But Needs Clarification in Help Text

| Pair | Issue |
|------|-------|
| `cleo agent status` vs `cleo agent health` | Registry vs daemon runtime — help text doesn't distinguish |
| `cleo agent detach` vs `cleo agent remove` (default) | `remove` default is exact alias for `detach` — confusing |
| `cleo agent spawn` vs `cleo orchestrate spawn` | Entity creation vs context preparation — naming collision |
| `cleo provider list/detect` vs `cleo adapter list/detect` | Installed vs runtime-loaded — naming is confusing |
| `cleo token` vs `cleo otel` | Different data sources — help text doesn't explain which to use when |

---

## Help Text Quality Assessment

### Adequate for Zero-Context Agents
Most commands have sufficient help. The best: `cleo add`, `cleo find`, `cleo briefing`, `cleo plan`, `cleo safestop`, `cleo session find`, `cleo agent create`.

### Too Terse / Inadequate
| Command | Issue |
|---------|-------|
| `cleo update` | One-word help description, no examples or preconditions |
| `cleo start` | Doesn't mention it does NOT transition task status |
| `cleo tree` | `[OPTIONS]` in USAGE but no options listed |
| `cleo promote` | `[OPTIONS]` in USAGE but no options listed |
| `cleo tags` | Shows "Alias for labels command" with no subcommands |
| `cleo context status` | `stale: true` meaning undocumented |
| `cleo session status` | No options documented |
| `cleo session gc` | No default maxAge documented; no --dry-run on destructive op |
| `cleo detect-drift` | Near-empty help body — no mention of what checks run |
| `cleo docs sync` | Description "scripts and docs index" is opaque |
| `cleo map --focus` | Doesn't say which focus values produce useful output |
| `cleo deps impact` | Claims impact analysis but just calls `deps show` |
| `cleo agent health --id` | Implies any registered agent ID works; only searches daemon |

---

## Wrong Exit Code Patterns

Multiple commands return wrong exit codes for "not found" scenarios:

| Command | Returns | Should Return |
|---------|---------|---------------|
| `cleo claim <missing>` | E_INTERNAL (1) | E_NOT_FOUND (4) |
| `cleo unclaim <missing>` | E_INTERNAL (1) | E_NOT_FOUND (4) |
| `cleo reason impact <missing>` | E_NOT_INITIALIZED (3) | E_NOT_FOUND (4) |
| `cleo promote <missing>` | E_NOT_INITIALIZED (3) | E_NOT_FOUND (4) |
| `cleo reparent <missing>` | E_NOT_INITIALIZED (3) | E_NOT_FOUND (4) |
| `cleo complexity <missing>` | E_NOT_INITIALIZED (3) | E_NOT_FOUND (4) |
| `cleo nexus resolve <missing>` | E_INTERNAL (1) | E_NOT_FOUND (4) |

---

## Envelope Violations (ADR-039)

| Command | Issue |
|---------|-------|
| `cleo brain maintenance --json` | Returns bare `{"decay":...}` instead of `{success, data, meta}` |
| `cleo phase show` (on failure) | Double-wraps: inner `success:false` inside outer `success:true` |

---

## Individual Domain Reports

All 12 detailed reports are in `.cleo/rcasd/`:
- `audit-task-crud.md` — 17 commands, 10 PASS / 4 PARTIAL / 1 FAIL
- `audit-task-org.md` — 26 entries, 18 PASS / 6 PARTIAL / 1 FAIL / 1 UNWIRED
- `audit-sessions.md` — 21 entries, 8 bugs
- `audit-memory.md` — 29 entries, 23 PASS / 4 FAIL / 1 DEAD
- `audit-lifecycle.md` — 25 entries, 6 bugs
- `audit-analysis.md` — 26 entries, exact duplicates + 5 compliance stubs
- `audit-code-docs.md` — 7 entries, tree-sitter dependency + 4 detect-drift bugs
- `audit-research-orch.md` — 34 entries, 2 P0 research bugs
- `audit-import-export.md` — 36 entries, 7 bugs
- `audit-agent.md` — 26 entries, 3 bugs + overlap analysis
- `audit-system.md` — 29 entries, 8 bugs + dangerous self-update
- `audit-tooling.md` — 56 entries, HIGH restore gap
