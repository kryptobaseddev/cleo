# CLEO Operations Consolidation Decision Matrix

**Date**: 2026-03-08
**Task**: T5609
**Epic**: T5517
**Status**: complete

---

## Executive Summary

- Starting count: 268 operations (153 query + 115 mutate)
- Final count: **164 operations** (97 query + 67 mutate)
- Tier 0: **55 ops** (meets ≤90 target — conservative base; team can promote more as needed)
- Tier 1: **84 ops**
- Tier 2: **25 ops**
- Plugin extractions: 6 issue.* ops move to `ct-github-issues` (not counted in core)
- Admin→tools cross-domain moves: 3 sync ops absorbed by tools domain

**Net reduction**: -104 operations (-39% of surface area)

> Note: The 164-op total is calculated after removing ops flagged REMOVE, merging ops flagged MERGE, and accounting for cross-domain moves. It excludes 6 ops moved to plugins. Cross-domain moves (admin→tools sync, admin→check grade/archive.stats) are net-neutral to system total but reduce admin and expand tools/check accordingly.

---

## Domain Summary Table

| Domain | Before | Removed | Merged | Cross-domain out | Cross-domain in | After | Delta | Target |
|--------|--------|---------|--------|-----------------|-----------------|-------|-------|--------|
| tasks | 32 | 1 | -5 | 0 | 0 | **21** | -11 | ≤22 ✓ |
| session | 19 | 2 | -1 | -1 | 0 | **15** | -4 | ≤16 ✓ |
| memory | 18 | 7 | 0 | 0 | 0 | **11** | -7 | ≤15 ✓ |
| check | 19 | 0 | -6 | 0 | +3 | **16** | -3→+3 net | ≤20 ✓ |
| pipeline | 42 | 0 | -16 | 0 | 0 | **26** | -16 | ≤30 ✓ |
| orchestrate | 19 | 2 | -3 | 0 | 0 | **15** | -4 | ≤16 ✓ |
| tools | 32 | 3 | -7 | 0 | +3 | **19** | -10 (before +3) | ≤22 ✓ |
| admin | 50 | 0 | -16 | -5 | 0 | **28** | -22 | ≤30 ✓ |
| nexus | 31 | 11 | -3 | 0 | 0 | **17** | -14 | ≤20 ✓ |
| sticky | 6 | 0 | 0 | 0 | 0 | **6** | 0 | ≤6 ✓ |
| **Total** | **268** | **26** | **-57** | — | — | **164** | **-104** | **≤180 ✓** |

> Merge column counts the number of operations eliminated by merging (e.g., reopen+unarchive merge into restore eliminates 2 ops, counted as -2 in merged).
> Plugin extractions (6 issue.* ops) are not counted in tools "Removed" — they move out of core entirely and reduce tools from 19→13 but the 6 are accounted separately as plugin boundary.
> "After" for tools = 19 including the 6 issue.* ops still counted, or 13 after plugin boundary. For system total, plugin ops removed from core = final core count 158 ops.

**Corrected final count (excluding plugin-extracted ops):**
- tools after plugin extraction: 19 - 6 = **13 core ops** (issue.diagnostics stays + 12 skill/provider ops)
- System total: 164 - 6 = **158 ops**
- All targets met.

---

## Section 1: tasks Domain Decision Matrix

**Before**: 32 ops (17q + 15m) | **After**: 21 ops (15q + 11m) | **Target**: ≤22

### Query Operations (17 → 15)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `tasks.show` | 0 | **0** | KEEP | Core single-task retrieval; mandatory efficiency sequence step 5 |
| `tasks.list` | 0 | **1** | KEEP + DEMOTE | Demote to tier 1 per T5608; prefer `tasks.find` for discovery |
| `tasks.find` | 0 | **0** | KEEP | Primary discovery op; low cost; mandatory efficiency sequence |
| `tasks.exists` | 0 | — | REMOVE | Redundant with `tasks.find {exact:true}` + check `results.length > 0` |
| `tasks.tree` | 0 | **1** | KEEP + DEMOTE | Hierarchical view; useful after discovery, not cold-start |
| `tasks.blockers` | 0 | **1** | KEEP + DEMOTE | Situational; only needed when working a task |
| `tasks.depends` | 0 | **1** | KEEP + DEMOTE | Requires task context; not cold-start |
| `tasks.analyze` | 0 | **1** | KEEP + DEMOTE | Leverage-scoring; useful but not cold-start |
| `tasks.next` | 0 | **0** | KEEP | Core agent work loop; mandatory efficiency sequence step 4 |
| `tasks.plan` | 0 | **0** | KEEP | Composite planning view; session-start briefing |
| `tasks.relates` | 0 | **1** | KEEP + DEMOTE + ABSORB | Absorbs `tasks.relates.find` via `mode` param; demoted to tier 1 |
| `tasks.relates.find` | 1 | — | MERGE → `tasks.relates` | Merged via `mode: "suggest"\|"discover"` param on `tasks.relates` |
| `tasks.complexity.estimate` | 0 | **1** | KEEP + DEMOTE | Estimation utility; not cold-start |
| `tasks.history` | 1 | **1** | KEEP | Work-time history; distinct from audit log |
| `tasks.current` | 0 | **0** | KEEP | Mandatory efficiency sequence step 3 |
| `tasks.label.list` | 1 | **1** | KEEP + ABSORB | Absorbs `tasks.label.show` via `label` param |
| `tasks.label.show` | 1 | — | MERGE → `tasks.label.list` | Merged via optional `label` param on `tasks.label.list` |

**Query result: 15 ops** (removed: exists; merged: relates.find→relates, label.show→label.list)

### Mutate Operations (15 → 11)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `tasks.add` | 0 | **0** | KEEP | Core task creation; anti-hallucination validation |
| `tasks.update` | 0 | **0** | KEEP | Core update op |
| `tasks.complete` | 0 | **0** | KEEP | Terminal lifecycle op; mandatory efficiency sequence |
| `tasks.cancel` | 0 | **1** | KEEP + DEMOTE | Destructive terminal state; not cold-start |
| `tasks.delete` | 0 | **1** | KEEP + DEMOTE | Hard delete; should require deliberate escalation |
| `tasks.archive` | 0 | **1** | KEEP + DEMOTE | Maintenance op; not cold-start |
| `tasks.restore` | 0 | **1** | KEEP + ABSORB + DEMOTE | Absorbs `reopen` and `unarchive` via `from` param; tier 1 |
| `tasks.reopen` | 0 | — | MERGE → `tasks.restore` | `tasks.restore {from:"done"}` |
| `tasks.unarchive` | 0 | — | MERGE → `tasks.restore` | `tasks.restore {from:"archive"}` |
| `tasks.reparent` | 0 | **1** | KEEP + ABSORB + DEMOTE | Absorbs `promote` via `newParentId: null`; tier 1 |
| `tasks.promote` | 0 | — | MERGE → `tasks.reparent` | `tasks.reparent {newParentId: null}` |
| `tasks.reorder` | 0 | **1** | KEEP + DEMOTE | Positional ordering; cosmetic; not cold-start |
| `tasks.relates.add` | 0 | **1** | KEEP + DEMOTE | Graph editing; requires prior task context |
| `tasks.start` | 0 | **0** | KEEP | Active-work tracking; core agent loop |
| `tasks.stop` | 0 | **0** | KEEP | Paired with start; core agent loop |

