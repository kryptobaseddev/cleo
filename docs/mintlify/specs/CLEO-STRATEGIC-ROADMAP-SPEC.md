---
title: "CLEO Strategic Roadmap"
version: "1.3.0"
status: "stable"
created: "2026-02-03"
updated: "2026-02-16"
epic: "T2968"
authors: ["Claude Opus 4.5", "CLEO Development Team"]
---

> **Note**: This document is a supporting reference under `docs/specs/CLEO-CANONICAL-PLAN-SPEC.md`. For canonical strategic direction, see the Canonical Plan. This document provides detailed phase definitions, success criteria, risk assessment, and gate enforcement.

# CLEO Strategic Roadmap Specification

**Version**: 1.3.0
**Status**: STABLE
**Date**: 2026-02-09
**Epic**: T2968 - CLEO Strategic Inflection Point Review
**Specification Task**: T2973
**Revision Task**: T2998

---

## Canonical Consolidation Notice (2026-02-13, updated 2026-02-16)

This roadmap remains the detailed phase and evidence-gate reference, but canonical strategy and decision authority now live in:

- `docs/specs/CLEO-CANONICAL-PLAN-SPEC.md`

If wording in this roadmap differs from newer migration/architecture language, follow the canonical plan document. Historical context in this roadmap is intentionally preserved.

Reconciliation rule: the strategic branch logic in this roadmap (for example, simplification fallback and TypeScript expansion gating) is historical context after 2026-02-13. Active execution authority is the canonical parallel-tracks plan.

## Wave 2 Audit/Cleanup Progress (2026-02-16)

Wave 2 (T4540 epic) has completed audit and validation tasks that provide gate evidence for Phase 0-1 progression:

| Wave 2 Task                            | Status   | Key Finding                                                                       |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| T4557 -- Documentation Audit           | Complete | 1,778 doc files inventoried; 310 canonical, 915 agent outputs, 330 superseded     |
| T4565/T4566 -- Architecture Validation | Complete | CLI 100% shared-core compliant; MCP 0% (parallel engine); overall ~17% compliance |
| T4567 -- Bash Deprecation Plan         | Complete | All 79 scripts + 106 libs have TS equivalents; 50 of 76 CLI commands unregistered |
| T4558 -- Canonical Doc Update          | Complete | This update                                                                       |

**Gate evidence**: These findings establish that Phase 0 (Foundation) TypeScript work is ~75% complete. The remaining gaps are: (1) register 50 CLI commands, (2) unify MCP engine with `src/core/`, and (3) update 81 `.mdx` command docs for TS CLI. See `.cleo/agent-outputs/T4565-T4566-architecture-validation-report.md` and `.cleo/agent-outputs/T4557-documentation-audit-report.md` for full evidence.

## 1. Executive Summary

This specification defines CLEO's evolution from a Bash-based task manager (Tier S: solo developer, single project) to a cognitive infrastructure system (Tier M: 2-3 projects, cross-project intelligence) and beyond. The roadmap adopts an **evidence-first, incremental approach**: validate assumptions before expansion, fix implementation gaps before consolidation, and maintain agent-first design as core differentiator.

### 1.0 Authority and Scope

This roadmap is an execution and sequencing specification. Product identity is defined by higher-authority documents:

1. `docs/concepts/vision.md` (immutable vision identity)
2. `docs/specs/PORTABLE-BRAIN-SPEC.md` (canonical product contract)

This document MUST NOT redefine CLEO identity. It defines how implementation progresses from current state to target capabilities under evidence-gated phase control.

### 1.1 Vision Statement

**CLEO as BRAIN for AI Systems**

CLEO evolves from task management protocol to cognitive infrastructure, implementing the BRAIN model:

| Layer             | Capability                   | Current State                       | Target State                                |
| ----------------- | ---------------------------- | ----------------------------------- | ------------------------------------------- |
| **B**ase (Memory) | Task/session storage         | Tier S (single project)             | Tier M (2-3 projects, MCP interface)        |
| **R**easoning     | Graph-RAG semantic discovery | Local graph only                    | Global cross-project intelligence           |
| **A**gent         | Orchestrator + subagents     | Protocol enforcement, 9 protocols   | Agent registry, capability routing          |
| **I**ntelligence  | Validation + compliance      | Anti-hallucination, lifecycle gates | Pattern extraction, adaptive prioritization |
| **N**etwork       | Isolated projects            | Registry (v0.80.0, unvalidated)     | Tier M/L cross-project coordination         |

**From**: Task manager with anti-hallucination validation
**To**: Cognitive substrate for autonomous AI agent coordination

### 1.2 Design Principles

1. **Evidence > Speculation**: Validate usage before expanding features (Nexus, MCP)
2. **Fix Before Simplify**: Address implementation gaps (missing CLI wrappers) before consolidation
3. **Incremental Migration**: TypeScript via MCP server, expand only if proven
4. **Agent-First**: Protocol enforcement, RCASD lifecycle, anti-hallucination remain core
5. **Scale Tiers**: S (1 project) → M (2-3) → L (3-10) → XL (10-100+)

---

## 2. Current State (as of baseline assessment)

### 2.1 Architecture Overview

**Scale**: 163 files (96 lib + 67 scripts), 133,203 LOC, 1,425 functions
**Tier**: S (solo developer, single project)
**Complexity Hotspots**:

- sessions.sh (3,098 lines)
- migrate.sh (2,884 lines)
- orchestrator-startup.sh (2,138 lines)

**Strengths**:

- Atomic operations (zero data loss)
- 4-layer validation (schema → semantic → referential → protocol)
- Graph-RAG semantic discovery
- RCASD-IVTR lifecycle enforcement
- Exit code system (72 codes)

**Pain Points**:

- Implementation gaps (missing protocol CLI, Nexus CLI)
- Technical debt (1,111 TODO comments)
- Nexus premature complexity (5 files, zero usage data)
- 22% protocol enforcement (orphaned code)

### 2.2 Validated and Unvalidated Assets (Updated 2026-02-16)

| Asset                        | Status                                                        | Evidence                                         |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| **TypeScript CLI**           | ~75% ported; 76 commands exist, 50 unregistered               | T4567 bash deprecation analysis (2026-02-16)     |
| **Shared-Core Architecture** | CLI 100% compliant; MCP 0% (parallel engine)                  | T4565/T4566 architecture validation (2026-02-16) |
| **MCP Server**               | Shipped (native TypeScript engine, 164 ops across 10 domains) | Adoption metrics pending (Phase 1 validation)    |
| **SQLite Store**             | Complete (16 tables)                                          | `src/store/schema.ts` via Drizzle ORM            |
| **Nexus**                    | Shipped v0.80.0                                               | Zero real-world multi-project usage              |

---

## 3. Phase Definitions (RFC 2119)

### 3.1 Phase 0: Foundation (Months 1-2)

**Goal**: Fix implementation gaps + deliver MCP Server for LLM integration

#### 3.1.1 Architecture Validation Results (Research T2992-T2996)

**Research Finding**: Domain research (T2992-T2996) validated that CLEO's current architecture is **sound**. The original consolidation goals addressed symptoms (file count, orphaned code) rather than root causes (implementation gaps).

**Architecture Validation Summary**:

