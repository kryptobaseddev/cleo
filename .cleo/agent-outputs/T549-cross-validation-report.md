# T549 Cross-Specification Validation Report

**Task**: T549 — Memory Architecture v2
**Report ID**: T549-XV
**Date**: 2026-04-13
**Author**: Cross-Validation subagent
**Status**: COMPLETE

---

## Verdict: CONDITIONAL PASS

All four architecture specs (CA1–CA4) are fundamentally sound and compatible. Seven conflicts
were identified — five are resolvable by adopting the CA1 definition as authoritative, one
requires a spec amendment, and one requires an implementation ordering constraint. No spec
fails outright. Implementation may proceed with the resolutions documented here applied before
coding begins.

---

## 1. Conflicts Found

### CONFLICT-01: Memory Type Vocabulary Mismatch (CA1 vs CA2)

**Severity**: HIGH — would cause routing bugs if not resolved before implementation.

**Description**:
CA1 defines three cognitive types using the values `['semantic', 'episodic', 'procedural']`
and exports them as `BRAIN_COGNITIVE_TYPES`. CA2 defines four type values in `MemoryCandidate`:
`['factual', 'episodic', 'procedural', 'decision']`. These are different vocabularies for the
same routing concept.

CA2 then routes candidates to tables:
- `memoryType='factual'` → `brain_learnings`
- `memoryType='episodic'` → `brain_observations`
- `memoryType='procedural'` → `brain_patterns`
- `memoryType='decision'` → `brain_decisions`

CA1 maps tables to cognitive types:
- `brain_decisions` → `semantic`
- `brain_learnings` → `semantic` (or `episodic` for transcript-derived)
- `brain_patterns` → `procedural`
- `brain_observations` → `episodic`

**The collision**: CA2's `'factual'` type does not exist in CA1's schema column enum. CA2's
`'decision'` type does not exist in CA1's column enum either. If CA2's `MemoryCandidate.memoryType`
field is directly stored in the `memory_type` database column (which CA1 defines as
`BRAIN_COGNITIVE_TYPES = ['semantic', 'episodic', 'procedural']`), the database write will
fail a CHECK constraint or insert an invalid enum value.

**Resolution** (adopt CA1 as authoritative):
CA2's `MemoryCandidate` interface must use CA1's cognitive type vocabulary. Update
`extraction-gate.ts`:

```typescript
// CORRECT: use CA1's cognitive type enum
memoryType: 'semantic' | 'episodic' | 'procedural';
```

CA2's internal routing switch maps extraction category to cognitive type at storage time:
- transcript signal "Decision:" → candidate.memoryType = `'semantic'` → routed to `brain_decisions`
- transcript signal "Always:" → candidate.memoryType = `'procedural'` → routed to `brain_patterns`
- transcript signal "Completed:" → candidate.memoryType = `'episodic'` → routed to `brain_observations`
- transcript signal "because X causes Y" → candidate.memoryType = `'semantic'` → routed to `brain_learnings`

The routing switch in `storeVerifiedCandidate()` must use a secondary `targetTable` field
(or a simple enum extension) to distinguish `brain_decisions` from `brain_learnings` when
both are `'semantic'` type. Proposed:

```typescript
export interface MemoryCandidate {
  text: string;
  title: string;
  memoryType: 'semantic' | 'episodic' | 'procedural';
  /** Disambiguates semantic candidates: 'decision' or 'learning'. Ignored for non-semantic. */
  semanticSubtype?: 'decision' | 'learning';
  tier: 'short' | 'medium' | 'long';
  confidence: number;
  source: 'transcript' | 'task-completion' | 'diff' | 'manual' | 'debrief';
  sourceSessionId?: string;
  trusted?: boolean;
}
```

This preserves CA1's three-value schema column while giving CA2 the routing granularity it needs.

---

### CONFLICT-02: Tier Assignment Authority (CA1 write-time vs CA2 extraction-time)

**Severity**: MEDIUM — creates ambiguity in which component owns tier assignment.

**Description**:
CA1 states (§4.1): "Every write path MUST assign memoryTier at insert time." CA1's decision
tree triggers at the storage layer (inside `observeBrain()`, `storeDecision()`, etc.).

CA2 states (§4.2): "Tier is set by the extraction engine, not the gate." CA2's default tier
table assigns tier based on source type before the entry reaches storage.

These are not mutually exclusive — CA2 extracts candidates with a provisional tier, and CA1's
storage functions apply the write-time routing logic. However, they can produce a conflict: a
CA2 candidate from a `task.complete` event arrives with `tier='medium'`, but CA1's decision
tree at storage time would set `tier='short'` because `sourceConfidence='task-outcome'` → medium
(actually both agree here). The conflict surfaces for `diff` source entries: CA2 says `tier='long'`
(code facts are durable), CA1's decision tree would say `tier='short'` (default if no owner/
debrief/task-outcome qualifier).

**Resolution**:
CA1's write-time decision tree is authoritative over CA2's default tier table for any entry
that passes through the full storage stack. CA2's provisional tier is a hint, not a final value.

Implement the resolution by having CA2's extraction gate pass the provisional tier to the
storage function, and the storage function overrides it only when CA1's routing rules produce
a stronger signal:

