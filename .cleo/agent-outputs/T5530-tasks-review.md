# T5530 — tasks Domain Review

**Task**: T5530
**Epic**: T5529
**Date**: 2026-03-07
**Status**: complete

---

## Summary

The tasks domain currently exposes 32 operations (17 query + 15 mutate). After applying the challenge questions, 10 operations can be eliminated or merged, projecting a post-rationalization count of 21 operations — one below the ≤22 ceiling. The primary savings come from collapsing three redundant "restore-like" mutate operations into one parameterized op, removing a duplicate query operation, and collapsing two label operations into one parameterized call.

---

## Decision Matrix

### Query Operations (17)

| Operation | Tier | Decision | Reason |
|-----------|------|----------|--------|
| tasks.show | 0 | KEEP | Core single-task retrieval; essential for every agent workflow |
| tasks.list | 0 | KEEP | Required for parent-scoped enumeration; has `parent` filter guard |
| tasks.find | 0 | KEEP | Primary discovery op; cheaper than list; correct for agents |
| tasks.exists | 0 | REMOVE | Redundant — `tasks.find` with `exact:true` returns the same info without a separate op; callers can check `results.length > 0` |
| tasks.tree | 0 | KEEP | Uniquely provides hierarchical view not available from list/find |
| tasks.blockers | 0 | KEEP | Uniquely surfaces blocking chains; essential for orchestrator decisions |
| tasks.depends | 0 | KEEP | Required for dependency analysis; already handles overview/cycles via `action` param — no need for separate ops |
| tasks.analyze | 0 | KEEP | Unique leverage-scoring view used by orchestrators to prioritize |
| tasks.next | 0 | KEEP | Core workflow op; scored task suggestion is the primary agent loop driver |
| tasks.plan | 0 | KEEP | Composite planning view providing unique cross-domain summary |
| tasks.relates | 0 | KEEP | Show existing relations for a task; distinct from relates.find |
| tasks.relates.find | 1 | MERGE → tasks.relates | Merge into `tasks.relates` via `mode` param (`mode: "suggest"` or `"discover"`); relates already accepts taskId; no workflow requires both ops simultaneously. Net: 1 op handles show + suggest + discover |
| tasks.complexity.estimate | 0 | KEEP | Deterministic scoring for sizing decisions; distinct output |
| tasks.history | 1 | KEEP | Work-time history; distinct from task audit log; needed for metrics |
| tasks.current | 0 | KEEP | Essential agent workflow op — "what am I working on?" |
| tasks.label.list | 1 | KEEP | Useful for label discovery across the project |
| tasks.label.show | 1 | MERGE → tasks.label.list | PARAMETERIZE into `tasks.label.list` via `label` param; when `label` is provided, filter to that label's tasks. Same data model, one op replaces two |

**Query subtotal after rationalization: 15** (removed: exists, relates.find merged into relates, label.show merged into label.list)

---

### Mutate Operations (15)

| Operation | Tier | Decision | Reason |
|-----------|------|----------|--------|
| tasks.add | 0 | KEEP | Core task creation; anti-hallucination validation built in |
| tasks.update | 0 | KEEP | Core update; already handles broad field set via single op |
| tasks.complete | 0 | KEEP | Terminal lifecycle op; triggers auto-complete and unblock logic |
| tasks.cancel | 0 | KEEP | Distinct soft-terminal state; reversible via restore |
| tasks.delete | 0 | KEEP | Hard delete; distinct from cancel/complete |
| tasks.archive | 0 | KEEP | Batch archive of done/cancelled tasks; distinct from delete |
| tasks.restore | 0 | KEEP — rename to canonical | Already the VERB-STANDARDS canonical name; handles cancelled→pending |
| tasks.reopen | 0 | MERGE → tasks.restore | Redundant with restore; both move tasks back to pending. Merge into `tasks.restore` with `from` param (`from: "done"` vs `from: "cancelled"`). The engine already has both implementations — the param routes to the correct core function |
| tasks.unarchive | 0 | MERGE → tasks.restore | Third "restore-like" op; moves archived tasks back to active. Merge into `tasks.restore` with `from: "archive"` param. Already wired in task-engine.ts |
| tasks.reparent | 0 | KEEP | Structural hierarchy change; unique semantics vs update |
| tasks.promote | 0 | MERGE → tasks.reparent | Promote is reparent with `newParentId: null`; can be expressed as `tasks.reparent` with `newParentId: null`. Saves one op with zero information loss |
| tasks.reorder | 0 | KEEP | Positional ordering is distinct from content updates |
| tasks.relates.add | 0 | KEEP | Required for building the relations graph; no substitute |
| tasks.start | 0 | KEEP | Active-work tracking; essential for current/history/session integration |
| tasks.stop | 0 | KEEP | Paired with start; stops active-work tracking |

**Mutate subtotal after rationalization: 11** (merged: reopen→restore, unarchive→restore, promote→reparent)

---

## Projected Totals

| | Before | After |
|--|--------|-------|
| Query | 17 | 15 |
| Mutate | 15 | 11 |
| **Total** | **32** | **21** |

Target ceiling: ≤22. Projected: **21**. One under ceiling.

---

## Merge/Parameterize Details

### 1. tasks.restore — absorbs reopen + unarchive (3→1)

**New signature:**
```
mutate tasks restore {
  taskId: string,        // required
  from?: "cancelled" | "done" | "archive",  // routing hint; auto-detected if absent
  cascade?: boolean,     // for archive mode
  status?: string,       // for done/archive: target status override
  notes?: string
}
```