| Domain               | Research Task | Finding                                                  | Recommended Action                                       |
| -------------------- | ------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| **Command System**   | T2992         | NO duplicates, sound architecture                        | Relocate 5 dev scripts only (scripts/→dev/)              |
| **Protocol System**  | T2993, T2997  | ALL 9 protocols required (7 conditional + 2 enforcement) | Add missing CLI wrappers (consensus.sh, contribution.sh) |
| **Migration System** | T2994         | All 17 migrations production-required                    | Keep current organization, NO snapshotting               |
| **Graph-RAG/Nexus**  | T2995         | Three systems serve distinct purposes                    | Add missing Nexus CLI commands (query, discover, search) |
| **BRAIN Vision**     | T2996         | 4.2/5 alignment, missing learning infrastructure         | Add BRAIN Certification gate (Phase 3.5)                 |

**Revised Phase 0 Goal**: Fix **implementation gaps**, not consolidation.

#### 3.1.2 Implementation Gap Resolution (Epic 1)

The following gaps were identified by domain research and **MUST** be addressed:

| Gap                          | Research Source | Implementation                                                                    | Priority |
| ---------------------------- | --------------- | --------------------------------------------------------------------------------- | -------- |
| **Missing protocol CLI**     | T2993/T2997     | Add `src/cli/commands/consensus.ts`, `src/cli/commands/contribution.ts` (shipped) | High     |
| **Misplaced dev scripts**    | T2992           | Bash scripts removed; dev scripts in `dev/`                                       | Medium   |
| **Missing Nexus CLI**        | T2995           | Add `nexus query`, `nexus discover`, `nexus search`                               | High     |
| **Orphaned protocol code**   | T2997           | Connect 3250 LOC to CLI entry points                                              | High     |
| **22% protocol enforcement** | T2997           | CLI wrappers expose validation (target 40%)                                       | High     |

**Technical Debt** (Target: 1,111 TODO comments → <100)

The following cleanup **MUST** occur:

1. Convert actionable TODO comments to tracked tasks via `cleo add`
2. Remove completed TODOs (code review)
3. Archive orphaned code paths (unused functions)
4. Update stale documentation (last modified >1 year)

**Success Criteria** (Revised based on research):

| Metric                      | Original Target | Revised Target | Rationale                                              |
| --------------------------- | --------------- | -------------- | ------------------------------------------------------ |
| **File Count**              | 163 → 100       | 163 → ~160     | Only relocate 5 dev scripts (research T2992)           |
| **Protocol CLI**            | N/A             | +2 commands    | Add consensus.sh, contribution.sh (research T2997)     |
| **Nexus CLI**               | N/A             | +3 commands    | Add query, discover, search (research T2995)           |
| **Protocol Enforcement**    | N/A             | 22% → 40%      | Connect orphaned code to CLI wrappers (research T2997) |
| **TODO Comments**           | 1,111 → <100    | 1,111 → <100   | Unchanged                                              |
| **Test Pass Rate**          | 100%            | 100%           | Unchanged                                              |
| **Architecture Validation** | N/A             | Complete       | Research T2992-T2996 confirms sound design             |

#### 3.1.3 MCP Server Implementation (Epic 2)

##### Status Update (2026-02-16)

T4334 (MCP Server Native TypeScript Engine) completed and shipped as v0.91.0. Key outcomes:

- **Native TypeScript engine**: The MCP server now has a standalone native TypeScript engine that operates cross-platform without requiring the Bash CLI
- **164 canonical operations**: Core CLEO operations across 10 canonical domains (tasks, session, memory, check, pipeline, orchestrate, tools, admin, nexus, sharing) run natively in TypeScript
- **Cross-platform standalone mode**: The MCP server can operate independently on any platform with Node.js, removing the Bash/jq dependency for MCP consumers
- **MCP-first migration validated**: This delivery validates the incremental "MCP-first then hotspots" migration strategy as canonical doctrine. The MCP server provides the foundation for further TypeScript expansion, independent of the T2112 Bash stabilization gate

**Architecture validation finding (2026-02-16, T4565/T4566)**: The MCP engine has been unified with `src/core/` shared-core layer via the dispatch architecture (ADR-003, ADR-008). Both CLI and MCP delegate to `src/core/` through the CQRS dispatch layer at `src/dispatch/`. The legacy `mcp-server/` directory has been archived. See ADR-003 and ADR-008 for the canonical architecture.

**Architecture** (TypeScript + @modelcontextprotocol/sdk)

The MCP server implements the following two-tool CQRS gateway:

```
┌─────────────────────────────────────────────────────────┐
│ MCP Tools (2)                                            │
│   - cleo_query (93 read operations)                     │
│   - cleo_mutate (71 write operations)                   │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ Dispatch Layer — CQRS (10 canonical domains)            │
│   tasks | session | memory | check | pipeline           │
│   orchestrate | tools | admin | nexus | sharing         │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ Shared Core (src/core/)                                 │
│   All business logic — both CLI and MCP delegate here   │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ SQLite (Drizzle ORM) — 16 tables in tasks.db            │
└─────────────────────────────────────────────────────────┘
```

**Implementation Requirements** (RFC 2119)

The MCP server **MUST**:

1. Use TypeScript with @modelcontextprotocol/sdk SDK
2. Expose exactly 2 tools: `cleo_query` and `cleo_mutate`
3. Route operations to 8 domains (tasks, session, orchestrate, research, lifecycle, validate, release, system)
4. Call Bash CLI via `child_process.spawn()` (single source of truth for business logic)
5. Return structured JSON responses with error.fix suggestions
6. Support stdio transport for Claude Code integration
7. Implement background job management for long-running operations (epic decomposition, research)
8. Include protocol enforcement layer (exit codes 60-70)

The MCP server **SHOULD**:

1. Support StreamableHTTP transport for future remote access
2. Cache query results (TTL configurable, default 30s)
3. Include OpenTelemetry instrumentation for token tracking
4. Provide performance benchmarks (vs CLI, token savings)

The MCP server **MAY**:

1. Add agent registry endpoint (track spawned subagents)
2. Implement semantic context injection (research manifest integration)
3. Support batch operations (multiple mutations in single call)

**Token Reduction Target**:

- **Current**: 65 CLI commands in context (~32,500 tokens at 500 tokens/command)
- **Target**: 2 MCP tools (~1,800 tokens)
- **Reduction**: 94% token savings

**Success Criteria**:

- Token reduction: >90% (validated via real-world usage)
- Query response time: <3s for semantic search
- Background operations: Epic decomposition completes without timeout
- Error handling: 100% of errors include fix suggestions
- Adoption: 3+ developers using MCP over CLI within 60 days

**Timeline**: 2-3 months (3 epics)

1. **Epic 1: MCP Server Core** (3-4 weeks) - cleo_query/mutate, CLI adapter, error handling
2. **Epic 2: MCP Server Features** (2-3 weeks) - Background jobs, status tracking, agent registry
3. **Epic 3: Integration** (1-2 weeks) - Claude Desktop, Cursor, docs, benchmarks

### 3.2 Phase 1: Validation (Months 2-4)

**Goal**: Validate Nexus usage + MCP adoption + resolve strategic direction

**Critical Decision Gate**: At Phase 1 completion, CLEO **MUST** explicitly commit to either **BRAIN expansion** OR **simplification**. Both paths cannot coexist.

#### 3.2.1 Nexus Validation Gate

**Validation Criteria** (All MUST pass to proceed to Phase 2 Nexus expansion)

| Metric                       | Target                           | Measurement Period    | Data Source                   |
| ---------------------------- | -------------------------------- | --------------------- | ----------------------------- |
| **Active Users**             | ≥3 developers                    | 30 consecutive days   | Registry access logs          |
| **Multi-Project Usage**      | ≥2 projects per user             | 30 days               | Cross-project query frequency |
| **Time Savings**             | >30% context discovery reduction | Comparative benchmark | MCP query logs vs `cleo list` |
| **Feature Requests**         | ≥5 actionable requests           | 30 days               | User feedback, issue tracker  |
| **Cross-Project Operations** | >100 queries in 30 days          | 30 days               | `nexus query` command logs    |

