# T5546 — pipeline Domain Review

**Task**: T5546
**Epic**: T5517
**Date**: 2026-03-08
**Status**: complete

---

## Summary

The pipeline domain currently holds 42 operations across 5 sub-domains (stage, phase, release, manifest, chain). The chain sub-domain (8 ops) is the primary candidate for removal or demotion to tier 2. Release step operations (5 ops) can collapse into a workflow parameter. Phase CRUD (4 ops) can merge. Projected: 42 → 26 ops, within the ≤30 target.

---

## Prior Analysis Summary (T5509)

T5509 ("Review pipeline domain - consolidate 37 operations to ~24") identified four concerns:

1. **Phase vs Stage redundancy** (8 ops → 5): phase.set/start/complete/advance → phase.transition
2. **Release workflow consolidation** (7 ops → 3): release.start, release.status, release.rollback
3. **Chain operations** (6 ops at time of writing): unclear distinction from phases/stages
4. **Manifest ops** (7 ops): question whether manifest deserves its own domain

Current count has grown to 42 (T5509 saw ~37), mostly from chain additions (T5405). The chain sub-domain is now 8 operations and is the largest single target.

---

## Complete Operation Inventory

### Query operations (18)

| # | Operation | Sub-domain | Notes |
|---|-----------|------------|-------|
| 1 | stage.validate | stage | Validates transition eligibility for an epic |
| 2 | stage.status | stage | Current RCASD-IVTR stage for an epic |
| 3 | stage.history | stage | Audit trail of stage transitions for a task |
| 4 | stage.gates | stage | Gate definitions for a task |
| 5 | stage.prerequisites | stage | Prerequisites for a target stage |
| 6 | manifest.show | manifest | Single manifest entry by ID |
| 7 | manifest.list | manifest | List entries (paginated) |
| 8 | manifest.find | manifest | FTS search across entries |
| 9 | manifest.pending | manifest | Entries not yet actionable |
| 10 | manifest.stats | manifest | Summary stats (optionally filtered by epic) |
| 11 | release.list | release | List releases |
| 12 | release.show | release | Single release by version |
| 13 | release.channel.show | release | Branch → channel → dist-tag mapping |
| 14 | phase.show | phase | Show one or current phase |
| 15 | phase.list | phase | List all phases (paginated) |
| 16 | chain.show | chain | Single chain definition |
| 17 | chain.list | chain | All chain definitions |
| 18 | chain.find | chain | Filtered chain discovery |

### Mutate operations (24)

| # | Operation | Sub-domain | Notes |
|---|-----------|------------|-------|
| 1 | stage.record | stage | Record stage progress |
| 2 | stage.skip | stage | Skip a stage with reason |
| 3 | stage.reset | stage | Reset a stage with reason |
| 4 | stage.gate.pass | stage | Mark gate passed for task |
| 5 | stage.gate.fail | stage | Mark gate failed for task |
| 6 | release.prepare | release | Initialize release record |
| 7 | release.changelog | release | Generate changelog for version |
| 8 | release.commit | release | Commit release files |
| 9 | release.tag | release | Create git tag |
| 10 | release.push | release | Push tag to remote |
| 11 | release.gates.run | release | Run pre-release gate checks |
| 12 | release.rollback | release | Roll back a release |
| 13 | release.cancel | release | Cancel a prepared release |
| 14 | release.ship | release | Orchestrated full release (prepare+changelog+commit+tag+push) |
| 15 | manifest.append | manifest | Append new entry to JSONL |
| 16 | manifest.archive | manifest | Archive entries older than date |
| 17 | phase.set | phase | Set active phase by slug |
| 18 | phase.start | phase | Mark phase as started |
| 19 | phase.complete | phase | Mark phase complete |
| 20 | phase.advance | phase | Auto-advance to next phase |
| 21 | phase.rename | phase | Rename a phase |
| 22 | phase.delete | phase | Delete a phase |
| 23 | chain.add | chain | Register a WarpChain definition |
| 24 | chain.instantiate | chain | Bind a chain to an epic |
| 25 | chain.advance | chain | Advance instance to next stage |
| 26 | chain.gate.pass | chain | Record gate pass on instance |
| 27 | chain.gate.fail | chain | Record gate fail on instance |

