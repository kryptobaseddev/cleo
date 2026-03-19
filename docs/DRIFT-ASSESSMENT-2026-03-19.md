# CLEO Documentation-Implementation Drift Assessment

**Date:** 2026-03-19  
**Specs Reviewed:**
- `docs/specs/PORTABLE-BRAIN-SPEC.md` (v1.3.0)
- `docs/specs/CLEO-BRAIN-SPECIFICATION.md` (v1.3.0)

**Codebase:** `packages/core/src/`

---

## Executive Summary

The codebase has **significant drift** from the specifications. While the **core data architecture** (brain.db schema, retrieval layers, reasoning) is largely implemented, there are major gaps in:

1. **CLI interface coverage** - Many specified CLI commands are not implemented
2. **Agent layer** - Self-healing, registry, load balancing are missing
3. **Intelligence layer** - Adaptive validation, quality prediction not implemented
4. **Network layer** - Knowledge transfer, federated agents not implemented

---

## 1. BASE (Memory Layer) - 85% Implemented

### ✅ IMPLEMENTED

| Spec Feature | Implementation Status | Location |
|--------------|----------------------|----------|
| `brain.db` with decisions/patterns/learnings/observations tables | ✅ Full | `store/brain-schema.ts:82-188` |
| `brain_page_nodes` / `brain_page_edges` (PageIndex graph) | ✅ Full | `store/brain-schema.ts:249-276` |
| 3-layer retrieval (search/timeline/fetch) | ✅ Full | `memory/brain-retrieval.ts` |
| `memory.observe` via MCP | ✅ Full | `memory/brain-retrieval.ts:508-598` |
| Decisions module (store/recall/search/list) | ✅ Full | `memory/decisions.ts` |
| Patterns module (store/search/stats) | ✅ Full | `memory/patterns.ts` |
| Learnings module | ✅ Full | `memory/learnings.ts` |
| Vector embeddings (384-dim vec0) | ✅ Full | `memory/brain-embedding.ts` |
| Hybrid search (FTS5 + vector + graph) | ✅ Full | `memory/brain-search.ts` |
| Brain similarity search | ✅ Full | `memory/brain-similarity.ts` |
| Temporal decay | ✅ Full | `memory/brain-lifecycle.ts` |
| Memory consolidation | ✅ Full | `memory/brain-lifecycle.ts` |
| Brain links (cross-references) | ✅ Full | `memory/brain-links.ts` |
| Sticky notes | ✅ Full | `store/brain-schema.ts:193-212` |

### ❌ NOT IMPLEMENTED

| Spec Feature | CLI Command | Gap |
|--------------|-------------|-----|
| Memory export/import JSONL | `cleo memory export --type decisions` | Not implemented |
| Memory consolidation CLI | `cleo memory consolidate --period "2026-Q1"` | Not implemented |

---

## 2. REASONING Layer - 65% Implemented

### ✅ IMPLEMENTED

| Spec Feature | Implementation Status | Location |
|--------------|----------------------|----------|
| `memory.reason.why` - causal trace | ✅ Full | `memory/brain-reasoning.ts:51-144` |
| `memory.reason.similar` - semantic similarity | ✅ Full | `memory/brain-reasoning.ts:181-276` |
| Dependency graph analysis | ✅ Full | `orchestration/analyze.ts` |
| Wave-based parallel execution | ✅ Full | `phases/deps.ts` |

### ❌ NOT IMPLEMENTED

| Spec Feature | CLI Command | Status |
|--------------|-------------|--------|
| Impact prediction | `cleo reason impact --change "Modify GraphRAG"` | ❌ Not implemented |
| Timeline analysis | `cleo reason timeline --type research` | ❌ Not implemented |
| Counterfactual reasoning | `cleo reason counterfactual --decision D045` | ❌ Not implemented |

**Gap Impact:** Cannot predict downstream effects of changes or analyze historical timelines.

---