**If Validation Succeeds** (All criteria met):

- Proceed to Phase 2 Nexus expansion (semantic search, PostgreSQL backend)
- Maintain 5-file structure
- Allocate development time for advanced features

**If Validation Fails** (Any criterion unmet):

- Consolidate Nexus (5 files → 1 file: `lib/nexus/nexus.sh`)
- Keep basic cross-project references only
- Defer advanced features to Phase 3+ (if ever)
- Archive Nexus spec to `archive/specs/CLEO-NEXUS-SPEC-v0.80.0.md`

**Validation Timeline**: 60 days from Phase 0 completion

#### 3.2.2 MCP Server Adoption Gate

**Validation Criteria** (All MUST pass to proceed to Phase 2 TypeScript expansion)

| Metric                 | Target                       | Measurement Period    | Data Source           |
| ---------------------- | ---------------------------- | --------------------- | --------------------- |
| **Developer Adoption** | ≥3 developers                | 60 days               | MCP server logs       |
| **Query Frequency**    | >500 queries/developer/month | 60 days               | Operation counts      |
| **Token Savings**      | >90% validated               | Comparative benchmark | Claude Code telemetry |
| **Performance**        | <3s query response           | Production load       | MCP server metrics    |
| **Error Rate**         | <5% operations fail          | 60 days               | Error logs            |

**If Validation Succeeds** (All criteria met):

- Proceed to Phase 2 TypeScript hotspot migration
- Expand MCP server features (semantic search integration, agent registry)
- Consider MCP as primary interface (CLI becomes maintenance mode)

**If Validation Fails** (Any criterion unmet):

- Keep MCP server operational but do NOT expand
- Abandon further TypeScript migration
- Focus on Bash CLI optimization instead
- Document lessons learned for future TypeScript attempts

**Validation Timeline**: 90 days from MCP server release

#### 3.2.3 Strategic Direction Decision Gate (NEW - from T2996)

**Context**: Research T2996 identified unresolved tension between competing visions:

- **Simplify**: Reduce complexity, maintain Tier S scope (solo developer, single project)
- **Expand**: Build BRAIN cognitive infrastructure, target Tier M/L scale

**Decision Criteria** (evaluated at Month 4):

| Criterion                | Threshold                             | Path                  |
| ------------------------ | ------------------------------------- | --------------------- |
| **Nexus validation**     | ALL criteria met                      | → BRAIN expansion     |
| **MCP adoption**         | ≥3 developers, >500 queries/dev/month | → BRAIN expansion     |
| **Community engagement** | >5 external contributions in 120 days | → BRAIN expansion     |
| **ANY criterion fails**  | Below threshold                       | → Simplification path |

**If BRAIN Expansion Path** (Month 4+):

1. Add Phase 2.5: Learning Infrastructure (pattern extraction, adaptive prioritization)
2. Add Phase 3.5: BRAIN Certification gate (5-dimension capability audit)
3. Commit to PostgreSQL backend (Phase 3)
4. Remove "archive Nexus" fallback
5. Full TypeScript hotspot migration (sessions, migrate, orchestrator)

**If Simplification Path** (Month 4+):

1. Archive Nexus spec to `archive/specs/CLEO-NEXUS-SPEC-v0.80.0.md`
2. Consolidate Nexus (5 files → 1 file, basic references only)
3. Abandon TypeScript expansion beyond MCP server
4. Focus on Bash CLI optimization
5. Explicitly scope as "Tier S task manager" (no Tier M/L claims)
6. Remove Phase 2-3 from roadmap

**This decision MUST be made explicitly** - "wait and see" is not an option after Phase 1 validation.

### 3.3 Phase 2: Intelligence (Months 4-9)

**Precondition**: Phase 1 validation MUST pass for both Nexus AND MCP Server

**Goal**: Add semantic intelligence capabilities for Tier M scale

#### 3.3.1 Semantic Search (Epic: SQLite-vec Integration)

**Requirements** (RFC 2119)

The semantic search system **MUST**:

1. Use SQLite-vec for vector embeddings (no external services)
2. Index task descriptions, titles, and labels
3. Support similarity search with threshold filtering
4. Maintain embedding cache (invalidate on task update)
5. Integrate with MCP `cleo_query` as new operation: `search.semantic`

The semantic search system **SHOULD**:

1. Pre-compute embeddings for all tasks at project initialization
2. Update embeddings incrementally (on task add/update)
3. Support multi-project semantic search (if Nexus validated)
4. Provide similarity scores in results (0.0-1.0)

The semantic search system **MAY**:

1. Support custom embedding models (configurable)
2. Include metadata filtering (status, labels, priority)
3. Implement query expansion (synonyms, related terms)

**Success Criteria**:

- Query response: <3s for 10,000 task corpus
- Relevance: >80% user satisfaction in blind tests
- Context discovery time: >30% reduction vs keyword search

**Timeline**: 4-6 weeks

#### 3.3.2 TypeScript Hotspot Migration (Epic: Sessions, Migrate, Orchestrator)

**Precondition**: MCP Server validation MUST succeed

**Migration Targets** (Prioritized by complexity)

| Hotspot                     | Current Lines | Rationale                             | Target API                        |
| --------------------------- | ------------- | ------------------------------------- | --------------------------------- |
| **sessions.sh**             | 3,098         | Complex state machine, 60+ functions  | TypeScript SessionManager class   |
| **migrate.sh**              | 2,884         | Schema evolution, version checks      | TypeScript MigrationEngine class  |
| **orchestrator-startup.sh** | 2,138         | Initialization sequence, token budget | TypeScript OrchestratorCore class |

**Migration Strategy** (RFC 2119)

For each hotspot, the migration **MUST**:

1. Create TypeScript equivalent module
2. Maintain 100% feature parity with Bash version
3. Add comprehensive unit tests (Jest)
4. Benchmark performance (must match or exceed Bash)
5. Implement FFI via JSON-RPC or CLI wrapper
6. Keep Bash version as fallback (delete only after 60-day bake period)

The migration **SHOULD**:

1. Use TypeScript strict mode
2. Add type definitions for all data structures
3. Include migration guide (Bash → TypeScript patterns)
4. Provide performance comparison documentation

**Success Criteria**:

- Feature parity: 100% (no regressions)
- Test coverage: ≥90% line coverage
- Performance: Match or exceed Bash (within 10%)
- Developer preference: >50% prefer TypeScript version (survey)
- Stability: <5% bug rate in 60-day bake period

**Timeline**: 8-12 weeks (3 hotspots in sequence)

**Rollback Trigger**: If any success criterion fails, halt migration and keep Bash version

#### 3.3.3 Research Indexing (Epic: SQLite Manifest Index)

**Requirements** (RFC 2119)

The research index **MUST**:

1. Create SQLite index of all research artifacts (MANIFEST.jsonl entries)
2. Support full-text search (FTS5)
3. Track cross-references (task links, epic links, file paths)
4. Invalidate cache on manifest append
5. Expose via MCP `cleo_query` operation: `research.find`

The research index **SHOULD**:

1. Support date range filtering
2. Include status filtering (complete, partial, blocked)
3. Provide relevance ranking
4. Cache query results (TTL 5 minutes)

**Success Criteria**:

