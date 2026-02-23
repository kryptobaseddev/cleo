# ADR-009: CLEO BRAIN Cognitive Architecture — Unified Reference

**Date**: 2026-02-22
**Status**: proposed
**Related ADRs**: ADR-006 (storage), ADR-007 (domain consolidation), ADR-008 (canonical architecture)
**Source Documents**: CLEO-BRAIN-SPECIFICATION.md, PORTABLE-BRAIN-SPEC.md, cognitive-architecture.mdx, NEXUS ARCHITECTURE.md, CLEO-STRATEGIC-ROADMAP-SPEC.md, vision.mdx
**Research**: T2971, T2996, T4797

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context and Problem Statement

CLEO's BRAIN cognitive architecture is defined across **6+ scattered documents** with no single authoritative reference connecting them. This fragmentation has produced:

- **Storage contradictions**: BRAIN Spec defines JSONL memory files; ADR-006 mandates SQLite for all operational data
- **Retrieval strategy conflict**: cognitive-architecture.mdx defines "Vectorless RAG"; BRAIN Spec and Strategic Roadmap plan SQLite-vec vector embeddings
- **Pipeline stage mismatch**: ADR-006 schema lists 9 stages with "adr" as a stage; ADR-007 mandates 8 stages with ADR as a protocol
- **Incomplete domain mapping**: ADR-007 Section 4.2 lists 10 future operations across 5 BRAIN dimensions; the BRAIN Spec defines 30+ operations
- **Undefined framework relationship**: The 5 Canonical Pillars (vision.mdx) and 5 BRAIN Dimensions (BRAIN Spec) are never formally related
- **Reasoning domain placement unresolved**: The BRAIN Spec defines `cleo reason *` commands, but no domain in ADR-007 naturally owns reasoning as a cross-cutting capability

This ADR serves as the **single bridging document** that resolves these conflicts and connects the BRAIN system across all existing specifications.

---

## 2. Decision

### 2.1 Two Orthogonal Frameworks

CLEO operates under **two complementary frameworks** at different abstraction levels:

| Framework | Authority | Abstraction | Defines | Mutability |
|-----------|-----------|-------------|---------|------------|
| **5 Canonical Pillars** | vision.mdx, PORTABLE-BRAIN-SPEC.md | Product contract | WHAT CLEO promises to users and agents | Immutable (constitutional) |
| **5 BRAIN Dimensions** | CLEO-BRAIN-SPECIFICATION.md | Capability model | HOW CLEO delivers on those promises | Evolves with implementation |

**The Pillars define identity. The BRAIN dimensions define capability.**

They are orthogonal: a single Pillar may be served by multiple BRAIN dimensions, and a single BRAIN dimension may contribute to multiple Pillars.

### 2.2 Pillar-to-BRAIN Crosswalk

| Pillar | Primary BRAIN Dimensions | How Delivered |
|--------|--------------------------|---------------|
| **Portable Memory** | Base (Memory), Network | Task/session persistence, cross-project knowledge transfer |
| **Provenance by Default** | Base (Memory), Intelligence | Audit trails, decision memory, compliance scoring |
| **Interoperable Interfaces** | Agent, Network | CLI + MCP + adapters, federated agent coordination |
| **Deterministic Safety** | Intelligence, Base (Memory) | 4-layer validation, adaptive validation, atomic writes |
| **Cognitive Retrieval** | Reasoning, Base (Memory), Network | Graph-RAG, vectorless hierarchy search, similarity detection, cross-project search |

### 2.3 The 5 BRAIN Dimensions — Canonical Definition

```
B — Base (Memory Layer)
    Persistent knowledge storage and retrieval across sessions.
    The foundation all other dimensions build upon.

R — Reasoning (Inference Layer)
    Causal inference, similarity detection, impact prediction, temporal analysis.
    The analytical capability that derives insight from stored memory.

A — Agent (Orchestration Layer)
    Autonomous multi-agent coordination with self-healing and learning.
    The execution fabric that carries out work.

I — Intelligence (Validation & Adaptation Layer)
    Adaptive validation, proactive suggestions, quality prediction.
    The quality system that learns from outcomes.

N — Network (Cross-Project Coordination Layer)
    Multi-project knowledge sharing and federated agent coordination.
    The global scope that connects project-local brains.
```

### 2.4 BRAIN Dimension to Domain Mapping

Each BRAIN dimension maps to one or more of the 9 canonical domains (ADR-007):

