# T549-R6: Existing Specs & ADRs Audit — Memory Architecture v2

**Date**: 2026-04-13
**Agent**: Research Explorer
**Task**: T549 (Memory Architecture v2 — Pre-Design Governance Audit)
**Status**: Complete

---

## 1. Complete Inventory of Memory-Related Specs

### 1.1 Primary Memory/Brain Specification

| Path | Version | Status | Authority Level |
|------|---------|--------|----------------|
| `docs/specs/CLEO-PORTABLE-PROJECT-BRAIN-SPEC.md` | 3.1.0 | APPROVED | 2 (below CLEO-VISION.md only) |

This is the single canonical product contract for BRAIN. It supersedes:
- `docs/specs/PORTABLE-BRAIN-SPEC.md` (v1.3.0) — archived
- `docs/specs/CLEO-BRAIN-SPECIFICATION.md` (v2.1.0) — archived

**Changelog highlights**:
- v3.1.0 (2026-04-11): Added Section 8.2 (Code Intelligence via `@cleocode/nexus`), updated Network dimension
- v3.0.0 (2026-04-11): Consolidated the two legacy specs into one AL2 document
- v2.1.0 (2026-03-24): T158 — CAAMP 1.9.1 hook taxonomy integration; 6 adapters; SubagentStart/Stop/PreCompact handlers
- v2.0.0 (2026-03-23): T134 — Brain memory automation; BrainConfig; local embeddings; hook-driven bridge refresh; session summarization; transcript extraction

### 1.2 Architecture Support Docs

| Path | Purpose | Status |
|------|---------|--------|
| `docs/architecture/erd-brain-db.md` | ERD for brain.db (9 tables) | Current — 2026-03-21 |
| `docs/architecture/DATABASE-ERDS.md` | Full DB ERDs for all 5 databases | Current |
| `docs/specs/DATABASE-ARCHITECTURE.md` | 5-DB topology (canonical) | Current — 2026-03-25 |
| `docs/concepts/CLEO-VISION.md` | Constitutional identity (Authority Level 1) | Immutable |
| `docs/concepts/CLEO-SYSTEM-FLOW-ATLAS.md` | Canonical information flow diagram | Current |
| `docs/specs/CLEO-OPERATION-CONSTITUTION.md` | Runtime dispatch contract | Current |

### 1.3 T523 BRAIN Integrity Epic Outputs (2026-04-11/12)

All produced under EPIC T523 (status: done):

| File | Content |
|------|---------|
| `T523-R1-brain-audit-report.md` | Forensic audit: 2,956 entries, ~97.5% noise; graph layer = 0 nodes |
| `T523-R2-ladybugdb-architecture-study.md` | LadybugDB graph architecture research |
| `T523-R3-memory-system-code-review.md` | Source code review of brain.db |
| `T523-CA1-brain-integrity-spec.md` | Purge + dedup + quality scoring spec |
| `T523-CA2-memory-sdk-spec.md` | Graph-native Cleo Memory SDK spec (Option C: Hybrid) |
| `T523-T513-cross-validation-report.md` | Cross-validation with code intelligence pipeline |
| `T528-brain-schema-expansion-summary.md` | Wave B-1 results: expanded brain_page_nodes schema |
| `T535-brain-cli-summary.md` | Wave F-1: graph traversal CLI commands |
| `T537-brain-hooks-summary.md` | Wave E-2: brain graph auto-population hooks |
| `T475-memory-domain-audit.md` | Memory domain: 18 ops audited, 10 CLI gaps closed |

---

## 2. All ADR Decisions That Constrain Memory Design

### ADR-006: Canonical SQLite Storage Architecture
**Status**: Accepted (2026-02-21) | **Amended by**: ADR-010, ADR-011, ADR-017, ADR-020

**Binding constraints on memory design**:
- SQLite is the canonical runtime store for ALL operational data — no exceptions for memory
- JSONL is STRICTLY PROHIBITED as a runtime store; permitted only as export/import format
- Three SQLite databases defined: `tasks.db` (shipped), `brain.db` (shipped), `nexus.db` (global, shipped)
- Must use `drizzle-orm` v1.0.0-beta (floor: beta.18) for schema definition
- Must use `node:sqlite` (`DatabaseSync`) via Node >= 24.0.0
- `drizzle-zod` package MUST NOT be installed; use `drizzle-orm/zod`
- All session state must be in SQLite `sessions` table (no JSON files)

