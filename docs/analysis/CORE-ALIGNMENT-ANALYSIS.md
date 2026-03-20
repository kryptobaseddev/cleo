# CLEO CORE Analysis: Task Alignment with Vision & Package Spec

**Date:** 2026-03-19  
**Analysis:** Complete task landscape vs CLEO-VISION.md and CORE-PACKAGE-SPEC.md  
**Scope:** What is truly CORE to CLEO?

---

## 🎯 Executive Summary: The CORE Question

**Is this work CORE?** Partially. We have **3 epics competing for attention**, but only **2 are truly CORE**.

| Epic | CORE? | Alignment | Priority |
|------|-------|-----------|----------|
| **T002** Monorepo Stabilization | ✅ **YES** | Foundation/Core package | Critical |
| **T029** Schema Review | ✅ **YES** | BRAIN integrity, data layer | High |
| **T038** Drift Remediation | ✅ **YES** | Agent/Intelligence dimensions | Critical |
| **T008** CleoOS | ❌ **NO** | Product layer (built ON core) | Should defer |

**The Problem:** We're trying to build the **roof (CleoOS)** before the **foundation (core)** is solid.

---

## 📐 Alignment Analysis

### Against CLEO-VISION.md

**CLEO's Four Canonical Systems:**

```
┌─────────────────────────────────────────────────────────────┐
│                    CLEO VISION                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  BRAIN (Memory)          LOOM (Pipeline)                    │
│  ├── Portable Memory     ├── RCASD-IVTR+C                   │
│  ├── 3-layer retrieval   ├── Lifecycle gates                │
│  └── Anti-hallucination  └── Provenance                     │
│                                                             │
│  NEXUS (Network)         LAFS (Contract)                    │
│  ├── Cross-project       ├── JSON envelopes                 │
│  ├── Federated queries   ├── MVI disclosure                 │
│  └── Pattern sharing     └── Exit codes                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

| Epic | Systems Affected | Vision Alignment |
|------|-----------------|------------------|
| **T002** | BRAIN, LOOM, LAFS | ✅ Stabilizes the foundation |
| **T029** | BRAIN, NEXUS | ✅ Fixes data integrity, validates NEXUS |
| **T038** | BRAIN (Agent/Intelligence) | ✅ Completes missing dimensions |
| **T008** | Extension layer | ⚠️ Builds ON TOP of canonical systems |

**CLEO-VISION Says:**
> "The four systems (BRAIN, LOOM, NEXUS, LAFS) are canonical and immutable. Individual system specifications may evolve, but the roles described here are fixed."

**T008 CleoOS violates this** - it introduces new concepts (Hearth, Impulse, Watchers, Refinery) that are NOT the four canonical systems.

---

### Against CORE-PACKAGE-SPEC.md

**@cleocode/core Contract:**

```
@cleocode/cleo (assembled CLI + MCP product)
  |-- @cleocode/core (standalone business logic kernel) ← THIS IS CORE
        |-- @cleocode/contracts (types + interfaces)
        |-- Domains: tasks, sessions, memory, orchestration, lifecycle, release, admin
        |-- Bundled SQLite store (Drizzle ORM)