| BRAIN Dimension | Primary Domain | Secondary Domains | Scope |
|-----------------|---------------|-------------------|-------|
| **Base (Memory)** | `memory` | `session`, `tasks` | Project-local (.cleo/) |
| **Reasoning** | **DEFERRED** | See Section 2.5 | Project-local (.cleo/) |
| **Agent** | `orchestrate` | `tools` | Project-local (.cleo/) |
| **Intelligence** | `check` | `pipeline` | Project-local (.cleo/) |
| **Network** | `nexus` | `admin` | Global (~/.cleo/) |

### 2.5 Reasoning Domain Placement — Deferred to Research & Consensus

**DECISION**: The domain placement of Reasoning operations is **deferred** to a future RCSD cycle.

**Rationale**: CLEO is built for LLM agents, not humans. Reasoning operations (`reason why`, `reason similar`, `reason impact`, `reason timeline`) could be:

1. A subdomain of `memory` (reasoning = querying and analyzing stored knowledge)
2. A cross-cutting capability spread across `tasks`, `memory`, and `orchestrate`
3. A subdomain of `check` (reasoning = analysis and validation)
4. Something entirely different when viewed from an agent's operational perspective

This decision requires dedicated research into how LLM agents would actually invoke and benefit from reasoning operations in their workflows. Agent-native design demands evidence, not assumptions.

**Interim Approach**: Reasoning operations are documented in this ADR as belonging to the BRAIN specification but without a committed domain assignment. Existing reasoning-adjacent operations (dependency analysis in `tasks`, wave computation in `orchestrate`, similarity in `nexus`) remain where they are.

**Required Task**: Create an RCSD research task to investigate reasoning domain placement from an LLM agent workflow perspective.

---

## 3. Storage Architecture — Hybrid Model

### 3.1 Resolution of ADR-006 vs BRAIN Spec Conflict

ADR-006 (accepted) mandates SQLite for all operational data. The BRAIN Spec defines JSONL memory files. These are reconciled as follows:

**SQLite is the canonical runtime store for all BRAIN memory data.**

JSONL serves as an **export/import format** for portability, not as a runtime store.

| Memory Type | Runtime Store | Export Format | Rationale |
|-------------|--------------|---------------|-----------|
| Decision Memory | `brain_decisions` SQLite table | JSONL export | Concurrent writes, relational queries, ACID |
| Pattern Memory | `brain_patterns` SQLite table | JSONL export | Frequency analysis, cross-reference queries |
| Learning Memory | `brain_learnings` SQLite table | JSONL export | Confidence-based filtering, type queries |
| Session Context | `sessions` SQLite table (existing) | JSON export | Already in SQLite per ADR-006 |
| Research Artifacts | MANIFEST.jsonl (existing) | JSONL (native) | Append-only, agent-output format |

### 3.2 SQLite Schema Extensions for BRAIN

The following tables extend the ADR-006 Project Store schema:

```sql
-- Decision Memory (BRAIN Base dimension)
CREATE TABLE brain_decisions (
  id TEXT PRIMARY KEY,              -- e.g., 'D001'
  type TEXT NOT NULL CHECK(type IN ('architecture', 'technical', 'process', 'strategic', 'tactical')),
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK(confidence IN ('low', 'medium', 'high')),
  outcome TEXT CHECK(outcome IN ('success', 'failure', 'mixed', 'pending')),
  alternatives_json TEXT,           -- JSON array of alternative approaches
  context_epic_id TEXT REFERENCES tasks(id),
  context_task_id TEXT REFERENCES tasks(id),
  context_phase TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Pattern Memory (BRAIN Base + Intelligence dimensions)
CREATE TABLE brain_patterns (
  id TEXT PRIMARY KEY,              -- e.g., 'P001'
  type TEXT NOT NULL CHECK(type IN ('workflow', 'blocker', 'success', 'failure', 'optimization')),
  pattern TEXT NOT NULL,
  context TEXT NOT NULL,
  frequency INTEGER NOT NULL DEFAULT 1,
  success_rate REAL,                -- 0.0-1.0 for workflow patterns
  impact TEXT CHECK(impact IN ('low', 'medium', 'high')),
  anti_pattern TEXT,
  mitigation TEXT,
  examples_json TEXT,               -- JSON array of task IDs
  extracted_at TEXT NOT NULL,
  updated_at TEXT
);

-- Learning Memory (BRAIN Base dimension)
CREATE TABLE brain_learnings (
  id TEXT PRIMARY KEY,              -- e.g., 'L001'
  insight TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0.0 AND confidence <= 1.0),
  actionable INTEGER NOT NULL DEFAULT 0,  -- boolean
  application TEXT,
  applicable_types_json TEXT,       -- JSON array of task types
  created_at TEXT NOT NULL,
  updated_at TEXT
);

-- Cross-references between BRAIN memory entries and tasks
CREATE TABLE brain_memory_links (
  memory_type TEXT NOT NULL CHECK(memory_type IN ('decision', 'pattern', 'learning')),
  memory_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK(link_type IN ('produced_by', 'applies_to', 'informed_by', 'contradicts')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_type, memory_id, task_id, link_type)
);
```