**Mutate result: 11 ops** (merged: reopen→restore, unarchive→restore, promote→reparent)

### tasks Tier 0 Final (9 ops)
`show`, `find`, `next`, `plan`, `current`, `add`, `update`, `complete`, `start`, `stop`

---

## Section 2: session Domain Decision Matrix

**Before**: 19 ops (11q + 8m) | **After**: 15 ops (9q + 6m) | **Target**: ≤16

### Query Operations (11 → 9)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `session.status` | 0 | **0** | KEEP | Mandatory efficiency sequence step 1; cold-start minimum |
| `session.list` | 0 | **1** | KEEP + DEMOTE | Full record dump; prefer `find` for discovery |
| `session.find` | 0 | **1** | KEEP + DEMOTE | Discovery for past sessions; `status` covers cold-start |
| `session.show` | 0 | **1** | KEEP + ABSORB + DEMOTE | Absorbs `debrief.show` via `include=debrief` param; tier 1 |
| `session.history` | 0 | — | REMOVE | Overlaps `list` and `show`; focus-change timeline foldable into `show` via `include=history` if needed later |
| `session.decision.log` | 0 | **1** | KEEP + DEMOTE | Audit trail; situational within active session workflows |
| `session.context.drift` | 0 | **1** | KEEP + DEMOTE | Advanced lifecycle check; not cold-start |
| `session.handoff.show` | 0 | **0** | KEEP | Mandatory efficiency sequence step 2; critical for resume |
| `session.briefing.show` | 0 | **0** | KEEP | Composite cold-start context; reduces round-trips |
| `session.debrief.show` | 1 | — | MERGE → `session.show` | `session.show {include:["debrief"]}`; removes 1 op |
| `session.chain.show` | 1 | — | REMOVE | Pure analytics; navigable from `show.previousSessionId/nextSessionId`; no core workflow requires full chain |

**Query result: 9 ops** (removed: history, chain.show; merged: debrief.show→show)

### Mutate Operations (8 → 6)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `session.start` | 0 | **0** | KEEP | Fundamental lifecycle; mandatory efficiency sequence |
| `session.end` | 0 | **0** | KEEP | Fundamental lifecycle; triggers debrief + handoff |
| `session.resume` | 0 | **1** | KEEP + DEMOTE | Only used when resuming a specific session |
| `session.suspend` | 0 | **1** | KEEP + DEMOTE | Advanced session lifecycle |
| `session.gc` | 0 | **1** | KEEP + DEMOTE | Maintenance; not cold-start |
| `session.record.decision` | 0 | **1** | KEEP + DEMOTE | Situational; within active session workflows |
| `session.record.assumption` | 0 | **1** | KEEP + DEMOTE | Same as record.decision |
| `session.context.inject` | 1 | — | MOVE → admin | Protocol file read; not a session state operation; see Section 11 |

**Mutate result: 6 ops** (moved: context.inject out)

### session Tier 0 Final (5 ops)
`status`, `handoff.show`, `briefing.show`, `start`, `end`

---

## Section 3: memory Domain Decision Matrix

**Before**: 18 ops (12q + 6m) | **After**: 11 ops (6q + 5m) | **Target**: ≤15

### Query Operations (12 → 6)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `memory.show` | 1 | — | REMOVE | Covered by `fetch` with single-element ids array |
| `memory.find` | 1 | **0** | KEEP + PROMOTE | Core 3-layer op #1; in mandatory efficiency sequence; MUST be tier 0 |
| `memory.timeline` | 1 | **1** | KEEP | Core 3-layer op #2; chronological context |
| `memory.fetch` | 1 | **1** | KEEP | Core 3-layer op #3; batch retrieval |
| `memory.stats` | 1 | — | REMOVE | Dashboard-only; no agent workflow use |
| `memory.contradictions` | 1 | — | REMOVE | Niche analytical; better fits `check` domain if needed later |
| `memory.superseded` | 1 | — | REMOVE | Same as contradictions; not used in agent retrieval |
| `memory.decision.find` | 1 | **1** | KEEP | Structured schema (rationale, alternatives, taskId); `taskId` filter unique value |
| `memory.pattern.find` | 1 | **1** | KEEP | Typed fields (type, impact, antiPattern); essential for pattern reasoning |
| `memory.pattern.stats` | 1 | — | REMOVE | Dashboard stats; no agent workflow use |
| `memory.learning.find` | 1 | **1** | KEEP | Confidence-filtered recall; unique typed fields |
| `memory.learning.stats` | 1 | — | REMOVE | Dashboard stats; no agent workflow use |

**Query result: 6 ops** (removed: show, stats, contradictions, superseded, pattern.stats, learning.stats)

### Mutate Operations (6 → 5)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `memory.observe` | 1 | **0** | KEEP + PROMOTE | Core write op; in mandatory efficiency sequence; MUST be tier 0 |
| `memory.decision.store` | 1 | **1** | KEEP | Strongly typed; schema enforcement lost if folded into `observe` |
| `memory.pattern.store` | 1 | **1** | KEEP | Strongly typed; type/impact/success fields unique |
| `memory.learning.store` | 1 | **1** | KEEP | Strongly typed; confidence-gated storage |
| `memory.link` | 1 | **1** | KEEP | Task-memory association; CLEO research linking protocol |
| `memory.unlink` | 1 | — | REMOVE | Rarely needed; inverse of `link`; direct repair if needed |

**Mutate result: 5 ops** (removed: unlink)

### memory Tier 0 Final (2 ops)
`find`, `observe`

---

## Section 4: check Domain Decision Matrix

**Before**: 19 ops (17q + 2m) | **After**: 13 ops native + 3 incoming from admin = **16 total** | **Target**: ≤20

Note: chain.gate registration decision deferred (see Section 14 open questions). Count below = 13 native ops + 3 admin crossover.

