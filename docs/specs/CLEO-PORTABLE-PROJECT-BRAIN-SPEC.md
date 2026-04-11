---
title: "CLEO Portable Project BRAIN Specification"
version: "3.0.0"
status: "approved"
authority: 2
created: "2026-02-03"
updated: "2026-04-11"
supersedes:
  - "docs/specs/PORTABLE-BRAIN-SPEC.md (v1.3.0)"
  - "docs/specs/CLEO-BRAIN-SPECIFICATION.md (v2.1.0)"
authors: ["CLEO Development Team"]
epic: "T158"
---

# CLEO Portable Project BRAIN Specification

**Version**: 3.0.0
**Status**: APPROVED
**Authority Level**: 2 (immediately below `docs/concepts/CLEO-VISION.md`)
**Canonical Path**: `docs/specs/CLEO-PORTABLE-PROJECT-BRAIN-SPEC.md`
**Supersedes**: `docs/specs/PORTABLE-BRAIN-SPEC.md` (v1.3.0) and `docs/specs/CLEO-BRAIN-SPECIFICATION.md` (v2.1.0)
**Contract Reference**: `packages/contracts/src/config.ts` → `BrainConfig`

---

## Changelog

| Version | Date | Summary |
|---------|------|---------|
| 3.0.0 | 2026-04-11 | Consolidated `PORTABLE-BRAIN-SPEC.md` (v1.3.0, AL2) and `CLEO-BRAIN-SPECIFICATION.md` (v2.1.0, AL5) into single AL2 authority document. All content preserved. No behavioral or contractual changes. |
| 2.1.0 | 2026-03-24 | T158: CAAMP 1.9.1 hook taxonomy integration; 6 adapters; SubagentStart/Stop/PreCompact brain handlers; `cleo doctor --hooks` |
| 2.0.0 | 2026-03-23 | T134: Brain memory automation; BrainConfig; local embeddings; hook-driven bridge refresh; session summarization; transcript extraction; brain maintenance CLI |
| 1.3.0 | 2026-03-06 | `PORTABLE-BRAIN-SPEC.md`: governance and change control; migration and portability section |
| 1.0.0 | 2026-02-03 | Initial BRAIN specification; 5-dimension model; phase map; JSON schemas |

### v2.1.0 detail — T158 CAAMP 1.9.1 Hook Normalizer Integration

| Task | Feature | Status |
|------|---------|--------|
| T159 | CAAMP ^1.9.1 upgrade — 16-event canonical taxonomy | SHIPPED |
| T160 | Hook types migrated to canonical names with backward compat | SHIPPED |
| T161 | Gemini CLI adapter: 10/16 hooks, getTranscript, install | SHIPPED |
| T162 | Codex adapter: 3/16 hooks, getTranscript, install | SHIPPED |
| T163 | Kimi adapter: install-only, no native hooks | SHIPPED |
| T164 | Claude Code (9→14 hooks) + OpenCode (6→10 hooks) via normalizer | SHIPPED |
| T165 | Cursor adapter: 0→10 hooks, fully implemented | SHIPPED |
| T166 | Brain automation handlers for SubagentStart/Stop, PreCompact | SHIPPED |
| T167 | `cleo doctor --hooks` provider hook matrix diagnostic | SHIPPED |
| T168 | E2E hook automation tests | SHIPPED |

**Key design decisions**:
- Canonical taxonomy owned by CAAMP — adapters declare support via manifest; normalizer handles translation
- Brain handlers are hook-first: observation logic lives in hook handlers, not in core session/task functions
- Best-effort everywhere: T166 handlers cannot throw or block lifecycle events
- All six adapters use the same CAAMP `HookNormalizer` API for consistent provider-neutral dispatch

### v2.0.0 detail — T134 Brain Memory Automation

| Task | Feature | Status |
|------|---------|--------|
| T135 | `BrainConfig` contract + config defaults | SHIPPED |
| T136 | Local embedding provider (all-MiniLM-L6-v2 via @xenova/transformers) | SHIPPED |
| T137 | Embedding queue with priority scheduling | SHIPPED |
| T138 | Hook-driven memory bridge refresh (debounced, 30s window) | SHIPPED |
| T139 | Context-aware memory bridge (scope-filtered hybrid search) | SHIPPED |
| T140 | Session summarization: dual-mode (prompt builder + structured ingestion) | SHIPPED |
| T141 | Embedding worker thread | SHIPPED |
| T142 | Brain maintenance CLI (`cleo brain maintenance`) | SHIPPED |
| T143 | Brain backfill with progress reporting | SHIPPED |
| T144 | Cross-provider transcript extraction | SHIPPED |
| T145 | Brain CLI command group | SHIPPED |
| T146 | Specification update | SHIPPED |

**Key design decisions**:
- Config-gated: all new features default to `false`/disabled, no behavioral change without opt-in
- Hook-first: refresh/extract logic lives in hook handlers, not in core task/session functions
- Best-effort everywhere: no T134 feature can throw or block lifecycle events
- Contract-first: `BrainConfig` in `@cleocode/contracts` is the SSoT for all feature flags

---

---
**PART I — PRODUCT CONTRACT**
*Normative. Defines WHAT CLEO is, the invariants that MUST hold across all implementations and phases, and the governance rules under which this specification operates. When any section of Part II conflicts with Part I, Part I prevails.*

---

## Section 0: Document Authority and Hierarchy

### 0.1 Authority Order for Product Truth

| # | Document | Role |
|---|----------|------|
| 1 | `docs/concepts/CLEO-VISION.md` | Immutable vision identity |
| **2** | **`docs/specs/CLEO-PORTABLE-PROJECT-BRAIN-SPEC.md`** | **This document — normative product contract + capability model** |
| 3 | `README.md` | Operational public contract |
| 4 | `docs/ROADMAP.md` | Sequencing and targets |
| 5 | All other specs | Scoped implementation details |

If conflicts occur, higher authority prevails. This document is the single authoritative source for both CLEO's product identity contract and its BRAIN dimension implementation model. All references to the former `PORTABLE-BRAIN-SPEC.md` or `CLEO-BRAIN-SPECIFICATION.md` MUST be updated to point here.

### 0.2 Current vs. Target Framing

- Current state MUST describe only shipped behavior.
- Target state MUST be labeled as planned or gated.
- Operational docs MUST NOT present aspirational capabilities as implemented.
- Implementation status markers used throughout this document: **SHIPPED**, **PENDING**, **CONTINGENT**.

### 0.3 Guiding Principles

1. **Memory First**: Persistent knowledge before advanced reasoning
2. **Evidence-Based**: Validate each capability before expansion
3. **Agent-Native**: Design for autonomous agents, not human workflows
4. **Incremental Rollout**: Phase-gated implementation aligned with Strategic Roadmap
5. **Anti-Hallucination**: Core validation architecture is non-negotiable

---

## Section 1: The Five Canonical Pillars

CLEO MUST preserve these five pillars across all interfaces, implementations, and roadmap phases. They are constitutional — no release, refactor, or capability expansion may violate them.

1. **Portable Memory**
   Project → Epic → Task hierarchy, research manifests, and agent outputs with stable identity.

2. **Provenance by Default**
   Every artifact is traceable to task, decision, agent, and operation event.

3. **Interoperable Interfaces**
   The CLI is the first-class runtime interface. Provider-specific adapters are optional, never required.

4. **Deterministic Safety**
   Validation layers, lifecycle gates, atomic operations, and immutable logs protect system integrity.

5. **Cognitive Retrieval**
   Page index plus graph/vector/RAG retrieval supports contextual reasoning at Tier M/L.

---

## Section 2: Core Invariants

The following are **non-negotiable system invariants**. They cannot be relaxed, worked around, or deferred:

1. **Stable task identity** — `T###` identifiers never change after assignment.
2. **Atomic writes** — Write operations follow the pattern: temp → validate → backup → rename.
3. **Validation-first enforcement** — Validation blocks invalid state creation; it does not merely warn.
4. **Append-only audit trail** — The audit log is write-once and fully traceable.
5. **Machine-first output** — JSON output is machine-parseable by default; human-readable output is opt-in.
6. **Explicit lifecycle enforcement** — Lifecycle state transitions are explicit and testable, never implicit.

---

## Section 3: Provider-Agnostic Contract

CLEO MUST remain provider-agnostic by design:

- MUST operate without dependence on any single LLM vendor.
- MUST support initialization in any project repository.
- MUST preserve portable memory format independent of runtime tool.
- SHOULD offer optimized integrations for specific tools (for example Claude Code) without changing core data contracts.
- MUST define behavior through open schemas, exit codes, and interface contracts.

**Standard formats**: JSON, SQLite, Markdown — universally readable.
**Exit code contracts**: Machine-parseable regardless of runtime.

---