### 3.3 JSONL Export/Import for Portability

BRAIN memory data can be exported to JSONL for transfer between projects or backup:

```bash
# Export decisions to JSONL
cleo memory export --type decisions --output decisions.jsonl

# Import decisions from JSONL
cleo memory import --type decisions --input decisions.jsonl

# Export all BRAIN memory
cleo memory export --all --output brain-export/
```

This preserves portability (Pillar 1: Portable Memory) while respecting ADR-006's SQLite mandate for runtime operations.

### 3.4 Storage Evolution Path

| Tier | Storage | BRAIN Capability |
|------|---------|-----------------|
| **S** (current) | SQLite (project-local .cleo/cleo.db) | Decision/Pattern/Learning tables |
| **M** (target) | SQLite + SQLite-vec (semantic embeddings) | + Similarity detection, semantic search |
| **L** (future) | SQLite + PostgreSQL (cross-project) | + Global intelligence, federated queries |
| **XL** (aspirational) | PostgreSQL + graph extensions | + Neural discovery, advanced reasoning |

---

## 4. Retrieval Architecture — Vectorless RAG + Future Vector Capability

### 4.1 Current State: Vectorless RAG

CLEO currently implements a **Vectorless RAG** system as documented in cognitive-architecture.mdx. This is not a limitation but a deliberate design choice:

```
Hierarchical Semantic Trees (current):
  Epic → Task → Subtask
       ↓
  LLM Reasoning Over Structure
       ↓
  Contextual Discovery Without Vectors
```

**Five Discovery Methods** (all vectorless):
1. **Label-based**: Jaccard similarity on shared tags
2. **Description-based**: Keyword extraction and matching
3. **File-based**: Shared code file references
4. **Hierarchy-based**: Tree distance via Lowest Common Ancestor (LCA) algorithm
5. **Auto mode**: Weighted combination with hierarchy boosting

**Neural Hierarchy**:
- Tasks act as **neurons** (atomic knowledge units)
- Dependencies act as **synapses** (directional connections)
- Hierarchy boosts act as **weights** (proximity strengthens relevance)
- Dual indexes provide O(1) lookup (forward: task->deps, reverse: task->dependents)

### 4.2 Future State: Vectorless RAG + Vector Augmentation

When SQLite-vec is introduced (Phase 2, contingent on validation gates), it **augments** the existing vectorless system rather than replacing it:

```
Query
  ├── Vectorless RAG (structural discovery)
  │   └── Hierarchy, labels, dependencies, LCA
  │
  └── Vector RAG (semantic discovery)
      └── SQLite-vec embeddings, cosine similarity

  → Merged Results (weighted by source confidence)
```

**Key Principle**: Structural discovery (vectorless) remains the **primary** retrieval method. Vector similarity is an **optional augmentation** for semantic queries that structural methods cannot answer well (e.g., "find tasks similar to authentication implementation" across unrelated hierarchies).

### 4.3 Knowledge Graph Edges

The `relates` field on tasks provides explicit knowledge graph connections:

| Edge Type | Meaning | Example |
|-----------|---------|---------|
| `relates-to` | General relationship | T100 relates-to T200 |
| `spawned-from` | Created by decomposition | T101 spawned-from T100 |
| `deferred-to` | Work moved to future task | T100 deferred-to T300 |
| `supersedes` | Replaces older task | T200 supersedes T100 |
| `duplicates` | Same work as another task | T100 duplicates T150 |

---

## 5. BRAIN Dimension — Full Capability Inventory

This section provides the comprehensive mapping of all BRAIN capabilities to the 9 canonical domains, resolving the gap in ADR-007 Section 4.2.

### 5.1 Base (Memory) — Domain: `memory` + `session`