### ADR-009: BRAIN Cognitive Architecture
**Status**: Accepted (2026-02-22) | **Amended by**: ADR-021

**Binding constraints on memory design**:
- Five BRAIN dimensions defined: B(ase/Memory), R(easoning), A(gent), I(ntelligence), N(etwork)
- B-R-A-I-N is an informative conceptual lens ONLY — not a runtime model (amended by ADR-021)
- The 10 canonical domains (ADR-007) are the runtime contract
- `memory` domain = cognitive memory ONLY (brain.db operations)
- SQLite is canonical runtime; JSONL is export/import format
- Vectorless RAG is primary retrieval method; vectors augment (do not replace) structural discovery
- Five discovery methods: label-based, description-based, file-based, hierarchy-based, auto (weighted)
- Storage evolution: S (SQLite) → M (SQLite + sqlite-vec) → L (SQLite + PostgreSQL) → XL (PostgreSQL + graph extensions)
- Tier M (sqlite-vec) is CONTINGENT on Phase 1 validation gates passing
- Authority hierarchy: CLEO-VISION.md > BRAIN-SPEC > ADR-006 > ADR-007 > ADR-008 > ADR-009 > ROADMAP
- Higher-priority documents always prevail in conflicts

**Brain.db schema (locked — `packages/core/src/store/brain-schema.ts`)**:
- `brain_decisions` — architecture/technical/process/strategic/tactical decisions
- `brain_patterns` — workflow/blocker/success/failure/optimization patterns
- `brain_learnings` — insights with 0.0–1.0 confidence
- `brain_observations` — raw observations (source of truth: 5,122+ entries post-migration)
- `brain_memory_links` — polymorphic cross-reference to tasks.db
- `brain_sticky_notes` — ephemeral capture
- `brain_page_nodes` — PageIndex graph nodes (extended schema via T523 Wave B-1)
- `brain_page_edges` — directed edges between nodes
- `brain_schema_meta` — schema versioning

**Current memory domain ops (17 total — ADR-021)**:
- 12 query ops: show, find, timeline, fetch, stats, contradictions, superseded, decision.find, pattern.find, pattern.stats, learning.find, learning.stats
- 5 mutate ops: observe, decision.store, pattern.store, learning.store, link
- Additional (post-T475): graph.show, graph.neighbors, graph.add, graph.remove, reason.why, reason.similar, search.hybrid

### ADR-013: Data Integrity & Checkpoint Architecture
**Status**: Accepted (2026-02-25), Resolved 2026-04-07 (T5158)

**Binding constraints on memory design**:
- `brain.db` MUST NOT be tracked in project git (git rm --cached)
- VACUUM INTO is the mandatory backup mechanism — no SQL dumps, no Litestream
- Auto-snapshot on `cleo session end` via `backup-session-end` hook (priority 10)
- 30-second debounce on `vacuumIntoBackupAll`; `force: true` bypasses debounce
- Max 10 rotating snapshots per database prefix
- `brain.db` and `tasks.db` listed in `SNAPSHOT_TARGETS` in `sqlite-backup.ts`
- `PRAGMA wal_checkpoint(TRUNCATE)` MUST run before every `VACUUM INTO`
- Recovery via `.cleo/backups/sqlite/brain-YYYYMMDD-HHmmss.db`
- Direct SQLite access (`sqlite3` CLI) on brain.db is PROHIBITED — always use `cleo` CLI

### ADR-021: Memory Domain Refactor — Cognitive-Only Cutover
**Status**: Accepted (2026-03-03) | **Amends**: ADR-007, ADR-009