## Section 4: Tier Progression Contract

- **Tier S**: Single-project, deterministic task/memory lifecycle (current).
- **Tier M**: Cross-project memory and retrieval with validated usage.
- **Tier L**: Coordinated multi-agent intelligence across projects.

Progression MUST remain gate-driven and evidence-based. No tier capability may be released without passing its validation gate.

---

## Section 5: The `.cleo/` Portable Brain

The `.cleo/` directory is CLEO's **portable brain** — a complete, self-contained project memory.

### 5.1 Directory Structure

```
.cleo/
├── tasks.db              # SQLite: tasks, sessions, lifecycle, audit_log, pipelineManifest (ADR-006)
│   ├── tasks              # Active + archived tasks (status-based)
│   ├── sessions           # Session state
│   ├── pipelineManifest   # Pipeline manifest entries
│   ├── lifecycle_*        # RCASD-IVTR pipeline state
│   ├── audit_log          # Immutable audit trail (ADR-019)
│   └── task_*             # Dependencies, relations, work history
├── brain.db              # SQLite: cognitive memory — observations, decisions, patterns,
│                         #   learnings, memory links, sticky notes, page graph (ADR-009)
├── conduit.db            # SQLite: project-tier agent messaging (ADR-037)
├── config.json           # Project configuration (human-editable, ADR-006 exception)
├── project-info.json     # Project identity (projectHash, projectId)
├── project-context.json  # LLM agent guidance (language, framework, conventions)
├── agent-outputs/        # Research and analysis artifacts
│   └── MANIFEST.jsonl    # Agent output manifest (append-only)
├── backups/              # Recovery backups
└── adrs/                 # Architecture Decision Records
```

> **Global registry**: `$XDG_DATA_HOME/cleo/signaldock.db` (ADR-037) — canonical cross-project
> agent identity registry, stored outside the project `.cleo/` directory.

> **Data safety (ADR-013 §9)**: `tasks.db`, `brain.db`, `config.json`, `project-info.json` are NOT git-tracked. Use `cleo backup add` or `cleo session end` (auto-snapshots). NEVER `git add` these files.

**brain.db shipped tables** (schema in `packages/core/src/store/brain-schema.ts`):
`brain_decisions`, `brain_patterns`, `brain_learnings`, `brain_observations`, `brain_memory_links`, `brain_sticky_notes`, `brain_page_nodes`, `brain_page_edges`, `brain_schema_meta`

For the full table reference, see `docs/architecture/DATABASE-ERDS.md` section 2.

### 5.2 Portability Mechanisms

| Mechanism | Description | Use Case |
|-----------|-------------|----------|
| **Git-tracked** | `.cleo/` (minus DBs) committable to version control | Team collaboration, history preservation |
| **Zippable** | Entire directory can be archived and transferred | Backup, migration, offline sharing |
| **Shareable** | Can be synced between developers | Pair programming, handoff |
| **Provider-agnostic** | No dependency on specific AI tools | Cross-tool workflows |

### 5.3 Cross-Tool Compatibility

The same `.cleo/` brain works with: Claude Code, OpenCode, Cursor, Gemini CLI, Codex, Kimi (via provider adapters), and direct CLI usage.

### 5.4 Migration and Portability Operations

**Moving a project**:
1. Commit `.cleo/` to git (or zip the directory)
2. Clone/copy to new location
3. Run `cleo admin.init` to validate integrity
4. NEXUS will auto-re-register on next sync

**Sharing between developers**:
```bash
# Export brain
zip -r project-brain.zip .cleo/

# Import brain
unzip project-brain.zip
cleo admin.validate
```

---

## Section 6: Data and Provenance Model

**Required artifact lineage** — artifacts SHOULD be linked by durable IDs and metadata:

| ID Format | Type | Status |
|-----------|------|--------|
| `T###` | Task IDs | Stable, shipped |
| `D###` | Decision IDs | Planned |
| `P###` | Pattern IDs | Planned |
| `L###` | Learning IDs | Planned |
| Session IDs | Session records | Shipped |
| Operation/event records | Audit trail | Shipped |

CLEO MUST treat research manifests and agent outputs as first-class memory artifacts, with explicit provenance links to tasks and sessions.

---

## Section 7: Interface Model

### 7.1 CLI

The TypeScript CLI (`packages/cleo/src/cli/`) is the primary runtime interface (ADR-004). It is 100% compliant with the shared-core architecture pattern, delegating all business logic to `packages/core/src/` modules (validated 2026-02-16, T4565). There are ~86 command files in `packages/cleo/src/cli/commands/`. The Bash CLI (`scripts/`, `lib/`) is deprecated and pending removal.

### 7.2 Dispatch Architecture

The CLI exposes 2 dispatch gateways (`query`, `mutate`) following the CQRS pattern, with registry-defined operations (see `packages/cleo/src/dispatch/registry.ts` for current count) across 10 canonical domains. ~224 canonical ops total. The dispatch engines (`packages/cleo/src/dispatch/engines/`) delegate to `packages/core/src/` modules via thin wrapper engines (task-engine, system-engine, orchestrate-engine, config-engine, etc.).

All operations route through `packages/cleo/src/dispatch/`.

### 7.3 Shared-Core Architecture (Salesforce DX Pattern)

The CLI interface MUST delegate to a shared core (`packages/core/src/`). Current compliance:
- **CLI**: 100% compliant (~86 command files route through `packages/core/src/`)

Provider/tool adapters MAY optimize UX but MUST NOT fork core memory semantics.

---

## Section 8: NEXUS Synchronization

The Portable Brain integrates with the **CLEO-NEXUS** system for cross-project intelligence:

- Project registered in global `~/.local/share/cleo/nexus.db` via `nexus.reconcile`
- Enables cross-project task references (`project:taskId`)
- Supports federated memory queries across projects

| Trigger | Sync Action |
|---------|-------------|
| Task created | Update NEXUS index |
| Task completed | Archive to NEXUS |
| Session start | Register active project |
| Memory injection | Sync to brain.db |

---

## Section 9: Governance and Change Control

### 9.1 Immutable Vision Requirement

`docs/concepts/CLEO-VISION.md` defines product identity and MUST be treated as constitutional text.

### 9.2 Amendment Process

Any change that alters canonical identity MUST:

1. Include explicit "Vision Amendment" rationale.
2. Update this spec and README in the same change set.
3. Include migration note if terminology or behavior shifts.

### 9.3 Drift Prevention

Documentation and implementation MUST use the same canonical terms for:

- Portable Memory
- Provenance
- Deterministic Safety
- Interoperability
- Cognitive Retrieval

---

---
**PART II — BRAIN CAPABILITY MODEL**
*Defines the five BRAIN dimensions in detail: their current shipped state, target capabilities, data structures, CLI interfaces, and success metrics. All claims in Part II are subordinate to the invariants and contracts in Part I.*

---

## Section 10: Executive Summary — BRAIN Architecture

CLEO implements the BRAIN model: a five-dimensional system that transforms CLEO from a task manager into persistent cognitive substrate for autonomous AI agent coordination.

**BRAIN** is not metaphor but architecture:

| Dimension | What It Means | Current State |
|-----------|---------------|---------------|
| **B**ase (Memory) | Persistent knowledge across sessions | SHIPPED: brain.db with decisions, patterns, learnings, observations tables; 3-layer retrieval (search/timeline/fetch); hybrid search (FTS5 + vector + graph); PageIndex graph (nodes/edges); 5,122 observations migrated. T134: automated capture via lifecycle hooks, local embedding (all-MiniLM-L6-v2), context-aware bridge, session summarization, transcript extraction |
| **R**easoning | Causal inference and temporal analysis | SHIPPED: reason.why (causal trace), reason.similar (FTS5/vector fallback), temporal decay, memory consolidation |
| **A**gent | Autonomous multi-agent orchestration | PARTIAL: orchestrator + subagent shipped; no self-healing or load balancing |
| **I**ntelligence | Adaptive validation and prediction | PARTIAL: 4-layer validation shipped; no pattern extraction or proactive suggestions |
| **N**etwork | Cross-project knowledge coordination | PARTIAL: Nexus registry shipped; unvalidated (zero usage data) |

**From**: Task manager with anti-hallucination validation (Tier S)
**To**: Cognitive infrastructure for AI-driven development workflows (Tier M/L)

---

## Section 11: BrainConfig Contract Reference (T135)

All T134 features are governed by `BrainConfig` in `packages/contracts/src/config.ts`.
This is the **SSoT for all BRAIN feature flags**.