- Query response: <500ms for 1,000 research entries
- Avoids re-reading MANIFEST.jsonl on every query
- Reduces orchestrator context loading time by >50%

**Timeline**: 2-3 weeks

### 3.4 Phase 2.5: Learning Infrastructure (NEW - from T2996)

**Precondition**: Phase 2 semantic search MUST be operational

**Goal**: Add pattern extraction and adaptive behavior for BRAIN Intelligence dimension

#### 3.4.1 Pattern Extraction Engine (Epic)

**Requirements** (RFC 2119)

The pattern extraction system **MUST**:

1. Analyze completed epics → extract common task sequences
2. Identify blocked tasks → correlate with labels/structure
3. Learn which task types block others → suggest priority adjustments
4. Summarize completed epics → distill key decisions

The pattern extraction system **SHOULD**:

1. Extract ≥10 actionable patterns from 50 completed epics
2. Store patterns in SQLite with metadata (confidence, frequency)
3. Provide pattern API via MCP `orchestrate.patterns` domain
4. Support pattern suggestions during epic planning

**Success Criteria**:

- Pattern extraction: ≥10 actionable patterns from 50 epics
- Blocker reduction: >20% via adaptive prioritization
- Epic summaries: Used in ≥50% of new epic planning
- Pattern relevance: >70% user satisfaction

**Timeline**: 4-6 weeks

**Components**:

1. Workflow Pattern Mining (4-6 weeks)
2. Anti-Pattern Detection (2-3 weeks)
3. Adaptive Prioritization (3-4 weeks)
4. Epic Consolidation (2-3 weeks)

### 3.5 Phase 3: Scale (Months 10-18)

**Precondition**: Phase 2 MUST validate TypeScript value AND demonstrate Tier M usage (5+ projects) AND Phase 1 decision = BRAIN expansion

**Goal**: Support Tier L scale (3-10 projects, 5-20 concurrent agents)

#### 3.5.1 Agent Coordination (Epic: Agent Registry + Capability Routing)

**Requirements** (RFC 2119)

The agent coordination system **MUST**:

1. Implement global agent registry (active agents, capabilities, task assignments)
2. Support capability-based routing (match tasks to agent skills)
3. Provide load balancing (max 5 tasks per agent)
4. Track agent health (heartbeat, timeout detection)
5. Expose via MCP `orchestrate` domain

The agent coordination system **SHOULD**:

1. Support agent priority levels (critical, normal, background)
2. Implement task queueing (FIFO per priority)
3. Provide agent performance metrics (completion rate, avg time)
4. Support agent pools (specialized groups)

**Success Criteria**:

- Support 5-20 concurrent agents
- Task routing latency: <100ms
- Agent utilization: >70% (not idle)
- Crash recovery: Reassign tasks from failed agents within 30s

**Timeline**: 6-8 weeks

#### 3.5.2 Cross-Project Intelligence (Epic: PostgreSQL Backend)

**Precondition**: Nexus validation MUST succeed + Tier L usage demonstrated

**Requirements** (RFC 2119)

The PostgreSQL backend **MUST**:

1. Migrate ~/.cleo/nexus.db (SQLite, per ADR-006) to PostgreSQL database
2. Support graph queries (dependencies, relationships, LCA)
3. Maintain JSON file compatibility (migration path)
4. Scale to 10+ projects, 10,000+ tasks
5. Provide SQL schema versioning (Flyway or similar)

The PostgreSQL backend **SHOULD**:

1. Support full-text search (PostgreSQL FTS)
2. Include vector similarity via pgvector extension
3. Provide query performance benchmarks vs JSON files
4. Support read replicas (future: distributed teams)

**Success Criteria**:

- Query performance: <1s for 10,000 task corpus
- Graph traversal: <500ms for 5-level dependency trees
- Concurrent access: Support 5+ simultaneous queries
- Migration: Zero data loss from JSON → PostgreSQL

**Timeline**: 8-12 weeks

### 3.6 Phase 3.5: BRAIN Certification (NEW - from T2996)

**Precondition**: Phase 3 complete AND all Tier L capabilities demonstrated

**Goal**: Validate CLEO achieves BRAIN model across all 5 dimensions before declaring "cognitive infrastructure" capability

#### 3.6.1 BRAIN Capability Audit

**Requirements** (RFC 2119)

Before declaring Tier L capability or "CLEO as BRAIN" status, the system **MUST** demonstrate:

| BRAIN Dimension   | Capability                                  | Validation Method      | Success Criteria                                            |
| ----------------- | ------------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| **Base (Memory)** | Multi-modal storage with semantic retrieval | Performance benchmark  | Query <3s for 10K tasks, vector search operational          |
| **Reasoning**     | Cross-project pattern detection             | Blind test on 50 epics | Identify similar tasks across 3 projects with >80% accuracy |
| **Agent**         | Autonomous multi-agent coordination         | Load test              | 5 subagents complete epic without HITL, <5% error rate      |
| **Intelligence**  | Learning from past interactions             | Historical analysis    | Extract ≥10 actionable patterns, suggest optimizations      |
| **Network**       | Cross-project intelligence sharing          | Multi-project usage    | Transfer learned patterns between projects, >70% relevance  |

**Additional Capabilities** (from T2996 gap analysis):

| Missing Capability        | Implementation                                    | Validation                                              |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| **Persistent Learning**   | Pattern extraction from completed work            | Workflow optimization based on 50+ completed epics      |
| **Causal Reasoning**      | Impact propagation ("changing X affects Y tasks") | Predict downstream effects with ±20% accuracy           |
| **Temporal Intelligence** | Historical timeline analysis (NOT estimates)      | "Similar epics took 2-3 weeks" context (no commitments) |
| **Memory Consolidation**  | Epic completion → summary artifact                | Distill 10 epics into reusable knowledge base           |

**Success Criteria**:

- ALL 5 BRAIN dimensions certified
- ALL 4 additional capabilities demonstrated
- Zero critical failures in 60-day production bake period
- > 50% user satisfaction with cognitive features (survey)

**If Certification Fails**:

- Document which dimensions failed
- Revert to "Tier M task manager with agent orchestration" (NOT "cognitive infrastructure")
- Create remediation epic for failed dimensions
- Re-attempt certification after fixes (3-6 month cycle)

**Timeline**: 4-6 weeks after Phase 3 completion

**Certification Approval**: HITL sign-off required before "CLEO v2.0: BRAIN" release

**Clarification: Temporal Intelligence vs Time Estimates** (from T2996)

**Keep**: "No time estimates **by humans or agents**" (prevents hallucination)
**Add**: "Historical timeline analysis **for context only**" (enables learning)

**Examples**:

- ❌ PROHIBITED: "This task will take 3 hours"
- ✅ ALLOWED: "Similar tasks historically took 2-4 days (median 3 days, 80% CI)"

**Rationale**: Temporal reasoning for **learning** is distinct from **estimation** for commitment.

---

## 4. Integration Strategy (Cognee Patterns)

### 4.1 Patterns to Adopt

**From Cognee Architecture Analysis (T2970)**

| Pattern                  | Cognee Implementation                           | CLEO Adaptation                                       | Phase         |
| ------------------------ | ----------------------------------------------- | ----------------------------------------------------- | ------------- |
| **Three-Tier Storage**   | Relational + Vector + Graph                     | JSON (Tier S) → SQLite (Tier M) → PostgreSQL (Tier L) | Phase 2-3     |
| **Pipeline Abstraction** | Task wrapper for sync/async                     | Skill execution wrapper with unified interface        | Phase 0 (MCP) |
| **MCP Architecture**     | @modelcontextprotocol/sdk with direct/API modes | MCP server with stdio/HTTP transports                 | Phase 0       |
| **Status Tracking**      | PipelineRunInfo for progress                    | Background job status (epic decomposition)            | Phase 0 (MCP) |
| **Config Validation**    | Pydantic BaseSettings                           | JSON Schema validation (already exists)               | Current       |