**Binding constraints on memory design**:
- `memory` domain = cognitive memory ONLY (brain.db interactions)
- Pipeline artifacts (MANIFEST.jsonl) belong to `pipeline` domain
- Protocol injection is `session.context.inject` — not a memory operation
- Single retrieval verb: `find` everywhere — NO `search` verb in the system
- 3-layer retrieval pattern: `memory.find` → `memory.timeline` → `memory.fetch`
- Write via: `memory.observe`
- ZERO legacy aliases — old operation names return `E_INVALID_OPERATION`
- Dead operations (will error): `memory.brain.search`, `memory.brain.timeline`, `memory.brain.fetch`, `memory.brain.observe`, `memory.pattern.search`, `memory.learning.search`, and all former manifest ops
- B-R-A-I-N metaphor is conceptual only — NOT a runtime routing model
- registry.ts is the executable SSoT — documentation derives from registry, not reverse

### ADR-032 / ADR-034: Provider-Agnostic Memory Bridge
**Status**: Accepted (2026-03-16) | (ADR-032 and ADR-034 cover the same decision)

**Binding constraints on memory design**:
- Three-layer memory surfacing architecture:
  - Layer 1: Static seed `.cleo/memory-bridge.md` (auto-generated, @-referenced from AGENTS.md)
  - Layer 2: `ct-memory` skill — guided self-retrieval (Tier 0/1/2)
  - Layer 3: MCP resources `cleo://memory/*` (on-demand from brain.db)
- Memory bridge is CLEO-owned — adapters NEVER write to it directly
- Regeneration triggers: session end, task completion, high-confidence observations, `cleo refresh-memory`
- Bridge content must stay compact: Layer 1 costs 200–400 tokens; Layers 2–3 are on-demand
- No writing to provider-owned files (CLAUDE.md, .cursorrules) for memory injection
- Token-efficiency routing table maps ops to cheapest effective channel

### ADR-036: CleoOS Database Topology + Lifecycle
**Status**: Accepted (2026-04-08)

**Binding constraints on memory design**:
- Canonical 4-DB × 2-tier topology is locked:
  - Project tier: `tasks.db`, `brain.db`, `signaldock.db`, `config.json`, `project-info.json`
  - Global tier: `nexus.db`, `signaldock.db` (after T310)
- `brain.db` belongs exclusively at project tier — no global brain.db
- `nexus.db` belongs exclusively at global tier — no project-tier nexus.db
- Walk-up algorithm: find nearest ancestor with `.cleo/` or `.git/` — no auto-create
- `CLEO_ROOT` env var bypasses walk-up (CI/monorepo escape hatch)
- VACUUM INTO backup covers both `brain.db` and `tasks.db` at project tier
- Global-tier nexus.db gets its own VACUUM INTO rotation (T306)
- Signaldock dual-scope (T310) is deferred — NOT in scope for current work

### ADR-011: Project Configuration Architecture
**Status**: Accepted (2026-02-23) | **Amends**: ADR-006

**Binding constraints on memory design**:
- Exactly three JSON config files exist at `.cleo/`: `config.json`, `project-info.json`, `project-context.json`
- These three files are exempt from ADR-006's SQLite-only mandate (human-editable)
- All writes to these files MUST use atomic file operations (`saveJson()`)
- `BrainConfig` in `packages/contracts/src/config.ts` is the SSoT for all BRAIN feature flags

---

## 3. What Is LOCKED and Cannot Change

The following decisions are locked by accepted ADRs or constitutional documents:

### 3.1 Storage Layer (IMMUTABLE)
- brain.db is SQLite — no alternatives, no hybrids with other runtime stores
- `drizzle-orm` v1.0.0-beta is the ORM — no downgrading, no raw SQL schemas without Drizzle
- JSONL is export/import ONLY — never runtime storage
- Brain.db not tracked in git — VACUUM INTO backups only
- Direct `sqlite3` CLI access to brain.db is prohibited

### 3.2 Schema Tables (LOCKED — changes require Drizzle migration + ADR)
All 9 tables in brain.db are locked. New tables require a new ADR:
- `brain_decisions`, `brain_patterns`, `brain_learnings`, `brain_observations`
- `brain_memory_links`, `brain_sticky_notes`
- `brain_page_nodes`, `brain_page_edges` (extended schema shipped in T523 Wave B-1)
- `brain_schema_meta`