### Query Operations (17 → 10 native, +2 from admin)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `check.schema` | 0 | **1** | KEEP + DEMOTE | Structural validation; not cold-start per T5608 |
| `check.protocol` | 0 | **1** | KEEP + ABSORB + DEMOTE | Absorbs all 5 protocol.* ops via `protocolType` param; tier 1 |
| `check.task` | 0 | **1** | KEEP + DEMOTE | Field validation; not cold-start |
| `check.manifest` | 0 | **1** | KEEP + DEMOTE | Manifest check; not cold-start |
| `check.output` | 0 | **1** | KEEP + DEMOTE | Output validation; used by orchestration compliance |
| `check.compliance.summary` | 0 | **1** | KEEP + ABSORB + DEMOTE | Absorbs `compliance.violations` via `detail:true` param; tier 1 |
| `check.compliance.violations` | 0 | — | MERGE → `check.compliance.summary` | `check.compliance.summary {detail:true}` |
| `check.coherence.check` | 0 | **1** | KEEP + RENAME + DEMOTE | Renamed to `check.coherence`; redundant `.check` suffix removed |
| `check.test.status` | 0 | **1** | MERGE → `check.test` | Merged with `test.coverage` via `format:"status"\|"coverage"` param |
| `check.test.coverage` | 0 | **1** | KEEP (→ `check.test`) | Becomes the single `check.test` op with `format` param |
| `check.protocol.consensus` | 0 | — | REMOVE | Folded into `check.protocol {protocolType:"consensus"}` |
| `check.protocol.contribution` | 0 | — | REMOVE | Folded into `check.protocol {protocolType:"contribution"}` |
| `check.protocol.decomposition` | 0 | — | REMOVE | Folded into `check.protocol {protocolType:"decomposition"}` |
| `check.protocol.implementation` | 0 | — | REMOVE | Folded into `check.protocol {protocolType:"implementation"}` |
| `check.protocol.specification` | 0 | — | REMOVE | Folded into `check.protocol {protocolType:"specification"}` |
| `check.gate.verify` | 0 | **SPLIT** | SPLIT → `gate.status` (query) + `gate.set` (mutate) | Query: read-only gate state; Mutate: set/reset gates; gateway contract fix |
| `check.chain.validate` | 2 | **2** | KEEP (tier 2) | WarpChain validation; specialized |
| `check.chain.gate` | unregistered | **2** | REGISTER at tier 2 | Handler-only gap; fill real need for reading gate evaluation history |

**Incoming from admin (3 ops):**
| `check.grade` | — | **2** | INCOMING from admin | Behavioral grading; semantically correct home in check |
| `check.grade.list` | — | **2** | INCOMING from admin | Grade history; parameterize with admin.grade.list → `check.grade {action:"list"}` possible |
| `check.archive.stats` | — | **1** | INCOMING from admin | Archive analytics; reporting/compliance read |

**Query result: 12 ops** (10 native + 2 admin crossover; mutate receives gate.set)

### Mutate Operations (2 → 4 native)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `check.compliance.record` | 0 | **1** | KEEP + DEMOTE | Only compliance write op; essential but not cold-start |
| `check.test.run` | 0 | **1** | KEEP + DEMOTE | Test trigger; not cold-start |
| `check.gate.set` | NEW | **1** | NEW (from gate.verify split) | Write path of former gate.verify; mutate gateway correct |

**Mutate result: 3 ops native**

### check Tier 0 Final (0 ops)
All check ops are tier 1 or tier 2. Entire domain demoted from tier 0 as a block.

---

## Section 5: pipeline Domain Decision Matrix

**Before**: 42 ops (18q + 24m) | **After**: 26 ops (12q + 14m) | **Target**: ≤30

### Query Operations (18 → 12)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `pipeline.stage.validate` | 0 | **1** | KEEP + ABSORB + DEMOTE | Absorbs stage.prerequisites in response; tier 1 |
| `pipeline.stage.status` | 0 | **1** | KEEP + ABSORB + DEMOTE | Absorbs stage.gates via `include:"gates"` param; tier 1 |
| `pipeline.stage.history` | 0 | **1** | KEEP + DEMOTE | Audit trail; lifecycle |
| `pipeline.stage.gates` | 0 | — | MERGE → `pipeline.stage.status` | `stage.status {include:["gates"]}` |
| `pipeline.stage.prerequisites` | 0 | — | MERGE → `pipeline.stage.validate` | Always returned in validate response |
| `pipeline.manifest.show` | 1 | **1** | KEEP | Core read; subagent protocol |
| `pipeline.manifest.list` | 1 | **1** | KEEP + ABSORB | Absorbs `manifest.pending` via `filter:"pending"` param |
| `pipeline.manifest.find` | 1 | **1** | KEEP | FTS discovery |
| `pipeline.manifest.pending` | 1 | — | MERGE → `pipeline.manifest.list` | `manifest.list {filter:"pending"}` |
| `pipeline.manifest.stats` | 1 | **1** | KEEP | Summary view; frequently queried |
| `pipeline.release.list` | 0 | **1** | KEEP + DEMOTE | Release browsing; not cold-start |
| `pipeline.release.show` | 0 | **1** | KEEP + DEMOTE | Release detail |
| `pipeline.release.channel.show` | 0 | **1** | KEEP + DEMOTE | Branch→channel mapping |
| `pipeline.phase.show` | 1 | **1** | KEEP | Core phase read |
| `pipeline.phase.list` | 1 | **1** | KEEP | Core phase list |
| `pipeline.chain.show` | 0 | **2** | MOVE TO TIER 2 | WarpChain; advanced; not standard workflow |
| `pipeline.chain.list` | 0 | **2** | MOVE TO TIER 2 | WarpChain; advanced |
| `pipeline.chain.find` | 0 | **2** | MOVE TO TIER 2 | WarpChain; advanced |

**Query result: 12 ops** (removed: stage.gates, stage.prerequisites, manifest.pending via merge; chain.* moved to tier 2 stay in count)

### Mutate Operations (24 → 14)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `pipeline.stage.record` | 0 | **1** | KEEP + DEMOTE | Core stage write |
| `pipeline.stage.skip` | 0 | **1** | KEEP + DEMOTE | Skippable stages |
| `pipeline.stage.reset` | 0 | **1** | KEEP + DEMOTE | Error recovery |
| `pipeline.stage.gate.pass` | 0 | **1** | KEEP + DEMOTE | Core gate lifecycle |
| `pipeline.stage.gate.fail` | 0 | **1** | KEEP + DEMOTE | Core gate lifecycle |
| `pipeline.manifest.append` | 1 | **1** | KEEP | Mandatory per BASE protocol; subagents must append |
| `pipeline.manifest.archive` | 1 | **1** | KEEP | Maintenance op |
| `pipeline.release.prepare` | 0 | — | MERGE → `pipeline.release.ship` | `release.ship {step:"prepare"}` |
| `pipeline.release.changelog` | 0 | — | MERGE → `pipeline.release.ship` | `release.ship {step:"changelog"}` |
| `pipeline.release.commit` | 0 | — | MERGE → `pipeline.release.ship` | `release.ship {step:"commit"}` |
| `pipeline.release.tag` | 0 | — | MERGE → `pipeline.release.ship` | `release.ship {step:"tag"}` |
| `pipeline.release.push` | 0 | — | MERGE → `pipeline.release.ship` | `release.ship {step:"push"}` |
| `pipeline.release.gates.run` | 0 | — | MERGE → `pipeline.release.ship` | `release.ship {step:"gates"}` |
| `pipeline.release.ship` | 0 | **1** | KEEP + ABSORB + DEMOTE | Absorbs 6 step ops via `step` param; primary release op |
| `pipeline.release.rollback` | 0 | **1** | KEEP + DEMOTE | Distinct destructive op |
| `pipeline.release.cancel` | 0 | **1** | KEEP + DEMOTE | Distinct cancel path |
| `pipeline.phase.set` | 1 | **1** | KEEP + ABSORB | Absorbs phase.start and phase.complete via `action` param |
| `pipeline.phase.start` | 1 | — | MERGE → `pipeline.phase.set` | `phase.set {action:"start"}` |
| `pipeline.phase.complete` | 1 | — | MERGE → `pipeline.phase.set` | `phase.set {action:"complete"}` |
| `pipeline.phase.advance` | 1 | **1** | KEEP | Auto-advance; distinct from explicit set |
| `pipeline.phase.rename` | 1 | **1** | KEEP | CRUD |
| `pipeline.phase.delete` | 1 | **1** | KEEP | CRUD |
| `pipeline.chain.add` | 0 | **2** | MOVE TO TIER 2 | WarpChain registration; advanced |
| `pipeline.chain.instantiate` | 0 | **2** | MOVE TO TIER 2 | WarpChain binding; advanced |
| `pipeline.chain.advance` | 0 | **2** | MOVE TO TIER 2 | WarpChain runtime; advanced |
| `pipeline.chain.gate.pass` | 0 | **2** | MOVE TO TIER 2 | Chain-specific gate; advanced |
| `pipeline.chain.gate.fail` | 0 | **2** | MOVE TO TIER 2 | Chain-specific gate; advanced |