**Implementation Timeline**:

- **Phase 0**: MCP architecture, pipeline abstraction (background jobs)
- **Phase 2**: SQLite-vec for semantic search (three-tier storage Tier M)
- **Phase 3**: PostgreSQL backend (three-tier storage Tier L)

### 4.2 Patterns to Avoid

**Deferred to Tier XL (10-100+ projects) or Never**

| Pattern                  | Cognee Use Case                     | CLEO Rationale for Avoidance                             |
| ------------------------ | ----------------------------------- | -------------------------------------------------------- |
| **Graph Database**       | Neo4j for complex relationships     | Premature optimization; SQLite sufficient for Tier M/L   |
| **LLM Dependency**       | Embedding generation, summarization | Keep core operations deterministic; optional for Tier XL |
| **Configuration Sprawl** | ~30 environment variables           | CLEO uses `.cleo/config.json` (single source of truth)   |
| **Real-Time Sync**       | WebSocket/SSE for updates           | Solo developer focus; on-demand sync sufficient          |

### 4.3 CLEO-Distinct Patterns (Preserve)

**Agent-First Design**

The following patterns are **unique to CLEO** and **MUST** be preserved:

1. **Protocol Enforcement** (RCASD-IVTR lifecycle)
   - Exit codes 60-70 for violations
   - Gate checks at spawn time
   - Lifecycle enforcement modes (strict/advisory/off)

2. **Anti-Hallucination Validation** (4-layer system)
   - Schema → Semantic → Referential → Protocol
   - Prevents invalid state creation by agents
   - Error messages with fix suggestions

3. **Atomic Operations** (Zero data loss)
   - Temp file → Validate → Backup → Rename
   - Lock files for concurrent access
   - Backup rotation (operational + recovery tiers)

4. **Task Hierarchy Constraints** (Max depth 3, configurable siblings with default unlimited)
   - Prevents infinite expansion
   - Clear epic → task → subtask structure
   - Sibling limit enforces decomposition quality

5. **Exit Code System** (72 standardized codes)
   - Machine-parseable errors
   - Structured JSON responses
   - Alternative actions for self-service fixes

**These patterns differentiate CLEO from generic task managers** and support autonomous agent operation without human oversight.

---

## 5. Migration Path (Bash → TypeScript)

### 5.1 Incremental Strategy

**Guiding Principle**: Validate TypeScript value before expanding beyond MCP server

```
Phase 0: TypeScript MCP Server (Months 1-3)
    ↓
  GATE: Adoption validation (3+ developers, 60 days)
    ↓
Phase 2: TypeScript Hotspots (Months 4-9)
    ↓
  GATE: Performance + stability validation (60-day bake)
    ↓
Phase 3: Expand or Stabilize (Months 10-18)
    ↓
  Decision: Continue migration OR maintain hybrid
```

### 5.2 Hybrid Architecture (During Migration)

**Layer Separation**

The hybrid architecture **MUST** maintain clear boundaries:

| Layer                 | Technology                                                  | Justification                                       |
| --------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| **MCP Server**        | TypeScript                                                  | Node.js required for MCP, structured JSON responses |
| **Complex Logic**     | TypeScript (sessions, migrate, orchestrator)                | State machines, version checks benefit from types   |
| **Simple Operations** | Bash (file-ops, validation, CLI wrappers)                   | Proven, tested, no benefit from rewrite             |
| **Data Layer**        | JSON files (Tier S) → SQLite (Tier M) → PostgreSQL (Tier L) | Storage evolution path                              |

**FFI Strategy** (Bash ↔ TypeScript)

Communication **MUST** occur via one of:

1. **JSON-RPC**: TypeScript exposes JSON-RPC server, Bash calls via curl/netcat
2. **CLI Wrapper**: TypeScript functions callable via CLI (e.g., `cleo-ts migrate check`)
3. **Child Process**: TypeScript spawns Bash scripts, captures stdout JSON

**Trade-offs**:

- JSON-RPC: Low latency, complex setup
- CLI Wrapper: Simple, higher latency (~50ms per call)
- Child Process: Existing pattern, TypeScript controls Bash (not reverse)

**Recommended**: CLI Wrapper for Bash→TypeScript, Child Process for TypeScript→Bash

### 5.3 Full TypeScript Option (Conditional)

**Trigger**: If Phase 2 validation succeeds AND developer preference >70% TypeScript

**Scope** (133,203 LOC total):

- Phase 1: MCP Server (new code, ~5K LOC)
- Phase 2: Hotspots (sessions, migrate, orchestrator: ~8K LOC)
- Phase 3+: Bash lib/ and scripts/ fully removed (TypeScript migration complete)

**Timeline**: 12-24 months for full migration

**Risk**: High regression risk, test suite rewrite (262 BATS files → Jest)

**Rollback Path**: Maintain Bash version in parallel, delete only after 6-month bake period

**Decision Point**: Month 12 (end of Phase 2)

---

## 6. Success Criteria

### 6.1 Phase 0 Success (Implementation Gaps + MCP)

**Quantitative Metrics** (REVISED based on research)

| Metric                    | Baseline      | Target        | Measurement                                 |
| ------------------------- | ------------- | ------------- | ------------------------------------------- |
| **File Count**            | 163 files     | ~160 files    | File system audit (5 dev scripts relocated) |
| **Protocol CLI Commands** | 7 commands    | 9 commands    | Add consensus.sh, contribution.sh           |
| **Nexus CLI Commands**    | 2 commands    | 5 commands    | Add query, discover, search                 |
| **Protocol Enforcement**  | 22%           | 40%           | Connect orphaned code to CLI                |
| **TODO Comments**         | 1,111         | <100          | `grep -r TODO`                              |
| **MCP Token Reduction**   | 32,500 tokens | <3,500 tokens | MCP tool definitions                        |
| **Test Pass Rate**        | 100%          | 100%          | BATS test suite                             |

**Qualitative Criteria**

The following **MUST** be validated by code review:

1. Protocol CLI wrappers expose validation (consensus, contribution)
2. Nexus commands functional (query, discover, search)
3. MCP server passes all integration tests (Claude Code, Cursor)
4. No breaking changes for existing CLI users
5. Documentation updated (CLAUDE.md, specs/, guides/)

**Timeline**: End of Month 2

### 6.2 Phase 1 Success (Validation)

**Nexus Validation**

All of the following **MUST** be true:

- [ ] 3+ developers using Nexus across 2+ projects for 30+ consecutive days
- [ ] > 100 cross-project queries in 30-day period
- [ ] > 30% context discovery time savings (validated benchmark)
- [ ] 5+ actionable feature requests from users
- [ ] Zero critical bugs reported

**MCP Server Validation**

All of the following **MUST** be true:

- [ ] 3+ developers using MCP server for 60+ consecutive days
- [ ] > 500 queries per developer per month
- [ ] > 90% token savings validated via telemetry
- [ ] <3s query response time (p95)
- [ ] <5% error rate

**Strategic Direction Decision**

The following **MUST** be decided explicitly (no "wait and see"):

- [ ] IF all gates pass → commit to BRAIN expansion (add Phase 2.5, 3.5)
- [ ] IF any gate fails → commit to simplification (archive specs, CLI-only)