Total: **42 operations** (18q + 24m, but getSupportedOperations() lists 27m — chain.gate.pass/fail are in mutate implementation but 25 in getSupportedOperations list; actual count from code is 18q + 24m = 42).

---

## Decision Matrix

| Operation | Decision | Reason |
|-----------|----------|--------|
| **stage.validate** | KEEP | Core lifecycle gate check; agents need this to know if a transition is allowed |
| **stage.status** | KEEP | Core; shows current RCASD position |
| **stage.history** | KEEP | Audit trail; needed for compliance/debugging |
| **stage.gates** | MERGE → stage.status | Gates are part of status. Add `include: "gates"` param to stage.status |
| **stage.prerequisites** | MERGE → stage.validate | Static info; fold as optional return field in stage.validate response |
| **stage.record** | KEEP | Core write op for stage transitions |
| **stage.skip** | KEEP | Needed; workflows have skippable stages |
| **stage.reset** | KEEP | Needed for error recovery |
| **stage.gate.pass** | KEEP | Core gate lifecycle |
| **stage.gate.fail** | KEEP | Core gate lifecycle |
| **manifest.show** | KEEP | Core read |
| **manifest.list** | KEEP | Core read |
| **manifest.find** | KEEP | Core discovery |
| **manifest.pending** | MERGE → manifest.list | Add `filter: "pending"` param to manifest.list |
| **manifest.stats** | KEEP | Summary view that agents query frequently for dashboards |
| **manifest.append** | KEEP | Core write; subagent protocol requires this |
| **manifest.archive** | KEEP | Maintenance op |
| **release.list** | KEEP | Discovery |
| **release.show** | KEEP | Detail view |
| **release.channel.show** | KEEP | Branch→channel mapping is useful and not in any other domain |
| **release.ship** | KEEP | This is the primary release op — orchestrated wrapper |
| **release.prepare** | PARAMETERIZE → release.ship | ship with `step: "prepare"` param or just use ship |
| **release.changelog** | PARAMETERIZE → release.ship | ship with `step: "changelog"` |
| **release.commit** | PARAMETERIZE → release.ship | ship with `step: "commit"` |
| **release.tag** | PARAMETERIZE → release.ship | ship with `step: "tag"` |
| **release.push** | PARAMETERIZE → release.ship | ship with `step: "push"` |
| **release.gates.run** | PARAMETERIZE → release.ship | ship with `step: "gates"` |
| **release.rollback** | KEEP | Distinct destructive op; should remain explicit |
| **release.cancel** | KEEP | Distinct cancel path |
| **phase.show** | KEEP | Core read |
| **phase.list** | KEEP | Core read |
| **phase.set** | KEEP | Primary phase transition |
| **phase.start** | MERGE → phase.set | phase.set with `action: "start"` param, or collapse start into set |
| **phase.complete** | MERGE → phase.set | phase.set with `action: "complete"` |
| **phase.advance** | KEEP | Auto-advance is distinct from explicit set |
| **phase.rename** | KEEP | CRUD — rename is common enough |
| **phase.delete** | KEEP | CRUD |
| **chain.show** | MOVE TO TIER 2 | WarpChain definitions are not used in standard CLEO workflows |
| **chain.list** | MOVE TO TIER 2 | As above |
| **chain.find** | MOVE TO TIER 2 | As above |
| **chain.add** | MOVE TO TIER 2 | Registration of chain definitions — admin/setup operation |
| **chain.instantiate** | MOVE TO TIER 2 | Binding chains to epics is advanced usage |
| **chain.advance** | MOVE TO TIER 2 | Runtime instance advancement — advanced usage |
| **chain.gate.pass** | MOVE TO TIER 2 | Chain-specific gate — advanced |
| **chain.gate.fail** | MOVE TO TIER 2 | Chain-specific gate — advanced |