```
TIER PRECEDENCE (highest wins):
1. CA1's sourceConfidence='owner' → 'medium' or 'long' (always override CA2)
2. CA1's sourceConfidence='task-outcome' → 'medium' (always override CA2's 'short')
3. CA2's provisional tier from source-type table → used as default
4. CA1's fallback: 'short'
```

This means: CA2 says diff entries are `'long'`. CA1 says the source is `'agent'`-confidence
unless the diff was manually triggered. Agent-confidence entries default to `'short'`. The
resolution is that diff entries should be classified as `sourceConfidence='agent'` initially
and promoted by the consolidator — CA2's `'long'` default for diffs is too aggressive for the
general case. The Drizzle migration backfill already handles this correctly (`UPDATE ... WHERE
source_type = 'agent'`).

**Implementation note**: CA2 §4.2 default tier table should be treated as a starting recommendation.
Document this explicitly in `extraction-gate.ts` with a comment: "Provisional tiers from CA2
are overridden by CA1 write-time routing when sourceConfidence produces a stronger signal."

---

### CONFLICT-03: Consolidation Tier Promotion Threshold Mismatch (CA1 vs CA2)

**Severity**: MEDIUM — would cause non-deterministic promotion if both implementations run.

**Description**:
CA1's consolidator (§4.2) promotes `short → medium` when:
- `quality_score >= 0.5 AND verified=true` OR `quality_score >= 0.7`

CA2's consolidator (§5, step 4c) promotes `short → medium` when:
- `quality_score >= 0.75 AND created_at < datetime('now', '-7 days')`

These are different thresholds and different timing requirements. CA1 promotes immediately at
session end with no age requirement. CA2 requires a 7-day age for `short → medium`.

For `medium → long`, CA2 uses `citation_count >= 3`, while CA1 uses age-based thresholds
(decisions: 7 days success outcome; learnings: 14 days, confidence >= 0.80, verified=true;
patterns: frequency >= 5, successRate >= 0.7).

The CA2 `citation_count` column does not exist in CA1's schema (CA1 adds no citation_count).
This is a schema-level incompatibility.

**Resolution**:
CA1 takes authority on tier promotion thresholds, as CA1 is the tiered memory spec. CA2's
consolidation enhancements are additive to CA1's consolidation, not a replacement.

Adopt CA1's thresholds for `short → medium` and `medium → long` as the canonical rules.
CA2's citation count concept is valid but requires the `citation_count` column to be added
to CA1's schema — CA1's §3.1 does not include this column. Add it to CA1's schema as an
addendum:

```sql
ALTER TABLE brain_observations ADD COLUMN citation_count INTEGER DEFAULT 0;
ALTER TABLE brain_learnings ADD COLUMN citation_count INTEGER DEFAULT 0;
ALTER TABLE brain_decisions ADD COLUMN citation_count INTEGER DEFAULT 0;
ALTER TABLE brain_patterns ADD COLUMN citation_count INTEGER DEFAULT 0;
```

This bridges the gap. CA2's `citation_count >= 3` rule for `medium → long` then becomes an
additional (not alternative) promotion gate alongside CA1's age-based gates.

---

### CONFLICT-04: Memory Bridge Token Budget — Compact Mode vs CA1 Sections (CA3 vs CA1)

**Severity**: MEDIUM — creates a sizing contradiction that must be resolved before bridge generation is implemented.

**Description**:
CA1 (§4.4) allocates a 1,800-token bridge budget divided across four sections:
- Long-term procedural: 500 tokens
- Long-term semantic: 500 tokens
- Medium-term recent decisions: 300 tokens
- Medium-term observations: 300 tokens
- Header reserve: 200 tokens
- Total: 1,800 tokens

CA3 (§4.2) specifies compact mode (Tier 1 — Claude Code) at ~200 tokens. CA3 §4 states the
bridge generator must enforce `compact ≤ 250`, `medium ≤ 700`, `rich ≤ 1,400`.

These are fundamentally different bridge sizes: CA1 designs a 1,800-token bridge, CA3 designs
a 200-token compact bridge.

Neither spec is wrong — they are serving different purposes. CA1 defines the content
architecture for what CAN be in the bridge. CA3 defines provider-adaptive rendering of
that content with mode-specific budgets. But they need explicit reconciliation to avoid
a developer misreading CA1's 1,800-token section design as the target output size.

**Resolution**:
CA1's 1,800-token section budget is the **content pool** — the maximum available before
mode selection. CA3's mode budgets are the **output limits** applied when rendering from
that pool.

Add this clarification to CA1 §4.4:
"Note: This 1,800-token section budget defines the content pool available for bridge
generation. The actual output size is governed by the provider tier mode selected by CA3:
compact (≤250 tokens), medium (≤700 tokens), or rich (≤1,400 tokens). The section
priorities (long-term procedural first, long-term semantic second, etc.) apply within
whatever budget is available."

Also note: CA3 compact mode at ~200 tokens can contain only a fraction of CA1's four
sections. In compact mode, only Section 1 (long-term procedural, top-3 entries) and a
pointer to full bridge content fit. This is intentional and correct per CA3's design goal.

---

