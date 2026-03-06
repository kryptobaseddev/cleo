# SN-005 Canon Naming Review -- Final Synthesis Report

**Date**: 2026-03-05
**Sticky Note**: SN-005 (Active)
**Tags**: canon, phase5, capstone, naming, meow, loom, cleo-evolution, legacy-pattern
**Agents**: canon-researcher, canon-auditor, protocol-analyst, import-validator, synthesis-agent
**Status**: COMPLETE

---

## 1. EXECUTIVE SUMMARY

- **94.4% canon naming compliance** across the CLEO codebase. All 10 canon terms from NEXUS-CORE-ASPECTS.md are either correctly implemented in runtime code or correctly absent (existing only as conceptual vocabulary mapped to standard domain names).
- **NEXUS is fully implemented** (24 operations, 13 tests) -- not a stub. MEMORY.md contains stale claims that must be corrected.
- **Sticky Notes are fully implemented** with two missing promotion paths (Session Note and Task Note conversions) out of four canon-defined paths.
- **MEOW, the legacy pattern, and "cleo-evolution" have zero codebase references.** MEOW remains an unimplemented concept representing composable workflow shape. the legacy pattern represents the anti-pattern of bolted-on quality that Protocol Chains/Warp would eliminate.
- **"Warp" proposed as canon-true alternative to "Protocol Chains"** for the MEOW+LOOM synthesis concept, extending the existing textile metaphor (warp = structural framework threads on a loom; weft = quality gates woven through). The codebase is clean and ready for Phase 5 evolution work.

---

## 2. CANON NAMING SCORECARD

Source of truth: `docs/concepts/NEXUS-CORE-ASPECTS.md`

| # | Term | Runtime Present | Canon-Correct | Domain Match | Score | Notes |
|---|------|----------------|---------------|--------------|-------|-------|
| 1 | **Thread** | NO (docs only) | PASS | `tasks` | PASS | "Smallest honest unit of work" = task. Correctly embodied by tasks domain. |
| 2 | **Loom** | NO (docs only) | PASS | `pipeline` | PASS | "Aspect of tension, framing, order" = epic frame. Pipeline domain serves this role. |
| 3 | **Tapestry** | NO (docs only) | PASS | `pipeline, orchestrate` | PASS | "Composed body of work" = multiple Looms in concert. Conceptual layer above Loom. |
| 4 | **Tessera** | NO (docs only) | PASS | `pipeline, orchestrate, tools` | PASS | "Reusable composition pattern" = pattern card. Correctly used in `.cleo/rcasd/T5332/` orchestration protocol. |
| 5 | **Cogs** | NO (docs only) | PASS | `tools` | PASS | "Practical metal parts" = callable capabilities. Tools domain serves this role. |
| 6 | **Clicks** | NO (docs only) | PASS | (implicit in tool execution) | PASS | "Single short-lived execution of a Cog." No formal runtime representation yet. |
| 7 | **Cascade** | PARTIAL (technical only) | PARTIAL | `pipeline, orchestrate, check` | PARTIAL | Canon = "descent through gates." Code uses `cascade` for task child-deletion (different semantic domain). See collision analysis below. |
| 8 | **Tome** | NO (docs only) | PASS | `memory, nexus` | PASS | "Illuminated memory" = living readable canon. Memory domain (brain.db) serves as deep archive beneath Tome. |
| 9 | **Sticky Notes** | YES (fully implemented) | PASS | `sticky` | PASS | "Quick captures" with promotion paths. Implementation matches canon. Missing 2 of 4 promotion targets. |
| 10 | **NEXUS** | YES (fully implemented) | PASS | `nexus` | PASS | "The Core" = cross-project star road. Full implementation: registry, query, deps, permissions, sharing/sync. |

**Overall Compliance: 94.4%** (188.75 / 200 points)

Scoring breakdown:
- Term correctness: 95/100 (9 PASS at 10pts + 1 PARTIAL at 5pts)
- Domain mapping: 50/50 (all 10 active domains match canon roles)
- NEXUS implementation: 23.75/25 (95% -- docked for ARCHITECTURE.md neural metaphor prose)
- Sticky Notes implementation: 20/25 (80% -- docked for missing Session Note and Task Note conversion)