```typescript
interface BrainConfig {
  autoCapture: boolean;        // Capture lifecycle events → brain.db (default: true)
  captureFiles: boolean;       // Capture file change events (default: false)
  embedding: {
    enabled: boolean;          // Enable local embedding model (default: false)
    provider: 'local' | 'openai';
  };
  memoryBridge: {
    autoRefresh: boolean;      // Auto-refresh memory-bridge.md (default: true)
    contextAware: boolean;     // Use hybrid search for scoped content (default: false)
    maxTokens: number;         // Token budget for bridge content (default: 2000)
  };
  summarization: {
    enabled: boolean;          // Build summarization prompt on session end (default: false)
  };
}
```

**Defaults**: All features default to `false`/disabled except `autoCapture: true` and `memoryBridge.autoRefresh: true`. Existing behavior is preserved without config changes.

**Note**: The vestigial `captureMcp` field has been removed from `packages/contracts/src/config.ts`. The shape above is canonical.

---

## Section 12: Canonical Hook Taxonomy Integration (T158)

CAAMP 1.9.1 introduces a 16-event canonical hook taxonomy. The BRAIN automation layer integrates with this taxonomy to capture observations from provider hook events in a provider-neutral way.

**Events that trigger brain observations** (governed by `brain.autoCapture`):

| Canonical Event | When Fired | Brain Observation |
|-----------------|-----------|------------------|
| `SubagentStart` | Subagent spawned by orchestrator | Capture spawn context: task ID, agent type, session |
| `SubagentStop` | Subagent completed or terminated | Capture outcome: success/failure, task result summary |
| `PreCompact` | Provider is about to compact context window | Capture session state snapshot before compaction |

**Provider adapter coverage** (all use the same CAAMP `HookNormalizer` API):

| Provider | Hook Coverage | Notes |
|----------|--------------|-------|
| Claude Code | 14/16 | Upgraded from 9 via normalizer |
| OpenCode | 10/16 | Upgraded from 6 via normalizer |
| Cursor | 10/16 | Upgraded from 0 — fully implemented |
| Gemini CLI | 10/16 | New in T161; getTranscript + install |
| Codex | 3/16 | New in T162; getTranscript + install |
| Kimi | install-only | New in T163; no native hooks |

Diagnostic: `cleo doctor --hooks` / `admin.hooks.matrix` query operation.

**Reference**: CAAMP ^1.9.1 release notes, `docs/specs/CAAMP-INTEGRATION-SPEC.md`

---

## Section 13: BRAIN Dimension Specifications

### 13.1 Base (Memory Layer) — SHIPPED

**Purpose**: Persistent knowledge storage and retrieval across sessions.

#### 13.1.1 Shipped Capabilities

**brain.db schema** (Drizzle ORM, `packages/core/src/store/brain-schema.ts`):

| Table | Purpose | Status |
|-------|---------|--------|
| `brain_decisions` | Architectural decisions with rationale | SHIPPED |
| `brain_patterns` | Recognized workflow patterns | SHIPPED |
| `brain_learnings` | Accumulated insights from completed work | SHIPPED |
| `brain_observations` | Raw observations (5,122 entries migrated from claude-mem) | SHIPPED |
| `brain_memory_links` | Cross-references to tasks.db | SHIPPED |
| `brain_sticky_notes` | Persistent sticky notes | SHIPPED |
| `brain_page_nodes` | PageIndex graph nodes | SHIPPED (Phase 3) |
| `brain_page_edges` | PageIndex graph edges (bidirectional) | SHIPPED (Phase 3) |
| `brain_schema_meta` | Schema versioning | SHIPPED |

Full table schemas: `docs/architecture/DATABASE-ERDS.md` section 2.

**Shipped retrieval features** (Phase 3, T5385-T5388):
- 3-layer retrieval pattern: `cleo memory find` → `cleo memory timeline` → `cleo memory fetch`
- FTS5 virtual tables with auto-sync triggers
- Vector embeddings via pluggable EmbeddingProvider (384-dim vec0 table)
- Hybrid search across FTS5, vector similarity, and graph neighbors (`memory.search.hybrid`)

**Shipped reasoning features** (Phase 4, T5390-T5395):
- `memory.reason.why` — causal trace through task dependency chains with brain_decisions enrichment
- `memory.reason.similar` — semantic similarity via vector search with FTS5 fallback
- Temporal decay — exponential confidence reduction for stale learnings (`brain-lifecycle.ts`)
- Memory consolidation — keyword-overlap clustering of old observations into summaries

**Shipped T158 hook automation**:
- 16-event canonical hook taxonomy via CAAMP ^1.9.1
- Brain automation handlers for `SubagentStart`, `SubagentStop`, and `PreCompact` events (T166)
- `cleo doctor --hooks` diagnostic shows hook coverage per detected adapter (T167)
- `admin.hooks.matrix` query operation returns full provider-hook coverage matrix (T167)

**Remaining gap**: Knowledge graph with version chains (deferred).

#### 13.1.2 Target Capabilities

| Capability | Description | Data Structure | Phase |
|------------|-------------|----------------|-------|
| **Context Persistence** | Resume conversation state across sessions | `sessions` table (tasks.db, ADR-006) | Phase 1 |
| **Decision Memory** | Record architectural decisions with rationale | `brain_decisions` table (ADR-009) | Phase 2 |
| **Pattern Memory** | Store recognized workflow patterns | `brain_patterns` table (ADR-009) | Phase 2 |
| **Learning Memory** | Accumulated insights from completed work | `brain_learnings` table (ADR-009) | Phase 3 |
| **Temporal Queries** | "What was decided about X in January?" | SQLite FTS on brain_decisions | Phase 2 |
| **Memory Consolidation** | Compress old memories into summaries | Consolidation pipeline | Phase 3 |
| **Memory Export/Import** | Portable JSONL export for cross-project transfer | JSONL files (export format only, ADR-009) | Phase 2 |

#### 13.1.3 Data Structures

> **Storage Note (ADR-006 / ADR-009)**: BRAIN memory data is stored in dedicated `.cleo/brain.db` (SQLite via Drizzle ORM). Schema defined in `packages/core/src/store/brain-schema.ts`. Legacy JSONL files remain for backward compatibility but brain.db is the canonical store. 5,122 observations migrated from claude-mem.

**Session Context** — stored in `sessions` table (`.cleo/tasks.db`, ADR-006)

```json
{
  "id": "session_20260203_094904_1a1046",
  "name": "BRAIN Specification Work",
  "status": "active",
  "scope_json": "{\"type\":\"epic\",\"id\":\"T2975\"}",
  "notes_json": "[\"Working on CLEO Consolidation Sprint. Current focus: BRAIN specification.\"]",
  "started_at": "2026-02-03T09:49:04Z"
}
```

**Decision Memory** — `brain_decisions` table (`.cleo/brain.db`, ADR-009)

```sql
-- See ADR-009 Section 3.2 for full schema
INSERT INTO brain_decisions (id, type, decision, rationale, confidence, context_epic_id, context_task_id, created_at)
VALUES
  ('D001', 'architecture', 'Adopt BRAIN model for cognitive infrastructure',
   'Provides concrete capabilities vs abstract intelligence', 'high', 'T2975', 'T3002', '2026-02-03T17:00:00Z'),
  ('D002', 'technical', 'Use SQLite-vec for semantic search',
   'No external dependencies, proven stability', 'medium', NULL, 'T2973', '2026-02-03T18:00:00Z');
```

**Pattern Memory** — `brain_patterns` table (`.cleo/brain.db`, ADR-009)

```sql
-- See ADR-009 Section 3.2 for full schema
INSERT INTO brain_patterns (id, type, pattern, context, frequency, success_rate, examples_json, extracted_at)
VALUES
  ('P001', 'workflow', 'Research -> Consensus -> Specification -> Decomposition',
   'RCASD lifecycle', 15, 0.93, '["T2968","T2975"]', '2026-02-03T18:00:00Z'),
  ('P002', 'blocker', 'Database tasks without migration plan block 2-3 downstream tasks',
   'Schema changes', 8, NULL, '["T1234","T1456"]', '2026-02-03T18:00:00Z');
```

**Learning Memory** — `brain_learnings` table (`.cleo/brain.db`, ADR-009)

```sql
-- See ADR-009 Section 3.2 for full schema
INSERT INTO brain_learnings (id, insight, source, confidence, actionable, applicable_types_json, application, created_at)
VALUES
  ('L001', 'Tasks labeled research take 2-4 days median, 80% CI',
   '50 completed research tasks', 0.85, 1, '["research"]',
   'Suggest realistic timeline for new research tasks', '2026-02-03T18:00:00Z'),
  ('L002', 'Epics with >15 subtasks have 60% higher failure rate',
   '30 completed epics', 0.78, 1, '["epic"]',
   'Warn when epic exceeds 12 subtasks, suggest decomposition', '2026-02-03T18:00:00Z');
```

**JSONL Export** (portability — not runtime storage):

```bash
cleo memory export --type decisions --output decisions.jsonl
cleo memory import --type decisions --input decisions.jsonl
```