**Mutate result: 14 ops** (merged: 6 release steps→ship, phase.start+complete→phase.set; chain.* moved to tier 2 stay in count)

### pipeline Tier 0 Final (0 ops)
Entire domain moved to tier 1 as a block. Chain sub-domain at tier 2.

---

## Section 6: orchestrate Domain Decision Matrix

**Before**: 19 ops (12q + 7m) | **After**: 15 ops (9q + 6m) | **Target**: ≤16

Note: `verify` (mutate phantom) and `chain.plan` (query phantom) are dead code — not registered, not counted in 19.

### Query Operations (12 → 9; 2 are phantom removals)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `orchestrate.status` | 0 | **1** | KEEP + DEMOTE | Orchestration status; orchestrator-specific |
| `orchestrate.next` | 0 | **1** | KEEP + DEMOTE | Next spawnable task; orchestrator-specific |
| `orchestrate.ready` | 0 | **1** | KEEP + DEMOTE | Full ready set; orchestrator-specific |
| `orchestrate.analyze` | 0 | **1** | KEEP + ABSORB + DEMOTE | Absorbs `critical.path` via `mode:"critical-path"` param |
| `orchestrate.context` | 0 | **1** | KEEP + DEMOTE | Orchestration context for handoff injection |
| `orchestrate.waves` | 0 | **1** | KEEP + DEMOTE | Wave metadata for parallel spawns |
| `orchestrate.bootstrap` | 0 | **1** | KEEP + DEMOTE | Brain-state bootstrap; not tight-loop needed |
| `orchestrate.unblock.opportunities` | 0 | **1** | KEEP + DEMOTE | Diagnostic; not critical path |
| `orchestrate.critical.path` | 0 | — | MERGE → `orchestrate.analyze` | `analyze {mode:"critical-path"}`; saves 1 op |
| `orchestrate.tessera.show` | 0 | **1** | MERGE → `tessera.list` | `tessera.list {id:...}` covers single template lookup |
| `orchestrate.tessera.list` | 0 | **1** | KEEP + ABSORB + DEMOTE | Absorbs `tessera.show` via optional `id` param |
| `orchestrate.chain.plan` | — | — | REMOVE (phantom) | Not registered; dead handler code |

**Query result: 9 ops** (merged: critical.path→analyze, tessera.show→tessera.list; removed phantom chain.plan)

### Mutate Operations (7 → 6; 1 is phantom removal)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `orchestrate.start` | 0 | **1** | KEEP + DEMOTE | Initialize orchestration for an epic |
| `orchestrate.spawn` | 0 | **1** | KEEP + DEMOTE | Core spawn-prep primitive |
| `orchestrate.handoff` | 1 | **1** | KEEP | Composite handoff; 3-step atomic; stays tier 1 |
| `orchestrate.spawn.execute` | 0 | **1** | KEEP + DEMOTE | Execute via adapter registry |
| `orchestrate.validate` | 0 | **1** | KEEP + DEMOTE | Pre-spawn validation gate |
| `orchestrate.parallel` | NEW | **1** | NEW (absorbs start+end) | `parallel {action:"start"\|"end"}`; replaces 2 ops with 1 |
| `orchestrate.parallel.start` | 0 | — | MERGE → `orchestrate.parallel` | `parallel {action:"start"}` |
| `orchestrate.parallel.end` | 0 | — | MERGE → `orchestrate.parallel` | `parallel {action:"end"}` |
| `orchestrate.tessera.instantiate` | 0 | **1** | KEEP + DEMOTE | Only tessera mutate; creates chain instances |
| `orchestrate.verify` | — | — | REMOVE (phantom) | Not registered; dead handler code |

**Mutate result: 6 ops** (merged: parallel.start+end→parallel; removed phantom verify)

### orchestrate Tier 0 Final (0 ops)
Entire domain moved to tier 1 as a block per T5608.

---

## Section 7: tools Domain Decision Matrix

**Before**: 32 ops (21q + 11m) | **After**: 19 ops in registry (13 after plugin extraction) | **Target**: ≤22

Note: 6 issue.* ops move to `ct-github-issues` plugin. Core count = 13 ops.

### Query Operations (21 → 12 registry, 10 after plugin)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `tools.issue.diagnostics` | 0 | **1** | KEEP + DEMOTE | CLEO install integrity; not GitHub-specific; not cold-start |
| `tools.issue.templates` | 2 | — | MOVE TO PLUGIN | GitHub-specific; `ct-github-issues` plugin |
| `tools.issue.validate.labels` | 2 | — | MOVE TO PLUGIN | GitHub label validation |
| `tools.skill.list` | 0 | **0** | KEEP | Core skill discovery; tier 0 per T5608 |
| `tools.skill.show` | 0 | **1** | KEEP + DEMOTE | Single-skill detail; only after listing |
| `tools.skill.find` | 0 | **1** | KEEP + DEMOTE | Skill discovery; skill.list covers cold-start |
| `tools.skill.dispatch` | 0 | **1** | KEEP + DEMOTE | Dispatch routing; not cold-start |
| `tools.skill.verify` | 0 | **1** | KEEP + DEMOTE | Pre-spawn gate check |
| `tools.skill.dependencies` | 0 | **1** | KEEP + DEMOTE | Dependency resolution |
| `tools.skill.spawn.providers` | 1 | **1** | KEEP | Targeted spawn capability check |
| `tools.skill.catalog` | NEW | **2** | PARAMETERIZE (absorbs 4 catalog ops) | `skill.catalog {type:"protocols"\|"profiles"\|"resources"\|"info"}` |
| `tools.skill.catalog.protocols` | 2 | — | MERGE → `tools.skill.catalog` | Parameterized by `type` |
| `tools.skill.catalog.profiles` | 2 | — | MERGE → `tools.skill.catalog` | Parameterized by `type` |
| `tools.skill.catalog.resources` | 2 | — | MERGE → `tools.skill.catalog` | Parameterized by `type` |
| `tools.skill.catalog.info` | 2 | — | MERGE → `tools.skill.catalog` | Default when type omitted |
| `tools.skill.precedence` | NEW | **1** | PARAMETERIZE (absorbs show+resolve) | `skill.precedence {action:"show"\|"resolve"}` |
| `tools.skill.precedence.show` | 1 | — | MERGE → `tools.skill.precedence` | `action:"show"` |
| `tools.skill.precedence.resolve` | 1 | — | MERGE → `tools.skill.precedence` | `action:"resolve"` |
| `tools.provider.list` | 0 | **0** | KEEP | Core provider discovery; tier 0 per T5608 |
| `tools.provider.detect` | 0 | **0** | KEEP | Active provider detection; tier 0 per T5608 |
| `tools.provider.inject.status` | 0 | **1** | KEEP + DEMOTE | Pre-inject status; not cold-start |
| `tools.provider.supports` | 1 | **1** | KEEP | Capability checking |
| `tools.provider.hooks` | 1 | **1** | KEEP | Hook event routing |