### CONFLICT-05: Self-Healing Suggestion Delivery vs Compact Bridge Size (CA4 vs CA3)

**Severity**: LOW-MEDIUM — a token budget constraint that limits CA4's delivery mechanism.

**Description**:
CA4 (§4.4) states: "All suggestions are written to brain_observations in brain.db. The
memory bridge regenerates `.cleo/memory-bridge.md` after each session event. Agents read
this file at session start — it is `@`-referenced in AGENTS.md."

CA3 (§4.2) specifies that compact mode is ~200 tokens. Risk observations written by CA4
are additional entries in `brain_observations` with titles like "HIGH RISK: Task T549
(score: 0.72)". Each such observation is ~30-50 tokens in the bridge.

With a 200-token compact bridge, there is room for at most 2-3 risk observations before
the procedural memory entries are crowded out. If multiple intelligence hooks fire (task
start risk + pre-verify gate focus), both observations compete for the same 200 tokens.

**Resolution**:
CA4's observations should be tagged with a priority tier in the bridge generator. Risk
observations with `type='change'` and title prefix `'HIGH RISK:'` or `'Gate focus for'`
should be treated as Section 0 (emergency override) in CA1's bridge generation:

Add to CA1 §4.4 as Section 0 (prepend before Section 1):
```
Section 0: Intelligence Alerts (CA4 observations — priority override)
  Query: brain_observations WHERE title LIKE 'HIGH RISK:%' OR title LIKE 'Gate focus for%'
         AND memory_tier = 'short' AND invalid_at IS NULL
         ORDER BY created_at DESC LIMIT 2
  Budget: 80 tokens (reserved within compact mode; compresses Section 1 accordingly)
```

This ensures CA4's alerts appear in compact bridge without destroying procedural memory.
The bridge generator trims Section 0 to 2 entries maximum. For medium and rich modes,
the Section 0 budget expands proportionally.

---

### CONFLICT-06: BRAIN Spec Phase Alignment — CA4 Intelligence vs Phase 3 Gating

**Severity**: LOW — a governance concern, not a technical conflict.

**Description**:
CA4 implements "Proactive Suggestions" (risk prediction, gate focus suggestions) and
"Quality Prediction" (task risk scoring). The BRAIN Spec §13.4 explicitly classifies
both of these as Phase 3 capabilities:
- "Proactive Suggestions" → Phase 3
- "Quality Prediction" → Phase 3

CA4 proposes shipping these in T549, which is current Phase 1 work. The spec's phase
gating exists to prevent premature expansion of capabilities that haven't passed their
evidence-based validation gates.

However, R6 §7.1 notes that new columns on existing tables are permitted without new ADRs,
and R6 §4 shows the existing intelligence functions (`calculateTaskRisk`, `suggestGateFocus`,
etc.) are already written in `packages/core/src/intelligence/`. CA4's work is wiring existing
functions to hooks and CLI — not building new ML models or violating the "no new tables"
constraint.

**Resolution**:
CA4's implementation is PERMITTED as Phase 1 work under this distinction:
- Shipping a CLI command that exposes existing functions = Phase 1 acceptable (additive, no
  validation gate required for CLI surface expansion)
- The functions themselves (`calculateTaskRisk`, etc.) are already in the codebase
- No new runtime stores, no new ADR-gated decisions
- The suggestion delivery mechanism (brain_observations → memory bridge) uses existing infrastructure

Document in CA4's ADR requirement: "This wiring does not constitute shipping Phase 3 proactive
intelligence. It makes Phase 1 wiring operational for existing Phase 1-eligible infrastructure.
The evidence-based validation gates in BRAIN Spec §17.2 still apply to measuring whether the
intelligence capability meets its success metrics."

---

### CONFLICT-07: Two New Tables (CA2) vs No New Tables Policy (CA1, R6)

**Severity**: HIGH — requires explicit ADR coverage.

**Description**:
CA1 (§0, Governing Constraints): "This spec requires no new tables." CA1 explicitly chose
the additive-column path to avoid needing a new ADR for new tables.

CA2 (§7) proposes two new tables:
1. `brain_pending_candidates` — stores extraction candidates with confidence < 0.40
2. `brain_retrieval_log` — stores co-retrieval data for graph edge strengthening

Per R6 §7.2: "Add new tables to brain.db (requires ADR amending ADR-009)."

These two tables are NOT covered by the CA1 ADR requirement (which only amends ADR-009 for
the new columns). CA2 needs separate ADR coverage or must restructure to avoid new tables.

**Resolution options (pick one before implementation)**:

**Option A (preferred)**: Merge `brain_pending_candidates` into an existing table. Use
`brain_observations` with a special `source_type='pending-candidate'` and `memory_tier='short'`
with a short TTL. The `confidence < 0.40` entries become short-term observations that the
consolidator evicts after 7 days (already supported by CA1's eviction logic). This eliminates
the need for a new table.

For `brain_retrieval_log`: store co-retrieval data as `brain_observations` of `type='feature'`
with `memory_type='episodic'` and a structured `narrative` field containing the entry IDs JSON.
The graph edge strengthening consolidation step reads these observations. This is weaker than a
proper log table but avoids the ADR requirement.

**Option B**: Write a short ADR addendum specifically for these two tables (can be included in
the CA1+CA2 combined ADR rather than a separate ADR). The addendum documents: table purpose,
schema, TTL, and why they cannot be modeled as columns on existing tables.

**Recommendation**: Option A for `brain_pending_candidates`. Option B for `brain_retrieval_log`
(structured co-retrieval data doesn't fit cleanly into existing tables). This minimizes the
ADR surface while keeping the retrieval log properly modeled.

---

## 2. Gaps Identified

### GAP-01: Missing `citation_count` Column in CA1's Schema

CA2's quality recompute (§5.2, step 4b) and budget enforcement (§6.4) depend on
`citation_count` incrementing per retrieval. CA1's schema additions (§3.1) do not include
this column. It must be added to the CA1 migration SQL. See CONFLICT-03 resolution for the
exact ALTER TABLE statements.

### GAP-02: CA3's `cleo context pull` Command Has No Implementation Owner

CA3 specifies `cleo context pull <task-id>` (§2.4) as a new command. No CA spec assigns
an implementation owner for this command. CA2 owns extraction. CA1 owns schema. CA3 owns
injection logic. CA4 owns intelligence hooks.

Resolution: CA3 owns the `cleo context pull` implementation. It uses `retrieveWithBudget()`
from CA2 and `cleo show` task data, bundled by a new CA3-owned function in `brain-retrieval.ts`
or a new file `context-pull.ts`. Assign to the CA3 implementation subtask.

### GAP-03: The `BRAIN_MEMORY_TYPES` Naming Collision Propagation

CA1 (§3.1.2, Risk table) flags the `BRAIN_MEMORY_TYPES` naming collision: the constant
already exists in `brain-schema.ts` as the link table enum, and the new constant must use
`BRAIN_COGNITIVE_TYPES`. CA1's own spec uses the correct name `BRAIN_COGNITIVE_TYPES`.

However, CA2 and CA3 reference "memory types" in their interface definitions without
explicitly referencing `BRAIN_COGNITIVE_TYPES`. The `MemoryCandidate.memoryType` field in
CA2's `extraction-gate.ts` must import `BRAIN_COGNITIVE_TYPES` (not `BRAIN_MEMORY_TYPES`)
from `brain-schema.ts`. CA3's bridge mode logic must do the same.

This is not a conflict between specs — it is a gap in CA2 and CA3 about which import to use.
Add to implementation guidance: "All code importing memory type constants MUST use
`BRAIN_COGNITIVE_TYPES` from `brain-schema.ts`. Never import or reference `BRAIN_MEMORY_TYPES`
for cognitive classification — that constant belongs to the link table enum."

### GAP-04: No Spec Covers the `task-primer.md` File Lifecycle

CA3 (§6.4) proposes a `.claude/context/task-primer.md` file written at session start by a
`SessionStart` hook. No spec defines:
- What happens to `task-primer.md` at session end (is it overwritten? archived? deleted?)
- Whether this file is git-tracked (CA3 §9.2 says it's a "session artifact at `.claude/context/`
  — outside the `.cleo/` config boundary. No ADR conflict." But `.claude/` IS git-tracked for
  Claude Code, which means the file would be committed unless excluded.)
- Whether `task-primer.md` should be in `.gitignore`

Resolution: Add to CA3 implementation guidance:
1. `task-primer.md` is regenerated at every `SessionStart` — it is ephemeral.
2. Add `.claude/context/task-primer.md` to `.gitignore` (alongside `.claude/worktrees/`
   which is already ignored per git status).
3. At `SessionEnd`, the hook may optionally delete it to prevent stale context on next session.

### GAP-05: CA4 Intelligence Hook Priority Ordering vs Existing Hook Priorities

CA4 (§4.1) registers `handleTaskStartIntelligence` at priority 80 on `PreToolUse`. CA4 (§1.4)
registers the watchdog at priority 50 on `SessionStart`/`SessionEnd`. No spec documents the
full priority table for all registered hooks.

From R1 (§3, callers table), existing hooks include:
- Backup hook: priority 10
- Session grading: priority 100
- Brain tool-start (CA4 references this): priority 100

At priority 80, `handleTaskStartIntelligence` runs before session grading (100) but after
backup (10). This is the correct ordering per CA4. However, no spec audits whether any
OTHER hooks at priority 80 conflict with this registration.

Gap only — not a conflict between CA specs. Resolution: Before implementing CA4 Phase 2,
run `grep -r "priority" packages/core/src/hooks/handlers/` to audit the full priority table
and confirm 80 is available.

### GAP-06: Consolidator Fire-and-Forget vs CA2's Required Metrics Recording

CA1 (§4.2) states the consolidator is "fire-and-forget async process. It MUST NOT block
session end." CA2 (§7.1) requires that consolidation metrics be written to
`.cleo/metrics/MEMORY_METRICS.jsonl` with `event: 'consolidate'` events including
`durationMs`.

If the consolidator is fire-and-forget and the session end process exits, the metrics
write may be lost if the process terminates before the consolidator finishes.

Resolution: The metrics write is "best-effort" — wrap in a try/catch inside the
consolidator. If the process exits before metrics are written, the session will simply
have no consolidation metric for that run. CA2's metrics spec already uses "best-effort"
language for `incrementCitationCount` (§6.4). Apply the same pattern to consolidation
metrics. Document this as a known limitation: consolidation metrics may be missing for
sessions that terminate immediately after session end.

---

## 3. Schema Consistency Verdict

### Column Naming: CONSISTENT

All four specs use the same column name conventions. Cross-referencing CA1 §3.1 against CA2 §7:

| Column | CA1 Name | CA2 Name | Match? |
|--------|----------|----------|--------|
| Tier | `memory_tier` | `tier` (column alias) | Yes — CA2 §7 SQL uses `tier`, CA1 uses `memory_tier`. CA1 is the schema spec; CA2's SQL must use `memory_tier` |
| Type | `memory_type` | `memory_type` | Yes |
| Valid from | `valid_at` | `valid_at` | Yes |
| Valid until | `invalid_at` | `invalid_at` | Yes |
| Source confidence | `source_confidence` | not in CA2 | CA2 does not address source_confidence column; CA1 owns this |

**One naming inconsistency**: CA2 §7 schema uses bare `tier TEXT` in the pending candidates
table but references `tier` in the ALTER TABLE statements. The CA1 canonical column name is
`memory_tier`. CA2's extraction SQL must use `memory_tier` consistently.

### New Tables: CONDITIONAL

CA2's two new tables (`brain_pending_candidates`, `brain_retrieval_log`) require ADR coverage
per R6 §7.2. See CONFLICT-07 resolution.

### Enum Values: CONFLICT (see CONFLICT-01)

CA2's `MemoryCandidate.memoryType` uses `['factual', 'episodic', 'procedural', 'decision']`.
CA1's `BRAIN_COGNITIVE_TYPES` uses `['semantic', 'episodic', 'procedural']`. Must resolve
before implementation. See CONFLICT-01 resolution.

---

## 4. Pipeline + Tier Consistency Verdict

### Tier Assignment Timing: RESOLVABLE (see CONFLICT-02)

CA1 says write-time assignment. CA2 says extraction-time assignment. Both are partially
correct and must be layered: extraction sets provisional tier, storage enforces authoritative tier.

### Type → Table Routing: CONSISTENT (after CONFLICT-01 resolution)

Once CA2 adopts CA1's cognitive type vocabulary, routing is consistent:
- `'semantic'` + `semanticSubtype='decision'` → `brain_decisions`
- `'semantic'` + `semanticSubtype='learning'` → `brain_learnings`
- `'episodic'` → `brain_observations`
- `'procedural'` → `brain_patterns`

### Quality Scoring: ADDITIVE (no conflict)

CA1 adds `sourceConfidence` multiplier to quality scoring. CA2 adds `tier` bonus.
Both are additive extensions to the existing `computeObservationQuality()`. The order of
application is: base score → sourceConfidence multiplier (CA1) → tier bonus (CA2). No
conflict; both apply.

---

## 5. JIT + Memory Bridge Consistency Verdict

### Token Budgets: RESOLVABLE (see CONFLICT-04)

CA1's 1,800-token budget is the content pool. CA3's compact/medium/rich budgets are
the output limits. Reconciled: bridge generator uses CA3's mode to select how much of
CA1's four-section pool to render.

### AGENTS.md Rewrite: COMPATIBLE WITH CA4

CA3 proposes a slimmed AGENTS.md (~900 tokens) that removes GitNexus and adds JIT
protocol. CA4 wires suggestions through `brain_observations → memory-bridge.md`. CA4's
delivery mechanism does not depend on any specific AGENTS.md content — it only depends
on memory-bridge.md being `@`-referenced in AGENTS.md, which CA3 preserves.

CA3's removal of GitNexus from AGENTS.md does not affect CA4. CA4 has no dependency on
GitNexus instructions being in the injection chain.

### Session Handoff: COMPATIBLE

CA3 (§2.4) proposes `cleo context pull <task-id>` as the canonical task-resume command.
CA4 writes risk observations to brain.db. At session resume, `cleo context pull` calls
`retrieveWithBudget()` (CA2) which includes CA4's risk observations in the results.
The data flows correctly.

---

## 6. Self-Healing + Pipeline Consistency Verdict

### Suggestion Delivery Size: RESOLVABLE (see CONFLICT-05)

CA4 observations must be sized to fit in compact mode. With the Section 0 intelligence
alerts allocation (80 tokens, max 2 entries), CA4's short titles ("HIGH RISK: T549 (0.72)")
fit within budget. CA4 should constrain `observation.title` to 60 characters for alert entries
and put the detail in `observation.subtitle`.

### No New Tables from CA4: CONFIRMED

CA4 §6.3 explicitly states "No New Tables Required." All self-healing data fits the existing
schema. CA4 is fully compliant with the CA1 constraint.

### Brain Bridge Refresh Timing: COMPATIBLE

CA4 writes observations during `PreToolUse` and `PostToolUseFailure` hooks. The bridge
refresh runs at `SessionStart` and `SessionEnd` and on `task.complete`. For CA4's alerts
to appear in compact bridge during an active session, either:
1. The bridge is refreshed manually (`cleo refresh-memory`)
2. The next `task.complete` hook triggers a refresh
3. The next session start reads the updated observations

This means CA4 alerts are visible at the start of the NEXT task or session, not
instantaneously. This is the correct design per ADR-032 (Layer 1 is static seed, not
live). Document this timing in CA4 §4.4: "Suggestion delivery to compact bridge occurs
on the next refresh cycle (task completion or session start), not instantaneously."

---

## 7. ADR Requirements — Consolidated

The following ADR work is required across all four specs. These should be written as a
single combined ADR amending ADR-009, ADR-021, and ADR-032 rather than multiple separate
ADRs, to keep the governance surface minimal.

### Combined ADR: Memory Architecture v2

**Amends**: ADR-009 (BRAIN Cognitive Architecture), ADR-021 (Memory Domain), ADR-032/034
(Memory Bridge)

**Title**: ADR-NNN: Memory Architecture v2 — Tiered Cognitive Memory with JIT Injection

**Decisions to record** (sourced from all four CA specs):

From CA1:
1. Three-tier model: `short` (session), `medium` (weeks), `long` (permanent) — definitions,
   promotion rules, eviction rules
2. Three cognitive types: `semantic`, `episodic`, `procedural` — table-to-type mapping
3. `BRAIN_COGNITIVE_TYPES` as the canonical constant name (NOT `BRAIN_MEMORY_TYPES_V2`)
4. Six new columns on four typed tables: `memory_tier`, `memory_type`, `verified`, `valid_at`,
   `invalid_at`, `source_confidence` (ADR-009 amendment — schema evolution)
5. `citation_count` column on all four typed tables (added by CONFLICT-03 resolution)
6. Bitemporal validity: `valid_at`/`invalid_at` on observations and learnings only
7. `verified` four-gate model (owner, task-outcome, corroboration, manual)
8. `source_confidence` four levels with quality multiplier semantics
9. Sleep-time consolidator: session-end hook, fire-and-forget
10. BrainConfig.tiering feature flag (defaults false)
11. New CLI ops: `memory.verify`, `memory.retract`, `memory.tier.stats` (ADR-021 amendment)

From CA2:
12. Extraction pipeline: `ExtractionEngine` with five source types, verification gate
13. `brain_pending_candidates` table (if Option B chosen for CONFLICT-07)
14. `brain_retrieval_log` table — co-retrieval logging (if Option B chosen)
15. Budget-aware retrieval: `retrieveWithBudget()` function and `tokensRemaining` contract
16. Memory metrics: `MEMORY_METRICS.jsonl` append-only event log

From CA3:
17. ADR-044: JIT Injection Protocol — static baseline targets per provider tier
18. Three-tier provider classification (Tier 1/2/3) — injection-specific, not CAAMP quality tiers
19. Memory bridge mode per tier: compact (≤250), medium (≤700), rich (≤1,400) (ADR-032 amendment)
20. JIT budget cap: 2,000 tokens per trigger event
21. `task-primer.md` as ephemeral session artifact in `.claude/context/` (gitignored)
22. `cleo context pull <task-id>` as canonical task-resume command (ADR-021 amendment — new op)
23. Memory bridge `maxTokens` enforcement in standard path (bug fix, not a new decision)

From CA4:
24. Watchdog scheduler: 60-second tick, session-scoped, per-project-root singleton
25. Intelligence CLI (`cleo intelligence predict/suggest/learn-errors/confidence/match`)
26. Intelligence alert observations: Section 0 priority in bridge generator (60-char title limit)

---

## 8. Unified Implementation Wave Plan

Dependencies are strict where noted. Parallel work is possible where not.

### Wave 0: Schema Foundation (Blocks everything)

**Must complete before any other wave starts.**

| Task | Owner | Deps | Description |
|------|-------|------|-------------|
| 0-A | CA1 impl | none | Write Drizzle migration `20260413000001_t549-tiered-typed-memory` with all CA1 columns + citation_count from CONFLICT-03 resolution |
| 0-B | CA1 impl | 0-A | Update `brain-schema.ts`: add constants, column defs, indexes |
| 0-C | CA1 impl | 0-B | Export new types from `packages/contracts/src/` |
| 0-D | CA1 impl | 0-C | Extend `BrainConfig` with `tiering` block (default false) |
| 0-E | CA1 impl | 0-A | Run migration via `cleo upgrade`, verify schema version bump |

Wave 0 output: brain.db has new columns, contracts package has new types, config interface is extended.

### Wave 1: Storage + Quality Layer (Blocks CA2 and CA4 Phase 1)

**Parallel with Wave 1-B (see below). Depends on Wave 0.**

| Task | Owner | Deps | Description |
|------|-------|------|-------------|
| 1-A | CA1 impl | Wave 0 | Update `observeBrain()`, `storeDecision()`, `storePattern()`, `storeLearning()` for tier/type/confidence assignment using CA1 §4.1 routing logic |
| 1-B | CA1 impl | Wave 0 | Update `computeObservationQuality()` and siblings with `sourceConfidence` multiplier (CA1 §5.3) AND tier bonus (CA2 §4.3) |
| 1-C | CA2 impl | Wave 0 | Implement `memory-metrics.ts` — JSONL append, metric event types |
| 1-D | CA3 impl | none | Rewrite `AGENTS.md` to CA3 §5.2 structure (~900 tokens) |
| 1-E | CA3 impl | none | Extract GitNexus block to `.claude/context/gitnexus.md`, update `CLAUDE.md` |
| 1-F | CA3 impl | none | Fix `writeMemoryBridge()` — enforce `maxTokens` in standard path (bug fix) |

### Wave 2: Extraction Gate + Bridge Mode (Blocks CA2 pipeline, CA3 JIT)

**Depends on Wave 1.**

| Task | Owner | Deps | Description |
|------|-------|------|-------------|
| 2-A | CA2 impl | 1-A | Implement `extraction-gate.ts`: `MemoryCandidate` with corrected type vocab (CONFLICT-01 resolution), `verifyAndStore()`, `verifyAndStoreBatch()`, `GateResult` |
| 2-B | CA2 impl | 2-A | Implement `extraction-engine.ts`: `fromTranscript()`, `fromTaskCompletion()`, `fromDiff()`, `fromDebriefNote()` |
| 2-C | CA1 impl | 1-B | Update `generateMemoryBridgeContent()` for tier-aware section logic (CA1 §4.4) with Section 0 intelligence alerts (CONFLICT-05 resolution) |
| 2-D | CA3 impl | 2-C | Add `mode: compact | medium | rich` parameter to bridge generator, enforce per-mode token budgets |
| 2-E | CA3 impl | 2-D | Add relevance scoring (hybridSearch) to bridge entry selection |

### Wave 3: Retrieval + Consolidator (Parallel with Wave 3-B)

**Depends on Wave 2.**

| Task | Owner | Deps | Description |
|------|-------|------|-------------|
| 3-A | CA2 impl | 2-A | Implement `retrieveWithBudget()` in `brain-retrieval.ts` |
| 3-B | CA1 impl | 2-A | Implement `runTierPromotion()` in `brain-lifecycle.ts` |
| 3-C | CA1 impl | 2-A | Implement `detectContradictions()` in new `brain-consolidator.ts` |
| 3-D | CA2 impl | 3-B, 3-C | Extend `consolidateMemories()` with CA2's new steps (deduplication, quality recompute, soft eviction, graph edge strengthening) — integrating with CA1's tier promotion |
| 3-E | CA1 impl | 3-B, 3-C | Wire consolidator to `session-hooks.ts` as fire-and-forget after backup |
| 3-F | CA2 impl | 2-B, 3-E | Wire `ExtractionEngine` to `session-hooks.ts` on session end |

### Wave 4: Intelligence CLI + Watchdog (Parallel execution)

**Depends on Wave 1 (for brain accessor patterns). CA4 Phase 1 only.**

| Task | Owner | Deps | Description |
|------|-------|------|-------------|
| 4-A | CA4 impl | Wave 1 | Create `packages/cleo/src/dispatch/domains/intelligence.ts` (IntelligenceHandler) |
| 4-B | CA4 impl | 4-A | Create `packages/cleo/src/cli/commands/intelligence.ts` |
| 4-C | CA4 impl | 4-B | Register handler in dispatch domains, register command in CLI |
| 4-D | CA4 impl | 4-C | Smoke test: `cleo intelligence predict --task T549` returns risk assessment |

### Wave 5: JIT Commands + Intelligence Hooks

**Depends on Wave 3 (for retrieveWithBudget) and Wave 4 (for intelligence functions).**

| Task | Owner | Deps | Description |
|------|-------|------|-------------|
| 5-A | CA3 impl | 3-A | Implement `cleo context pull <task-id>` command |
| 5-B | CA3 impl | 5-A | Implement SessionStart hook: write `task-primer.md` for Claude Code |
| 5-C | CA3 impl | 5-B | Add `task-primer.md` to `.gitignore` |
| 5-D | CA4 impl | 4-A | Create `packages/core/src/hooks/handlers/intelligence-hooks.ts` (CA4 Phase 2) |
| 5-E | CA4 impl | 5-D | Wire `handleTaskStartIntelligence` on `PreToolUse` (priority 80) |
| 5-F | CA4 impl | 5-D | Extend `error-hooks.ts` with healing suggestion retrieval |

### Wave 6: Watchdog + Routing Integration (CA4 Phases 3 and 4)

**Depends on Wave 5. Highest-risk phase.**

| Task | Owner | Deps | Description |
|------|-------|------|-------------|
| 6-A | CA4 impl | Wave 5 | Create `watchdog-hooks.ts`, implement tick/start/stop |
| 6-B | CA4 impl | 6-A | Register watchdog on SessionStart/SessionEnd at priority 50 |
| 6-C | CA4 impl | Wave 5 | Run `gitnexus_impact` on `orchestrateSpawnExecute` before modification |
| 6-D | CA4 impl | 6-C | Add capacity check block to `orchestrateSpawnExecute` (after impact report review) |
| 6-E | CA4 impl | 6-D | Verify: zero-agent fallback passes; overloaded path returns E_SPAWN_CAPACITY_EXHAUSTED |

### Wave 7: Provider Adaptation + Metrics (Can start at Wave 3 completion)

**Lower priority; parallel execution encouraged.**

| Task | Owner | Deps | Description |
|------|-------|------|-------------|
| 7-A | CA3 impl | Wave 3 | Add provider tier detection to injection generator |
| 7-B | CA3 impl | 7-A | Add `baseline_tokens` + `bridge_tokens` to TOKEN_USAGE.jsonl at session start |
| 7-C | CA2 impl | Wave 3 | Add new CLI commands: `cleo memory extract`, `cleo memory pending`, `cleo brain health` |
| 7-D | CA1 impl | Wave 3 | Add new CLI commands: `cleo memory verify`, `cleo memory retract`, `cleo memory tier-stats` |
| 7-E | CA1 impl | Wave 3 | Add `--tier`, `--verified`, `--at` flags to `cleo memory find` |

### Wave 8: ADR + Quality Gates

**Final wave. No deployment until this passes.**

| Task | Owner | Deps | Description |
|------|-------|------|-------------|
| 8-A | all impl | Wave 7 | Write combined ADR-NNN (see §7 consolidated requirements) |
| 8-B | all impl | Wave 7 | Run full quality gate: `pnpm biome check --write .` |
| 8-C | all impl | 8-B | Run build: `pnpm run build` |
| 8-D | all impl | 8-C | Run test suite: `pnpm run test` — zero new failures |
| 8-E | all impl | 8-D | Run `gitnexus_detect_changes()` — verify only expected symbols changed |
| 8-F | all impl | 8-E | Commit with tag v2026.M.D (CalVer per project policy) |

---

## 9. Sign-Off Conditions

All of the following conditions must be met before T549 is marked complete.

### Technical Sign-Off

- [ ] CONFLICT-01 resolved: `MemoryCandidate.memoryType` uses `BRAIN_COGNITIVE_TYPES` vocabulary with `semanticSubtype` disambiguation
- [ ] CONFLICT-02 resolved: Tier assignment precedence documented in `extraction-gate.ts` comments
- [ ] CONFLICT-03 resolved: `citation_count` column added to CA1 migration SQL
- [ ] CONFLICT-04 resolved: CA1 §4.4 updated with "content pool vs output limit" note
- [ ] CONFLICT-05 resolved: Section 0 intelligence alerts added to bridge generator with 80-token budget
- [ ] CONFLICT-06 resolved: CA4 ADR note distinguishes "wiring existing functions" from "shipping Phase 3 capability"
- [ ] CONFLICT-07 resolved: Either Option A (reuse existing tables) or Option B (separate ADR addendum) chosen and implemented
- [ ] GAP-01 resolved: `citation_count` column in CA1 migration
- [ ] GAP-02 resolved: `cleo context pull` assigned to CA3 implementation subtask
- [ ] GAP-03 resolved: All code uses `BRAIN_COGNITIVE_TYPES`, never `BRAIN_MEMORY_TYPES`
- [ ] GAP-04 resolved: `task-primer.md` added to `.gitignore`, lifecycle documented
- [ ] GAP-05 resolved: Hook priority audit run before CA4 Phase 2 implementation
- [ ] GAP-06 resolved: Consolidation metrics documented as best-effort

### Governance Sign-Off

- [ ] Combined ADR-NNN written and accepted (covers all 26 decisions in §7)
- [ ] ADR-NNN filed in `.cleo/adrs/` with proper front matter
- [ ] CA1, CA2, CA3 specs each updated to reference combined ADR by number
- [ ] BRAIN Spec §13.4 not altered to claim Phase 3 capabilities as shipped

### Quality Sign-Off

- [ ] `pnpm biome check --write .` passes with zero warnings
- [ ] `pnpm run build` passes
- [ ] `pnpm run test` passes with zero new failures
- [ ] `gitnexus_detect_changes()` confirms only expected symbols changed
- [ ] No `any` types introduced
- [ ] No `unknown` shortcuts introduced
- [ ] All exported functions, classes, types have TSDoc comments

---

## Appendix: Quick Conflict Resolution Reference

| Conflict | Resolution | Action Item |
|----------|-----------|-------------|
| CONFLICT-01: Type vocab mismatch | CA1 wins; CA2 adopts `BRAIN_COGNITIVE_TYPES` + `semanticSubtype` | Update `extraction-gate.ts` MemoryCandidate interface |
| CONFLICT-02: Tier assignment owner | Layered: CA2 provisional → CA1 authoritative override | Document in `extraction-gate.ts` |
| CONFLICT-03: Consolidator threshold mismatch + citation_count missing | CA1 thresholds authoritative; add citation_count to CA1 schema | Amend CA1 migration SQL |
| CONFLICT-04: Bridge token budget contradiction | CA1 = content pool; CA3 = output limit | Add note to CA1 §4.4 |
| CONFLICT-05: Suggestions vs compact bridge | Add Section 0 alerts (80 tokens, max 2 entries) | Amend CA1 §4.4 bridge generator spec |
| CONFLICT-06: Phase gate violation risk | Document CA4 as wiring, not Phase 3 shipping | Add to CA4 ADR note |
| CONFLICT-07: New tables need ADR | Option A (pending→observations); Option B (ADR addendum for retrieval log) | Decision required before Wave 2 |