**Cascade collision note**: The `cascade` usage in `src/core/tasks/deletion-strategy.ts` refers to the standard database/tree concept of cascade delete (SQL `ON DELETE CASCADE`). This operates in a completely different semantic domain from canon Cascade ("descent through gates"). They never appear in the same context, live in different domains (tasks vs pipeline/orchestrate), and use different casing conventions. No action needed now; if canon Cascade is eventually implemented, use a distinct identifier like `LifecycleCascade`.

---

## 3. PHASE 5 CAPSTONE NAMING FIT

### Does Every Phase 5 Planned Term Correctly Map to Workshop Language?

The existing canon terms map cleanly to their runtime domains. The gap is not in the existing terms but in the **synthesis concept** that Phase 5 would introduce: the merger of workflow shape (MEOW) and quality completion (LOOM) into a single definition-time construct.

### Naming Collisions or Ambiguities

- **No collisions** between existing canon terms and planned Phase 5 concepts.
- **One ambiguity**: "Protocol Chains" as a name does not match the workshop/craft aesthetic. The canon uses textile metaphors (Thread, Loom, Tapestry, Weave) and mechanical metaphors (Cogs, Clicks, Forge-bench) -- never abstract computer science terminology like "protocol" or "chain."

### The "Warp" Proposal

The protocol-analyst identified **"Warp"** as the strongest canon-true alternative to "Protocol Chains":

- In weaving, the **warp** is the lengthwise threads stretched on the loom that define the structural framework
- The **weft** is what weaves through the warp (the quality gates crossing through the structure)
- Together, warp and weft produce **fabric** -- the complete workflow with embedded quality

This extends the textile metaphor naturally:
- A **Tessera** defines a "Warp pattern" (structural template with embedded quality weft)
- The pattern is mounted on a **Loom** (epic frame) to produce a working **Tapestry**
- **Cascade** carries the live Tapestry through gates

### Assessment: Does Phase 5 Naming Fit the Workshop Aesthetic?

**Yes, with "Warp" instead of "Protocol Chains."** The term integrates seamlessly into the existing vocabulary progression: Thread -> Loom -> Tapestry -> Tessera -> Warp (structural definition with embedded quality). "Protocol Chains" would be the developer-facing technical name (like RCASD-IVTR+C), while "Warp" would be the canon/conceptual name (like LOOM).

---

## 4. MEOW / LOOM / PROTOCOL CHAINS SYNTHESIS

### MEOW = Workflow Shape (Composable Workflow Program Structure)

**Current state**: MEOW has zero codebase references. The concept is implicit in several existing patterns:

| Existing Pattern | MEOW Alignment | Location |
|-----------------|----------------|----------|
| Tessera Pattern | Closest match -- defines reusable multi-agent orchestration shapes | `.cleo/rcasd/T5332/` (docs only, zero TypeScript) |
| Wave computation | Runtime shape calculation from task DAG | `src/core/orchestration/waves.ts` |
| RCASD-IVTR+C pipeline | Fixed linear workflow shape (9 stages) | `src/core/lifecycle/stages.ts` |
| Orchestrator protocol | Shape constraints (dependency order, compliance verification) | Orchestrator spec ORC-004, ORC-008 |

**What is missing**:
- No declarative workflow definition format (shapes are hardcoded or computed at runtime)
- No composability primitives (cannot sequence, fork, or branch workflow shapes)
- No workflow shape validation (no static check for well-formedness before execution)
- Tessera exists only in documentation -- zero TypeScript source references

### LOOM = Quality Completion (Gates and Correctness)

**Current state**: LOOM is well-established with 5 enforcement layers:

| Layer | Location | Function |
|-------|----------|----------|
| 1. Pipeline Stage Gates | `src/core/lifecycle/state-machine.ts` | Prerequisite validation before stage transitions |
| 2. Verification Gates | `src/core/validation/verification.ts` | 6-gate dependency chain (implemented -> testsPassed -> qaPassed -> cleanupDone -> securityPassed -> documented) |
| 3. Dispatch Middleware | `src/dispatch/middleware/verification-gates.ts` | Intercepts all dispatch operations for gate checks |
| 4. Protocol Validators | `src/core/orchestration/protocol-validators.ts` | 9 protocol types with specific validation rules |
| 5. Check Domain | `src/dispatch/domains/check.ts` | Schema validation, compliance, protocol enforcement |

**What is missing**:
- Gates are runtime-only (no way to embed gate requirements into workflow definitions)
- No gate composition (cannot configure per-workflow gate contracts)
- No custom gate definitions (fixed 6-gate chain)
- No gate-aware workflow planning (cannot verify planned shape satisfies gates before execution)

