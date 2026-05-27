# CLI Audit: Task Organization Domain

**Date**: 2026-04-11
**Auditor**: Claude (Sonnet 4.6)
**Domain**: Task Organization (archive, labels/tags, promote, relates, reorder, reparent, deps, tree, blockers, complexity)

---

## Summary Table

| Command | Status | Help Quality | Notes |
|---------|--------|--------------|-------|
| `cleo archive` | PASS | Good | dryRun, --tasks, --before, --noCancelled all work |
| `cleo labels list` | PASS | Adequate | Returns 77 labels with counts and status breakdown |
| `cleo labels show` | PARTIAL | Adequate | Works for valid labels; empty-string input BUG |
| `cleo labels stats` | PASS | Adequate | Same output as list — may be redundant |
| `cleo tags` (bare) | PASS | POOR | Alias works bare; help shows no subcommands |
| `cleo tags show/list/stats` | FAIL | POOR | Subcommands not proxied — all return label list |
| `cleo promote` | PARTIAL | POOR | Works functionally; no error on root-level task; [OPTIONS] in USAGE with no options listed |
| `cleo relates suggest` | PASS | Adequate | Works; threshold default 50 undocumented |
| `cleo relates add` | PASS | Good | All 7 types work; invalid type rejected correctly |
| `cleo relates discover` | PARTIAL | POOR | Duplicate of suggest at threshold 0; no documented distinction |
| `cleo relates list` | PASS | Adequate | Works correctly |
| `cleo relates remove` | UNWIRED | N/A | Does not exist — no way to remove relationships |
| `cleo reorder` (no flags) | PASS | Adequate | Correctly errors when no position flag given |
| `cleo reorder --top` | PARTIAL | Adequate | Position is 1-indexed (returns 1) despite help saying 0-based |
| `cleo reorder --bottom` | PASS | Adequate | Works correctly |
| `cleo reorder --position N` | PASS | Adequate | Works; negative values accepted silently |
| `cleo reparent` | PASS | Good | --to works; --to "" makes root; invalid parent gives E_NOT_INITIALIZED (wrong code) |
| `cleo deps overview` | PASS | Adequate | Returns all task dep health stats |
| `cleo deps show` | PASS | Good | --tree flag adds upstreamTree field |
| `cleo deps waves` | PASS | DUPLICATE | Identical to `orchestrate waves` (same operation: orchestrate.waves) |
| `cleo deps critical-path` | PASS | Adequate | Returns path array |
| `cleo deps impact` | PARTIAL | POOR | Returns `tasks.depends` operation — indistinguishable from `deps show`; also duplicates `reason impact` |
| `cleo deps cycles` | PASS | Adequate | Returns hasCycles + cycles array |
| `cleo tree` | PASS | POOR | Works; [OPTIONS] in USAGE but no options listed; undocumented options absent |
| `cleo blockers` | PASS | Adequate | Works; no blocked tasks in current dataset |
| `cleo blockers --analyze` | PARTIAL | POOR | --analyze flag exists but output is identical to bare blockers |
| `cleo complexity estimate` | PASS | Good | Scores on 5 factors; correct on both task and epic |

**Totals**: 18 PASS / 6 PARTIAL / 1 FAIL / 1 UNWIRED | 5 DUPLICATE/OVERLAP issues

---

## Per-Command Details

### 1. `cleo archive`

**Status**: PASS

**Help Quality**: Good. All 4 options documented with clear descriptions.

**Behavior**:
- `--dryRun` correctly previews without modifying (exit 0)
- `--tasks T494,T497` correctly filters to specific IDs
- `--before 2025-01-01` correctly returns 0 (all done tasks are recent)
- `--noCancelled` works; returned same 12-task count as bare (no cancelled tasks in dataset, so indistinguishable from base)
- Bare `cleo archive --tasks T494` (no dryRun) actually archived T494 — irreversible with status `archived`
- Archiving already-archived tasks returns archivedCount:0 — idempotent, correct

**Issues**:
- None functional. Minor: `--noCancelled` cannot be tested as having effect because the dataset has no cancelled tasks separate from done.

---

### 2. `cleo labels` / `cleo tags`

**Status**: PARTIAL (labels) / FAIL (tags subcommands)

**Help Quality**:
- `cleo labels` help is adequate — lists 3 subcommands clearly
- `cleo tags` help is POOR — shows "Alias for labels command" with no subcommands listed; agents cannot discover that tags has list/show/stats

**Behavior**:

`cleo labels list`: PASS — returns 77 labels with per-status breakdowns. Clean JSON.

`cleo labels show <label>`: PASS for valid labels (returns filtered task list). FAIL on empty string.

**BUG — labels show "" returns all tasks**:
```
cleo labels show ""
→ success:true, tasks:10 (paginated), total:79, filtered:79
```
Empty string label bypasses filter validation and matches all tasks. Should return error or 0 results.

