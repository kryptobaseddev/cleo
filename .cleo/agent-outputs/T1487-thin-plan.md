# T1487 Thin Plan — Tasks / Nexus / Playbook Dispatch Handlers

Generated: 2026-04-27
Task: T1487 (T-TW-FU6)
ADR: ADR-057 D3, ADR-058

---

## Phase 1 Audit Results

### Summary

Three dispatch domain files examined:
- `packages/cleo/src/dispatch/domains/tasks.ts` (969 lines)
- `packages/cleo/src/dispatch/domains/playbook.ts` (789 lines)
- `packages/cleo/src/dispatch/domains/nexus.ts` (1666 lines)

### Pattern Taxonomy

| Category | Pattern | Thinnable? |
|----------|---------|-----------|
| **A — Simple passthrough** | call engineFn(root, params), if !success lafsError, else lafsSuccess | Yes — `wrapCoreResult(await fn(...), opName)` |
| **B — Branching dispatch** | conditional routing to different engine fns | Yes — each branch becomes `wrapCoreResult(await fn(...), opName)` |
| **C — Page-envelope lifting** | strip data.page, promote to envelope top-level | SSoT-EXEMPT (presentation contract) |
| **D — DB injection** | acquireDb() + executePlaybook/resumePlaybook | SSoT-EXEMPT (ADR-057 D1 exception) |
| **E — File loading + parsing** | load .cantbook, parsePlaybook, build opts | SSoT-EXEMPT (ADR-057 D1 exception) |

---

### Domain: tasks.ts

| Op | Lines | Category | Current Body LOC | Target LOC | Action |
|----|-------|----------|-----------------|-----------|--------|
| `show` | 100-133 | B | 33 | 10 | Use `wrapCoreResult` in each of 3 branches |
| `list` | 135-166 | A+page | 31 | 8 | `wrapCoreResult` + page pass-through already in engine |
| `find` | 168-189 | A | 21 | 2 | `wrapCoreResult` passthrough |
| `tree` | 191-202 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `blockers` | 204-215 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `depends` | 217-257 | B | 40 | 10 | 3 branches, each use `wrapCoreResult` |
| `analyze` | 259-270 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `impact` | 272-283 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `next` | 285-296 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `plan` | 298-309 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `relates` | 311-336 | B | 25 | 6 | 2 branches, each use `wrapCoreResult` |
| `complexity.estimate` | 338-349 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `history` | 351-373 | B | 22 | 6 | 2 branches, each use `wrapCoreResult` |
| `current` | 375-386 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `label.list` | 388-399 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `sync.links` | 401-412 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `add` | 418-448 | A | 30 | 2 | `wrapCoreResult` passthrough (engine fn accepts all params) |
| `update` | 450-482 | A | 32 | 2 | `wrapCoreResult` passthrough |
| `complete` | 484-513 | B+side-effect | 29 | 12 | `complete` has `--force` guard + `setImmediate` side-effect — keep guards, use `wrapCoreResult` for result |
| `cancel` | 515-526 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `delete` | 528-539 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `archive` | 541-556 | A | 15 | 2 | `wrapCoreResult` passthrough |
| `restore` | 558-601 | B | 42 | 12 | 3 branches + SSoT-EXEMPT note for `from` routing |
| `reparent` | 603-614 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `reorder` | 616-627 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `relates.add` | 629-651 | B+alias | 22 | 8 | Keep alias guard (SSoT-EXEMPT), use `wrapCoreResult` |
| `start` | 653-664 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `stop` | 666-677 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `sync.reconcile` | 679-697 | A | 18 | 2 | `wrapCoreResult` passthrough |
| `sync.links.remove` | 699-710 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `claim` | 712-723 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `unclaim` | 725-736 | A | 11 | 2 | `wrapCoreResult` passthrough |

**Thinnable: 32 ops. SSoT-EXEMPT: 0 full ops (some branches within ops have EXEMPT comments).**

---

### Domain: nexus.ts — Typed Handler