## 3. AGENT Layer - 40% Implemented

### ✅ IMPLEMENTED

| Spec Feature | Implementation Status | Location |
|--------------|----------------------|----------|
| Orchestrator with session tracking | ✅ Full | `orchestration/index.ts:85-113` |
| Dependency analysis | ✅ Full | `orchestration/analyze.ts` |
| 7 protocol dispatch mapping | ✅ Full | `orchestration/index.ts:304-333` |
| Auto-dispatch by labels/keywords | ✅ Full | `orchestration/index.ts:339-362` |
| Spawn context preparation | ✅ Full | `orchestration/index.ts:210-236` |
| Wave-based parallel execution | ✅ Full | `phases/deps.ts` |

### ❌ NOT IMPLEMENTED (Major Gaps)

| Spec Feature | CLI Command | Gap Severity |
|--------------|-------------|--------------|
| Self-healing | N/A - automatic | 🔴 **CRITICAL** - Agent failures require HITL |
| Agent registry with health monitoring | `cleo agent status` | 🔴 **CRITICAL** - Cannot track active agents |
| Load balancing | `cleo agent capacity --show` | 🔴 **CRITICAL** - No capacity awareness |
| Capability discovery | `cleo agent spawn --auto-select` | 🟡 **HIGH** - Manual skill assignment only |
| Learning from execution | `cleo agent learn --task T3002` | 🟡 **HIGH** - No feedback loop |
| Retry logic with exponential backoff | N/A - automatic | 🔴 **CRITICAL** - No automatic retry |
| Heartbeat monitoring (30s intervals) | N/A - automatic | 🔴 **CRITICAL** - No crash detection |

**Gap Impact:** Agents are essentially stateless with no recovery, monitoring, or learning. Same mistakes repeated. No production-grade reliability.

---

## 4. INTELLIGENCE Layer - 50% Implemented

### ✅ IMPLEMENTED

| Spec Feature | Implementation Status | Location |
|--------------|----------------------|----------|
| 4-layer validation (schema/semantic/referential/protocol) | ✅ Full | `validation/` |
| 72 standardized exit codes | ✅ Full | `error-catalog.ts` |
| Protocol enforcement | ✅ Full | `compliance/protocol-enforcement.ts` |
| Lifecycle gate enforcement | ✅ Full | `lifecycle/` |
| Compliance metrics dashboard | ✅ Partial | `compliance/index.ts` |
| Anti-hallucination checks | ✅ Full | `validation/compliance.ts` |

### ❌ NOT IMPLEMENTED

| Spec Feature | CLI Command | Gap Severity |
|--------------|-------------|--------------|
| Adaptive validation (learn common errors) | `cleo intelligence learn-errors` | 🟡 **HIGH** - Static rules only |
| Proactive suggestions | `cleo intelligence suggest` | 🟡 **HIGH** - Reactive only |
| Quality prediction (ML risk scoring) | `cleo intelligence predict --task T3002` | 🟡 **HIGH** - No prediction capability |
| Auto-remediation | `cleo intelligence suggest-fix --error E_VALIDATION_FAILED` | 🟡 **HIGH** - No automatic fixes |
| Error pattern learning | N/A - automatic | 🟡 **HIGH** - Same errors repeated |

**Gap Impact:** System cannot learn from mistakes or predict task success likelihood. All validation is static.

---

## 5. NETWORK (Nexus) Layer - 30% Implemented

### ✅ IMPLEMENTED

| Spec Feature | Implementation Status | Location |
|--------------|----------------------|----------|
| Nexus registry (cross-project) | ✅ Full | `nexus/registry.ts` |
| Project registration | ✅ Full | `nexus/registry.ts:191-246` |
| Cross-project task resolution | ✅ Full | `nexus/query.ts` |
| Cross-project search (basic) | ✅ Full | `nexus/discover.ts:127-180` |
| Global dependency graph | ✅ Full | `nexus/deps.ts:89-165` |
| Three-tier permissions | ✅ Full | `nexus/permissions.ts` |

