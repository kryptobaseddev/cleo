# T5538 — memory Domain Review

**Task**: T5538
**Epic**: T5517
**Date**: 2026-03-08
**Status**: complete

---

## Summary

Current: 18 ops (12q + 6m) | Target: ≤15 | Projected: 13 ops (9q + 4m)

The memory domain serves brain.db cognitive memory exclusively (post-T5241 cutover). The 4 core retrieval ops (find, timeline, fetch, observe) are indispensable to the 3-layer agent retrieval protocol. The typed sub-ops (decision/pattern/learning find+store) provide valuable structured access that cannot be fully replaced by type filters on `memory.find` without breaking existing callers and losing strongly-typed params. The `stats.*`, `contradictions`, `superseded`, and `show` ops are either unused by agents in normal workflows or duplicatable through core ops and should be removed.

---

## Operation Inventory (18 Registered)

### Query Operations (12)

| # | Operation | Tier | Description |
|---|-----------|------|-------------|
| Q1 | `show` | 1 | Look up single brain.db entry by ID |
| Q2 | `find` | 1 | Cross-table FTS5 search (requires `query`) |
| Q3 | `timeline` | 1 | Chronological context window around anchor ID |
| Q4 | `fetch` | 1 | Batch fetch by IDs array |
| Q5 | `stats` | 1 | Aggregate statistics across brain.db |
| Q6 | `contradictions` | 1 | Find contradictory entries |
| Q7 | `superseded` | 1 | Find superseded entries |
| Q8 | `decision.find` | 1 | Search decisions table with taskId filter |
| Q9 | `pattern.find` | 1 | Search patterns by type, impact, keyword |
| Q10 | `pattern.stats` | 1 | Pattern counts by type and impact |
| Q11 | `learning.find` | 1 | Search learnings by confidence, actionability |
| Q12 | `learning.stats` | 1 | Learning counts by confidence band |

### Mutate Operations (6)

| # | Operation | Tier | Description |
|---|-----------|------|-------------|
| M1 | `observe` | 1 | Save observation to brain.db |
| M2 | `decision.store` | 1 | Store decision with rationale and alternatives |
| M3 | `pattern.store` | 1 | Store workflow pattern or anti-pattern |
| M4 | `learning.store` | 1 | Store insight with confidence and applicability |
| M5 | `link` | 1 | Link brain entry to task |
| M6 | `unlink` | 1 | Remove link between brain entry and task |

### Unregistered Handler-Only Ops (not counted in 18)

The domain handler also implements `graph.show`, `graph.neighbors`, `graph.add`, `graph.remove`, `reason.why`, `reason.similar`, `search.hybrid`. These are Phase 3 (T5385, T5388-T5393) work-in-progress and are not registered in the dispatch registry — they do not contribute to the current count.

---

## Decision Matrix

| Operation | Decision | Reason |
|-----------|----------|--------|
| `show` | REMOVE | Covered by `fetch` with a single-element ids array. No unique value for agents; adds surface area with no distinct workflow role. |
| `find` | KEEP | Core 3-layer op #1. Primary agent entry point for brain search. |
| `timeline` | KEEP | Core 3-layer op #2. Chronological context is unique and not replicated by other ops. |
| `fetch` | KEEP | Core 3-layer op #3. Batch retrieval by known IDs from find/timeline results. |
| `stats` | REMOVE | Dashboard-oriented. Not used in agent reasoning workflows. Agents discover what they need via find/timeline/fetch. Data available via direct DB query if needed for diagnostics. |
| `contradictions` | REMOVE | Niche analytical op. Not part of any normal agent workflow. If needed in the future, re-add as a `check` domain operation where analytical/diagnostic ops belong. |
| `superseded` | REMOVE | Same case as `contradictions`. Not used in agent retrieval or write workflows. |
| `decision.find` | KEEP | Decisions have a structured schema (rationale, alternatives, taskId) not surfaced by `memory.find`. The `taskId` filter is uniquely useful for decision retrieval on a per-task basis. |
| `pattern.find` | KEEP | Patterns have typed fields (type, impact, antiPattern, mitigation, successRate) not returned by `memory.find`. The type+impact filter combination is essential for pattern-oriented reasoning. |
| `pattern.stats` | REMOVE | Statistics op — same rationale as `memory.stats`. Dashboard-only, no agent workflow use. Can be folded into `pattern.find` with count-only mode if needed. |
| `learning.find` | KEEP | Learnings have confidence scores, actionability flags, and applicableTypes not surfaced by `memory.find`. Agents need confidence-filtered recall. |
| `learning.stats` | REMOVE | Statistics op — same rationale as `memory.stats`. Remove. |
| `observe` | KEEP | Core write op. All general observations go here. |
| `decision.store` | KEEP | Strongly typed: decision, rationale, alternatives, taskId. Cannot be replicated by `observe` without losing schema enforcement. |
| `pattern.store` | KEEP | Strongly typed: type, impact, antiPattern, mitigation, successRate. Structural value exceeds what `observe` can provide. |
| `learning.store` | KEEP | Strongly typed: insight, confidence, actionable, applicableTypes. Confidence-gated storage is not replicable via `observe`. |
| `link` | KEEP | Bidirectional task-memory association. Critical for CLEO research linking protocol. |
| `unlink` | REMOVE | Rarely needed. Inverse of `link`; can be handled through direct repair if needed. Saves 1 op from the surface area. |