`cleo labels stats`: PASS — returns same payload structure as labels list. Functionally redundant (same operation and data). No additional "stats" information beyond counts.

**Tags alias issues**:
- `cleo tags` bare: PASS — calls `tasks.label.list`, returns full label list correctly
- `cleo tags list`: PASS — works as alias
- `cleo tags show cli`: FAIL — returns the labels list (not tasks filtered by label). The alias does not forward the subcommand argument correctly; it calls the bare labels endpoint instead.
- `cleo tags stats`: appears to return label list, not stats

**Cross-domain**: `cleo labels` and `cleo tags` are documented as separate commands, but tags is only a partial alias. Zero-context agents will try `tags show` and get wrong results.

---

### 3. `cleo promote <id>`

**Status**: PARTIAL

**Help Quality**: POOR — USAGE line shows `[OPTIONS]` but no OPTIONS section is rendered. Help is incomplete for agents.

**Behavior**:
- `cleo promote T501` (T501 had parent T091): PASS — correctly set parentId to null, returns `reparented:true, newParent:null`
- `cleo promote T091` (already root-level): Returns `success:true, reparented:true, newParent:null` — no warning or error that task was already at root. Silent no-op is acceptable but misleading.
- `cleo promote T9999` (nonexistent): Returns error with code `E_NOT_INITIALIZED (3)` — should be `E_NOT_FOUND (4)`.

**Issues**:
- Error code mismatch: task-not-found returns E_NOT_INITIALIZED instead of E_NOT_FOUND
- No idempotency indication when promoting a root-level task (returns success regardless)
- Help text says [OPTIONS] but there are no options

---

### 4. `cleo relates`

**Status**: PASS (add/list), PARTIAL (suggest/discover), UNWIRED (remove)

**Help Quality**: Good for `add` (lists all 7 valid types). Adequate for `list`. POOR for `suggest` and `discover` — the distinction between them is not explained in help text.

**Behavior**:

`cleo relates add FROM TO TYPE REASON`: PASS
- All positional args required and validated
- Invalid type gives clear error with valid types listed (exit 1)
- Adding `blocks` relationship works correctly

`cleo relates list <taskId>`: PASS — returns relations array with type and reason

`cleo relates suggest <taskId>`: PASS
- Default threshold 50 is undocumented in help (shown as `--threshold="50"` which is visible)
- Returns empty array for tasks with no shared attributes above threshold
- At threshold 30, correctly finds T469 related to T465 via shared labels

`cleo relates discover <taskId>`: PARTIAL
- Returns same JSON shape as `suggest` via same `cli.output` operation
- Functionally equivalent to `suggest --threshold 0` (no minimum score filter)
- Help text "various methods" implies richer discovery but behavior is a lower-threshold suggest
- No documented distinction from suggest makes this confusing

**Missing feature**: No `relates remove` or `relates delete` subcommand. Once a relationship is added it cannot be removed via CLI. This is a functional gap.

**Overlap**: `relates add` with type `blocks` creates a semantic relationship, but `cleo blockers` only reads from the `depends` field, not from relates. The two blocking systems (relates.blocks vs depends) are completely separate and not cross-linked.

---

### 5. `cleo reorder <id>`

**Status**: PARTIAL

**Help Quality**: Adequate — 3 options documented clearly.

**Behavior**:
- `cleo reorder T501` (no flags): Correctly errors "Must specify --position, --top, or --bottom" (exit 2)
- `cleo reorder T501 --bottom`: PASS — returns newPosition:80, totalSiblings:80 when T501 was unparented (global scope). After reparenting to T091, returns newPosition:1, totalSiblings:1 (correct)
- `cleo reorder T501 --top`: PARTIAL — returns newPosition:1 despite help saying "zero-based position". When T501 is sole child of T091, position 1 is effectively correct but contradicts the zero-based documentation.
- `cleo reorder T501 --position 0`: Returns newPosition:1 — position 0 resolves to 1. Zero-based positions appear to be stored/returned as 1-based.
- `cleo reorder T501 --position -1`: Accepted without error, returns newPosition:1 — negative positions should be rejected.
- `cleo reorder T501 --top --position 2`: Accepted — --top wins silently; no conflict validation.

**Early test showed database lock**: First `--top` call returned `E_NOT_INITIALIZED: database is locked` (exit 3), retry 10 seconds later succeeded. Transient WAL contention.

**Issues**:
- Help says "zero-based position" but `--top` returns position 1, and `--position 0` maps to position 1 in output. Position semantics are inconsistent.
- Negative `--position` values accepted without validation.
- Conflicting flags (--top + --position) silently resolve without error.
- "database is locked" under concurrent access — not retried internally.

---

### 6. `cleo reparent <id> --to <parentId>`

**Status**: PASS