### Protocol Chains / Warp = The Synthesis

**Definition**: Composable workflow definitions (MEOW shape) with embedded quality gates (LOOM correctness) baked in at definition time, verified before execution begins.

A Protocol Chain / Warp is a workflow program where each link carries:
1. A **stage definition** (what work happens -- the Thread)
2. A **gate contract** (what quality conditions must be met -- the LOOM check)
3. A **connection topology** (how links connect -- the MEOW shape)

**The key property**: definition-time verification. You cannot define a workflow that is structurally incapable of satisfying its own gates. The definition IS the proof that the quality contract can be met.

### How This Makes CLEO "Better Than the legacy pattern"

the legacy pattern = the anti-pattern of bolted-on quality, where:
1. Workflow shape is designed first (ad-hoc, implicit)
2. Quality gates are added after (runtime-only, external)
3. Failures are late and expensive (shape never promised anything)
4. Adding/modifying gates silently breaks existing workflows

CLEO with Protocol Chains / Warp:
1. Shape and gates are co-defined (MEOW + LOOM at definition time)
2. Static analysis verifies gate satisfiability before execution
3. Failures are early and cheap (bad definition = type error, not runtime surprise)
4. Composed chains maintain gate invariants from all source chains

CLEO already has sophisticated gates (5 layers). The gap is not "CLEO lacks gates" -- it is "CLEO's gates are not part of the workflow definition language." Protocol Chains / Warp closes that gap.

### Canon Naming Recommendation

| Option | Pros | Cons |
|--------|------|------|
| **Warp** (recommended) | Extends textile metaphor naturally; warp+weft=fabric; canon-true | Less immediately obvious to developers unfamiliar with weaving |
| **Protocol Chains** | Technically precise; developer-friendly | Does not match workshop aesthetic; uses CS terminology |
| **Dual naming** | Best of both: "Warp" in canon/concepts, "Protocol Chains" in technical docs | Adds naming complexity; precedent exists (LOOM/RCASD-IVTR+C) |

**Recommendation**: Use **dual naming** following existing precedent. "Warp" is the canon concept name (like "LOOM"), while "Protocol Chains" is the technical implementation name (like "RCASD-IVTR+C"). This preserves workshop aesthetics in conceptual documentation while maintaining technical clarity in specs and code.

---

## 5. CODEBASE HEALTH STATUS

Independent verification by import-validator agent:

| Check | Status | Details |
|-------|--------|---------|
| TODO/FIXME/HACK in src/ | CLEAN | 0 actionable markers (2 false positives: `SN-XXX` pattern doc, `todo.json` section comment) |
| TODO/FIXME/HACK in tests/ | CLEAN | 0 found |
| Underscore imports | All legitimate | 14 `_error.js` imports (engine helper), 10 `_meta.js` imports (domain helper) |
| Unused imports | None detected | All underscore-prefixed imports are internal module references |
| TypeScript compilation | CLEAN | `npx tsc --noEmit` -- 0 errors, 0 warnings |
| Test suite | ALL PASS | 242 files, 3912 tests, 0 failures (129.13s) |

---

## 6. STALE DOCUMENTATION CORRECTIONS NEEDED

### 6.1 MEMORY.md: NEXUS Stub Claim (INCORRECT)

**Current text**:
> "NEXUS domain handler: STUB ONLY (E_NOT_IMPLEMENTED for all ops)"
> "No registry entries, no nexus.db schema"
> "Depends on: stable BRAIN foundation (now done)"

**Actual state**: NEXUS is a fully implemented domain handler (`src/dispatch/domains/nexus.ts`, 660 lines) with 24 operations (11 query + 13 mutate), full business logic delegating to `src/core/nexus/`, merged sharing operations (T5277), and 13 passing tests. Zero `E_NOT_IMPLEMENTED` references in the file.

### 6.2 MEMORY.md: Test Count (STALE)

**Current text**: "233 files, 3847 tests, 0 failures (as of 2026-03-03)"

**Actual**: 242 files, 3912 tests, 0 failures

### 6.3 NEXUS ARCHITECTURE.md: Pre-Canon Neural Metaphors

**File**: `src/core/nexus/ARCHITECTURE.md`

**Issue**: Uses "neural network metaphors (neurons, synapses, weights, activation)" in prose. This predates the canon workshop vocabulary. The code itself does NOT use neural metaphors in identifiers -- only ARCHITECTURE.md's descriptive text.