---

## Chain Analysis — Plugin or Tier 2

### Assessment

The WarpChain system (T5405, T5407) is an advanced composable workflow engine layered on top of the standard RCASD-IVTR lifecycle. It introduces a separate concepts hierarchy: WarpChain definitions → WarpChainInstances → WarpChainExecutions with GateResults.

**Key evidence it is not tier 0:**
- Chain operations are never called in the standard agent work loop described in CLEO-INJECTION.md
- stage.* already covers RCASD-IVTR gates; chain.gate.* duplicates this concept at a higher abstraction
- Agents discovering the system via `admin.help` at tier 0 would receive 8 extra operations for a workflow engine they may never need
- chain.instantiate requires prior knowledge of a chain ID, which requires chain.find — a two-step discovery pattern that signals tier 2 usage
- The WarpChain schema is complex (WarpStage, WarpLink, ChainShape, GateContract with discriminated unions) — appropriate for expert/advanced users

**Recommendation: MOVE ALL chain.* TO TIER 2**

This removes 8 operations from the tier 0 surface (3q + 5m). Chain operations should be documented in tier 2 help and accessible via `admin.help --tier 2` or a `ct-warp` skill. The underlying implementation stays in place; only the tier 0 registration changes.

**Alternative if chain.* cannot be tiered:** Merge chain.gate.pass/fail into chain.advance with a `gateResults` param (already present in chain.advance signature). This would collapse 5 mutate ops to 3: chain.add, chain.instantiate, chain.advance. But tier 2 demotion is cleaner.

---

## Phase Consolidation

### Phase vs Stage distinction

- **stage**: RCASD-IVTR lifecycle — research, consensus, architecture, specification, decomposition, implementation, validation, testing, release, contribution. These are per-epic/per-task audit trail entries with gate enforcement.
- **phase**: A higher-level project organization concept. Phases group work across tasks (e.g., "Sprint 1", "Q1 goals"). They live in tasks.db but represent project rhythm, not task lifecycle.

The distinction is real and should be preserved. However, phase.start, phase.set, and phase.complete are semantically overlapping write operations.

### Merge: phase.start + phase.complete → phase.set with action param

```
phase.set { phaseId, action: "start" | "complete" | "set" }
```

This consolidates 3 ops → 1 op with a discriminated action param, matching the pattern used by tasks.update. phase.advance remains separate because it does not target a specific phaseId.

**Phase net result**: 8 ops → 6 ops (−2)

---

## Release Step Consolidation

### Problem

release.prepare, release.changelog, release.commit, release.tag, release.push, release.gates.run are individual steps in an orchestrated release workflow. release.ship already wraps all of them. Keeping the step-level operations exposes implementation detail as API surface.

### Consolidation: Parameterize into release.ship

```
release.ship { version, epicId, step?: "prepare" | "changelog" | "commit" | "tag" | "push" | "gates" }
```

When `step` is omitted, ship runs the full orchestrated flow (current behavior). When `step` is provided, ship runs only that step. This preserves the ability to run individual steps without exposing 6 separate operations.

**Release net result**: 9m + 3q = 12 ops → 5 ops (−7): release.list, release.show, release.channel.show, release.ship, release.rollback, release.cancel

Wait — re-counting: release.rollback and release.cancel are also kept. So: 3q + 3m = 6 ops (−6 from removing 5 step ops and keeping cancel + rollback).

---

## Manifest Analysis

The manifest sub-domain replaced the former research.* domain (per T5241 memory cutover). These 7 ops are actively used by subagents following the BASE protocol (manifest.append is mandatory per MANIFEST.jsonl write requirement).