| Op | Lines | Category | Current Body LOC | Target LOC | Action |
|----|-------|----------|-----------------|-----------|--------|
| `status` | 109-119 | A | 10 | 2 | `wrapCoreResult` passthrough |
| `list` | 121-144 | C | 22 | 22 | SSoT-EXEMPT: page envelope lifting is presentation contract |
| `show` | 146-159 | A+C | 13 | 4 | Keep name guard, use `wrapCoreResult` |
| `resolve` | 161-174 | A+C | 13 | 4 | Keep query guard |
| `deps` | 176-190 | A+C | 14 | 5 | Keep query guard + direction default |
| `graph` | 192-202 | A | 10 | 2 | `wrapCoreResult` passthrough |
| `path.show` | 204-214 | A | 10 | 2 | `wrapCoreResult` passthrough |
| `blockers.show` | 216-229 | A+C | 13 | 4 | Keep query guard |
| `orphans.list` | 231-253 | C | 22 | 22 | SSoT-EXEMPT: page envelope lifting |
| `discover` | 254-269 | A+C | 15 | 5 | Keep guards + defaults |
| `search` | 271-285 | A+C | 14 | 5 | Keep guard + default |
| `augment` | 287-301 | A+C | 14 | 5 | Keep guard + default |
| `share.status` | 303-313 | A | 10 | 2 | `wrapCoreResult` passthrough |
| `transfer.preview` | 315-339 | A+C | 24 | 8 | Keep triple param guard |
| `top-entries` | 341-355 | A | 14 | 2 | `wrapCoreResult` passthrough |
| `impact` | 357-370 | A+C | 13 | 4 | Keep symbol guard |
| `full-context` | 372-386 | A+C | 14 | 4 | Keep symbol guard |
| `task-footprint` | 388-402 | A+C | 14 | 4 | Keep taskId guard |
| `brain-anchors` | 404-418 | A+C | 14 | 4 | Keep entryId guard |
| `why` | 420-434 | A+C | 14 | 4 | Keep symbol guard |
| `impact-full` | 436-450 | A+C | 14 | 4 | Keep symbol guard |
| `route-map` | 452-465 | A+default | 13 | 5 | Keep projectId default |
| `shape-check` | 467-483 | A+C | 16 | 6 | Keep routeSymbol guard + projectId default |
| `search-code` | 485-499 | A+C | 14 | 5 | Keep pattern guard + default |
| `wiki` | 501-517 | A+default | 16 | 5 | Keep outputDir default |
| `contracts-show` | 519-533 | A+C | 14 | 4 | Keep projectA+B guard |
| `task-symbols` | 535-549 | A+C | 14 | 4 | Keep taskId guard |
| `profile.view` | 551-562 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `profile.get` | 564-575 | A+C | 11 | 4 | Keep traitKey guard |
| `sigil.list` | 577-588 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `init` | 594-604 | A | 10 | 2 | `wrapCoreResult` passthrough |
| `register` | 606-622 | A+C | 16 | 4 | Keep path guard |
| `unregister` | 624-637 | A+C | 13 | 4 | Keep name guard |
| `sync` | 640-650 | A | 10 | 2 | `wrapCoreResult` passthrough |
| `permission.set` | 652-675 | A+C+validate | 23 | 8 | Keep multi-field guards + level validation |
| `reconcile` | 677-688 | A+default | 11 | 4 | Keep projectRoot default |
| `share.snapshot.export` | 690-701 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `share.snapshot.import` | 703-717 | A+C | 14 | 4 | Keep inputPath guard |
| `transfer` | 719-744 | A+C | 25 | 8 | Keep triple guard + defaults |
| `contracts-sync` | 746-759 | A+default | 13 | 5 | Keep repoPath/projectId defaults |
| `contracts-link-tasks` | 761-774 | A+default | 13 | 5 | Keep repoPath/projectId defaults |
| `conduit-scan` | 776-787 | A | 11 | 2 | `wrapCoreResult` passthrough |
| `profile.import` | 789-799 | A | 10 | 2 | `wrapCoreResult` passthrough |
| `profile.export` | 801-811 | A | 10 | 2 | `wrapCoreResult` passthrough |
| `profile.reinforce` | 813-826 | A+C | 13 | 4 | Keep traitKey guard |
| `profile.upsert` | 828-844 | A+C | 16 | 4 | Keep trait guard |
| `profile.supersede` | 846-860 | A+C | 14 | 4 | Keep oldKey+newKey guard |
| `sigil.sync` | 862-872 | A | 10 | 2 | `wrapCoreResult` passthrough |