| Capability | Domain.Operation | Phase | Status |
|------------|-----------------|-------|--------|
| Task persistence | `tasks.*` | Current | Shipped |
| Session state | `session.*` | Current | Shipped |
| Research artifacts | `memory.manifest.*` | Current | Shipped |
| Context persistence | `session.context.*` | 1 | Planned |
| Decision memory store | `memory.decision.store` | 2 | Planned |
| Decision memory recall | `memory.decision.recall` | 2 | Planned |
| Decision memory search | `memory.decision.search` | 2 | Planned |
| Pattern memory store | `memory.pattern.store` | 2 | Planned |
| Pattern memory extract | `memory.pattern.extract` | 2 | Planned |
| Pattern memory search | `memory.pattern.search` | 2 | Planned |
| Learning memory store | `memory.learning.store` | 3 | Planned |
| Learning memory search | `memory.learning.search` | 3 | Planned |
| Memory consolidation | `memory.consolidate` | 3 | Planned |
| Temporal queries | `memory.search` (with date filters) | 2 | Planned |
| Memory export (JSONL) | `memory.export` | 2 | Planned |
| Memory import (JSONL) | `memory.import` | 2 | Planned |
| Contradiction detection | `memory.contradictions` | Current | Shipped |

### 5.2 Reasoning (Inference) — Domain: DEFERRED (See Section 2.5)

| Capability | Proposed Operation | Phase | Status |
|------------|-------------------|-------|--------|
| Causal inference | `reason.why` | 2 | Deferred |
| Similarity detection | `reason.similar` | 2 | Deferred |
| Impact prediction | `reason.impact` | 2 | Deferred |
| Timeline analysis | `reason.timeline` | 3 | Deferred |
| Counterfactual reasoning | `reason.counterfactual` | 3 | Deferred |
| Dependency graph analysis | `tasks.blockers`, `tasks.depends` | Current | Shipped |
| Wave-based analysis | `orchestrate.waves`, `orchestrate.analyze` | Current | Shipped |
| Critical path analysis | `orchestrate.critical.path` | Current | Shipped |
| Cross-project similarity | `nexus.find` | Current | Shipped (unvalidated) |

**Note**: Existing reasoning-adjacent operations remain in their current domains. The `reason.*` namespace is reserved pending R&C outcome.

### 5.3 Agent (Orchestration) — Domain: `orchestrate` + `tools`

| Capability | Domain.Operation | Phase | Status |
|------------|-----------------|-------|--------|
| Multi-agent spawning | `orchestrate.spawn` | Current | Shipped |
| Protocol injection | `orchestrate.start` | Current | Shipped |
| Wave computation | `orchestrate.waves` | Current | Shipped |
| Next task recommendation | `orchestrate.next` | Current | Shipped |
| Brain bootstrap | `orchestrate.bootstrap` | Current | Shipped |
| Context management | `orchestrate.context` | Current | Shipped |
| Skill dispatch | `tools.skill.dispatch` | Current | Shipped |
| Self-healing (retry) | `orchestrate.agent.retry` | 1 | Planned |
| Health monitoring (heartbeat) | `orchestrate.agent.health` | 1 | Planned |
| Timeout detection | `orchestrate.agent.timeout` | 1 | Planned |
| Agent registry | `orchestrate.agent.registry` | 2 | Planned |
| Load balancing | `orchestrate.agent.balance` | 2 | Planned |
| Capability discovery | `orchestrate.agent.capabilities` | 2 | Planned |
| Capacity management | `orchestrate.agent.capacity` | 2 | Planned |
| Learning from execution | `orchestrate.agent.learn` | 3 | Planned |
| Adaptive routing | `orchestrate.agent.route` | 3 | Planned |
| Agent kill (graceful) | `orchestrate.agent.kill` | 2 | Planned |

### 5.4 Intelligence (Validation & Adaptation) — Domain: `check` + `pipeline`

| Capability | Domain.Operation | Phase | Status |
|------------|-----------------|-------|--------|
| Schema validation | `check.schema` | Current | Shipped |
| Protocol validation | `check.protocol` | Current | Shipped |
| Task validation | `check.task` | Current | Shipped |
| Coherence checks | `check.coherence.check` | Current | Shipped |
| Compliance summary | `check.compliance.summary` | Current | Shipped |
| Test execution | `check.test.run` | Current | Shipped |
| Lifecycle gates | `pipeline.stage.gates` | Current | Shipped |
| Compliance scoring | `check.compliance.score` | 1 | Planned |
| Error pattern learning | `check.intelligence.learn` | 2 | Planned |
| Adaptive validation | `check.intelligence.adapt` | 2 | Planned |
| Auto-remediation | `check.intelligence.fix` | 2 | Planned |
| Proactive suggestions | `check.intelligence.suggest` | 3 | Planned |
| Quality prediction | `check.intelligence.predict` | 3 | Planned |
| Suggestion acceptance tracking | `check.intelligence.feedback` | 3 | Planned |