- manifest.pending merges into manifest.list (add `filter` param) — saves 1 op
- All other manifest ops are essential

**Manifest net result**: 7 ops → 6 ops (−1)

---

## Stage Analysis

stage.gates and stage.prerequisites are supplementary query ops that expand stage.status/stage.validate respectively.

- Merge stage.gates into stage.status with `include: "gates"` param
- Merge stage.prerequisites into stage.validate response (always return prerequisites on validate call)

**Stage net result**: 10 ops → 8 ops (−2)

---

## Tier 0 Projected Count After All Changes

| Sub-domain | Before | After | Delta |
|------------|--------|-------|-------|
| stage | 10 | 8 | −2 |
| manifest | 7 | 6 | −1 |
| release | 12 | 6 | −6 |
| phase | 8 | 6 | −2 |
| chain | 8 | 0 | −8 |
| **Total** | **42** | **26** | **−16** |

**Projected: 26 operations** — within the ≤30 target.

Chain operations (8) move to tier 2 documentation, accessible via `admin.help --tier 2` or skill injection. Implementation is unchanged.

---

## Recommended Final Operation Set (26 ops)

### Query (13)
- stage.status (absorbs stage.gates via `include` param)
- stage.validate (absorbs stage.prerequisites in response)
- stage.history
- manifest.show
- manifest.list (absorbs manifest.pending via `filter` param)
- manifest.stats
- manifest.find
- release.list
- release.show
- release.channel.show
- phase.show
- phase.list

### Mutate (13)
- stage.record
- stage.skip
- stage.reset
- stage.gate.pass
- stage.gate.fail
- manifest.append
- manifest.archive
- release.ship (absorbs prepare/changelog/commit/tag/push/gates.run via `step` param)
- release.rollback
- release.cancel
- phase.set (absorbs phase.start/phase.complete via `action` param)
- phase.advance
- phase.rename
- phase.delete

Wait — that is 12q + 14m = 26 total. Corrected: stage.status and stage.validate + stage.history = 3; manifest = 4; release = 3; phase = 2 → 12 query. For mutate: stage (5) + manifest (2) + release (3) + phase (4) = 14 mutate. Total = 26.

---

## Migration Notes

### Backward Compatibility Impact

| Removed Operation | Migration Path |
|-------------------|----------------|
| stage.gates | Use stage.status with `include: ["gates"]` param |
| stage.prerequisites | Check stage.validate response — prerequisites now always returned |
| manifest.pending | Use manifest.list with `filter: "pending"` |
| release.prepare | Use release.ship with `step: "prepare"` |
| release.changelog | Use release.ship with `step: "changelog"` |
| release.commit | Use release.ship with `step: "commit"` |
| release.tag | Use release.ship with `step: "tag"` |
| release.push | Use release.ship with `step: "push"` |
| release.gates.run | Use release.ship with `step: "gates"` |
| phase.start | Use phase.set with `action: "start"` |
| phase.complete | Use phase.set with `action: "complete"` |
| chain.* (all 8) | Tier 2 — accessible via admin.help --tier 2 |

### Implementation Order

1. Chain.* tier 2 demotion (registry change only, no logic change) — zero risk
2. Manifest.pending → manifest.list filter (additive param, old op removed)
3. Phase.start/complete → phase.set action param (additive, then remove)
4. Stage.gates → stage.status include param (additive, then remove)
5. Stage.prerequisites → stage.validate response inclusion (additive, then remove)
6. Release step ops → release.ship step param (additive, then remove 6 ops)

---

## References

- T5509: Prior analysis (37→24 consolidation ideas)
- T5547: Inventory subtask
- T5548: LAFS/MVI challenge subtask
- T5549: Per-operation disposition subtask
- T5405, T5407: WarpChain implementation tasks
- T5241: Memory/manifest domain cutover (why manifest.* is in pipeline)
- src/dispatch/domains/pipeline.ts — implementation source
- src/types/warp-chain.ts — WarpChain type system