**Timeline**: End of Month 4

### 6.3 Phase 2 Success (Intelligence)

**Semantic Search**

All of the following **MUST** be validated:

- [ ] Query response <3s for 10,000 task corpus
- [ ] > 80% relevance (user satisfaction survey)
- [ ] > 30% context discovery time reduction vs keyword search
- [ ] Integration with MCP `cleo_query` complete
- [ ] Zero data loss during embedding updates

**TypeScript Hotspot Migration**

All of the following **MUST** be true for EACH migrated hotspot:

- [ ] 100% feature parity (no regressions)
- [ ] ≥90% test coverage (Jest)
- [ ] Performance matches or exceeds Bash (within 10%)
- [ ] <5% bug rate in 60-day bake period
- [ ] > 50% developer preference (survey)

**Timeline**: End of Month 9

### 6.4 Phase 2.5 Success (Learning Infrastructure)

**Pattern Extraction**

All of the following **MUST** be validated:

- [ ] ≥10 actionable patterns extracted from 50 completed epics
- [ ] Patterns stored in SQLite with metadata
- [ ] Pattern API exposed via MCP `orchestrate.patterns`
- [ ] Blocker reduction >20% via adaptive prioritization
- [ ] Epic summaries used in ≥50% of new epic planning
- [ ] > 70% user satisfaction with pattern relevance

**Timeline**: End of Month 11

### 6.5 Phase 3 Success (Scale)

**Agent Coordination**

All of the following **MUST** be validated:

- [ ] Support 5-20 concurrent agents (load test)
- [ ] Task routing latency <100ms
- [ ] > 70% agent utilization
- [ ] Crash recovery within 30s
- [ ] Zero task loss during agent failures

**Cross-Project Intelligence (PostgreSQL)**

All of the following **MUST** be true:

- [ ] Query performance <1s for 10,000 task corpus
- [ ] Graph traversal <500ms for 5-level trees
- [ ] 5+ concurrent queries supported
- [ ] Zero data loss during migration from JSON
- [ ] Rollback path tested and documented

**Timeline**: End of Month 18

### 6.6 Phase 3.5 Success (BRAIN Certification)

**BRAIN Dimensions**

All 5 dimensions **MUST** be certified:

- [ ] **Base (Memory)**: Query <3s for 10K tasks, vector search operational
- [ ] **Reasoning**: Identify similar tasks across 3 projects with >80% accuracy
- [ ] **Agent**: 5 subagents complete epic without HITL, <5% error rate
- [ ] **Intelligence**: Extract ≥10 actionable patterns, suggest optimizations
- [ ] **Network**: Transfer learned patterns between projects, >70% relevance

**Additional Capabilities**

All 4 capabilities **MUST** be demonstrated:

- [ ] **Persistent Learning**: Workflow optimization based on 50+ epics
- [ ] **Causal Reasoning**: Predict downstream effects with ±20% accuracy
- [ ] **Temporal Intelligence**: Historical analysis (no commitments)
- [ ] **Memory Consolidation**: Distill 10 epics into knowledge base

**Final Criteria**:

- [ ] Zero critical failures in 60-day production bake period
- [ ] > 50% user satisfaction with cognitive features (survey)
- [ ] HITL sign-off before "CLEO v2.0: BRAIN" release

**Timeline**: End of Month 19-20

---

## 7. Risk Assessment

### 7.1 High-Risk Decisions

| Decision                    | Risk                                                                             | Mitigation                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **MCP Server (TypeScript)** | New runtime (Node.js), unproven adoption, maintenance burden                     | Incremental: Core → Features → Integration. Rollback to CLI if unused after 90 days.                           |
| **TypeScript Migration**    | Regression bugs, test suite rewrite (262 BATS → Jest), performance degradation   | Incremental: MCP only → hotspots → expand. Keep Bash as fallback. 60-day bake periods.                         |
| **Nexus Expansion**         | Unvalidated feature (zero usage data), premature scaling, maintenance cost       | Gate expansion on 30-day validation. Consolidate to single file if criteria unmet.                             |
| **Storage Evolution**       | SQLite → PostgreSQL migration complexity, data loss risk, performance regression | JSON compatibility maintained. Migration tested with 10K+ task corpus. Rollback to SQLite if PostgreSQL fails. |

### 7.2 Medium-Risk Decisions

| Decision                      | Risk                                                                       | Mitigation                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Implementation Gaps First** | Delays consolidation (163 files remain), increases maintenance             | Gaps are foundational - fix before consolidation or gaps persist in consolidated code.        |
| **Cognee Patterns**           | Over-engineering (graph DB, vector search), complexity creep               | Adopt proven patterns only. Defer speculative features (graph DB to Tier XL).                 |
| **Hybrid Bash/TypeScript**    | Maintenance burden (two languages), FFI complexity, debugging difficulty   | Clear layer separation. Use CLI wrappers (simple FFI). Maintain hybrid only during migration. |
| **Semantic Search**           | Relevance tuning difficulty, embedding maintenance cost, query performance | Use battle-tested SQLite-vec. Validate with 80% user satisfaction threshold.                  |

### 7.3 Low-Risk Decisions

| Decision                  | Risk                                       | Mitigation                                                                   |
| ------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| **Dev Script Relocation** | Temporary confusion about script locations | Clear migration guide. Update imports systematically. Document in CLAUDE.md. |
| **Protocol CLI Addition** | Increased command surface area             | Commands wrap existing lib functions. No new logic. Test coverage required.  |
| **TODO Cleanup**          | Missed TODOs become lost work              | Convert to tracked tasks before deletion. Code review required.              |

### 7.4 Rollback Triggers

**Automatic Rollback** (no human intervention):

- Test pass rate drops below 95%
- Critical data loss bug (Severity: Critical)
- Performance regression >50% (validated benchmark)

**Manual Rollback** (human decision required):

- Nexus validation fails (any criterion unmet)
- MCP adoption <3 developers after 90 days
- TypeScript hotspot migration fails success criteria
- Developer preference survey shows >70% prefer Bash

**Rollback Procedure** (RFC 2119)

For any feature rollback, the following **MUST** occur:

1. Create rollback task epic (track all revert tasks)
2. Restore Bash version from backup (atomic operation)
3. Archive TypeScript code to `archive/typescript-migration-YYYY-MM-DD/`
4. Update documentation (CLAUDE.md, specs/)
5. Notify users via CHANGELOG.md
6. Post-mortem analysis (what failed, why, lessons learned)
7. Update roadmap (defer or cancel failed approach)

---

## 8. Decision Gates (Phase Progression)

### 8.1 Gate Structure

Each phase **MUST** pass validation gate before proceeding:

```
Phase 0: Foundation
    ↓
GATE 1: Implementation Gaps Fixed + MCP Server Complete
    ├─ All Phase 0 success criteria met?
    ├─ Test pass rate 100%?
    └─ Zero critical bugs?
    ↓
Phase 1: Validation (60-90 days)
    ↓
GATE 2: Nexus + MCP Adoption Validated + Strategic Direction Decided
    ├─ Nexus validation criteria met?
    ├─ MCP validation criteria met?
    ├─ Strategic direction decision made (BRAIN vs Simplification)?
    └─ Performance benchmarks pass?
    ↓
Phase 2: Intelligence
    ↓
GATE 3: TypeScript Value Demonstrated
    ├─ Semantic search meets criteria?
    ├─ TypeScript hotspots validated?
    └─ Developer preference >50% TypeScript?
    ↓
Phase 2.5: Learning Infrastructure
    ↓
GATE 4: Pattern Extraction Validated
    ├─ ≥10 actionable patterns extracted?
    ├─ Blocker reduction >20%?
    └─ Epic summaries used ≥50%?
    ↓
Phase 3: Scale
    ↓
GATE 5: BRAIN Certification
    ├─ All 5 BRAIN dimensions certified?
    ├─ All 4 additional capabilities demonstrated?
    └─ HITL sign-off granted?
```