**Thinnable: 47 ops. SSoT-EXEMPT: 2 (`list`, `orphans.list` — page envelope lifting).**

---

### Domain: playbook.ts — Typed Handler

| Op | Lines | Category | Current Body LOC | Target LOC | Action |
|----|-------|----------|-----------------|-----------|--------|
| `status` | 356-367 | A+C | 11 | 4 | Keep runId guard + db acquire; reduce error path |
| `list` | 369-392 | D | 23 | 23 | SSoT-EXEMPT: db injection + runtime offset pagination |
| `validate` | 394-462 | D+E | 68 | 68 | SSoT-EXEMPT: file loading + parsing (ADR-057 D1) |
| `run` | 468-538 | D+E | 70 | 70 | SSoT-EXEMPT: db injection + file loading + executePlaybook (ADR-057 D1) |
| `resume` | 540-629 | D | 89 | 89 | SSoT-EXEMPT: db injection + gate validation (ADR-057 D1) |

**Thinnable: 1 op (`status`). SSoT-EXEMPT: 4 (`list`, `validate`, `run`, `resume`).**

Note: `status` can be slightly reduced. The main reduction in playbook is annotating all 4 SSoT-EXEMPT ops with `// SSoT-EXEMPT:<reason>` per ADR-058.

---

## Phase 3 Implementation Plan

### Step 1: tasks.ts
1. Add `wrapCoreResult` to import from `../adapters/typed.js`
2. Replace every simple passthrough (Category A) with `wrapCoreResult(await fn(projectRoot, ...), opName)` 
3. For branching ops, use `wrapCoreResult` within each branch
4. Commit: `feat(T1487): thin tasks dispatch handlers via wrapCoreResult`

### Step 2: nexus.ts
1. Add `wrapCoreResult` to import from `../adapters/typed.js`
2. Replace every simple passthrough with `wrapCoreResult(await fn(...), opName)`
3. Annotate `list` and `orphans.list` with `// SSoT-EXEMPT:page-envelope-lifting`
4. Commit: `feat(T1487): thin nexus dispatch handlers via wrapCoreResult`

### Step 3: playbook.ts
1. Add `// SSoT-EXEMPT:<reason>` to `list`, `validate`, `run`, `resume`
2. Thin `status` handler slightly
3. Commit: `feat(T1487): annotate playbook SSoT-EXEMPT handlers per ADR-058`

---

## SSoT-EXEMPT Declarations

| Handler | Reason |
|---------|--------|
| `tasks.complete` — setImmediate block | Fire-and-forget side-effect; must not be moved to Core (timing contract) |
| `tasks.relates.add` — relatedId/targetId alias | Backward-compat alias (T5149); documented alias, not removable |
| `nexus.list` — page lifting | Presentation envelope contract; engine puts page in data, handler lifts it |
| `nexus.orphans.list` — page lifting | Same as list |
| `playbook.list` — offset slicing | `listPlaybookRunsState` only supports LIMIT; offset must be applied client-side |
| `playbook.validate` — file load + parse | ADR-057 D1 exception: runtime file I/O before DB row creation |
| `playbook.run` — db injection + file load | ADR-057 D1 exception: `db: DatabaseSync` is non-wire-serializable infrastructure |
| `playbook.resume` — db injection + gate validation | ADR-057 D1 exception: approval gate state machine requires DB handle |