**Should use**: Workshop vocabulary (star road, hearth, axle, central chamber) consistent with NEXUS-CORE-ASPECTS.md.

---

## 7. REMEDIATION PLAN

### Priority 1: MEMORY.md Corrections (small)

**Scope**: Small -- single file edit
**Files affected**: `/home/keatonhoskins/.claude/projects/-mnt-projects-claude-todo/memory/MEMORY.md`
**What needs to change**:
- Replace "NEXUS Status" section: remove "STUB ONLY" claim, replace with "FULLY IMPLEMENTED (24 operations: 11 query + 13 mutate)"
- Update test count from "233 files, 3847 tests" to "242 files, 3912 tests"
- Update "Key Project Facts" section test count accordingly

### Priority 2: Sticky Notes Missing Promotion Paths (small)

**Scope**: Small -- two new conversion functions following existing pattern
**Files affected**:
- `src/core/sticky/convert.ts` -- add `convertStickyToSessionNote()` and `convertStickyToTaskNote()`
- `src/core/sticky/types.ts` -- extend `ConvertedTargetType` to include `'session_note' | 'task_note'`
- `src/dispatch/engines/sticky-engine.ts` -- wire new engine functions
- `src/dispatch/domains/sticky.ts` -- add new mutate operations
- `src/dispatch/registry.ts` -- register new operations
- Tests for new conversion paths

### Priority 3: NEXUS ARCHITECTURE.md Vocabulary Update (small)

**Scope**: Small -- prose-only edit in one file
**Files affected**: `src/core/nexus/ARCHITECTURE.md`
**What needs to change**: Replace neural metaphors (neurons, synapses, weights, activation) with workshop vocabulary (star road, hearth, central chamber, axle) from NEXUS-CORE-ASPECTS.md. No code changes required.

### Priority 4: Protocol Chains / Warp Implementation (large)

**Scope**: Large -- new concept spanning multiple domains
**Files affected**: New files in `src/core/` for chain definition, gate contract embedding, chain composition, and chain validation. Extensions to `pipeline`, `check`, and `orchestrate` domains.
**What needs to change**: This is the Phase 5 capstone implementation. See protocol-analyst roadmap (5 phases: chain definition format, gate contract embedding, chain composition, runtime execution, developer experience). This is future work contingent on user approval of the overall direction.

---

## 8. NEXT STEPS

Ordered implementation tasks if remediation is approved:

1. **Correct MEMORY.md** -- Fix NEXUS stub claim and test counts. Immediate, no code changes.
2. **Add `convertStickyToSessionNote()` and `convertStickyToTaskNote()`** -- Complete the canon-defined promotion paths. Should be a CLEO task (small scope).
3. **Update NEXUS ARCHITECTURE.md prose** -- Replace neural metaphors with workshop vocabulary. Cosmetic, no functional impact.
4. **Create ADR for Warp / Protocol Chains concept** -- Document the design decision for MEOW+LOOM synthesis before implementation begins. Establishes canon naming (Warp = concept, Protocol Chains = technical).
5. **Phase 5 implementation** -- If approved, begin with chain definition format (Phase 1 of protocol-analyst roadmap). Each phase should be a separate CLEO task or epic.

---

## 9. SN-005 RESOLUTION RECOMMENDATION

**Recommendation: SN-005 can be marked RESOLVED.**

The sticky note's core ask was: "perform a word-for-word canon naming review against NEXUS-CORE-ASPECTS.md and verify every planned term maps correctly to the workshop language." That review is now complete with the following conclusions:

- All 10 canon terms verified against runtime code and documentation
- 94.4% canon compliance confirmed
- MEOW/LOOM/Protocol Chains distinction analyzed and synthesized
- Phase 5 capstone naming fit assessed (Warp recommended as canon name)
- "Better than the legacy pattern" path identified (definition-time gate embedding)
- Remediation items catalogued with scope and priority

The review **deliverable** is complete. The remediation **implementation** (Priority 1-4 items above) should be tracked as separate CLEO tasks, not kept open under SN-005. The sticky note served its purpose: it caught the thought, the thought has been fully resolved into actionable work, and those action items should now be promoted to Threads (tasks) per the canon lifecycle.

---

*Synthesis performed by synthesis-agent from reports by canon-researcher, canon-auditor, protocol-analyst, and import-validator.*