#### 13.1.4 CLI Commands

```bash
# Store knowledge
cleo memory store --type decision --content "Use SQLite-vec for semantic search" \
  --rationale "No external dependencies" \
  --linked-task T2973

# Recall knowledge
cleo memory recall "Why did we choose SQLite-vec?"

# Search memory
cleo memory search "authentication" --type decision --date-range "2026-01"

# 3-layer retrieval
cleo memory find "authentication"
cleo memory timeline <anchor-id>
cleo memory fetch <id>

# Observe
cleo memory observe "text" --title "title"

# Consolidate
cleo memory consolidate --period "2026-Q1" --output .cleo/memory/consolidated/2026-Q1-summary.md

# Maintenance
cleo brain maintenance
```

#### 13.1.5 Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Context recall accuracy | >90% after 7 days | Blind recall test with 20 sessions |
| Decision retrieval time | <500ms for 1,000 decisions | Benchmark on production data |
| Pattern recognition | >10 actionable patterns per 50 epics | Manual review by HITL |
| Storage efficiency | <10MB for 1 year of memory | File system audit |

---

### 13.2 Reasoning (Inference Layer) — SHIPPED

**Purpose**: Causal inference, similarity detection, and temporal reasoning.

#### 13.2.1 Shipped Capabilities

- Dependency graph analysis (`cleo deps`)
- Wave-based parallel execution (`cleo orchestrator analyze`)
- Graph-RAG semantic discovery
- **Causal inference** via `memory.reason.why` — walks blocker chains with brain_decisions enrichment (SHIPPED, T5390)
- **Similarity detection** via `memory.reason.similar` — vector KNN with FTS5 fallback (SHIPPED, T5391)
- **Temporal decay** via `applyTemporalDecay` — exponential confidence reduction for stale learnings (SHIPPED, T5394)
- **Memory consolidation** via `consolidateMemories` — keyword-overlap clustering into summaries (SHIPPED, T5395)

**Limitations**:
- No impact prediction: cannot predict downstream effects
- No temporal reasoning: cannot analyze timelines (prohibited by "NO TIME ESTIMATES" rule)

#### 13.2.2 Target Capabilities

| Capability | Description | Phase |
|------------|-------------|-------|
| **Causal Inference** | "Task T1 failed → blocked T2 → delayed Epic E" | Phase 2 |
| **Similarity Detection** | "Find tasks similar to authentication implementation" | Phase 2 |
| **Impact Prediction** | "Changing API X affects 7 tasks across 3 epics" | Phase 2 |
| **Timeline Analysis** | Historical pattern matching (context only, no estimates) | Phase 3 |
| **Counterfactual Reasoning** | "If we chose approach B..." | Phase 3 (experimental) |

#### 13.2.3 Causal Inference Model

```
Task Event → Dependency Impact → Epic Outcome
     ↓              ↓                  ↓
  Blockers    Parallel Wave     Completion Time
     ↓              ↓                  ↓
  Root Cause  Critical Path     Predictive Model
```

```bash
cleo reason why --task T2345 --outcome blocked

# Output:
# Causal Chain:
#   1. T2345 depends on T2300 (migration task)
#   2. T2300 blocked due to missing schema approval
#   3. Schema approval required decision D045 (not yet made)
#   4. Decision D045 waiting on consensus C012
#   5. ROOT CAUSE: Consensus C012 incomplete (3/5 votes)
#
# Recommendation: Complete consensus C012 to unblock chain
```

#### 13.2.4 Similarity Detection Model

```
Task Description + Labels + Context
            ↓
    Text Embedding Model
            ↓
    SQLite-vec Storage
            ↓
    Cosine Similarity Search
            ↓
    Ranked Results (threshold > 0.8)
```

```bash
cleo reason similar --task T3002 --threshold 0.8 --limit 5

# Output:
# Similar Tasks (similarity score):
#   1. T2973 (0.92): Specification: CLEO Strategic Roadmap
#   2. T2971 (0.89): Research: BRAIN Vision Requirements
#   3. T2400 (0.87): Design: Skill Loading Mechanism
#   4. T2398 (0.85): Specification: Protocol Stack v1
#   5. T1234 (0.82): Specification: CLI Dispatch Architecture
```

#### 13.2.5 Temporal Analysis Model

**Clarification: "No Time Estimates" vs Historical Analysis**

| Prohibited | Allowed |
|-----------|---------|
| "This task will take 3 hours" | "Similar tasks historically took 2-4 days (median 3 days, 80% CI)" |
| "Epic will complete by Friday" | "20 similar epics: 15 took 2-3 weeks, 3 took 4+ weeks, 2 failed" |
| Agent/human time estimates | Historical timeline analysis for learning only |

**Rationale**: Temporal reasoning enables **learning** (identify patterns) without **commitment** (prevent hallucinated estimates).

```bash
cleo reason timeline --type research --sample-size 50
# Output: historical distribution only — NOT a prediction or estimate
```

#### 13.2.6 CLI Commands

```bash
# Causal inference
cleo reason why --task T2345
cleo reason why --epic T2975 --outcome delayed

# Similarity detection
cleo reason similar --task T3002 --threshold 0.8
cleo reason similar --description "authentication implementation" --limit 10

# Impact prediction (Phase 2)
cleo reason impact --change "Modify GraphRAG interface"
cleo reason impact --task T2345 --what-if completed

# Timeline analysis (historical context only — Phase 3)
cleo reason timeline --type research
cleo reason timeline --epic T2975 --compare-to T2968

# Counterfactual (experimental — Phase 3)
cleo reason counterfactual --decision D045 --alternative "Use PostgreSQL instead of SQLite"
```

#### 13.2.7 Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Causal inference accuracy | >85% root cause identified correctly | Blind validation on 50 blocked tasks |
| Similarity relevance | >80% of top-5 results rated relevant | User satisfaction survey |
| Impact prediction recall | >90% of affected tasks identified | Compare prediction vs actual |
| Timeline analysis usefulness | >70% of users find context helpful | Feedback survey |

---

### 13.3 Agent (Orchestration Layer) — PARTIAL

**Purpose**: Autonomous multi-agent coordination with self-healing and learning.

#### 13.3.1 Shipped Capabilities

- Orchestrator (ct-orchestrator)
- Universal subagent (cleo-subagent)
- 7 conditional protocols (Research, Consensus, Specification, Decomposition, Implementation, Contribution, Release)
- Protocol enforcement (exit codes 60-70)
- RCASD-IVTR lifecycle
- Multi-agent spawning via Task tool, protocol injection, token pre-resolution, manifest-based output

**Limitations** (PENDING):
- No self-healing: agent failures require HITL intervention
- No load balancing: all tasks queue, no capacity awareness
- No learning from execution: same mistakes repeated
- No capability discovery: manual skill assignment
- No agent registry: cannot track active agents

#### 13.3.2 Target Capabilities

| Capability | Description | Phase |
|------------|-------------|-------|
| **Self-Healing** | Recover from agent failures, reassign tasks | Phase 1 |
| **Agent Health Monitoring** | Track agent state, detect crashes | Phase 1 |
| **Load Balancing** | Distribute work based on agent capacity | Phase 2 |
| **Capability Discovery** | Auto-detect which agents handle which tasks | Phase 2 |
| **Learning from Execution** | Improve based on task outcomes | Phase 3 |
| **Parallel Execution** | Wave-based parallelization | Current (enhance) |

#### 13.3.3 Self-Healing Architecture

```
Agent Spawn
    ↓
Heartbeat Every 30s
    ↓
Timeout After 3min → FAILURE DETECTED
    ↓
Retry Logic (3 attempts, exponential backoff: 0s → 2s → 4s)
    ↓
If All Retries Fail → Reassign to Different Agent
    ↓
If Reassignment Fails → Escalate to HITL
    ↓
Log failure to learning memory for pattern analysis
```

#### 13.3.4 Load Balancing Architecture

```
Agent Registry:
  - agent_id
  - current_tasks (max 5)
  - capacity_remaining (5 - current_tasks)
  - specialization (skills)
  - performance_history (completion rate, avg time)

Task Queue:
  - task_id
  - priority (critical > normal > background)
  - required_skills
  - estimated_complexity (small/medium/large)

Routing Algorithm:
  1. Filter agents by required skills
  2. Sort by capacity_remaining DESC
  3. Prefer agents with successful history for similar tasks
  4. Assign task to highest-ranked agent
  5. Update capacity tracking
```

#### 13.3.5 Learning from Execution

```
Task Completion
    ↓
Outcome Analysis (success/failure, complexity, blockers, patterns)
    ↓
Store in brain_learnings table
    ↓
Update Agent Performance History
    ↓
Adjust Future Task Routing
```