### 3.3 Domain Assignment (LOCKED by ADR-021)
- `memory` domain = cognitive memory interactions with brain.db — cannot be expanded to cover other concerns
- Manifest ops belong to `pipeline` domain — cannot move back to `memory`
- `session.context.inject` belongs to `session` domain — not memory
- The `find` verb is canonical — `search` verb is banned system-wide

### 3.4 5 Canonical Pillars (CONSTITUTIONAL — cannot be violated by any release)
1. Portable Memory
2. Provenance by Default
3. Interoperable Interfaces (CLI is first-class)
4. Deterministic Safety (atomic writes, validation-first)
5. Cognitive Retrieval (graph/vector/RAG at Tier M/L)

### 3.5 6 Core Invariants (IMMUTABLE)
1. Stable task identity (T### never changes)
2. Atomic writes (temp → validate → backup → rename)
3. Validation-first enforcement (blocks invalid state, does not warn)
4. Append-only audit trail
5. Machine-first JSON output by default
6. Explicit lifecycle enforcement

### 3.6 BrainConfig Feature Flags (LOCKED — all default false/disabled)
```typescript
interface BrainConfig {
  autoCapture: boolean;        // default: true
  captureFiles: boolean;       // default: false
  embedding: { enabled: boolean; provider: 'local' | 'openai' };  // default: false
  memoryBridge: { autoRefresh: boolean; contextAware: boolean; maxTokens: number }; // autoRefresh: true
  summarization: { enabled: boolean };  // default: false
}
```
Config-gating is mandatory — all new features MUST default to false until opt-in.

### 3.7 Backup Constraints (LOCKED by ADR-013 + ADR-036)
- VACUUM INTO is the only permitted backup mechanism
- Auto-snapshot on session end is mandatory
- 10-snapshot rotation per prefix is the maximum
- 30-second debounce applies except for session end and manual backup

---

## 4. What Is PLANNED But Not Built (Phase Map)

### Phase 1 (Months 3-4) — Validation Gate PENDING
| Capability | Status | Gate |
|-----------|--------|------|
| Session context persistence | PENDING | Nexus validation + CLI adoption |
| Agent self-healing (heartbeat, retry, reassign) | PENDING | Phase 1 gate |
| Compliance scoring | PENDING | Phase 1 gate |
| Cross-project search via Nexus (contingent) | PENDING | Nexus validation gate |

**Nexus Validation Gate** (CRITICAL): Network dimension expansion is contingent on:
- ≥3 developers using Nexus actively for 30 days
- ≥2 projects/user, >100 cross-project queries, >30% context discovery reduction
- **If gate FAILS**: consolidate Nexus to single file, defer Network to Phase 3+

### Phase 2 (Months 5-9) — Precondition: Phase 1 must pass
| Capability | Status | Domain |
|-----------|--------|--------|
| Adaptive validation (error pattern learning) | PLANNED | check |
| Auto-remediation | PLANNED | check |
| Agent load balancing + capacity tracking | PLANNED | orchestrate |
| Agent capability discovery | PLANNED | orchestrate |
| Memory export/import (JSONL portability ops) | PLANNED | memory |
| Temporal queries via date filters | PLANNED | memory |
| Knowledge transfer across projects (contingent) | PLANNED | nexus |
| Project similarity detection | PLANNED | nexus |

### Phase 3 (Months 10-18) — Precondition: Phase 2 validation + Tier M usage
| Capability | Status | Domain |
|-----------|--------|--------|
| Proactive suggestions | PLANNED | check |
| Quality prediction (ML model) | PLANNED | check |
| Learning from execution (agent adaptive routing) | PLANNED | orchestrate |
| Timeline analysis (historical only, no estimates) | PLANNED | reason |
| Counterfactual reasoning (experimental) | PLANNED | reason |
| Memory consolidation (full pipeline) | PLANNED | memory |
| Federated agents (contingent on Tier L) | PLANNED | nexus |
| Global intelligence aggregation | PLANNED | nexus |

### Reasoning Domain Placement — DEFERRED (ADR-009 §2.5)
The `reason.*` namespace is reserved. Domain placement of reasoning operations requires a dedicated Research & Consensus cycle. Currently, reasoning-adjacent operations stay where they are (`tasks.blockers`, `orchestrate.waves`, `nexus.find`). No new `reason.*` operations may be committed to a domain without completing the R&C cycle.

### Signaldock Dual-Scope (T310) — DEFERRED
Global `signaldock.db` identity registry plus project-reference schema split. Not in scope until T310 RCASD pipeline completes.

### Cross-Machine Backup Export/Import (T311) — DEFERRED
Tarball format with `manifest.json`, SHA-256 checksums, schema-version validation. Not in scope until T311 RCASD pipeline completes.

### Code Intelligence Full Pipeline (T513 follow-up) — PENDING
- `@cleocode/nexus` foundations shipped (T506: tree-sitter, LanguageProvider, impact analysis, code_index)
- Full codebase indexing pipeline (`cleo nexus analyze`), import resolution, call graphs, community detection — all PENDING

---

## 5. Contradictions Between Specs

### 5.1 Resolved Contradictions (no longer active)

| # | Former Contradiction | Resolution | Authority |
|---|---------------------|------------|-----------|
| 1 | BRAIN Spec said JSONL runtime store; ADR-006 said SQLite only | SQLite is runtime; JSONL is export/import | ADR-006 (accepted) |
| 2 | cognitive-architecture.mdx said "Vectorless RAG only"; BRAIN Spec planned sqlite-vec | Both coexist: vectorless primary, vectors augment | ADR-009 |
| 3 | ADR-006 schema had 9 stages with "adr"; ADR-007 said 8 stages | 9 pipeline stages; `architecture_decision` replaced "adr" | ADR-014 |
| 4 | Nexus storage: ADR-006 said nexus.db; others said JSON files | SQLite (nexus.db) canonical | ADR-006 (accepted) |
| 5 | `memory.brain.search` used non-canonical verb | Renamed to `memory.find`; old name returns E_INVALID_OPERATION | ADR-021 |
| 6 | Pipeline artifacts in `memory` domain | Moved to `pipeline.manifest.*` | ADR-021 |

### 5.2 Active Tensions (not resolved contradictions, but areas needing care)

**A. BRAIN Spec v3.1.0 "Shipped" labels vs. ADR-009 "Deferred" labels**

The BRAIN Spec (AL2) Section 13.2 lists `memory.reason.why` and `memory.reason.similar` as SHIPPED (via T5390, T5391). ADR-009 Section 5.2 marks these as "Deferred." The Reasoning domain placement R&C was explicitly deferred by ADR-009, yet BRAIN Spec marks implementation as shipped.

Resolution: The BRAIN Spec (higher authority, AL2) prevails. The reasoning operations shipped under the `memory.*` namespace even though domain assignment is formally deferred. The ops exist; the domain placement decision for future ops is still pending.

**B. Appendix B in BRAIN Spec vs. Section 14 Data Flow**

Appendix B still shows the old Phase 2 framing for Causal Inference and Similarity Detection as "Phase 2" items, but Section 13.2 and Section 14 describe them as SHIPPED. This is an internal spec inconsistency. Section 13 and 14 are authoritative (more specific, more recently updated).

**C. ADR-032 and ADR-034 are duplicates**

Both ADR-032 and ADR-034 cover "Provider-Agnostic Memory Bridge" and reference the same task (T5240). ADR-032 was written first; ADR-034 appears to be a revision or duplicate entry. Both are marked Accepted. Functionally they are consistent; the duplication is a housekeeping issue, not a contradiction.

---

## 6. Authority Hierarchy for Memory Decisions

Per ADR-009 Section 7 and BRAIN Spec Section 0.1, the conflict resolution order is:

```
1. docs/concepts/CLEO-VISION.md                     (Constitutional — IMMUTABLE)
2. docs/specs/CLEO-PORTABLE-PROJECT-BRAIN-SPEC.md   (Authority Level 2 — product contract)
3. README.md                                         (Operational public contract)
4. docs/ROADMAP.md                                   (Sequencing and targets)
5. .cleo/adrs/ADR-006-canonical-sqlite-storage.md   (Storage — ACCEPTED)
6. .cleo/adrs/ADR-007-domain-consolidation.md       (Domains — 10 canonical)
7. .cleo/adrs/ADR-008-CLEO-CANONICAL-ARCHITECTURE.md
8. .cleo/adrs/ADR-009-BRAIN-cognitive-architecture.md  (BRAIN bridge)
9. .cleo/adrs/ADR-013-data-integrity.md             (Backup + safety rules)
10. .cleo/adrs/ADR-021-memory-domain-refactor.md    (Cognitive-only cutover)
11. .cleo/adrs/ADR-032/034-memory-bridge.md         (Provider-agnostic bridge)
12. .cleo/adrs/ADR-036-database-topology.md         (4-DB × 2-tier topology)
13. All other specs                                  (Scoped implementation details)
```

**Conflict resolution rule (ADR-009 §7)**: Higher-numbered entries MUST NOT contradict lower-numbered entries. If they do, the lower-numbered document prevails and the conflicting document requires correction.

**Governance for new decisions**:
- Any change that alters canonical identity requires a Vision Amendment + spec update in the same change set
- Any change to memory schema, domain assignment, or storage model requires a new ADR through the RCASD pipeline
- Phase-gated capabilities require evidence validation before expansion (no spec changes that mark things "shipped" prematurely)

---

## 7. What We CAN Do Without Violating Existing Governance

Based on the full audit, the following work is permitted WITHOUT conflicting with existing decisions:

### 7.1 Permitted Without New ADR (extend existing locked decisions)

- Add new columns to existing brain.db tables via Drizzle migration (schema evolution is expected; versioning via `brain_schema_meta` is already in place)
- Extend `brain_page_nodes` node types (the T523-CA2 spec defines the extension model; `BRAIN_NODE_TYPES` can be extended)
- Add new edge types to `brain_page_edges` (no constraint on edge type set)
- Add new CLI subcommands that invoke existing registry ops (no new ops needed)
- Fix bugs in existing memory ops (deduplication, quality scoring, hook noise — all addressed in T523)
- Write to `memory.observe`, `memory.decision.store`, `memory.pattern.store`, `memory.learning.store` from new trigger points
- Extend the memory bridge content format (Layer 1 is CLEO-owned; content is not locked)
- Add new entries to the `ct-memory` skill (Layer 2)
- Tune the token-efficiency routing table

### 7.2 Permitted With New ADR (governed expansion)

- Add new tables to brain.db (requires ADR amending ADR-009)
- Add new operations to the `memory` domain (requires registry update + ADR amending ADR-021)
- Change storage tier (e.g., enable sqlite-vec — already specified as Phase M, needs validation gate evidence)
- Move any operation between domains (requires ADR amending ADR-007 + ADR-021)
- Assign reasoning operations (`reason.*`) to a domain (requires R&C cycle per ADR-009 §2.5)
- Enable embedding by default (currently gated behind `BrainConfig.embedding.enabled = false`)
- Add cross-machine export/import capability (T311 — requires its own RCASD pipeline)
- Change the 4-DB × 2-tier topology (requires ADR amending ADR-036)
- Split signaldock global/project (T310 — requires its own RCASD pipeline)

### 7.3 PROHIBITED (violates locked decisions)

- Using any store other than SQLite as a runtime memory store
- Using JSONL as a runtime store (export/import only)
- Adding a `search` verb to any operation (violates ADR-021 + VERB-STANDARDS.md)
- Re-adding `memory.brain.*` prefixed operations (returns E_INVALID_OPERATION)
- Moving manifest operations back to the `memory` domain
- Moving `session.context.inject` to memory domain
- Tracking `brain.db` in git
- Using direct `sqlite3` CLI on brain.db
- Deploying new BRAIN capabilities without passing their phase gate
- Bypassing drizzle-orm for schema changes
- Creating a `reason.*` domain assignment without completing the R&C research cycle
- Claiming any Phase 2/3 capability as "shipped" without evidence-based validation gate

---

## 8. Key Findings Summary

### What Phase Are We In?

Per BRAIN Spec Section 15 and the T523 completion status:

- **Phase 0** (Foundation): COMPLETE — CLI dispatch hardened, 10-domain model stable
- **Phase 1** (Validation): IN PROGRESS — Nexus validation gate PENDING; session context persistence PENDING
- **T523** (BRAIN Integrity Crisis): COMPLETE (2026-04-12) — brain.db purged, graph layer populated, dedup engine, quality scoring, embedding pipeline activated, CLI graph commands shipped

The spec describes Phases 0-3 over 18 months. We are early in Phase 1. T134 and T158 added significant capabilities (hook automation, embedding pipeline) that the spec marks as shipped in v2.x/3.x but the phase map still shows Phase 1 as the current gate.

### What T523 Delivered (Now Complete)

This is the most recent major memory work and its outputs constrain v2 design:

1. **Purge**: 2,927 noise pattern entries deleted; brain.db now at ~1.9% noise
2. **Dedup engine**: Content-hash deduplication prevents future noise accumulation
3. **Quality scoring**: Every brain.db entry has a quality score (0.0–1.0)
4. **Graph layer**: `brain_page_nodes` schema extended with `qualityScore`, `contentHash`, `lastActivityAt`, `metadata_json`; `BRAIN_NODE_TYPES` extended with 12 node types
5. **Graph population**: 128 surviving entries auto-populated into graph nodes
6. **Hook fixes**: `extractTaskCompletionMemory` gutted (no-op); duplicate session hooks severed
7. **Embedding pipeline**: sqlite-vec installed + activated
8. **CLI commands**: `memory graph show/neighbors/add/remove`, `memory reason why/similar`, `memory search hybrid`, `memory decision find/store`, `memory link`

### Critical Gaps That Remain Open (Pending Tasks)

| Task | Title | Priority | Status |
|------|-------|---------|--------|
| T548 | T542-6: Full re-validation — independent agent proves PASS | critical | pending |
| T468 | Implement stale memory detection in brain.db | medium | pending |
| T475 | W3: memory domain lead (18 ops) | high | pending |
| T155 | Brain.db symbol indexing — optional code awareness | medium | pending |
| T053 | Transfer brain observations — optional memory migration | medium | pending |
| T548 | T542-6: Full re-validation of T523 work | critical | pending |

### The Spec Alignment Gap

ADR-009 Section 9.3 lists this as a required follow-up task: "BRAIN Spec update — Align CLEO-PORTABLE-PROJECT-BRAIN-SPEC.md storage references with ADR-006/ADR-009 hybrid model." Status: PENDING.

The spec (v3.1.0) describes some capabilities as shipped that were originally Phase 2/3 targets. Any Memory Architecture v2 design must treat the current shipped state of brain.db (post-T523) as the baseline, not the Phase maps in the spec which reflect the pre-T523 state.

---

## 9. References

- `/mnt/projects/cleocode/.cleo/adrs/ADR-006-canonical-sqlite-storage.md`
- `/mnt/projects/cleocode/.cleo/adrs/ADR-009-BRAIN-cognitive-architecture.md`
- `/mnt/projects/cleocode/.cleo/adrs/ADR-013-data-integrity-checkpoint-architecture.md`
- `/mnt/projects/cleocode/.cleo/adrs/ADR-021-memory-domain-refactor.md`
- `/mnt/projects/cleocode/.cleo/adrs/ADR-032-provider-agnostic-memory-bridge.md`
- `/mnt/projects/cleocode/.cleo/adrs/ADR-034-provider-agnostic-memory-bridge.md`
- `/mnt/projects/cleocode/.cleo/adrs/ADR-036-cleoos-database-topology.md`
- `/mnt/projects/cleocode/.cleo/adrs/ADR-011-project-configuration-architecture.md`
- `/mnt/projects/cleocode/docs/specs/CLEO-PORTABLE-PROJECT-BRAIN-SPEC.md` (v3.1.0)
- `/mnt/projects/cleocode/docs/architecture/erd-brain-db.md`
- `/mnt/projects/cleocode/docs/specs/DATABASE-ARCHITECTURE.md`
- `/mnt/projects/cleocode/.cleo/agent-outputs/T523-R1-brain-audit-report.md`
- `/mnt/projects/cleocode/.cleo/agent-outputs/T523-CA2-memory-sdk-spec.md`
- `/mnt/projects/cleocode/.cleo/agent-outputs/T475-memory-domain-audit.md`