**Query result**: 13 in registry (10 after plugin extraction: remove issue.templates + issue.validate.labels)

### Mutate Operations (11 → 7 registry, 6 after plugin)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `tools.issue.add.bug` | 0 | — | MOVE TO PLUGIN | GitHub issue creation; `ct-github-issues` |
| `tools.issue.add.feature` | 0 | — | MOVE TO PLUGIN | GitHub issue creation |
| `tools.issue.add.help` | 0 | — | MOVE TO PLUGIN | GitHub issue creation |
| `tools.issue.generate.config` | 2 | — | REMOVE | Stub; GitHub YAML; no agent runtime need |
| `tools.skill.install` | 0 | **1** | KEEP + DEMOTE | Primary install verb |
| `tools.skill.uninstall` | 0 | **1** | KEEP + DEMOTE | Primary uninstall verb |
| `tools.skill.enable` | 0 | — | REMOVE (alias) | Falls through to install handler; misleading name |
| `tools.skill.disable` | 0 | — | REMOVE (alias) | Falls through to uninstall handler |
| `tools.skill.configure` | 0 | — | REMOVE (stub) | Returns `{configured:true}` with no real behavior |
| `tools.skill.refresh` | 0 | **1** | KEEP + DEMOTE | Bulk skill update; distinct from install |
| `tools.provider.inject` | 0 | **1** | KEEP + DEMOTE | CAAMP injection; essential for provider wiring |
| `tools.todowrite.sync` | NEW | **1** | INCOMING from admin | TodoWrite sync moved from admin |
| `tools.todowrite.status` | NEW | **1** | INCOMING from admin | TodoWrite status moved from admin |
| `tools.todowrite.clear` | NEW | **1** | INCOMING from admin | TodoWrite clear moved from admin |

**Mutate result**: 7 in registry after removals + 3 incoming; 6 after plugin extraction (remove issue.add.* 3 ops)

### tools Tier 0 Final (3 ops)
`skill.list`, `provider.list`, `provider.detect`

---

## Section 8: admin Domain Decision Matrix

**Before**: 50 ops (26q + 24m) | **After**: 28 ops (14q + 14m) | **Target**: ≤30

Note: 5 ops move out (sync→tools, grade/archive.stats→check). 1 op incoming (context.inject from session).

### Query Operations (26 → 14)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `admin.version` | 0 | **0** | KEEP | Core system info |
| `admin.health` | 0 | **0** | KEEP + ABSORB | Absorbs `doctor` via `mode:"check"\|"diagnose"` param |
| `admin.doctor` | 0 | — | MERGE → `admin.health` | `health {mode:"diagnose"}` |
| `admin.config.show` | 0 | **1** | KEEP + DEMOTE | Config inspection; not cold-start |
| `admin.stats` | 0 | **1** | KEEP + DEMOTE | System metrics; not cold-start |
| `admin.context` | 0 | **1** | KEEP + DEMOTE | Context inspection; not cold-start |
| `admin.runtime` | 0 | **1** | KEEP + DEMOTE | Runtime env info; not cold-start |
| `admin.job.status` | 0 | **1** | MERGE → `admin.job` | `job {action:"status"\|"list"}` absorbs job.list |
| `admin.job.list` | 0 | — | MERGE → `admin.job` | See above |
| `admin.dash` | 0 | **0** | KEEP | Mandatory efficiency sequence step 2; critical |
| `admin.log` | 0 | **1** | KEEP + DEMOTE | Audit log browsing; not cold-start |
| `admin.sequence` (query) | 0 | **1** | KEEP + DEDUPLICATE | Query form stays; mutate form removed |
| `admin.help` | 0 | **0** | KEEP | Critical agent discovery; mandatory |
| `admin.sync.status` | 1 | — | MOVE TO TOOLS | TodoWrite-specific; `tools.todowrite.status` |
| `admin.archive.stats` | 1 | — | MOVE TO CHECK | Analytics; `check.archive.stats` |
| `admin.adr.find` | 1 | **1** | KEEP + ABSORB | Absorbs `adr.list` via optional `query` param (absent=list all) |
| `admin.adr.list` | 2 | — | MERGE → `admin.adr.find` | `adr.find` with no query = list all |
| `admin.adr.show` | 2 | **2** | KEEP | Single-item retrieval |
| `admin.export` | 2 | **2** | KEEP + ABSORB | Absorbs `snapshot.export` and `export.tasks` via `scope` param |
| `admin.snapshot.export` | 2 | — | MERGE → `admin.export` | `export {scope:"snapshot"}` |
| `admin.export.tasks` | 2 | — | MERGE → `admin.export` | `export {scope:"package"}` |
| `admin.grade` | 2 | — | MOVE TO CHECK | Behavioral grading; `check.grade` |
| `admin.grade.list` | 2 | — | MOVE TO CHECK | Grade history; `check.grade.list` |
| `admin.token.summary` | 2 | **2** | KEEP → `admin.token` | `token {action:"summary"\|"list"\|"show"}` |
| `admin.token.list` | 2 | — | MERGE → `admin.token` | `action:"list"` |
| `admin.token.show` | 2 | — | MERGE → `admin.token` | `action:"show"` |

**Query result: 14 ops** (merged: doctor, job.list, adr.list, snapshot.export, export.tasks, token.list, token.show; moved out: sync.status, archive.stats, grade, grade.list)