### 5.5 Network (Cross-Project) — Domain: `nexus`

| Capability | Domain.Operation | Phase | Status |
|------------|-----------------|-------|--------|
| Cross-project search | `nexus.find` | Current | Shipped (unvalidated) |
| Project registry | `nexus.registry` (via admin) | Current | Shipped |
| Cross-project export | `nexus.export` | 1 | Planned |
| Cross-project import | `nexus.import` | 1 | Planned |
| Knowledge transfer | `nexus.transfer` | 2 | Planned |
| Pattern library (global) | `nexus.patterns.list` | 2 | Planned |
| Pattern export | `nexus.patterns.export` | 2 | Planned |
| Pattern import | `nexus.patterns.import` | 2 | Planned |
| Project similarity | `nexus.similarity` | 2 | Planned |
| Federated agent registry | `nexus.agents` | 3 | Planned |
| Cross-project coordination | `nexus.coordinate` | 3 | Planned |
| Global intelligence | `nexus.insights` | 3 | Planned |

**Contingency**: Network dimension expansion is gated on Nexus validation (Phase 1). If validation fails, defer all Phase 2+ Network operations.

---

## 6. Pipeline Stage Correction

### 6.1 Canonical 8-Stage Pipeline

Per ADR-007, the lifecycle pipeline is **8 stages** with ADR as a cross-cutting protocol, not a stage:

```
RCSD Phase (4 stages):
  research → consensus → specification → decomposition

IVTR Phase (4 stages):
  implementation → validation → testing → release
```

### 6.2 ADR-006 Schema Correction Required

The `lifecycle_stages` table CHECK constraint in ADR-006 MUST be updated:

**Current** (incorrect):
```sql
CHECK(stage_name IN ('research', 'consensus', 'adr', 'spec', 'decompose',
                      'implement', 'verify', 'test', 'release'))
```

**Corrected**:
```sql
CHECK(stage_name IN ('research', 'consensus', 'specification', 'decomposition',
                      'implementation', 'validation', 'testing', 'release'))
```

### 6.3 Cross-Cutting Protocols

| Protocol | Type | Triggered During | Produces |
|----------|------|-----------------|----------|
| **ADR Protocol** | Decision capture | After Consensus stage | ADR documents in `.cleo/adrs/` |
| **Contribution Protocol** | Collaborative work | Any stage | Contribution records, agent outputs |

These are NOT pipeline stages. They are protocols that produce artifacts alongside the pipeline.

---

## 7. Document Authority Hierarchy

```
1. docs/concepts/vision.mdx                    (Constitutional identity — IMMUTABLE)
2. docs/specs/PORTABLE-BRAIN-SPEC.md           (Product contract — 5 Pillars)
3. .cleo/adrs/ADR-006-canonical-sqlite-storage.md  (Storage architecture — ACCEPTED)
4. .cleo/adrs/ADR-007-mcp-domain-consolidation.md  (Domain model — 9 domains)
5. .cleo/adrs/ADR-008-CLEO-CANONICAL-ARCHITECTURE.md (Code architecture)
6. .cleo/adrs/ADR-009-BRAIN-cognitive-architecture.md (THIS DOCUMENT — BRAIN bridge)
7. docs/specs/CLEO-BRAIN-SPECIFICATION.md       (Capability detail — 5 dimensions)
8. docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md    (Phased implementation)
9. docs/concepts/cognitive-architecture.mdx      (Vectorless RAG concepts)
10. src/core/nexus/ARCHITECTURE.md               (Nexus implementation detail)
```

**Conflict resolution rule**: Higher-numbered documents MUST NOT contradict lower-numbered documents. If they do, the lower-numbered document prevails and the conflicting document requires correction.

---

## 8. Contradictions Resolved