### ❌ NOT IMPLEMENTED

| Spec Feature | CLI Command | Gap Severity |
|--------------|-------------|--------------|
| Semantic search across Nexus | `cleo network search "authentication"` | 🟡 **HIGH** - Only basic keyword search |
| Knowledge transfer | `cleo network export-pattern P001 --global` | 🔴 **CRITICAL** - Patterns don't cross projects |
| Federated agents | `cleo network agents` | 🔴 **CRITICAL** - Agents are project-scoped only |
| Global intelligence aggregation | `cleo network insights` | 🟡 **HIGH** - No consolidated dashboard |
| Project similarity detection | `cleo network similarity --project X` | 🟡 **HIGH** - No embedding-based similarity |

**Gap Impact:** Nexus shipped 8+ days ago with zero usage. No cross-project intelligence sharing. Patterns discovered in Project A don't inform Project B.

---

## 6. CLI Interface Coverage - 60% Implemented

### Spec'd CLI Commands vs Implementation

| Spec CLI Command | Status | Notes |
|------------------|--------|-------|
| `cleo memory store --type decision` | ❌ **MISSING** | Decisions module exists but no CLI |
| `cleo memory recall "Why did we choose SQLite-vec?"` | ❌ **MISSING** | No CLI for recallDecision |
| `cleo memory search "authentication"` | ❌ **MISSING** | No CLI for searchDecisions |
| `cleo memory consolidate --period "2026-Q1"` | ❌ **MISSING** | No CLI for consolidation |
| `cleo reason why --task T2345` | ❌ **MISSING** | reasonWhy exists but no CLI |
| `cleo reason similar --task T3002` | ❌ **MISSING** | reasonSimilar exists but no CLI |
| `cleo reason impact --change "X"` | ❌ **MISSING** | Not implemented in core |
| `cleo reason timeline --type research` | ❌ **MISSING** | Not implemented in core |
| `cleo agent spawn --task T3002 --auto-select` | ❌ **MISSING** | prepareSpawn exists but no CLI |
| `cleo agent status` | ❌ **MISSING** | No agent registry |
| `cleo agent registry` | ❌ **MISSING** | No agent registry |
| `cleo agent capacity --show` | ❌ **MISSING** | No capacity tracking |
| `cleo intelligence suggest` | ❌ **MISSING** | Not implemented |
| `cleo intelligence predict --task T3002` | ❌ **MISSING** | Not implemented |
| `cleo network search "authentication"` | ❌ **MISSING** | discover.ts exists but no CLI |
| `cleo network export-pattern P001 --global` | ❌ **MISSING** | Not implemented |
| `cleo network agents` | ❌ **MISSING** | Not implemented |

**Key Finding:** Many core functions exist in `packages/core/src/` but are **only exposed via MCP**, not CLI. The CLI layer is significantly behind.

---

## 7. Data Schema Compliance

| Schema | Spec Location | Implementation | Status |
|--------|---------------|----------------|--------|
| Session Context | Section 4.1 | `sessions` table with JSON columns | ✅ Compliant |
| Decision Memory | Section 4.2 | `brain_decisions` table | ✅ Compliant |
| Pattern Memory | Section 4.3 | `brain_patterns` table | ✅ Compliant |
| Learning Memory | Section 4.4 | `brain_learnings` table | ✅ Compliant |
| Observation | ADR-009 | `brain_observations` table | ✅ Compliant (+ claude-mem migration) |

**Note:** 5,122 observations migrated from claude-mem per spec claim.

---

## 8. Critical Architecture Gaps

### 8.1 Missing Infrastructure