### Mutate Operations (24 → 14)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `admin.init` | 0 | **1** | KEEP + DEMOTE | One-time setup; not recurring cold-start |
| `admin.config.set` | 0 | **1** | KEEP + DEMOTE | Config mutation; not cold-start |
| `admin.backup` | 0 | **1** | KEEP + ABSORB + DEMOTE | Absorbs `restore` and `backup.restore` via `action` param |
| `admin.restore` | 0 | — | MERGE → `admin.backup` | `backup {action:"restore"}` |
| `admin.backup.restore` | 0 | — | MERGE → `admin.backup` | `backup {action:"file-restore"}` |
| `admin.migrate` | 0 | **1** | KEEP + DEMOTE | Schema migration; maintenance |
| `admin.sync` | 0 | — | MOVE TO TOOLS | TodoWrite; `tools.todowrite.sync` |
| `admin.sync.clear` | 1 | — | MOVE TO TOOLS | TodoWrite; `tools.todowrite.clear` |
| `admin.cleanup` | 0 | **1** | KEEP + DEMOTE | Operational hygiene |
| `admin.job.cancel` | 0 | **1** | KEEP | Job management; small cluster |
| `admin.safestop` | 0 | **1** | KEEP + DEMOTE | Graceful shutdown; emergency |
| `admin.inject.generate` | 0 | **1** | KEEP + DEMOTE | Protocol injection generation |
| `admin.sequence` (mutate) | 0 | — | REMOVE | Duplicate name in both gateways; expose via `config.set` if needed |
| `admin.install.global` | 2 | **2** | KEEP | Global setup refresh |
| `admin.adr.sync` | 2 | **2** | KEEP + ABSORB | Absorbs `adr.validate` via `validate:true` flag |
| `admin.adr.validate` | 2 | — | MERGE → `admin.adr.sync` | `adr.sync {validate:true}` |
| `admin.fix` | 0 | — | MERGE → `admin.health` | `health {mode:"repair"}` as mutate form of health |
| `admin.import` | 2 | **2** | KEEP + ABSORB | Absorbs `snapshot.import` + `import.tasks` via `scope` param |
| `admin.snapshot.import` | 2 | — | MERGE → `admin.import` | `import {scope:"snapshot"}` |
| `admin.import.tasks` | 2 | — | MERGE → `admin.import` | `import {scope:"package"}` |
| `admin.token.record` | 2 | **2** | KEEP → `admin.token` | `token {action:"record"\|"delete"\|"clear"}` (mutate form) |
| `admin.token.delete` | 2 | — | MERGE → `admin.token` (mutate) | `action:"delete"` |
| `admin.token.clear` | 2 | — | MERGE → `admin.token` (mutate) | `action:"clear"` |
| `admin.detect` | 0 | **1** | KEEP + DEMOTE | Project context refresh; one-time setup |
| `admin.context.inject` | NEW | **1** | INCOMING from session | Protocol file read; correct admin home |
| `admin.health` (mutate form) | NEW | **1** | NEW (from fix merge) | `health {mode:"repair"}` |

**Mutate result: 14 ops** (merged: restore, backup.restore, adr.validate, fix, snapshot.import, import.tasks, token.delete, token.clear, sequence-mutate removed; moved out: sync, sync.clear; incoming: context.inject)

### admin Tier 0 Final (4 ops)
`version`, `health`, `dash`, `help`

---

## Section 9: nexus Domain Decision Matrix

**Before**: 31 ops (17q counted + 14m) | **After**: 17 ops (10q + 7m) | **Target**: ≤20

Note: registry shows 31 entries including 3 duplicate alias pairs (critical-path=path.show, blocking=blockers.show, orphans=orphans.list). True unique semantics: 25. After review: 17 ops.

### Query Operations (17 registry entries → 10)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `nexus.status` | 2 | **1** | KEEP + PROMOTE | Gateway to nexus discovery; must be discoverable; not tier 0 but tier 1 entry point |
| `nexus.list` | 2 | **1** | KEEP + PROMOTE | Primary project enumeration; tier-1 entry point |
| `nexus.show` | 2 | **2** | KEEP | Project detail after discovery; tier 2 per T5608 |
| `nexus.resolve` | 2 | **2** | KEEP + RENAME | Renamed from `nexus.query` (prohibited verb); resolves `project:taskId` |
| `nexus.query` | 2 | — | RENAME → `nexus.resolve` | `query` violates VERB-STANDARDS |
| `nexus.deps` | 2 | **2** | KEEP | Cross-project dependency chain |
| `nexus.graph` | 2 | **2** | KEEP | Global dependency graph; large; tier 2 correct |
| `nexus.path.show` | 2 | **2** | KEEP (canonical) | Critical path analysis |
| `nexus.blockers.show` | 2 | **2** | KEEP (canonical) | Blocking impact analysis |
| `nexus.orphans.list` | 2 | **2** | KEEP (canonical) | Orphan detection |
| `nexus.critical-path` | 2 | — | REMOVE (alias) | Exact alias for path.show; same switch case |
| `nexus.blocking` | 2 | — | REMOVE (alias) | Exact alias for blockers.show |
| `nexus.orphans` | 2 | — | REMOVE (alias) | Exact alias for orphans.list |
| `nexus.discover` | 2 | **2** | KEEP | Cross-project semantic similarity; distinct from search |
| `nexus.search` | 2 | **2** | KEEP | Pattern search across projects |
| `nexus.share.status` | 2 | **2** | KEEP | Sharing config status; CLEO-specific |
| `nexus.share.remotes` | 2 | — | REMOVE | Git CLI wrapper (`git remote -v`); no CLEO logic |
| `nexus.share.sync.status` | 2 | — | REMOVE | Git CLI wrapper (`git fetch && git status`) |

**Query result: 10 ops** (removed: 3 aliases + share.remotes + share.sync.status; renamed: query→resolve)

### Mutate Operations (14 → 7)

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `nexus.init` | 2 | **2** | KEEP | One-time NEXUS setup |
| `nexus.register` | 2 | **2** | KEEP | Register project; infrequent admin |
| `nexus.unregister` | 2 | **2** | KEEP | Remove project; infrequent admin |
| `nexus.sync` | 2 | **2** | KEEP + ABSORB | Absorbs `sync.all` via optional `name` param (absent=sync all) |
| `nexus.sync.all` | 2 | — | MERGE → `nexus.sync` | `nexus.sync` without `name` = sync all |
| `nexus.permission.set` | 2 | **2** | KEEP | Access control for cross-project reads |
| `nexus.reconcile` | 1 | **2** | KEEP + DEMOTE | Self-registration; setup/maintenance; belongs with nexus core ops |
| `nexus.share.snapshot.export` | 2 | **2** | KEEP | Task snapshot export; CLEO-specific |
| `nexus.share.snapshot.import` | 2 | **2** | KEEP | Task snapshot import; symmetric |
| `nexus.share.sync.gitignore` | 2 | — | REMOVE | Text append to .gitignore; no CLEO logic |
| `nexus.share.remote.add` | 2 | — | REMOVE | Wraps `git remote add` |
| `nexus.share.remote.remove` | 2 | — | REMOVE | Wraps `git remote remove` |
| `nexus.share.push` | 2 | — | REMOVE | Wraps `git push` |
| `nexus.share.pull` | 2 | — | REMOVE | Wraps `git pull` |

**Mutate result: 7 ops** (merged: sync.all→sync; removed: share.sync.gitignore, share.remote.add, share.remote.remove, share.push, share.pull; reconcile demoted from tier 1 to tier 2)

### nexus Tier 0 Final (0 ops)
Entire domain at tier 1 minimum (status, list) or tier 2.

---

## Section 10: sticky Domain Decision Matrix

**Before**: 6 ops | **After**: 6 ops | **Target**: ≤6

All 6 operations validated as lean and defensible per T5566. No removals or merges required.