Example learning entry:
```jsonl
{"id":"L003","timestamp":"2026-02-03T18:00:00Z","insight":"Tasks requiring database migration should be assigned to agents with 'migration' skill","source":"5 failed assignments to generalist agents","confidence":0.90,"actionable":true,"application":"Update routing to require 'migration' skill for schema change tasks"}
```

#### 13.3.6 CLI Commands

```bash
# Agent management (Phase 1-2)
cleo agent spawn --task T3002 --auto-select
cleo agent status
cleo agent kill session_xyz
cleo agent registry

# Learning (Phase 3)
cleo agent learn --task T3002 --outcome success --notes "Pattern X worked well"
cleo agent learn --task T3002 --outcome failure --notes "Blocker: missing schema approval"

# Capacity management (Phase 2)
cleo agent capacity --show
cleo agent capacity --limit 10
```

#### 13.3.7 Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Self-healing success rate | >95% recovery without HITL | Production failure injection test |
| Load balancing efficiency | >70% agent utilization | Capacity tracking logs |
| Learning effectiveness | >20% efficiency gain over 30 days | A/B comparison: learning on vs off |
| Agent uptime | >99.5% availability | Monitoring logs |

---

### 13.4 Intelligence (Validation & Adaptation Layer) — PARTIAL

**Purpose**: Adaptive validation, proactive suggestions, and quality prediction.

#### 13.4.1 Shipped Capabilities

- 4-layer validation (schema → semantic → referential → protocol)
- 72 standardized exit codes
- Protocol enforcement (RCASD-IVTR lifecycle)
- Lifecycle gate enforcement (strict/advisory/off modes)
- Anti-hallucination checks

**Limitations** (PENDING):
- Static validation: same rules for all tasks, no learning
- Reactive only: validates after operation, no proactive suggestions
- No error pattern learning: same errors repeated
- No quality prediction: cannot predict task success likelihood

#### 13.4.2 Target Capabilities

| Capability | Description | Phase |
|------------|-------------|-------|
| **Compliance Scoring** | Rate protocol adherence quality | Phase 1 |
| **Adaptive Validation** | Learn common errors, suggest fixes proactively | Phase 2 |
| **Auto-Remediation** | Automatically fix known error patterns | Phase 2 |
| **Proactive Suggestions** | Suggest actions before user asks | Phase 3 |
| **Quality Prediction** | Predict task success likelihood before execution | Phase 3 |

#### 13.4.3 Adaptive Validation Model

```
Error Occurrence
    ↓
Extract Pattern (error code + context, common preconditions, successful fixes)
    ↓
Store in Pattern Memory (brain_patterns table)
    ↓
Generate Proactive Warning for Similar Context
    ↓
Suggest Pre-Validated Fix
```

Example output:
```
[WARNING] E_COMMON_PATTERN_DETECTED
Pattern: Tasks without epic scope often require reparenting (40% historical rate)
Suggestion: Set parent epic now to avoid rework
Fix: cleo add "Implement feature X" --parent T2975
Alternative: Skip warning with --force flag
```

#### 13.4.4 Proactive Suggestion Engine

```
Current Session State
    ↓
Analyze (focused task + dependencies, recent decisions + patterns, historical similar sessions)
    ↓
Identify Likely Next Actions
    ↓
Suggest Proactively (if confidence >80%)
```

Example output:
```
[SUGGESTION] Next Action Predicted (85% confidence)
Based on similar specification tasks, consider:
  1. Decompose epic for Phase 1 implementation
     Command: cleo orchestrator spawn T2975 --protocol decomposition
  2. Create follow-up research task for validation
     Command: cleo add "Research: BRAIN Memory Layer Validation" --parent T2975
  3. Continue with next pending task in epic
     Command: cleo next
```

#### 13.4.5 Quality Prediction Model

```
Task Metadata (description complexity, dependency count, label similarity to past failures, agent history)
    ↓
Historical Data (1,000+ completed tasks: success/failure rates, blocker patterns)
    ↓
ML Model (Logistic Regression): Predict success probability + risk factors
    ↓
Output: Risk Score + Recommendations
```

Example output:
```
[QUALITY PREDICTION] Task Risk Analysis
Success Probability: 65% (MEDIUM RISK)
Risk Factors: Large file (3,098 lines) → 40% higher failure rate; 12 dependencies → 15% additional risk
Recommended Mitigations: Break into 3 smaller subtasks (<1,000 lines each)
```

#### 13.4.6 CLI Commands

```bash
# Compliance (Phase 1)
cleo compliance score --task T3002
cleo compliance score --epic T2975 --summary

# Adaptive validation (Phase 2)
cleo intelligence learn-errors
cleo intelligence suggest-fix --error E_VALIDATION_FAILED

# Proactive suggestions (Phase 3)
cleo intelligence suggest
cleo intelligence suggest --confidence 0.9

# Quality prediction (Phase 3)
cleo intelligence predict --task T3002
cleo intelligence predict --description "Refactor sessions.sh"
```

#### 13.4.7 Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Error prevention rate | >30% of common errors prevented proactively | Before/after comparison |
| Suggestion acceptance rate | >60% of proactive suggestions accepted | User action tracking |
| Prediction accuracy | >75% success probability within ±10% | Validation on 100 tasks |
| Compliance score correlation | r>0.7 between compliance score and success | Statistical analysis |

---

### 13.5 Network (Cross-Project Coordination Layer) — CONTINGENT

**Purpose**: Multi-project knowledge sharing and federated agent coordination.

#### 13.5.1 Shipped Capabilities

- Nexus registry (cross-project references)
- Global project registration (`~/.cleo/projects/`)
- Project-level isolation

**Limitations**:
- **Unvalidated**: Nexus shipped 8 days ago, zero real-world usage data
- No cross-project intelligence: cannot find related work across projects
- No knowledge transfer: patterns discovered in Project A don't inform Project B
- No federated agents: agents are project-scoped only
- **Validation risk**: may be archived if Phase 1 validation fails

#### 13.5.2 Nexus Validation Gate (Phase 1) — CRITICAL

Network dimension expansion is **contingent** on Nexus validation passing ALL criteria:

| Metric | Target | Period | Status |
|--------|--------|--------|--------|
| Active Users | ≥3 developers | 30 days | PENDING |
| Multi-Project Usage | ≥2 projects/user | 30 days | PENDING |
| Cross-Project Queries | >100 queries | 30 days | PENDING |
| Time Savings | >30% context discovery reduction | 30 days | PENDING |

**If validation fails**: Consolidate Nexus (5 files → 1 file), defer Network to Phase 3+, focus on B/R/A/I dimensions.

**If validation succeeds**: Expand Nexus with semantic search (Phase 2), implement knowledge transfer (Phase 2), add federated agents (Phase 3).

#### 13.5.3 Target Capabilities

| Capability | Description | Phase |
|------------|-------------|-------|
| **Cross-Project Search** | Find related work anywhere in Nexus | Phase 1 (if validated) |
| **Knowledge Transfer** | Apply learnings across projects | Phase 2 |
| **Project Similarity** | "Find projects similar to current work" | Phase 2 |
| **Federated Agents** | Coordinate agents across multiple projects | Phase 3 |
| **Global Intelligence** | Aggregate insights from all projects | Phase 3 |

#### 13.5.4 Cross-Project Search Architecture

```
Query: "authentication implementations"
    ↓
Nexus Registry Scan (5+ projects)
    ↓
Semantic Search (SQLite-vec): task descriptions, research artifacts, decision memory
    ↓
Rank by Relevance + Recency
    ↓
Return Results with Context (project name, task ID + title, similarity score, date + status)
```

```bash
cleo network search "authentication JWT implementation"

# Output:
# Cross-Project Results (3 projects):
#
# Project: backend-api (similarity: 0.94)
#   - T456: Implement JWT authentication middleware
#     Status: completed (2026-01-15)
#     Key Decision: Use HS256 for internal services, RS256 for public API
#
# Project: mobile-app (similarity: 0.87)
#   - T789: Add JWT token refresh logic
#     Status: completed (2026-01-20)
#     Anti-Pattern: Token stored in localStorage caused security issue
```

#### 13.5.5 Knowledge Transfer Architecture

```
Source Project Pattern (pattern memory entry, success rate + context)
    ↓
Export to Global Pattern Library (nexus.db — global_patterns table)
    ↓
Target Project Import (relevance check, context adaptation)
    ↓
Store in Target Project brain_patterns
    ↓
Track Transfer Effectiveness
```

```bash
# Export pattern from project A
cleo network export-pattern P001 --global
# Pattern P001: "RCASD lifecycle reduces rework by 40%"
# Exported to: ~/.local/share/cleo/nexus.db (global_patterns table)

# Import to project B
cleo network import-pattern P001 --adapt-to-context
```

#### 13.5.6 Federated Agent Coordination (Phase 3)