### 8.2 Gate Enforcement (RFC 2119)

**Strict Mode** (Default)

Phase progression **MUST NOT** occur unless:

1. All quantitative metrics meet targets
2. All qualitative criteria validated by code review
3. Zero critical bugs in current phase
4. HITL approval granted (human-in-the-loop sign-off)

**Advisory Mode** (Optional)

Phase progression **MAY** occur if:

1. 80%+ of quantitative metrics meet targets
2. All qualitative criteria validated
3. <3 critical bugs with mitigation plans
4. HITL acknowledges risks

**Off Mode** (Emergency Only)

Phase progression **MAY** occur without validation if:

1. Critical production issue requires immediate feature
2. Technical debt blocks all development
3. HITL explicitly overrides gate

**Emergency Bypass** (Temporary)

To temporarily disable gate enforcement:

```bash
# Set advisory mode (warn but proceed)
jq '.lifecycleEnforcement.mode = "advisory"' .cleo/config.json > tmp && mv tmp .cleo/config.json

# OR set off mode (skip all checks)
jq '.lifecycleEnforcement.mode = "off"' .cleo/config.json > tmp && mv tmp .cleo/config.json

# REMEMBER: Restore strict mode after emergency
jq '.lifecycleEnforcement.mode = "strict"' .cleo/config.json > tmp && mv tmp .cleo/config.json
```

### 8.3 Gate Failure Handling

**If Gate Fails** (Any criterion unmet)

The following **MUST** occur:

1. **Stop Phase Progression**: Do NOT start next phase work
2. **Root Cause Analysis**: Document why gate failed (task, findings)
3. **Mitigation Plan**: Create tasks to address failures
4. **Revalidation**: Re-run gate check after fixes
5. **Lessons Learned**: Update roadmap with insights

**If Gate Fails Repeatedly** (3+ times)

The following **MUST** be considered:

1. **Defer Phase**: Move phase to future (6-12 months)
2. **Cancel Phase**: Abandon approach, document rationale
3. **Pivot Strategy**: Change approach (e.g., Bash optimization instead of TypeScript)
4. **Scope Reduction**: Remove features to meet criteria

**Gate Failure Exit Code**: 75 (E_LIFECYCLE_GATE_FAILED)

---

## 9. Timeline Summary

### 9.1 Gantt Chart (ASCII)

```
Month:    1    2    3    4    5    6    7    8    9   10   11   12   13   14   15   16   17   18   19   20
          ─────────────────────────────────────────────────────────────────────────────────────────────────
Phase 0:  ████████
          │      │
          │      └─► GATE 1: Implementation Gaps + MCP Complete
          │
          ├─ Protocol CLI (consensus, contribution)
          ├─ Nexus CLI (query, discover, search)
          ├─ Dev Script Relocation
          └─ MCP Server Core/Features/Integration

Phase 1:        ████████
                │      │
                │      └─► GATE 2: Nexus + MCP Validation + Strategic Decision
                │
                ├─ Nexus Usage Tracking
                ├─ MCP Adoption Metrics
                └─ BRAIN vs Simplification Decision

Phase 2:                ████████████████████
                        │                  │
                        │                  └─► GATE 3: TypeScript Value Demonstrated
                        │
                        ├─ Semantic Search (SQLite-vec)
                        ├─ TypeScript Hotspot Migration (sessions, migrate, orchestrator)
                        └─ Research Indexing

Phase 2.5:                                  ████████
                                            │      │
                                            │      └─► GATE 4: Pattern Extraction Validated
                                            │
                                            ├─ Workflow Pattern Mining
                                            ├─ Anti-Pattern Detection
                                            ├─ Adaptive Prioritization
                                            └─ Epic Consolidation

Phase 3:                                            ████████████████████████
                                                    │                      │
                                                    │                      └─► Tier L Validated
                                                    │
                                                    ├─ Agent Coordination
                                                    └─ PostgreSQL Backend (if Nexus validated)

Phase 3.5:                                                                    ████
                                                                              │  │
                                                                              │  └─► BRAIN Certified
                                                                              │
                                                                              └─ BRAIN Capability Audit
```

### 9.2 Milestone Dates (Estimated)

| Milestone                        | Month | Description                                              |
| -------------------------------- | ----- | -------------------------------------------------------- |
| **Phase 0 Start**                | 1     | Implementation gaps + MCP server development begins      |
| **GATE 1**                       | 2     | Protocol CLI + Nexus CLI + MCP server core complete      |
| **MCP Server Release**           | 3     | MCP server v1.0.0 shipped to production                  |
| **Phase 1 Start**                | 3     | Validation period begins (60-90 days)                    |
| **GATE 2**                       | 4     | Nexus + MCP validation results + strategic decision      |
| **Phase 2 Start**                | 4     | Semantic search + TypeScript hotspots (if Gate 2 passes) |
| **Semantic Search Release**      | 6     | SQLite-vec integration complete                          |
| **TypeScript Hotspots Complete** | 9     | Sessions, migrate, orchestrator migrated                 |
| **GATE 3**                       | 9     | TypeScript value validation                              |
| **Phase 2.5 Start**              | 10    | Learning infrastructure (if BRAIN expansion)             |
| **Pattern Extraction Complete**  | 11    | Workflow mining, adaptive prioritization operational     |
| **GATE 4**                       | 11    | Pattern extraction validation                            |
| **Phase 3 Start**                | 12    | Agent coordination + PostgreSQL (if Gate 4 passes)       |
| **Agent Registry Release**       | 14    | Agent coordination operational                           |
| **PostgreSQL Backend Release**   | 18    | Tier L scale capability complete                         |
| **Phase 3.5 Start**              | 19    | BRAIN Certification audit begins                         |
| **BRAIN Certification**          | 20    | CLEO v2.0: BRAIN certified and released                  |

### 9.3 Critical Path

**Sequential Dependencies** (Cannot parallelize):

```
Implementation Gaps → MCP Server Implementation → Gate 1
    ↓
Nexus Validation (60 days) + MCP Validation (90 days) → Strategic Decision → Gate 2
    ↓
TypeScript Hotspot Migration (sessions → migrate → orchestrator) → Gate 3
    ↓
Pattern Extraction → Gate 4
    ↓
Agent Coordination → PostgreSQL Backend → Gate 5
    ↓
BRAIN Certification
```

**Parallel Opportunities**:

- Protocol CLI || Nexus CLI (Phase 0, Months 1-2)
- Semantic Search || TypeScript Hotspot Migration (Phase 2, Months 4-9)
- Research Indexing || Pattern Extraction (Months 9-11)

---

## 10. References

### 10.1 Strategic Foundation

- **T2968**: EPIC: CLEO Strategic Inflection Point Review
- **T2969**: Research: CLEO Current State Assessment (v0.80.0 analysis)
- **T2970**: Research: Cognee Architecture Analysis (pattern analysis)
- **T2971**: Research: BRAIN Vision Requirements (scale tiers, capability gaps) _(archived — pre-SQLite migration)_
- **T2972**: Consensus: Strategic Direction (voting matrix, confidence scores)

### 10.2 Domain Research (Phase 0 Validation)