**Help Quality**: Good — `--to` marked as required, valid values documented (task ID or "" for root).

**Behavior**:
- `cleo reparent T501 --to T091`: PASS — moves T501 under T091, returns oldParent/newParent
- `cleo reparent T501 --to ""`: PASS — makes T501 root-level (newParent:null)
- `cleo reparent T501 --to T9999`: Error "Parent task 'T9999' not found" — correct, but error code is E_NOT_INITIALIZED (3) instead of E_NOT_FOUND (4)
- Warn message "Detected stale migration journal entries" appears consistently on each invocation — noisy but non-blocking

**Issues**:
- Wrong error code (E_NOT_INITIALIZED vs E_NOT_FOUND) for missing parent
- Stale migration journal WARN on every reparent call — cosmetic noise

---

### 7. `cleo deps`

**Status**: PASS (overview, show, critical-path, cycles), PARTIAL (impact), DUPLICATE (waves)

**Help Quality**: Good top-level (all 6 subcommands listed). Subcommand help adequate.

**Behavior**:

`cleo deps overview`: PASS — returns tasksWithDeps:0, blockedTasks:[], readyTasks:[all 65 pending]. Works correctly.

`cleo deps show <taskId>`: PASS — returns upstream/downstream arrays (empty in current dataset). `--tree` flag adds `upstreamTree` field.

`cleo deps waves <epicId>`: PASS functionally — **DUPLICATE of `orchestrate waves`**. Both call `operation: orchestrate.waves`. Having the same command in two domains (deps and orchestrate) violates DRY and confuses agents. `cleo deps waves T091` vs `cleo orchestrate waves T091` return identical JSON.

`cleo deps critical-path <taskId>`: PASS — returns path array with task metadata.

`cleo deps impact <taskId>`: PARTIAL — **returns `operation: tasks.depends`** — same as `deps show`. The impact operation appears to call the depends endpoint rather than a dedicated impact analysis. Output is indistinguishable from `deps show`. Also duplicates `reason impact <taskId>` (same tasks.depends operation).

`cleo deps cycles`: PASS — returns `{hasCycles: false, cycles: []}`. No cycles found.

**Cross-domain overlaps**:
- `deps waves` == `orchestrate waves` (exact duplicate)
- `deps impact` == `reason impact <taskId>` == `deps show` (same operation: tasks.depends)

---

### 8. `cleo tree [rootId]`

**Status**: PASS

**Help Quality**: POOR — USAGE shows `[OPTIONS]` but no OPTIONS section is listed. Agents cannot know what options exist.

**Behavior**:
- `cleo tree` (bare): PASS — returns full hierarchy. All 80 tasks shown; hierarchy correctly shows T091 > T501 when T501 is under T091.
- `cleo tree T091`: PASS — scoped to T091 subtree only, returns 2 nodes
- `cleo tree --status pending`: Fails with E_VALIDATION_FAILED — `--status` is interpreted as rootId "pending" (no option parsing). Unknown option silently treated as rootId argument.
- `cleo tree --depth 2`: Fails with E_NOT_FOUND for "T2" — `--depth 2` parsed as rootId "2" prefixed with "T".

**Issues**:
- No depth limit option (useful for large trees)
- No status filter option
- [OPTIONS] in USAGE is misleading — there are no options
- Unknown flags are silently treated as rootId argument (wrong parsing behavior)

---

### 9. `cleo blockers`

**Status**: PASS (functionally), PARTIAL (--analyze flag)

**Help Quality**: Adequate — single `--analyze` option documented.

**Behavior**:
- `cleo blockers`: PASS — returns `{blockedTasks:[], criticalBlockers:[], summary:"No blocked tasks found", total:0, limit:20}`. No deps in dataset, correctly reports 0 blocked.
- `cleo blockers --analyze`: PARTIAL — returns identical JSON to bare `cleo blockers`. The `--analyze` flag does not produce any additional output (no chain analysis, no tree). Behavior does not match help text "Show full blocking chain analysis".

**Design note**: `blockers` reads from the `depends` field only. The `relates` type `blocks` is ignored by this command. An agent that uses `relates add T316 T315 blocks` will NOT see T315 as blocked in `cleo blockers`. This disconnect is undocumented.

**Overlap**: `blockers` partially overlaps with `deps overview` (both show blocked task counts). `deps overview` returns `blockedTasks` while `blockers` returns `blockedTasks` + `criticalBlockers`. `blockers` is the correct command to use for blocking chain analysis.

---

### 10. `cleo complexity estimate <taskId>`

**Status**: PASS

**Help Quality**: Adequate — subcommand clearly named, taskId documented.