```
Project A/B/C: Local Agent Pools
    ↓
Global Agent Registry (track all agents, coordinate cross-project tasks, load balance globally)
    ↓
Cross-Project Task Assignment (borrow agent with required expertise, return after completion)
```

#### 13.5.7 CLI Commands

```bash
# Cross-project search (Phase 1, contingent)
cleo network search "authentication implementation"
cleo network search --project backend-api --query "JWT"

# Knowledge transfer (Phase 2, contingent)
cleo network export-pattern P001 --global
cleo network import-pattern P001 --project /path/to/project-b
cleo network list-patterns --global

# Federated agents (Phase 3, contingent)
cleo network agents
cleo network coordinate --projects "A,B,C"
cleo network transfer-agent agent_xyz --from A --to B --duration 2h

# Global intelligence (Phase 3, contingent)
cleo network insights
cleo network similarity --project backend-api
```

#### 13.5.8 Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Cross-project query usefulness | >70% of queries find relevant results | User feedback survey |
| Knowledge transfer effectiveness | >30% improvement in target project | Before/after comparison |
| Federated agent utilization | >80% when enabled | Capacity tracking |
| Global pattern library growth | >50 patterns after 6 months | Pattern count audit |

---

## Section 14: Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ USER INTERACTION LAYER                                       │
│ - cleo CLI (sole runtime surface, ~89 commands)              │
│ - Internal CQRS dispatch (query / mutate tags in registry)   │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ INTELLIGENCE LAYER (Validation + Adaptation)                 │
│ - 4-layer validation [SHIPPED]                               │
│ - Adaptive validation [Phase 2]                              │
│ - Proactive suggestions [Phase 3]                            │
│ - Quality prediction [Phase 3]                               │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ AGENT LAYER (Orchestration)                                  │
│ - ct-orchestrator + cleo-subagent [SHIPPED]                  │
│ - Self-healing [Phase 1]                                     │
│ - Load balancing [Phase 2]                                   │
│ - Learning from execution [Phase 3]                          │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ REASONING LAYER (Inference)                                  │
│ - Causal inference (reason.why) [SHIPPED]                    │
│ - Similarity detection (reason.similar) [SHIPPED]            │
│ - Temporal decay + memory consolidation [SHIPPED]            │
│ - Impact prediction [Phase 2]                                │
│ - Timeline analysis [Phase 3]                                │
│ - Domain placement: DEFERRED (ADR-009 Section 2.5)           │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ BASE LAYER (Memory) — SQLite per ADR-006                     │
│ - Tasks + sessions (.cleo/tasks.db)                          │
│ - Decision memory (.cleo/brain.db — brain_decisions)         │
│ - Pattern memory (.cleo/brain.db — brain_patterns)           │
│ - Learning memory (.cleo/brain.db — brain_learnings)         │
│ - Observations (.cleo/brain.db — brain_observations)         │
│ - PageIndex graph (.cleo/brain.db — brain_page_nodes/edges)  │
│ - Pipeline manifest (pipelineManifest in tasks.db)           │
│ - conduit.db (project-tier agent messaging, ADR-037)         │
│ - signaldock.db (global-tier agent identity, ADR-037)        │
│ - JSONL export/import for portability (ADR-009)              │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ NETWORK LAYER (Cross-Project) — SQLite per ADR-006           │
│ - Global Registry (~/.local/share/cleo/nexus.db)             │
│ - Global patterns (nexus.db — future table, contingent)      │
│ - Agent registry (federated, Phase 3, contingent)            │
└─────────────────────────────────────────────────────────────┘
```

---

## Section 15: Implementation Phases

### 15.1 Phase Alignment Summary

| BRAIN Dimension | Phase 0 (M1-2) | Phase 1 (M3-4) | Phase 2 (M5-9) | Phase 3 (M10-18) |
|-----------------|----------------|----------------|----------------|------------------|
| **Base (Memory)** | Current state | Context persistence | Decision/Pattern memory | Learning memory + consolidation |
| **Reasoning** | Current state | — | Causal + Similarity + Impact | Timeline analysis + Counterfactual |
| **Agent** | Current state | Self-healing + Health monitoring | Load balancing + Capability discovery | Learning from execution |
| **Intelligence** | Current state | Compliance scoring | Adaptive validation | Proactive suggestions + Quality prediction |
| **Network** | Current state | Cross-project search (if Nexus validates) | Knowledge transfer + Project similarity | Federated agents + Global intelligence |

### 15.2 Phase 0: Foundation (Months 1-2) — SHIPPED

**Goal**: Simplify codebase + harden the CLI dispatch surface (no BRAIN expansion).

**Deliverables**:
- 163 files → 100 files
- `cleo` CLI v1.0.0 with registry-defined `query` and `mutate` operations across all 10 domains
- Zero breaking changes

### 15.3 Phase 1: Validation (Months 3-4)

**Goal**: Validate Nexus + CLI dispatch adoption before BRAIN expansion.

**Base — Session Context Persistence**:

| Task | Description |
|------|-------------|
| Design context schema | `session-context.json` structure |
| Implement context save | Store on session end |
| Implement context resume | Restore on session start |
| Test context continuity | Validate 7-day recall |

Success criteria: Context recall >90% accurate after 7 days; zero data loss.

**Agent — Self-Healing**:

| Task | Description |
|------|-------------|
| Implement heartbeat monitoring | 30s intervals |
| Add timeout detection | 3min timeout threshold |
| Build retry logic | 3 attempts, exponential backoff |
| Add reassignment logic | Failover to different agent |

Success criteria: >95% automatic recovery rate; zero task loss.

**Intelligence — Compliance Scoring**:

| Task | Description |
|------|-------------|
| Define compliance metrics | Score calculation algorithm |
| Implement scoring dashboard | `cleo compliance score` |
| Historical analysis | Backfill scores for completed tasks |
| Correlation validation | Score vs success rate |

Success criteria: r>0.7 correlation between score and success; scoring overhead <100ms.

**Network — Cross-Project Search (CONTINGENT on Nexus validation)**:

| Task | Description |
|------|-------------|
| Nexus validation tracking | Measure 5 criteria for 30 days (passive) |
| Semantic search integration | SQLite-vec for Nexus queries |
| Cross-project query API | `cleo network search` |
| Performance benchmarking | <3s for 10 projects |

Validation gate: if Nexus fails validation, defer Network to Phase 3+.

### 15.4 Phase 2: Intelligence (Months 5-9)

**Goal**: Add semantic intelligence capabilities (Tier M scale).
**Precondition**: Phase 1 validation MUST pass for Nexus AND the CLI dispatch surface.

**Base — Decision/Pattern Memory**:

| Task | Description |
|------|-------------|
| Design decision + pattern schemas | `brain_decisions`, `brain_patterns` tables (ADR-009) |
| Implement decision logging | `cleo memory store --type decision` |
| Implement pattern extraction | Auto-extract from completed epics |
| Build query interface | `cleo memory recall`, `cleo memory search` |

Success criteria: >10 actionable patterns per 50 epics; retrieval <500ms for 1,000 entries.

**Reasoning — Causal + Similarity + Impact**:

| Task | Description |
|------|-------------|
| Causal inference implementation | `cleo reason why` |
| Similarity detection (SQLite-vec) | `cleo reason similar` |
| Impact prediction | `cleo reason impact` |
| Historical timeline analysis | `cleo reason timeline` (context only) |

**Agent — Load Balancing + Capability Discovery**:

| Task | Description |
|------|-------------|
| Build agent registry | Track capacity + skills |
| Implement capacity tracking | Max 5 tasks/agent |
| Build routing algorithm | Skill-based + capacity-aware |
| Performance optimization | <100ms routing latency |

**Intelligence — Adaptive Validation**:

| Task | Description |
|------|-------------|
| Error pattern database | Store common errors + fixes |
| Proactive warning system | Detect patterns before errors |
| Auto-remediation library | Fix scripts for known errors |
| Effectiveness tracking | Measure prevention rate |

**Network — Knowledge Transfer (CONTINGENT)**:

| Task | Description |
|------|-------------|
| Global pattern library | `nexus.db` (global_patterns table) |
| Export/import interface | `cleo network export-pattern` |
| Pattern adaptation logic | Context-aware adjustments |
| Effectiveness tracking | Measure transfer impact |

### 15.5 Phase 3: Scale (Months 10-18)

**Goal**: Support Tier L scale (3-10 projects, 5-20 concurrent agents).
**Precondition**: Phase 2 MUST validate TypeScript value AND Tier M usage demonstrated.

**Base — Learning Memory + Consolidation**:

| Task | Description |
|------|-------------|
| Design learning schema | `brain_learnings` SQLite table (per ADR-009) |
| Implement learning extraction | Auto-extract insights from completed work |
| Build consolidation pipeline | Compress old memories into summaries |
| Semantic linking | Connect related memories |

**Reasoning — Timeline Analysis + Counterfactual**:

| Task | Description |
|------|-------------|
| Timeline prediction model | ML model for historical analysis |
| Counterfactual simulation | Decision tree "what-if" analysis |
| Deadline feasibility checks | Based on historical data |
| Integration testing | Validate predictions on 100 tasks |

**Agent — Learning from Execution**:

| Task | Description |
|------|-------------|
| Feedback loop implementation | Capture task outcomes + blockers |
| Performance history tracking | Agent success rates + patterns |
| Adaptive routing | Adjust assignments based on learning |
| A/B testing framework | Measure learning effectiveness |

**Intelligence — Proactive Suggestions + Quality Prediction**:

| Task | Description |
|------|-------------|
| Context analysis engine | Predict next actions |
| Quality prediction model | ML model for task risk scoring |
| Suggestion acceptance tracking | Measure usefulness |
| Prediction accuracy validation | Test on 100 tasks |

**Network — Federated Agents + Global Intelligence (CONTINGENT on Tier L usage)**:

| Task | Description |
|------|-------------|
| Global agent registry | Track agents across projects |
| Cross-project RPC | Agent communication protocol |
| Global load balancing | Coordinate across projects |
| Global intelligence aggregation | Consolidated insights dashboard |

---

## Section 16: JSON Schemas

### 16.1 Session Context Schema

**File**: `schemas/session-context.schema.json` | **Table**: `sessions` (`.cleo/tasks.db`, ADR-006)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cleo-dev.com/schemas/v1/session-context.schema.json",
  "title": "CLEO Session Context",
  "description": "Persistent conversation context across sessions",
  "type": "object",
  "required": ["_meta", "sessionId", "context", "lastUpdated"],
  "properties": {
    "_meta": {
      "type": "object",
      "required": ["schemaVersion", "type"],
      "properties": {
        "schemaVersion": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+$",
          "description": "Schema version (semver)"
        },
        "type": { "type": "string", "const": "session-context" }
      }
    },
    "sessionId": {
      "type": "string",
      "pattern": "^session_\\d{8}_\\d{6}_[a-f0-9]{6}$",
      "description": "Session identifier"
    },
    "context": {
      "type": "object",
      "required": ["conversationSummary"],
      "properties": {
        "conversationSummary": {
          "type": "string",
          "maxLength": 1000,
          "description": "High-level summary of conversation context"
        },
        "keyDecisions": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["timestamp", "decision", "rationale"],
            "properties": {
              "timestamp": { "type": "string", "format": "date-time" },
              "decision": { "type": "string", "maxLength": 500 },
              "rationale": { "type": "string", "maxLength": 1000 }
            }
          }
        },
        "openQuestions": { "type": "array", "items": { "type": "string", "maxLength": 500 } },
        "nextActions": { "type": "array", "items": { "type": "string", "maxLength": 500 } }
      }
    },
    "lastUpdated": { "type": "string", "format": "date-time" },
    "tokenBudget": {
      "type": "object",
      "properties": {
        "used": { "type": "integer", "minimum": 0 },
        "total": { "type": "integer", "minimum": 0 },
        "percentage": { "type": "number", "minimum": 0, "maximum": 100 }
      }
    }
  }
}
```