| # | Contradiction | Resolution | Authority |
|---|--------------|------------|-----------|
| 1 | BRAIN Spec says JSONL memory files; ADR-006 says SQLite only | SQLite is runtime store. JSONL is export/import format for portability. | ADR-006 (accepted) |
| 2 | cognitive-architecture.mdx says "Vectorless RAG"; BRAIN Spec says SQLite-vec | Both coexist. Vectorless RAG is primary (structural). Vectors augment for semantic queries in Phase 2+. | This ADR |
| 3 | ADR-006 schema has 9 stages with "adr"; ADR-007 says 8 stages | 8 stages. ADR is a protocol, not a stage. ADR-006 schema requires correction. | ADR-007 |
| 4 | Nexus storage: ADR-006 says ~/.cleo/cleo-nexus.db; others say JSON files | SQLite (cleo-nexus.db) is canonical per ADR-006. JSON references are pre-SQLite. | ADR-006 (accepted) |
| 5 | BRAIN Spec defines `cleo reason *` commands; ADR-007 maps to `memory.reason.*` | Reasoning domain placement deferred to R&C cycle. Namespace reserved. | This ADR |
| 6 | 5 Pillars and 5 BRAIN Dimensions never formally related | Orthogonal frameworks: Pillars = product contract (WHAT), BRAIN = capability model (HOW). Crosswalk in Section 2.2. | This ADR |

---

## 9. Implementation Dependencies

```
ADR-009 (this)
    │
    ├── DEPENDS ON: ADR-006 (storage — accepted)
    ├── DEPENDS ON: ADR-007 (domains — proposed)
    ├── DEPENDS ON: ADR-008 (architecture — proposed)
    │
    ├── BLOCKS: BRAIN memory SQLite schema implementation
    ├── BLOCKS: Reasoning domain R&C research task
    ├── BLOCKS: Pipeline stage correction in ADR-006 schema
    │
    └── ENABLES: Unified BRAIN capability tracking across domains
```

### 9.1 Required Follow-Up Tasks

| Task | Description | Priority |
|------|-------------|----------|
| **BRAIN memory schema** | Implement brain_decisions, brain_patterns, brain_learnings SQLite tables | P1 |
| **Reasoning R&C** | Research how LLM agents would use reasoning operations; consensus on domain placement | P2 |
| **Pipeline stage fix** | Update lifecycle_stages CHECK constraint from 9 to 8 stages | P1 |
| **BRAIN Spec update** | Align CLEO-BRAIN-SPECIFICATION.md storage references with ADR-006/ADR-009 hybrid model | P2 |
| **cognitive-architecture.mdx update** | Add note about future vector augmentation alongside vectorless RAG | P3 |

---

## 10. Compliance Criteria

This decision is compliant when:

1. All BRAIN memory stores (decisions, patterns, learnings) use SQLite tables at runtime
2. JSONL export/import operations exist for BRAIN memory portability
3. ADR-006 `lifecycle_stages` schema corrected to 8 stages without "adr"
4. ADR-007 Section 4.2 updated with comprehensive BRAIN dimension coverage (per Section 5 of this ADR)
5. Reasoning domain placement R&C task created and tracked
6. No document in the codebase contradicts the authority hierarchy in Section 7
7. BRAIN Spec (CLEO-BRAIN-SPECIFICATION.md) updated to reference SQLite tables instead of JSONL files for runtime storage
8. cognitive-architecture.mdx updated to clarify vectorless RAG as primary with future vector augmentation

---

## 11. Notes

### 11.1 Agent-Native Design Principle

CLEO is built for LLM agents, not humans. Every BRAIN capability MUST be evaluated from the perspective of how an autonomous agent would invoke it during a workflow. The deferred Reasoning domain placement reflects this principle: we will not commit a domain structure based on human mental models of reasoning. Instead, we will research how agents actually use analytical operations in practice.

### 11.2 Progressive Disclosure

BRAIN capabilities follow the same progressive disclosure tiers as ADR-007:

- **Tier 0** (80% of agents): `tasks` + `session` = basic task work, no BRAIN features needed
- **Tier 1** (15% of agents): + `memory`, `check` = decision memory, compliance scoring
- **Tier 2** (5% of agents): + `orchestrate`, `pipeline`, `tools`, `admin`, `nexus` = full BRAIN capabilities

Most agents never need BRAIN features. They are opt-in capabilities for complex workflows.

### 11.3 Certification Gate

Before CLEO can claim "BRAIN" capability status, all 5 dimensions MUST pass certification criteria defined in CLEO-STRATEGIC-ROADMAP-SPEC.md Section 3.6 (Phase 3.5). This requires HITL sign-off.

---

**END OF ADR-009**