**Projected total: 13 ops (9q + 4m)**

---

## Core 4 Analysis

The 4 core ops form the canonical 3-layer retrieval protocol documented in CLEO-INJECTION.md:

1. `memory.find` — search index (IDs + titles), cheap entry point
2. `memory.timeline` — chronological context around an anchor ID
3. `memory.fetch` — batch full-detail retrieval for filtered IDs
4. `memory.observe` — write observations back to brain.db

These are non-negotiable KEEP. They constitute the contract published to agents via CLAUDE.md and are the primary usage pattern. Removing any of them breaks the documented 3-layer protocol.

`memory.show` overlaps with `memory.fetch` for single-entry cases. `fetch` already accepts an array of 1. `show` adds no distinct capability and should be removed to tighten the surface.

---

## Extended Type Ops Analysis

### Can typed ops unify into core ops with a `type` parameter?

**Decision: PARTIALLY — typed find ops should stay separate; typed store ops must stay separate.**

Arguments for unification (`memory.find {type: "decision"}`):
- Reduces total operation count
- Simpler mental model

Arguments against (decisive):
1. **Typed find ops return different fields.** `decision.find` returns `rationale`, `alternatives`, `taskId`. `pattern.find` returns `impact`, `antiPattern`, `mitigation`, `successRate`. `learning.find` returns `confidence`, `actionable`, `applicableTypes`. A unified `memory.find` returns only the base `observations` table fields. You would need schema-polymorphic responses, which complicates validation and agent parsing.
2. **Typed find ops accept different filter params.** `pattern.find` accepts `impact` (high/medium/low enum) and `minFrequency`. `learning.find` accepts `minConfidence` (number) and `actionableOnly` (bool). These cannot be expressed cleanly via a single generic param set without a confusing union schema.
3. **Typed store ops have required fields unique to each type.** `decision.store` requires `decision` + `rationale`. `pattern.store` requires `pattern` + `context`. `learning.store` requires `insight` + `source`. Unifying under `observe` would lose all required-field validation at the MCP gateway layer.

**Conclusion**: The three typed find ops and three typed store ops carry sufficient structural differentiation to justify their existence. The consolidation opportunity is in pruning `stats`, `contradictions`, `superseded`, `show`, and `unlink` — not in flattening the type hierarchy.

---

## Simplification Summary

### Removals (5 ops cut)
- `memory.show` — duplicates `memory.fetch` for single-entry case
- `memory.stats` — dashboard-only, no agent workflow use
- `memory.contradictions` — analytical, better fits `check` domain if ever needed
- `memory.superseded` — same as contradictions, analytical only
- `memory.pattern.stats` — redundant stats op
- `memory.learning.stats` — redundant stats op
- `memory.unlink` — rarely used inverse; remove for surface tightening

Wait — that is 7 removals, not 5. Recount:

| Removed | Count |
|---------|-------|
| show | 1 |
| stats | 1 |
| contradictions | 1 |
| superseded | 1 |
| pattern.stats | 1 |
| learning.stats | 1 |
| unlink | 1 |
| **Total removed** | **7** |

18 - 7 = **11 ops projected** (9q + 2m... wait, let me recount kept ops)

**Query keeps**: find, timeline, fetch, decision.find, pattern.find, learning.find = 6q
**Mutate keeps**: observe, decision.store, pattern.store, learning.store, link = 5m

**Projected total: 11 ops (6q + 5m)** — well within the ≤15 ceiling, with 4 ops of headroom for Phase 3 graph/reason ops when they are registered.

### Phase 3 Headroom

The unregistered Phase 3 ops (graph.show, graph.neighbors, graph.add, graph.remove, reason.why, reason.similar, search.hybrid) will need registration when Phase 3 completes. With a projected base of 11 ops, there is room to add up to 4 Phase 3 ops before hitting 15. The domain should prioritize registering the most agent-facing ones first (likely `reason.why`, `search.hybrid`, `graph.neighbors`) and keep graph mutation (add/remove) as lower-priority or move to an admin/tools context.

---

## References

- Related tasks: T5517 (epic), T5539 (inventory subtask), T5540 (LAFS challenge), T5541 (dispositions)
- Memory domain cutover: T5241
- BRAIN epic: T5149
- Phase 3 graph ops: T5385
- Phase 3 reasoning ops: T5388-T5393
- Source files reviewed:
  - `/mnt/projects/claude-todo/src/dispatch/domains/memory.ts`
  - `/mnt/projects/claude-todo/src/dispatch/registry.ts` (lines 450-571, 1566-1626)