### 16.2 Decision Memory Schema

**File**: `schemas/decision-memory.schema.json` | **Table**: `brain_decisions` (`.cleo/brain.db`, ADR-009)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cleo-dev.com/schemas/v1/decision-memory.schema.json",
  "title": "CLEO Decision Memory Entry",
  "description": "Architectural decision with rationale and context",
  "type": "object",
  "required": ["id", "timestamp", "type", "decision", "rationale", "context", "confidence"],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^D\\d{3,}$",
      "description": "Decision identifier (D001, D002, ...)"
    },
    "timestamp": { "type": "string", "format": "date-time" },
    "type": {
      "type": "string",
      "enum": ["architecture", "technical", "process", "strategic", "tactical"],
      "description": "Decision category"
    },
    "decision": { "type": "string", "maxLength": 500, "description": "What was decided" },
    "rationale": { "type": "string", "maxLength": 1000, "description": "Why this decision was made" },
    "context": {
      "type": "object",
      "properties": {
        "epic": { "type": "string", "pattern": "^T\\d{3,}$" },
        "task": { "type": "string", "pattern": "^T\\d{3,}$" },
        "phase": { "type": "string" }
      }
    },
    "outcome": {
      "type": ["string", "null"],
      "enum": ["success", "failure", "mixed", "pending", null],
      "description": "Decision outcome (null if not yet evaluated)"
    },
    "confidence": {
      "type": "string",
      "enum": ["low", "medium", "high"],
      "description": "Confidence level in decision"
    },
    "alternatives": {
      "type": "array",
      "items": { "type": "string", "maxLength": 500 },
      "description": "Alternative approaches considered"
    },
    "linkedTasks": {
      "type": "array",
      "items": { "type": "string", "pattern": "^T\\d{3,}$" }
    }
  }
}
```

### 16.3 Pattern Memory Schema

**File**: `schemas/pattern-memory.schema.json` | **Table**: `brain_patterns` (`.cleo/brain.db`, ADR-009)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cleo-dev.com/schemas/v1/pattern-memory.schema.json",
  "title": "CLEO Pattern Memory Entry",
  "description": "Recognized workflow pattern or anti-pattern",
  "type": "object",
  "required": ["id", "type", "pattern", "context", "frequency", "extractedAt"],
  "properties": {
    "id": { "type": "string", "pattern": "^P\\d{3,}$", "description": "Pattern identifier (P001, ...)" },
    "type": {
      "type": "string",
      "enum": ["workflow", "blocker", "success", "failure", "optimization"],
      "description": "Pattern category"
    },
    "pattern": { "type": "string", "maxLength": 500, "description": "Pattern description" },
    "context": { "type": "string", "maxLength": 500, "description": "Context where pattern applies" },
    "frequency": { "type": "integer", "minimum": 1, "description": "Number of times pattern observed" },
    "successRate": { "type": "number", "minimum": 0, "maximum": 1 },
    "impact": { "type": "string", "enum": ["low", "medium", "high"] },
    "extractedAt": { "type": "string", "format": "date-time" },
    "examples": {
      "type": "array",
      "items": { "type": "string", "pattern": "^T\\d{3,}$" },
      "description": "Example task IDs where pattern occurred"
    },
    "antiPattern": { "type": "string", "maxLength": 500, "description": "Related anti-pattern to avoid" },
    "mitigation": { "type": "string", "maxLength": 500, "description": "How to avoid/fix this pattern" }
  }
}
```

### 16.4 Learning Memory Schema