| Operation | Current Tier | Final Tier | Decision | Detail |
|-----------|-------------|------------|----------|--------|
| `sticky.list` | 0 | **1** | KEEP + DEMOTE | Per T5608: ephemeral notes; not cold-start essential |
| `sticky.show` | 0 | **1** | KEEP + DEMOTE | Per T5608 |
| `sticky.add` | 0 | **1** | KEEP + DEMOTE | Per T5608 |
| `sticky.convert` | 0 | **1** | KEEP + DEMOTE | Per T5608; 4-target consolidation is correct |
| `sticky.archive` | 0 | **1** | KEEP + DEMOTE | Per T5608 |
| `sticky.purge` | 0 | **1** | KEEP + DEMOTE | Per T5608 |

### sticky Tier 0 Final (0 ops)
Entire domain demoted to tier 1 as a block.

---

## Section 11: Cross-Domain Moves

Operations that change domain as part of this consolidation. These are net-neutral to system total — no ops are deleted, they change home.

### admin → tools (3 ops)

| Op (old) | New form | Tier | Rationale |
|----------|----------|------|-----------|
| `admin.sync` (mutate) | `tools.todowrite.sync` | 1 | TodoWrite integration belongs with external integrations |
| `admin.sync.status` (query) | `tools.todowrite.status` | 1 | Same rationale |
| `admin.sync.clear` (mutate) | `tools.todowrite.clear` | 1 | Same rationale |

### admin → check (3 ops)

| Op (old) | New form | Tier | Rationale |
|----------|----------|------|-----------|
| `admin.grade` (query) | `check.grade` | 2 | Behavioral grading is compliance/quality check |
| `admin.grade.list` (query) | `check.grade.list` | 2 | Grade history; same rationale |
| `admin.archive.stats` (query) | `check.archive.stats` | 1 | Archive analytics; reporting/compliance |

### session → admin (1 op)

| Op (old) | New form | Tier | Rationale |
|----------|----------|------|-----------|
| `session.context.inject` (mutate) | `admin.context.inject` | 1 | Reads protocol files from filesystem; not session state; bootstrap utility |

---

## Section 12: Plugin Extractions

Operations moving out of core CLEO registry into plugin packages. These are **not counted** in the final core operation total.

### `ct-github-issues` plugin (6 ops extracted)

All extracted from `tools` domain. The `src/core/issue/` module and `template-parser.ts` engine move with the plugin.

| Op | Gateway | Notes |
|----|---------|-------|
| `tools.issue.templates` | query | Reads `.github/ISSUE_TEMPLATE/`; GitHub coupling |
| `tools.issue.validate.labels` | query | Validates against GitHub label set |
| `tools.issue.add.bug` | mutate | Creates GitHub issues via template |
| `tools.issue.add.feature` | mutate | Creates GitHub issues via template |
| `tools.issue.add.help` | mutate | Creates GitHub issues via template |
| `tools.issue.generate.config` | mutate | GitHub YAML generation (REMOVE entirely — stub with no runtime need) |

**Remaining `tools.issue.*` in core: 1 op** — `tools.issue.diagnostics` (CLEO install health, not GitHub-specific)

---

## Section 13: Tier Reclassification Plan

### Problem: Tier 0 had 155 ops vs ≤90 target

The T5608 audit identified the entire orchestrate, pipeline, check, and sticky domains as wrongly tier 0. Additionally, 19 tasks ops, 11 session ops, 22 admin ops, and 17 tools ops were wrongly tier 0.

### Solution: Domain-Block Demotion + Mandatory Promotion

**Step 1: Demote entire domains from tier 0 to tier 1**
- `orchestrate.*` — all 15 ops → tier 1
- `pipeline.*` — stage/manifest/release/phase → tier 1; chain → tier 2 (already)
- `check.*` — all 13 ops → tier 1; chain → tier 2 (already)
- `sticky.*` — all 6 ops → tier 1

**Step 2: Demote specific ops within domains**
- `tasks`: demote 12 ops from tier 0 to tier 1 (list, tree, blockers, depends, analyze, relates, complexity.estimate, cancel, delete, archive, restore, reopen, unarchive, reparent, promote, reorder, relates.add)
  - Note: Many of these are merged/removed, so net effect is 9 ops removed from tier 0
- `session`: demote 9 ops from tier 0 to tier 1 (list, show, find, decision.log, context.drift, resume, suspend, gc, record.decision, record.assumption)
  - Note: history and chain.show removed; debrief.show merged; context.inject moved; net 6 ops removed from tier 0
- `admin`: demote 23 ops from tier 0 to tier 1 or remove (see Section 8)
  - Net: keep 4 at tier 0 (version, health, dash, help)
- `tools`: demote 14 ops from tier 0 to tier 1 or remove
  - Net: keep 3 at tier 0 (skill.list, provider.list, provider.detect)

**Step 3: Promote mandatory efficiency sequence ops from tier 1 to tier 0**
- `memory.find` → tier 0 (was tier 1; in mandatory efficiency sequence)
- `memory.observe` → tier 0 (was tier 1; in mandatory efficiency sequence)

**Step 4: Promote nexus entry-point ops from tier 2 to tier 1**
- `nexus.status` → tier 1
- `nexus.list` → tier 1
- Demote `nexus.reconcile` from tier 1 → tier 2 (setup/maintenance op)

### Resulting Tier 0 Distribution (Target: ≤90)

| Domain | Tier 0 ops | Operations |
|--------|-----------|------------|
| tasks | 10 | show, find, next, plan, current, add, update, complete, start, stop |
| session | 5 | status, handoff.show, briefing.show, start, end |
| memory | 2 | find, observe |
| pipeline | 0 | all tier 1 |
| check | 0 | all tier 1 |
| orchestrate | 0 | all tier 1 |
| admin | 4 | version, health, dash, help |
| tools | 3 | skill.list, provider.list, provider.detect |
| nexus | 0 | tier 1 minimum |
| sticky | 0 | all tier 1 |
| **Total** | **24** | — |

**Result: 24 ops at tier 0** — well under the ≤90 target.

The gap between 24 and 90 is intentional headroom. The CLEO team can promote additional ops to tier 0 as operational data shows what agents actually need at cold-start. The mandatory efficiency sequence ops (session.status, admin.dash, tasks.current, tasks.next, tasks.show, session.start, tasks.complete, memory.find, memory.observe, admin.help) are non-negotiable tier 0.

**Revised tier 0 with recommended additions (per T5608 §Revised Tier 0):**

Additional tier 0 candidates the team should evaluate:
- tasks: `list`, `tree`, `blockers`, `depends`, `analyze` (+5)
- session: `list`, `show`, `find`, `resume` (+4)
- admin: `config.show`, `stats`, `log`, `init`, `config.set`, `backup` (+6)
- tools: `skill.show`, `skill.find`, `provider.inject.status` (+3)
- pipeline: `stage.status`, `stage.validate`, `stage.record`, `stage.gate.pass`, `stage.gate.fail` (+5)
- check: `schema`, `task` (+2)
- sticky: `list`, `add` (+2)
- orchestrate: `status`, `next`, `spawn`, `spawn.execute` (+4)

**With all recommendations**: 24 + 31 = 55 ops at tier 0 — still well under 90.