- **T2992**: Research: Command Architecture Analysis (sound design, 5 scripts to relocate)
- **T2993**: Research: Protocol Coverage Gap Analysis (preliminary, superseded by T2997)
- **T2994**: Research: Migration System Analysis (17 production-required, no consolidation)
- **T2995**: Research: Graph-RAG/Nexus Unified Architecture (3 systems, distinct purposes)
- **T2996**: Research: BRAIN Vision Alignment (4.2/5 alignment, missing learning layer)
- **T2997**: Research: Protocol Architecture Validation (9 protocols correct, fix gaps not consolidate)

### 10.3 Existing Specifications

- **docs/specs/PORTABLE-BRAIN-SPEC.md**: Canonical product identity and invariants
- **docs/specs/MCP-SERVER-SPECIFICATION.md**: Two-tool CQRS gateway (39KB)
- **docs/specs/CLEO-NEXUS-SPEC.md**: Cross-project intelligence (43KB)
- **docs/specs/PROJECT-LIFECYCLE-SPEC.md**: RCASD-IVTR pipeline
- **docs/specs/PROTOCOL-STACK-SPEC.md**: Base + conditional protocols

### 10.4 Architecture Documentation

- **CLAUDE.md**: Core repository guidelines
- **.cleo/templates/CLEO-INJECTION.md**: Subagent architecture (v1.0.0)
- **docs/concepts/vision.md**: CLEO vision statement
- **docs/specs/PORTABLE-BRAIN-SPEC.md**: Canonical portable brain product contract
- **docs/guides/protocol-enforcement.md**: Protocol validation guide

### 10.5 Current State Artifacts

- **CHANGELOG.md**: v0.80.0 (Nexus release, 2026-01-26)
- **VERSION**: 0.80.0
- **lib/**: 96 library modules, 69,276 LOC
- **src/cli/commands/**: ~86 TypeScript CLI commands
- **tests/**: 262 BATS test files, 100,421 LOC

### 10.6 External References

- **Cognee**: Three-tier storage, MCP architecture, pipeline abstraction
- **@modelcontextprotocol/sdk**: TypeScript MCP server SDK
- **SQLite-vec**: Vector similarity extension for SQLite
- **PostgreSQL**: Target database for Tier L scale
- **pgvector**: Vector similarity extension for PostgreSQL

---

## 11. Appendices

### Appendix A: Scale Tier Definitions

| Tier   | Projects | Agents                     | Features                                       | Storage        |
| ------ | -------- | -------------------------- | ---------------------------------------------- | -------------- |
| **S**  | 1        | 1 orchestrator + subagents | Task management, sessions, Graph-RAG           | JSON files     |
| **M**  | 2-3      | 2-5 concurrent             | Nexus registry, MCP interface, semantic search | SQLite         |
| **L**  | 3-10     | 5-20 concurrent            | Agent coordination, cross-project intelligence | PostgreSQL     |
| **XL** | 10-100+  | 20-100+ concurrent         | Distributed agents, real-time sync, graph DB   | Distributed DB |

**Current State**: Tier S (fully mature)
**Phase 0-1 Target**: Tier S → M foundation
**Phase 2-3 Target**: Tier M → L capability

### Appendix B: Technology Stack Evolution

| Layer              | Phase 0 (Current)     | Phase 1 (Target)                 | Phase 2+ (Future)                        |
| ------------------ | --------------------- | -------------------------------- | ---------------------------------------- |
| **Interface**      | Bash CLI              | MCP Server (TypeScript) + CLI    | MCP primary, CLI maintenance             |
| **Business Logic** | Bash (lib/)           | Bash + TypeScript hotspots       | TypeScript majority, Bash for simple ops |
| **Storage**        | JSON files            | JSON + SQLite (semantic search)  | SQLite/PostgreSQL hybrid                 |
| **Graph**          | graph-cache.sh (JSON) | SQLite-vec (embeddings)          | PostgreSQL + pgvector                    |
| **Testing**        | BATS                  | BATS + Jest (TypeScript modules) | Jest primary, BATS for CLI               |
| **Validation**     | JSON Schema + custom  | Same + MCP gateway validation    | Same                                     |

### Appendix C: Key Metrics Dashboard

**Phase 0 Targets** (REVISED):

- Files: 163 → ~160 (5 dev scripts relocated)
- Protocol CLI: 7 → 9 commands (add consensus, contribution)
- Nexus CLI: 2 → 5 commands (add query, discover, search)
- Protocol enforcement: 22% → 40%
- MCP tokens: 32,500 → <3,500 (>90% reduction)
- TODO comments: 1,111 → <100

**Phase 1 Targets**:

- Nexus users: ≥3 developers, 30+ days
- MCP queries: >500/developer/month
- Token savings: >90% validated
- Error rate: <5%
- Strategic decision: BRAIN vs Simplification (explicit)

**Phase 2 Targets**:

- Semantic search: <3s query, >80% relevance
- TypeScript hotspots: 100% parity, ≥90% coverage
- Research index: <500ms query
- Test coverage: ≥90%

**Phase 2.5 Targets** (NEW):

- Pattern extraction: ≥10 patterns from 50 epics
- Blocker reduction: >20%
- Epic summaries: ≥50% adoption
- Pattern relevance: >70% satisfaction

**Phase 3 Targets**:

- Agents: 5-20 concurrent support
- Routing latency: <100ms
- PostgreSQL: <1s queries, 10K+ tasks
- Agent utilization: >70%

**Phase 3.5 Targets** (NEW):

- BRAIN dimensions: 5/5 certified
- Additional capabilities: 4/4 demonstrated
- Production stability: 60-day bake, zero critical bugs
- User satisfaction: >50%

---

**Specification Status**: STABLE
**Last Updated**: 2026-02-16
**Version**: 1.3.0

**Changes from v1.2.0** (2026-02-16, T4558):

1. Added Wave 2 audit/cleanup progress section with gate evidence from T4557, T4565/T4566, T4567
2. Updated Unvalidated Assets table to reflect architecture validation and bash deprecation findings
3. Added architecture validation finding to MCP Server status (parallel engine discovery)
4. Incorporated documentation audit inventory (1,778 files) as supporting evidence

**Reconciliation Update (2026-02-13)**:

1. Added canonical consolidation notice and conflict-resolution pointer to `docs/specs/CLEO-CANONICAL-PLAN-SPEC.md`
2. Clarified that strategic branch fallback language is preserved as historical context after parallel-tracks activation

**Changes from v1.1.0**:

1. MCP Server status updated: v0.91.0 shipped with native TypeScript engine (T4334)
2. Unvalidated Assets table updated to reflect MCP implementation and TS migration validation
3. T2742 research (folder structure/memory-trees) completed and indexed in MANIFEST

**Changes from v1.0.0**:

1. Phase 0 revised: Implementation gaps, not consolidation (based on T2992-T2996)
2. Success criteria updated: Protocol CLI +2, Nexus CLI +3, enforcement 22%→40%
3. Added Phase 2.5: Learning Infrastructure (from T2996 gap analysis)
4. Added Phase 3.5: BRAIN Certification (from T2996 recommendation)
5. Added Strategic Direction Decision Gate at Phase 1 (from T2996)
6. Clarified temporal intelligence vs time estimates (from T2996)
7. 9 protocols confirmed as correct architecture (from T2997)
8. Migration system organization validated (from T2994)
9. Graph-RAG/Nexus distinct purposes confirmed (from T2995)

**Approval**: Pending HITL review
**Next Review**: End of Phase 0 (Month 2)