**File**: `schemas/learning-memory.schema.json` | **Table**: `brain_learnings` (`.cleo/brain.db`, ADR-009)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cleo-dev.com/schemas/v1/learning-memory.schema.json",
  "title": "CLEO Learning Memory Entry",
  "description": "Accumulated insight from historical data",
  "type": "object",
  "required": ["id", "timestamp", "insight", "source", "confidence", "actionable"],
  "properties": {
    "id": { "type": "string", "pattern": "^L\\d{3,}$", "description": "Learning identifier (L001, ...)" },
    "timestamp": { "type": "string", "format": "date-time" },
    "insight": { "type": "string", "maxLength": 1000, "description": "What was learned" },
    "source": { "type": "string", "maxLength": 500, "description": "Data source for this learning" },
    "confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "Confidence level (0.0-1.0)"
    },
    "applicableToTypes": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Task types this learning applies to"
    },
    "actionable": { "type": "boolean", "description": "Can this insight be acted upon?" },
    "application": { "type": "string", "maxLength": 500, "description": "How to apply this learning" }
  }
}
```

---

## Section 17: Success Metrics and Certification

### 17.1 BRAIN Certification Criteria

**When is CLEO a true AGENTIC BRAIN?** All 5 dimensions MUST meet certification criteria:

| Dimension | Certification Criteria | Evidence Required | Timeline |
|-----------|------------------------|-------------------|----------|
| **Base (Memory)** | Multi-modal storage (JSON + SQLite), context recall >90%, <10MB/year | Performance benchmarks + storage audit | Phase 1-3 |
| **Reasoning** | Causal inference >85% accuracy, similarity relevance >80%, impact recall >90% | Blind validation on 100 tasks | Phase 2-3 |
| **Agent** | Self-healing >95% recovery, load balancing >70% utilization, learning >20% efficiency gain | Production load testing | Phase 1-3 |
| **Intelligence** | Adaptive validation >30% error prevention, proactive suggestions >60% acceptance, quality prediction >75% accuracy | A/B comparison + user surveys | Phase 2-3 |
| **Network** | Cross-project queries >70% useful, knowledge transfer >30% improvement, >50 global patterns | Multi-project usage data | Phase 1-3 (contingent) |

**Certification Gate**: After Phase 3 completion (Month 18+).

### 17.2 Phase-Specific Metrics

**Phase 1 (Months 3-4)**:

| Metric | Target | Status |
|--------|--------|--------|
| Context recall accuracy | >90% after 7 days | PENDING |
| Self-healing recovery rate | >95% without HITL | PENDING |
| Compliance score correlation | r>0.7 with success rate | PENDING |
| Nexus cross-project queries | >100 in 30 days | PENDING (validation gate) |

**Phase 2 (Months 5-9)**:

| Metric | Target | Status |
|--------|--------|--------|
| Pattern extraction | >10 per 50 epics | PENDING |
| Causal inference accuracy | >85% blind validation | PENDING |
| Similarity relevance | >80% user satisfaction | PENDING |
| Agent load balancing | >70% utilization | PENDING |
| Error prevention rate | >30% proactive | PENDING |

**Phase 3 (Months 10-18)**:

| Metric | Target | Status |
|--------|--------|--------|
| Learning effectiveness | >20% efficiency gain | PENDING |
| Timeline analysis usefulness | >70% user satisfaction | PENDING |
| Quality prediction accuracy | >75% within ±10% | PENDING |
| Suggestion acceptance rate | >60% acceptance | PENDING |
| Global pattern library | >50 patterns after 6 months | PENDING |

### 17.3 Continuous Monitoring (OpenTelemetry)

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Memory storage growth | <10MB/year | >20MB/year |
| Query response time | <3s p95 | >5s p95 |
| Agent uptime | >99.5% | <99% |
| Context recall accuracy | >90% | <85% |
| Error prevention rate | >30% | <20% |

---

## Section 18: Risks and Mitigations

### 18.1 High-Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| Memory bloat | Storage >100MB/year, performance degrades | Memory consolidation pipeline, strict retention policies |
| Learning accuracy | Wrong patterns learned, reduced efficiency | Confidence thresholds, HITL review, rollback mechanism |
| Network dimension failure | Nexus validation fails, lose cross-project capability | Contingency: consolidate to single file, defer to Phase 3+ |
| Complexity creep | BRAIN features add overhead without value | Phase gates enforce evidence-based expansion |
| Agent coordination failures | Deadlocks, race conditions | Self-healing, timeout detection, circuit breakers |

### 18.2 Medium-Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| Schema evolution | Breaking changes to memory schemas | Versioning + migration functions |
| Query performance | Semantic search >3s response time | SQLite-vec optimization, caching, indexing |
| Pattern extraction noise | >50% false patterns | Frequency threshold (min 5 occurrences), HITL review |
| Suggestion fatigue | Users ignore proactive suggestions | Confidence threshold >80%, limit frequency |

### 18.3 Rollback Triggers

**Automatic** (no human intervention):
- Memory storage >50MB/year
- Query response >10s p95
- Context recall <80% accuracy
- Agent uptime <98%

**Manual** (HITL decision):
- Phase validation fails (any criterion unmet)
- User satisfaction <50% for any BRAIN dimension
- >3 critical bugs in production

---

## Section 19: References

### 19.1 Authority Documents

- `docs/concepts/CLEO-VISION.md` — immutable vision identity
- `docs/specs/CLEO-PORTABLE-PROJECT-BRAIN-SPEC.md` — **this document** (canonical product contract + capability model)
- `README.md` — operational public contract
- `docs/ROADMAP.md` — current and future targets

### 19.2 Strategic Foundation

- **T2975**: EPIC: CLEO Consolidation Sprint
- **T2996**: Research: BRAIN Vision Alignment - Strategic Roadmap Review
- **T2973**: Specification: CLEO Strategic Roadmap
- **T2971**: Research: BRAIN Vision Requirements *(archived — pre-SQLite migration)*
- **T2968**: EPIC: CLEO Strategic Inflection Point Review
- **T158**: EPIC: CAAMP 1.9.1 Hook Normalizer Integration
- **T134**: EPIC: Brain Memory Automation (T135-T146)
- **T4565**: Shared-core compliance audit (2026-02-16)

### 19.3 Related Specifications

- `docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` — phase definitions and timeline
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — canonical runtime dispatch contract (CLI + internal CQRS)
- `docs/specs/CLEO-NEXUS-ARCHITECTURE.md` — network dimension architecture
- `docs/specs/PROJECT-LIFECYCLE-SPEC.md` — RCASD-IVTR lifecycle
- `docs/specs/CLEO-SYSTEM-FLOW-ATLAS.md` — canonical information flow diagram
- `docs/specs/CAAMP-INTEGRATION-SPEC.md` — CAAMP hook taxonomy integration
- `docs/architecture/DATABASE-ERDS.md` — full brain.db table reference

### 19.4 Implementation References

- `packages/contracts/src/config.ts` — `BrainConfig` interface (SSoT for feature flags)
- `packages/core/src/store/brain-schema.ts` — Drizzle ORM schema for brain.db
- `packages/cleo/src/dispatch/registry.ts` — dispatch operation registry
- `.cleo/agent-outputs/T4565-T4566-architecture-validation-report.md` — shared-core compliance audit (historical)
- `.cleo/agent-outputs/T4557-documentation-audit-report.md` — documentation inventory

---

## Appendix A: BRAIN vs Task Manager Comparison

| Capability | Task Manager (Tier S) | AGENTIC BRAIN (Tier M/L) |
|------------|----------------------|--------------------------|
| **Memory** | Single-session only | Persistent across sessions |
| **Reasoning** | Static dependencies | Causal inference + temporal analysis |
| **Agent** | Protocol enforcement | Self-healing + learning + coordination |
| **Intelligence** | Reactive validation | Adaptive + proactive + predictive |
| **Network** | Isolated projects | Cross-project intelligence + federated agents |
| **Learning** | None | Pattern extraction + knowledge transfer |
| **Prediction** | None | Quality prediction + timeline analysis |
| **Coordination** | Project-scoped | Multi-project federated |

---

## Appendix B: Data Flow Architecture (Detailed)

```
┌─────────────────────────────────────────────────────────────┐
│ USER INTERACTION LAYER                                       │
│ - cleo CLI (sole runtime surface, ~89 commands)              │
│ - Internal CQRS dispatch (query / mutate tags in registry)   │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ INTELLIGENCE LAYER (Validation + Adaptation)                 │
│ - 4-layer validation                                         │
│ - Adaptive validation (Phase 2)                              │
│ - Proactive suggestions (Phase 3)                            │
│ - Quality prediction (Phase 3)                               │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ AGENT LAYER (Orchestration)                                  │
│ - ct-orchestrator                                            │
│ - cleo-subagent                                              │
│ - Self-healing (Phase 1)                                     │
│ - Load balancing (Phase 2)                                   │
│ - Learning from execution (Phase 3)                          │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ REASONING LAYER (Inference)                                  │
│ - Causal inference (Phase 2)                                 │
│ - Similarity detection (Phase 2)                             │
│ - Impact prediction (Phase 2)                                │
│ - Timeline analysis (Phase 3)                                │
│ - Domain placement: DEFERRED (ADR-009 Section 2.5)           │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ BASE LAYER (Memory) — SQLite per ADR-006                     │
│ - Tasks + sessions (.cleo/tasks.db — tasks, sessions tables) │
│ - Decision memory (.cleo/brain.db — brain_decisions table)   │
│ - Pattern memory (.cleo/brain.db — brain_patterns table)     │
│ - Learning memory (.cleo/brain.db — brain_learnings table)   │
│ - Pipeline manifest (pipelineManifest table in tasks.db)     │
│ - conduit.db (project-tier agent messaging, ADR-037)         │
│ - signaldock.db (global-tier agent identity, ADR-037)        │
│ - JSONL export/import for portability (ADR-009)              │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│ NETWORK LAYER (Cross-Project) — SQLite per ADR-006           │
│ - Global Registry (~/.local/share/cleo/nexus.db)             │
│ - Global patterns (nexus.db — future table)                  │
│ - Agent registry (federated, Phase 3)                        │
└─────────────────────────────────────────────────────────────┘
```

---

**Specification Status**: APPROVED
**Implementation**: Phases 1-4 shipped (brain.db, 3-layer retrieval, vector search, PageIndex graph, reasoning engine, temporal decay, memory consolidation). T134 automation layer shipped. T158 CAAMP 1.9.1 hook normalizer integration shipped.
**Next Steps**: Phase 5 planning (claude-mem full retirement)
**Approval Authority**: CLEO Development Team
**Review Cycle**: Quarterly (or after each phase gate)
**Canonical Path**: `docs/specs/CLEO-PORTABLE-PROJECT-BRAIN-SPEC.md`