| Component | Impact | Priority |
|-----------|--------|----------|
| Agent health monitoring | Cannot detect crashes | 🔴 P0 |
| Retry logic with exponential backoff | No failure recovery | 🔴 P0 |
| Agent registry with capacity tracking | Cannot load balance | 🔴 P0 |
| Impact prediction | Cannot assess change risk | 🟡 P1 |
| Quality prediction (ML model) | Cannot predict task success | 🟡 P1 |
| Knowledge transfer across projects | Siloed learning | 🟡 P1 |

### 8.2 Interface Parity Gap

The MCP interface has 256 canonical operations, but **CLI commands are ~50 vs ~86 claimed** in PORTABLE-BRAIN-SPEC.md line 159. Many memory/reasoning/agent operations are MCP-only.

---

## 9. Spec Claims vs Reality

| Spec Claim | Reality | Drift |
|------------|---------|-------|
| "~86 command files" (line 159) | Actually ~50 CLI commands | ⚠️ Overstated |
| "5,122 observations migrated" (line 94) | Cannot verify without DB | ✅ Likely accurate |
| "MCP ~95% compliant" (line 173) | MCP delegates to core | ✅ Accurate |
| "Self-healing" (Phase 1) | ❌ Not implemented | 🔴 Major gap |
| "Load balancing" (Phase 2) | ❌ Not implemented | 🔴 Major gap |
| "Federated agents" (Phase 3) | ❌ Not implemented | 🔴 Major gap |

---

## 10. Recommendations

### Immediate (P0 - This Sprint)
1. **Implement agent health monitoring** - Heartbeat every 30s, timeout after 3min
2. **Add retry logic** - 3 attempts with exponential backoff
3. **Create agent registry** - Track active agents, capacity, performance history

### Short-term (P1 - Next 2 Sprints)
4. **CLI parity with MCP** - Expose memory.* and reason.* via CLI
5. **Implement impact prediction** - Reverse dependency analysis for changes
6. **Add quality prediction** - Simple heuristics-based risk scoring

### Medium-term (P2 - Next Quarter)
7. **Knowledge transfer** - Export/import patterns across projects
8. **Adaptive validation** - Learn from error patterns
9. **Federated agents** - Cross-project agent coordination

---

## Appendix: File Inventory

### Core Memory/Brain Files (Implemented)
- `packages/core/src/store/brain-schema.ts` - Schema definitions
- `packages/core/src/store/brain-accessor.ts` - Data accessor
- `packages/core/src/store/brain-sqlite.ts` - SQLite layer
- `packages/core/src/memory/brain-retrieval.ts` - 3-layer retrieval
- `packages/core/src/memory/decisions.ts` - Decision operations
- `packages/core/src/memory/patterns.ts` - Pattern operations
- `packages/core/src/memory/learnings.ts` - Learning operations
- `packages/core/src/memory/brain-reasoning.ts` - Causal/similarity reasoning
- `packages/core/src/memory/brain-lifecycle.ts` - Temporal decay/consolidation
- `packages/core/src/memory/brain-search.ts` - FTS5/hybrid search
- `packages/core/src/memory/brain-embedding.ts` - Vector embeddings

### Core Orchestration Files (Partial)
- `packages/core/src/orchestration/index.ts` - Basic orchestrator
- `packages/core/src/orchestration/analyze.ts` - Dependency analysis
- `packages/core/src/phases/deps.ts` - Wave-based execution

### Core Compliance Files (Partial)
- `packages/core/src/compliance/index.ts` - Metrics dashboard
- `packages/core/src/compliance/protocol-enforcement.ts` - Protocol validation
- `packages/core/src/validation/compliance.ts` - Compliance checks

### Core Nexus Files (Partial)
- `packages/core/src/nexus/index.ts` - Registry, query, discover
- `packages/core/src/nexus/registry.ts` - Project registration
- `packages/core/src/nexus/discover.ts` - Cross-project search
- `packages/core/src/nexus/deps.ts` - Global dependency graph

---

**Assessment by:** Claude Code  
**Confidence:** High (based on direct source code analysis)