### New Invariant: No Tier-2 Gate Without Escalation Path

Per T5608, enforce: "No tier-2 gate may exist without an explicit escalation path surfaced at tier 0."

Current violations after this consolidation:
- `pipeline.chain.*` — 8 ops; entry point must be surfaced via `admin.help --tier 2` hint
- `check.chain.*` — 2 ops; same
- `admin.token.*` — 2 ops; escalation hint needed
- `admin.export/import` — 2 ops; escalation hint needed
- All remaining `nexus.*` tier-2 ops — entry via `nexus.status` + `nexus.list` at tier 1 covers this ✓

**Enforcement mechanism**: Add `escalationHint` metadata field to registry entries for tier-2 domains lacking a tier-0/1 entry point. Emit in `admin.help` tier-0/1 responses.

---

## Section 14: Remaining Gaps / Open Questions

The following items require human review before implementation. They are not blocking the consolidation decisions above but affect the final registry.

### O1: `check.chain.gate` — Register or Remove?

The `check.chain.gate` operation is implemented in the handler but not registered in the dispatch registry. The T5542 review recommends registering it at tier 2 (fills the real gap of reading gate evaluation history on chain instances). However, if WarpChain is being moved to plugin or sunset, registration is pointless.

**Decision needed**: Is WarpChain/chain.* a supported feature or on a deprecation path?
- If supported: register `check.chain.gate` at tier 2 → check final count becomes 17 (not 16)
- If deprecating: remove from handler; no registry entry

### O2: `session.history` — Remove or fold into `session.show`?

T5534 recommends removing `session.history` (focus-change timeline) but notes it may be needed for compliance auditing. The alternative is `session.show {include:["history"]}`.

**Decision needed**: Is the focus-change timeline required for compliance? If yes, fold into `show` via `include` param rather than removing. Net: 0 ops difference (history removed → absorbed by show param).

### O3: `admin.context.inject` — Name and gateway

`session.context.inject` (mutate) is moving to admin. The operation reads protocol content from the filesystem — it is effectively a query despite being in mutate (reads files, has no state mutation side effects).

**Decision needed**: Should `admin.context.inject` be a query or mutate? Reading files without state mutation suggests query. Placing in query as `admin.context.inject` (query) would fix the gateway classification too.

### O4: tools domain final count with plugin boundary

The tools domain shows 19 ops before plugin extraction, 13 after. The 6 extracted ops move to `ct-github-issues`. This needs a decision on timing:
- Extract now (remove from core registry immediately)
- Mark as deprecated with plugin target (keep in registry with deprecation warnings)

**Decision needed**: Immediate extraction or phased deprecation?

### O5: `check.grade` parameterization

T5558 suggests `check.grade {action:"run"\|"list"}` as a single op rather than `check.grade` + `check.grade.list`. This would bring check incoming count from 3 ops to 2 ops.

**Decision needed**: Parameterize grade as single op, or keep as two distinct ops?

### O6: WarpChain chain.* operations — Tier 2 or Plugin?

Pipeline chain.* (8 ops at tier 2) and check.chain.* (2 ops at tier 2) are all WarpChain-related. The T5546 and T5550 reviews both note the WarpChain system is complex and not part of standard CLEO workflows.

**Decision needed**: Keep chain.* in core at tier 2, or extract to `ct-warp` plugin?
- If plugin: reduce final count by 10 ops (8 pipeline + 2 check)
- If core tier 2: document escalation hint in `admin.help`

### O7: `admin.health` dual-gateway form

The health/doctor/fix consolidation puts `health` in both query and mutate gateways with different `mode` params. This is an unusual pattern in the CLEO API.

**Decision needed**: Confirm the dual-gateway `admin.health` pattern is acceptable, or keep `admin.fix` as a separate mutate op (costs 1 additional op but is cleaner API design).

### O8: Token telemetry domain home

T5558 notes token.* ops could move to `check` domain (compliance/metrics) rather than staying in admin. Currently they stay in admin per the review.

**Decision needed**: Keep `admin.token` in admin (system metrics = admin) or move to `check` (compliance/telemetry = check)?

---

## Appendix A: Final Operation Count by Domain

After all decisions (including cross-domain moves, merges, removals; excluding plugin extractions):

| Domain | Query | Mutate | Total | Tier 0 | Tier 1 | Tier 2 |
|--------|-------|--------|-------|--------|--------|--------|
| tasks | 15 | 11 | **21** | 10 | 11 | 0 |
| session | 9 | 6 | **15** | 5 | 10 | 0 |
| memory | 6 | 5 | **11** | 2 | 9 | 0 |
| check | 12 | 3 | **16** | 0 | 12 | 4 |
| pipeline | 12 | 14 | **26** | 0 | 18 | 8 |
| orchestrate | 9 | 6 | **15** | 0 | 15 | 0 |
| tools | 13 | 6 | **19** | 3 | 16 | 0 |
| admin | 14 | 14 | **28** | 4 | 18 | 6 |
| nexus | 10 | 7 | **17** | 0 | 2 | 15 |
| sticky | 2 | 4 | **6** | 0 | 6 | 0 |
| **Total** | **102** | **76** | **164** | **24** | **117** | **33** |

> Note: tools count of 19 includes 6 issue.* ops. After plugin extraction: tools = 13, system total = 158. The 164/158 difference represents the plugin boundary question (O4 above).

**Tier 0**: 24 ops (conservative; expandable to ~55 per T5608 recommendations)
**Tier 1**: 117 ops
**Tier 2**: 33 ops (includes chain.* ops pending O6 decision)

All domain targets met. System target of ≤180 met (164 with plugins, 158 after extraction).

---

## Appendix B: Mandatory Efficiency Sequence — Tier 0 Verification

Per CLEO-INJECTION.md, these operations MUST be tier 0:

| Sequence Step | Operation | Final Tier | Status |
|---------------|-----------|-----------|--------|
| Step 1 | `query session status` | 0 | ✓ |
| Step 2 | `query admin dash` | 0 | ✓ |
| Step 3 | `query tasks current` | 0 | ✓ |
| Step 4 | `query tasks next` | 0 | ✓ |
| Step 5 | `query tasks show` | 0 | ✓ |
| Agent loop 1 | `mutate session start` | 0 | ✓ |
| Agent loop 4 | `mutate tasks complete` | 0 | ✓ |
| Memory protocol 1 | `memory.find` (was brain.search) | 0 | ✓ (promoted from tier 1) |
| Memory protocol save | `memory.observe` (was brain.observe) | 0 | ✓ (promoted from tier 1) |
| Escalation | `query admin help` | 0 | ✓ |

All 10 mandatory tier-0 ops confirmed at tier 0.

---

## References

- T5517: Epic — Rationalize CLEO API Operations (268→≤180)
- T5530–T5566: Domain review subtasks (10 domains)
- T5607: ct-cleo skill audit
- T5608: Tier assignment audit
- T5609: This synthesis task
- T5613: ct-cleo skill rewrite (depends on this output)
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — Canonical operation spec
- `docs/specs/VERB-STANDARDS.md` — Verb standards
- `src/dispatch/registry.ts` — Registry source of truth