```

**Core Purity Rules:**
- ❌ MUST NOT import from `packages/cleo/src/cli/`
- ❌ MUST NOT import from `packages/cleo/src/mcp/`
- ❌ MUST NOT import from `packages/cleo/src/dispatch/`

| Epic | Core Package Impact | Violates Purity? |
|------|-------------------|------------------|
| **T002** | Direct - fixes @cleocode/core | ❌ No |
| **T029** | Direct - fixes core data layer | ❌ No |
| **T038** | Direct - adds core capabilities | ❌ No |
| **T008** | Indirect - builds on top | ✅ **Yes** - introduces new layer |

**T008 CleoOS would add:**
- Autonomous Runtime (Watchers, Impulse, Patrol)
- Conduit Protocol (agent relay)
- The Hearth (operator surface)

These are **product features**, not **core package features**.

---

## 🔴 Critical Finding: Work Misalignment

### The Problem

We have **28 pending tasks** across 4 epics, but:

1. **No acceptance criteria** on ANY task (blocks definition of done)
2. **T008 CleoOS distracts** from stabilizing the foundation
3. **Missing dependencies** between epics (T008 should depend on T002)
4. **T029 and T038 overlap** (both fix BRAIN/NEXUS issues)

### What CLEO Actually Needs Right Now

Based on DRIFT-ASSESSMENT-2026-03-19.md:

**BRAIN System:**
- ✅ Base: 85% complete (5,122 observations, 3-layer retrieval)
- ✅ Reasoning: 65% complete (causal trace, similarity)
- ⚠️ **Agent: 40% complete** ← **CRITICAL GAP**
- ⚠️ **Intelligence: 50% complete** ← **CRITICAL GAP**
- ⚠️ **Network: 30% complete** ← Needs validation

**What this means:**
- Agents crash without monitoring (T039-T041)
- Same errors repeat (no learning)
- No quality prediction
- Nexus shipped but unused

**The Foundation is shaky. We shouldn't build CleoOS on quicksand.**

---

## 💡 Recommendation: Consolidate to CORE-ONLY

### Phase 1: Foundation (T002)
**Goal:** @cleocode/core is production-ready

**Tasks:**
- T003: Fix 107 test failures
- T004: Validate Drizzle migrations
- T005: Wire reconciliation dispatch
- T006: Migrate CLI to citty
- T007: Fix node:sqlite casts

**Why:** "Standalone business logic package" isn't standalone if tests fail.

---

### Phase 2: BRAIN Integrity (Merge T029 + T038)
**Goal:** Complete BRAIN's B-R-A-I-N dimensions

**Wave 0 (Foundation):**
- T030: Soft FK audit → **ACCEPTANCE: Prevent orphaned brain records**
- T031: Missing indexes → **ACCEPTANCE: Query perf <100ms for dashboard**

**Wave 1 (Validation):**
- T032: Nexus validation → **ACCEPTANCE: Pass 31 operation test suite**
- T033: Connection remediation → **ACCEPTANCE: Zero orphaned records after deletes**

**Wave 2 (Agent Dimension):**
- T034: Self-healing → **ACCEPTANCE: Auto-retry 3x with backoff**
- T039: Health monitoring → **ACCEPTANCE: Detect crashes within 30s**
- T040: Retry logic → **ACCEPTANCE: Exponential backoff 1s, 2s, 4s**
- T041: Agent registry → **ACCEPTANCE: Track active agents, capacity, history**

**Wave 3 (Intelligence Dimension):**
- T035: Quality prediction → **ACCEPTANCE: Risk score for tasks**
- T042: Memory CLI parity → **ACCEPTANCE: cleo memory search/find/fetch**
- T043: Impact prediction → **ACCEPTANCE: Detect downstream change effects**
- T044: Reasoning CLI parity → **ACCEPTANCE: cleo reason why/similar**

**Wave 4 (Documentation):**
- T036: ERD diagrams → **ACCEPTANCE: Visual schema for all 3 DBs**
- T037: Documentation → **ACCEPTANCE: Update specs, close drift**
- T045: Nexus decision → **ACCEPTANCE: Mark N dimension validated or deferred**

---

### Phase 3: Product Layer (Defer T008)
**Goal:** Build CleoOS on solid foundation

**Condition:** T002 + merged T029/T038 epics complete

**Rationale:** From CLEO-VISION:
> "Workshop vocabulary such as Thread, Tapestry, Tessera, Cogs, Cascade, Tome, Sticky Notes, The Hearth, The Impulse, Conduit, Watchers, The Sweep, Refinery, Looming Engine, Living BRAIN, and The Proving is conceptual language layered on top..."

These are **product concepts**, not **core architecture**. They belong in a separate product epic that builds ON @cleocode/core, not IN it.

---

## 🎬 Action Plan

### Immediate (Today)

1. **Add acceptance criteria** to all T002 tasks
2. **Start T003** (test failures) - unblocks everything
3. **Archive T008** or move to "Future Product" backlog

### This Sprint

4. **Consolidate T029 + T038** into single "CLEO CORE Hardening" epic
5. **Add AC to all tasks** using the patterns above
6. **Create dependency chain:** T002 → Merged Epic

### Next Sprint

7. **Complete T002** (foundation stable)
8. **Start merged epic** Wave 0 (data integrity)

---

## 📊 Final Task Count

| Phase | Epics | Tasks | Status |
|-------|-------|-------|--------|
| **Before** | 4 | 28 pending | Scattered, unfocused |
| **After** | 2 | 17 tasks | Consolidated, CORE-only |
| **Deferred** | 1 (T008) | 4 tasks | Future product layer |

**Result:** Focus on what makes @cleocode/core a solid, reliable, intelligent foundation.

---

## 🤔 Questions for You

1. **Should we archive T008 (CleoOS)** or move it to a separate product roadmap?
2. **Should I consolidate T029 + T038** into a single "CORE Hardening" epic?
3. **Priority order:** T002 (foundation) first, or parallel with merged epic?
4. **CLI parity** (T042, T044): Is this CORE or product-layer work?

The vision is clear: **BRAIN, LOOM, NEXUS, LAFS** are canonical. Let's make them rock-solid before adding new layers.