**Behavior**:
- `cleo complexity estimate T501`: Returns `size:medium, score:4` with 5 factor breakdown (descriptionLength, acceptanceCriteria, dependencyDepth, subtaskCount, fileReferences)
- `cleo complexity estimate T091`: Returns `size:medium, score:7` — correctly counts 1 subtask
- `cleo complexity estimate T9999`: Error "Task 'T9999' not found" with E_NOT_INITIALIZED (3) — wrong code, should be E_NOT_FOUND (4)

**Issues**:
- Wrong error code on missing task (E_NOT_INITIALIZED vs E_NOT_FOUND) — consistent with same bug in promote/reparent
- `complexity` top-level has only one subcommand (`estimate`) — makes the sub-command grouping feel unnecessary for a single operation

---

## Bugs Found

| # | Severity | Command | Bug |
|---|----------|---------|-----|
| B1 | HIGH | `cleo labels show ""` | Empty string label bypasses filter — returns ALL tasks with filtered:79. Should reject or return 0. |
| B2 | MEDIUM | `cleo tags show <label>` | Tags alias does not proxy subcommands correctly — returns label list instead of filtered tasks |
| B3 | MEDIUM | `cleo reorder --position N` | Help says "zero-based" but --top returns position 1, --position 0 returns 1. 0-vs-1-indexed inconsistency. |
| B4 | MEDIUM | `cleo blockers --analyze` | Flag documented as "Show full blocking chain analysis" but output is identical to bare blockers |
| B5 | MEDIUM | `cleo deps impact` | Calls `tasks.depends` operation — indistinguishable from `deps show`. Not implementing impact analysis. |
| B6 | LOW | `cleo promote T091` (root task) | Returns success:true reparented:true even though task had no parent — misleading no-op |
| B7 | LOW | Multiple commands | Wrong error code: task-not-found returns E_NOT_INITIALIZED (3) instead of E_NOT_FOUND (4). Affects: promote, reparent, complexity estimate |
| B8 | LOW | `cleo reorder --position -1` | Negative positions accepted without validation, map to position 1 |
| B9 | LOW | `cleo reorder --top --position N` | Conflicting flags silently resolve — no validation error |
| B10 | LOW | `cleo reparent` (every call) | WARN "Detected stale migration journal entries" emitted on every call — noisy |

---

## Missing Features / Gaps

| # | Severity | Gap |
|---|----------|-----|
| G1 | HIGH | `cleo relates remove` — no way to delete a relationship once added |
| G2 | MEDIUM | `cleo tree` has no depth-limit or status-filter options despite [OPTIONS] in USAGE |
| G3 | MEDIUM | `cleo blockers` does not read `relates.type=blocks` — only reads `depends` field. Blocking via relates is invisible to blockers. |
| G4 | LOW | `cleo promote` shows [OPTIONS] in USAGE but has no options |
| G5 | LOW | `cleo relates discover` vs `cleo relates suggest` — distinction undocumented; discover appears to be suggest with threshold=0 |

---

## Duplicate / Overlap Issues

| Commands | Overlap Type | Recommendation |
|----------|-------------|----------------|
| `deps waves` vs `orchestrate waves` | Exact duplicate (same operation: orchestrate.waves) | Remove from `deps`, keep in `orchestrate` |
| `deps impact` vs `reason impact <id>` vs `deps show` | All call tasks.depends | `deps impact` needs its own implementation or alias docs |
| `relates discover` vs `relates suggest` | Both use same `cli.output` op; differ only in threshold default | Document threshold difference; consider merging with --threshold flag only |
| `labels stats` vs `labels list` | Return identical data structures | `stats` could add top-N analysis, co-occurrence data, or trend info to differentiate |
| `blockers` vs `deps overview` | Both return blocked task counts | Clear: `blockers` for chain analysis, `deps overview` for health summary |

---

## Help Text Quality Issues

| Command | Issue |
|---------|-------|
| `cleo tags` | Help shows "Alias for labels command" with no USAGE or subcommands — agents cannot discover subcommands |
| `cleo promote` | USAGE says [OPTIONS] but no OPTIONS section rendered |
| `cleo tree` | USAGE says [OPTIONS] but no OPTIONS section rendered |
| `cleo relates discover` | Description "various methods" is vague — no explanation of how it differs from suggest |
| `cleo blockers --analyze` | Described as "full blocking chain analysis" but behavior is identical to bare command |
| `cleo deps impact` | No indication that it calls the same endpoint as deps show |
| `cleo labels show` | No mention that empty-string label is invalid (bug B1) |
| `cleo reorder --position` | Says "zero-based position" but system appears 1-based |

---

## State Changes Made During Audit

The following changes were made to the live task database:
- T494 (Fix snake_case in bootstrap-cli-tool test.py): status changed to `archived` — permanent
- T316→T315 `blocks` relationship added via `relates add` — cannot be removed (G1)
- T501 reparented between T091 and root multiple times — restored to T091 at end of audit
- T501→T091 `related` relationship added — cannot be removed (G1)