**Routing logic in domain handler:**
- If task is cancelled → call `coreTaskRestore` (existing restore path)
- If task is done → call `coreTaskReopen` (existing reopen path)
- If task is in archive → call `coreTaskUnarchive` (existing unarchive path)
- `from` param is optional and provides a bypass hint; auto-detection reads task state

**Why this works:** All three operations share the semantic intent "reverse a terminal or archived state." The caller knows what they want to undo; the system can detect the task's current state. A single op with a `from` routing hint satisfies all cases.

**CLI impact:** `cleo restore`, `cleo reopen`, `cleo unarchive` each become thin wrappers that call `mutate tasks restore` with the appropriate `from` hint.

---

### 2. tasks.relates — absorbs relates.find (2→1)

**New signature:**
```
query tasks relates {
  taskId: string,
  mode?: "show" | "suggest" | "discover",  // default: "show"
  threshold?: number     // only for mode: "suggest"
}
```

**Routing logic:**
- `mode: "show"` (default) → existing `coreTaskRelates` (list stored relations)
- `mode: "suggest"` → `suggestRelated` from core
- `mode: "discover"` → `discoverRelated` from core

**Why this works:** The caller navigating relations always starts from a taskId. The `mode` param cleanly separates the three sub-queries. The domain handler already imports all three functions.

---

### 3. tasks.label.list — absorbs label.show (2→1)

**New signature:**
```
query tasks label.list {
  label?: string    // optional; when present, return tasks for that label
}
```

**Routing logic:**
- No `label` → return all labels with counts (existing `listLabels`)
- With `label` → return tasks for that specific label (existing `showLabelTasks`)

**Why this works:** Two separate ops with a clear superset/subset relationship. A single parameterized op is the standard CLEO pattern (see `tasks.depends` with `action` param).

---

### 4. tasks.reparent — absorbs promote (2→1)

**Promote is reparent with null parent:**
```
mutate tasks reparent { taskId: "T123", newParentId: null }
```

The existing `taskReparent` engine function already accepts `null` for `newParentId` and handles the type-change logic. The domain handler already passes `newParentId ?? null`. No new code needed — just remove the separate `promote` op registration and CLI alias.

**CLI impact:** `cleo promote <id>` becomes a CLI shorthand that calls `reparent` with `newParentId=null`.

---

### 5. tasks.exists — REMOVE

`tasks.find` with `{query: "T1234", exact: true}` returns the task if it exists. The caller checks `results.length > 0`. The `exists` op was a convenience wrapper with no unique capability. Agents can use `tasks.show` for existence + details in one call, or `tasks.find` for lightweight existence checking.

---

## CLI Impact

| CLI Command | Impact |
|-------------|--------|
| `cleo reopen` | Thin alias → `mutate tasks restore {from: "done"}` |
| `cleo unarchive` | Thin alias → `mutate tasks restore {from: "archive"}` |
| `cleo promote` | Thin alias → `mutate tasks reparent {newParentId: null}` |
| `cleo exists` | Replace with `cleo find --exact --id <id>` in docs |
| `cleo label show <label>` | Merge into `cleo label list --filter <label>` |
| `cleo relates find` | Merge into `cleo relates --mode suggest/discover` |

CLI commands themselves are NOT removed — they remain as human-facing convenience wrappers that delegate to the rationalized MCP operations. This maintains backward compatibility.

---

## Notes

### Operations NOT merged despite initial hypothesis

- **tasks.blockers vs tasks.depends**: These were considered for merge but serve distinct disclosure needs. `blockers` is a project-wide view (which tasks are blocked and by what). `depends` is a task-specific view (what does this task need / what needs this task). They have different output shapes and are used in different workflow contexts.

- **tasks.analyze vs tasks.plan**: Both are composite views but with different audiences. `analyze` is leverage-scoring for task prioritization within the dependency graph. `plan` is a session-start briefing with epics, ready tasks, and bugs. Different outputs, different use cases, different tiers.

- **tasks.archive vs tasks.delete**: Archive is reversible (via restore) and batch-capable; delete is permanent and single-task (with optional force cascade). Functionally and semantically distinct.

### Deps overview/cycles already merged

`tasks.depends` already handles `action: "overview"` and `action: "cycles"` via the `action` param routing in the domain handler (T5157). These are NOT listed as separate ops in the registry — confirmed. So no additional merge is needed here.

### stats, lint, export, import, batch-validate

These engine functions (`taskStats`, `taskLint`, `taskExport`, `taskImport`, `taskBatchValidate`) exist in `task-engine.ts` but are NOT registered in the dispatch registry and NOT wired in the domain handler. They are CLI-only operations. This review confirms they should remain CLI-only unless a specific agent workflow is identified that requires MCP access. No action needed.

### Sequencing for implementation

Recommended implementation order (T5531/T5532/T5533 follow-up):
1. Merge restore + reopen + unarchive (highest ROI, cleanest semantics)
2. Remove tasks.exists (zero-effort removal)
3. Merge relates + relates.find (requires mode param in domain handler)
4. Merge label.list + label.show (requires label param routing)
5. Merge reparent + promote (requires CLI alias preservation)

---

## References

- Task engine: `src/dispatch/engines/task-engine.ts`
- Domain handler: `src/dispatch/domains/tasks.ts`
- Registry: `src/dispatch/registry.ts` (lines 55–242 query tasks, 1249–1399 mutate tasks)
- Verb standards: `docs/specs/VERB-STANDARDS.md`
- Related tasks: T5529 (epic), T5531, T5532, T5533 (sibling subtasks)
