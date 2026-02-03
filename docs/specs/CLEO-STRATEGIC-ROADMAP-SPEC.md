---
title: "CLEO Strategic Roadmap"
version: "1.0.0"
status: "stable"
created: "2026-02-03"
epic: "T2968"
authors: ["Claude Opus 4.5", "CLEO Development Team"]
---

# CLEO Strategic Roadmap Specification

**Version**: 1.0.0
**Status**: STABLE
**Date**: 2026-02-03
**Epic**: T2968 - CLEO Strategic Inflection Point Review
**Specification Task**: T2973

---

## 1. Executive Summary

This specification defines CLEO's evolution from a Bash-based task manager (Tier S: solo developer, single project) to a cognitive infrastructure system (Tier M: 2-3 projects, cross-project intelligence) and beyond. The roadmap adopts an **evidence-first, incremental approach**: validate assumptions before expansion, simplify before extending, and maintain agent-first design as core differentiator.

### 1.1 Vision Statement

**CLEO as BRAIN for AI Systems**

CLEO evolves from task management protocol to cognitive infrastructure, implementing the BRAIN model:

| Layer | Capability | Current State | Target State |
|-------|-----------|---------------|--------------|
| **B**ase (Memory) | Task/session storage | Tier S (single project) | Tier M (2-3 projects, MCP interface) |
| **R**easoning | Graph-RAG semantic discovery | Local graph only | Global cross-project intelligence |
| **A**gent | Orchestrator + subagents | Protocol enforcement, 7 protocols | Agent registry, capability routing |
| **I**ntelligence | Validation + compliance | Anti-hallucination, lifecycle gates | Semantic search, pattern extraction |
| **N**etwork | Isolated projects | Registry (v0.80.0, unvalidated) | Tier M/L cross-project coordination |

**From**: Task manager with anti-hallucination validation
**To**: Cognitive substrate for autonomous AI agent coordination

### 1.2 Design Principles

1. **Evidence > Speculation**: Validate usage before expanding features (Nexus, MCP)
2. **Simplify First**: Reduce 163 files before adding complexity
3. **Incremental Migration**: TypeScript via MCP server, expand only if proven
4. **Agent-First**: Protocol enforcement, RCSD lifecycle, anti-hallucination remain core
5. **Scale Tiers**: S (1 project) → M (2-3) → L (3-10) → XL (10-100+)

---

## 2. Current State (v0.80.0)

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
- RCSD-IVTR lifecycle enforcement
- Exit code system (72 codes)

**Pain Points**:
- File sprawl (96 library modules)
- Migration accumulation (85+ functions)
- Session complexity (60+ functions in single file)
- Technical debt (1,111 TODO comments)
- Nexus premature complexity (5 files, zero usage data)

### 2.2 Unvalidated Assets

| Asset | Status | Evidence Gap |
|-------|--------|--------------|
| **Nexus** | Shipped v0.80.0 (8 days ago) | Zero real-world multi-project usage |
| **MCP Server** | Specification complete (39KB) | Not implemented, no integration tests |
| **TypeScript Rewrite** | Referenced in planning | No specification, unclear scope |

---

## 3. Phase Definitions (RFC 2119)

### 3.1 Phase 0: Foundation (Months 1-2)

**Goal**: Simplify current complexity + deliver MCP Server for LLM integration

#### 3.1.1 Simplification (Epic 1)

**File Consolidation** (Target: 96 lib files → 50-60 files)

The following consolidations **MUST** be completed:

| Consolidation | Current Files | Target Structure | Reduction |
|---------------|---------------|------------------|-----------|
| Agent system | 14 files | `lib/agent/{orchestrator,skills,registry}.sh` | 14 → 3 |
| Nexus | 5 files | `lib/nexus/nexus.sh` (single file) | 5 → 1 |
| Sessions | 6 files | `lib/sessions/{core,enforcement}.sh` | 6 → 2 |
| Protocols | 5 files | `lib/protocols/{validation,lifecycle}.sh` | 5 → 2 |

**Migration Cleanup** (Target: migrate.sh from 2,884 lines → <1,000 lines)

The following migration strategy **MUST** be implemented:

1. **Migration Snapshots**: Collapse pre-v1.0 migrations into single snapshot function
2. **External Migrations**: Move version-specific migrations to `migrations/v*.sh` files
3. **Minimum Version Policy**: Drop migrations older than 6 months (configurable)
4. **Lazy Loading**: Load migration functions on-demand, not at startup

**Technical Debt** (Target: 1,111 TODO comments → <100)

The following cleanup **MUST** occur:

1. Convert actionable TODO comments to tracked tasks via `cleo add`
2. Remove completed TODOs (code review)
3. Archive orphaned code paths (unused functions)
4. Update stale documentation (last modified >1 year)

**Success Criteria**:
- File count: 163 → 100 files (38% reduction)
- Largest file: 3,098 lines → <2,000 lines
- TODO comments: 1,111 → <100
- Test pass rate: Maintain 100% (no regressions)

#### 3.1.2 MCP Server Implementation (Epic 2)

**Architecture** (TypeScript + FastMCP)

The MCP server **MUST** implement the following two-tool CQRS gateway:

```
┌─────────────────────────────────────────────────────────┐
│ MCP Tools (2)                                            │
│   - cleo_query (45 read operations)                     │
│   - cleo_mutate (53 write operations)                   │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ Domain Router (8 domains)                                │
│   tasks | session | orchestrate | research | lifecycle  │
│   validate | release | system                           │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ CLI Adapter (child_process spawns)                      │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ Bash CLI (65 commands)                                  │
└─────────────────────────────────────────────────────────┘
```

**Implementation Requirements** (RFC 2119)

The MCP server **MUST**:
1. Use TypeScript with FastMCP SDK
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

**Goal**: Validate Nexus usage + MCP adoption before further investment

#### 3.2.1 Nexus Validation Gate

**Validation Criteria** (All MUST pass to proceed to Phase 2 Nexus expansion)

| Metric | Target | Measurement Period | Data Source |
|--------|--------|-------------------|-------------|
| **Active Users** | ≥3 developers | 30 consecutive days | Registry access logs |
| **Multi-Project Usage** | ≥2 projects per user | 30 days | Cross-project query frequency |
| **Time Savings** | >30% context discovery reduction | Comparative benchmark | MCP query logs vs `cleo list` |
| **Feature Requests** | ≥5 actionable requests | 30 days | User feedback, issue tracker |
| **Cross-Project Operations** | >100 queries in 30 days | 30 days | `nexus query` command logs |

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

| Metric | Target | Measurement Period | Data Source |
|--------|--------|-------------------|-------------|
| **Developer Adoption** | ≥3 developers | 60 days | MCP server logs |
| **Query Frequency** | >500 queries/developer/month | 60 days | Operation counts |
| **Token Savings** | >90% validated | Comparative benchmark | Claude Code telemetry |
| **Performance** | <3s query response | Production load | MCP server metrics |
| **Error Rate** | <5% operations fail | 60 days | Error logs |

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

| Hotspot | Current Lines | Rationale | Target API |
|---------|---------------|-----------|------------|
| **sessions.sh** | 3,098 | Complex state machine, 60+ functions | TypeScript SessionManager class |
| **migrate.sh** | 2,884 | Schema evolution, version checks | TypeScript MigrationEngine class |
| **orchestrator-startup.sh** | 2,138 | Initialization sequence, token budget | TypeScript OrchestratorCore class |

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
5. Expose via MCP `cleo_query` operation: `research.query`

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

### 3.4 Phase 3: Scale (Months 10-18)

**Precondition**: Phase 2 MUST validate TypeScript value AND demonstrate Tier M usage (5+ projects)

**Goal**: Support Tier L scale (3-10 projects, 5-20 concurrent agents)

#### 3.4.1 Agent Coordination (Epic: Agent Registry + Capability Routing)

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

#### 3.4.2 Cross-Project Intelligence (Epic: PostgreSQL Backend)

**Precondition**: Nexus validation MUST succeed + Tier L usage demonstrated

**Requirements** (RFC 2119)

The PostgreSQL backend **MUST**:
1. Replace ~/.cleo/nexus/*.json files with PostgreSQL database
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

---

## 4. Integration Strategy (Cognee Patterns)

### 4.1 Patterns to Adopt

**From Cognee Architecture Analysis (T2970)**

| Pattern | Cognee Implementation | CLEO Adaptation | Phase |
|---------|----------------------|-----------------|-------|
| **Three-Tier Storage** | Relational + Vector + Graph | JSON (Tier S) → SQLite (Tier M) → PostgreSQL (Tier L) | Phase 2-3 |
| **Pipeline Abstraction** | Task wrapper for sync/async | Skill execution wrapper with unified interface | Phase 0 (MCP) |
| **MCP Architecture** | FastMCP with direct/API modes | MCP server with stdio/HTTP transports | Phase 0 |
| **Status Tracking** | PipelineRunInfo for progress | Background job status (epic decomposition) | Phase 0 (MCP) |
| **Config Validation** | Pydantic BaseSettings | JSON Schema validation (already exists) | Current |

**Implementation Timeline**:
- **Phase 0**: MCP architecture, pipeline abstraction (background jobs)
- **Phase 2**: SQLite-vec for semantic search (three-tier storage Tier M)
- **Phase 3**: PostgreSQL backend (three-tier storage Tier L)

### 4.2 Patterns to Avoid

**Deferred to Tier XL (10-100+ projects) or Never**

| Pattern | Cognee Use Case | CLEO Rationale for Avoidance |
|---------|-----------------|------------------------------|
| **Graph Database** | Neo4j for complex relationships | Premature optimization; SQLite sufficient for Tier M/L |
| **LLM Dependency** | Embedding generation, summarization | Keep core operations deterministic; optional for Tier XL |
| **Configuration Sprawl** | ~30 environment variables | CLEO uses `.cleo/config.json` (single source of truth) |
| **Real-Time Sync** | WebSocket/SSE for updates | Solo developer focus; on-demand sync sufficient |

### 4.3 CLEO-Distinct Patterns (Preserve)

**Agent-First Design**

The following patterns are **unique to CLEO** and **MUST** be preserved:

1. **Protocol Enforcement** (RCSD-IVTR lifecycle)
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

4. **Task Hierarchy Constraints** (Max depth 3, max 7 siblings)
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

| Layer | Technology | Justification |
|-------|-----------|---------------|
| **MCP Server** | TypeScript | Node.js required for MCP, structured JSON responses |
| **Complex Logic** | TypeScript (sessions, migrate, orchestrator) | State machines, version checks benefit from types |
| **Simple Operations** | Bash (file-ops, validation, CLI wrappers) | Proven, tested, no benefit from rewrite |
| **Data Layer** | JSON files (Tier S) → SQLite (Tier M) → PostgreSQL (Tier L) | Storage evolution path |

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
- Phase 3+: Remaining lib/ (~61K LOC), scripts/ (~64K LOC)

**Timeline**: 12-24 months for full migration

**Risk**: High regression risk, test suite rewrite (262 BATS files → Jest)

**Rollback Path**: Maintain Bash version in parallel, delete only after 6-month bake period

**Decision Point**: Month 12 (end of Phase 2)

---

## 6. Success Criteria

### 6.1 Phase 0 Success (Simplification + MCP)

**Quantitative Metrics**

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| **File Count** | 163 files | 100 files | File system audit |
| **Largest File** | 3,098 lines | <2,000 lines | LOC count |
| **TODO Comments** | 1,111 | <100 | `grep -r TODO` |
| **MCP Token Reduction** | 32,500 tokens | <3,500 tokens | MCP tool definitions |
| **Test Pass Rate** | 100% | 100% | BATS test suite |

**Qualitative Criteria**

The following **MUST** be validated by code review:

1. Consolidated modules have clear boundaries (no cross-contamination)
2. Migration snapshots reduce migrate.sh by >60%
3. MCP server passes all integration tests (Claude Code, Cursor)
4. No breaking changes for existing CLI users
5. Documentation updated (CLAUDE.md, specs/, guides/)

**Timeline**: End of Month 2

### 6.2 Phase 1 Success (Validation)

**Nexus Validation**

All of the following **MUST** be true:

- [ ] 3+ developers using Nexus across 2+ projects for 30+ consecutive days
- [ ] >100 cross-project queries in 30-day period
- [ ] >30% context discovery time savings (validated benchmark)
- [ ] 5+ actionable feature requests from users
- [ ] Zero critical bugs reported

**MCP Server Validation**

All of the following **MUST** be true:

- [ ] 3+ developers using MCP server for 60+ consecutive days
- [ ] >500 queries per developer per month
- [ ] >90% token savings validated via telemetry
- [ ] <3s query response time (p95)
- [ ] <5% error rate

**Timeline**: End of Month 4

### 6.3 Phase 2 Success (Intelligence)

**Semantic Search**

All of the following **MUST** be validated:

- [ ] Query response <3s for 10,000 task corpus
- [ ] >80% relevance (user satisfaction survey)
- [ ] >30% context discovery time reduction vs keyword search
- [ ] Integration with MCP `cleo_query` complete
- [ ] Zero data loss during embedding updates

**TypeScript Hotspot Migration**

All of the following **MUST** be true for EACH migrated hotspot:

- [ ] 100% feature parity (no regressions)
- [ ] ≥90% test coverage (Jest)
- [ ] Performance matches or exceeds Bash (within 10%)
- [ ] <5% bug rate in 60-day bake period
- [ ] >50% developer preference (survey)

**Timeline**: End of Month 9

### 6.4 Phase 3 Success (Scale)

**Agent Coordination**

All of the following **MUST** be validated:

- [ ] Support 5-20 concurrent agents (load test)
- [ ] Task routing latency <100ms
- [ ] >70% agent utilization
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

---

## 7. Risk Assessment

### 7.1 High-Risk Decisions

| Decision | Risk | Mitigation |
|----------|------|------------|
| **MCP Server (TypeScript)** | New runtime (Node.js), unproven adoption, maintenance burden | Incremental: Core → Features → Integration. Rollback to CLI if unused after 90 days. |
| **TypeScript Migration** | Regression bugs, test suite rewrite (262 BATS → Jest), performance degradation | Incremental: MCP only → hotspots → expand. Keep Bash as fallback. 60-day bake periods. |
| **Nexus Expansion** | Unvalidated feature (zero usage data), premature scaling, maintenance cost | Gate expansion on 30-day validation. Consolidate to single file if criteria unmet. |
| **Storage Evolution** | SQLite → PostgreSQL migration complexity, data loss risk, performance regression | JSON compatibility maintained. Migration tested with 10K+ task corpus. Rollback to SQLite if PostgreSQL fails. |

### 7.2 Medium-Risk Decisions

| Decision | Risk | Mitigation |
|----------|------|------------|
| **Simplification First** | Delays new features (MCP, Nexus expansion), potential for churn during consolidation | Parallel with MCP server development. Focus on high-value consolidations only. |
| **Cognee Patterns** | Over-engineering (graph DB, vector search), complexity creep | Adopt proven patterns only. Defer speculative features (graph DB to Tier XL). |
| **Hybrid Bash/TypeScript** | Maintenance burden (two languages), FFI complexity, debugging difficulty | Clear layer separation. Use CLI wrappers (simple FFI). Maintain hybrid only during migration. |
| **Semantic Search** | Relevance tuning difficulty, embedding maintenance cost, query performance | Use battle-tested SQLite-vec. Validate with 80% user satisfaction threshold. |

### 7.3 Low-Risk Decisions

| Decision | Risk | Mitigation |
|----------|------|------------|
| **File Consolidation** | Merge conflicts, temporary confusion | Clear migration guide. Preserve git history. Update imports systematically. |
| **Migration Snapshots** | Loss of granular version history | Archive old migrations. Document snapshot creation process. |
| **TODO Cleanup** | Missed TODOs become lost work | Convert to tracked tasks before deletion. Code review required. |

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
GATE 1: Simplification + MCP Server Complete
    ├─ All Phase 0 success criteria met?
    ├─ Test pass rate 100%?
    └─ Zero critical bugs?
    ↓
Phase 1: Validation (60-90 days)
    ↓
GATE 2: Nexus + MCP Adoption Validated
    ├─ Nexus validation criteria met?
    ├─ MCP validation criteria met?
    └─ Performance benchmarks pass?
    ↓
Phase 2: Intelligence
    ↓
GATE 3: TypeScript Value Demonstrated
    ├─ Semantic search meets criteria?
    ├─ TypeScript hotspots validated?
    └─ Developer preference >50% TypeScript?
    ↓
Phase 3: Scale
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
Month:    1    2    3    4    5    6    7    8    9   10   11   12   13   14   15   16   17   18
          ─────────────────────────────────────────────────────────────────────────────────────
Phase 0:  ████████
          │      │
          │      └─► GATE 1: Simplification + MCP Complete
          │
          ├─ File Consolidation
          ├─ Migration Cleanup
          └─ MCP Server Core/Features/Integration

Phase 1:        ████████
                │      │
                │      └─► GATE 2: Nexus + MCP Validation (60-90 days)
                │
                ├─ Nexus Usage Tracking
                └─ MCP Adoption Metrics

Phase 2:                ████████████████████
                        │                  │
                        │                  └─► GATE 3: TypeScript Value Demonstrated
                        │
                        ├─ Semantic Search (SQLite-vec)
                        ├─ TypeScript Hotspot Migration (sessions, migrate, orchestrator)
                        └─ Research Indexing

Phase 3:                                    ████████████████████████
                                            │                      │
                                            │                      └─► Tier L Capability Validated
                                            │
                                            ├─ Agent Coordination
                                            └─ PostgreSQL Backend (if Nexus validated)
```

### 9.2 Milestone Dates (Estimated)

| Milestone | Month | Description |
|-----------|-------|-------------|
| **Phase 0 Start** | 1 | Simplification + MCP server development begins |
| **GATE 1** | 2 | File consolidation + MCP server core complete |
| **MCP Server Release** | 3 | MCP server v1.0.0 shipped to production |
| **Phase 1 Start** | 3 | Validation period begins (60-90 days) |
| **GATE 2** | 4 | Nexus + MCP validation results available |
| **Phase 2 Start** | 4 | Semantic search + TypeScript hotspots (if Gate 2 passes) |
| **Semantic Search Release** | 6 | SQLite-vec integration complete |
| **TypeScript Hotspots Complete** | 9 | Sessions, migrate, orchestrator migrated |
| **GATE 3** | 9 | TypeScript value validation |
| **Phase 3 Start** | 10 | Agent coordination + PostgreSQL (if Gate 3 passes) |
| **Agent Registry Release** | 12 | Agent coordination operational |
| **PostgreSQL Backend Release** | 18 | Tier L scale capability complete |

### 9.3 Critical Path

**Sequential Dependencies** (Cannot parallelize):

```
File Consolidation → MCP Server Implementation → Gate 1
    ↓
Nexus Validation (60 days) + MCP Validation (90 days) → Gate 2
    ↓
TypeScript Hotspot Migration (sessions → migrate → orchestrator) → Gate 3
    ↓
Agent Coordination → PostgreSQL Backend
```

**Parallel Opportunities**:

- File Consolidation || MCP Server Core (Months 1-2)
- Semantic Search || TypeScript Hotspot Migration (Months 4-9)
- Research Indexing || Agent Coordination (Months 10-12)

---

## 10. References

### 10.1 Strategic Foundation

- **T2968**: EPIC: CLEO Strategic Inflection Point Review
- **T2969**: Research: CLEO Current State Assessment (v0.80.0 analysis)
- **T2970**: Research: Cognee Architecture Analysis (pattern analysis)
- **T2971**: Research: BRAIN Vision Requirements (scale tiers, capability gaps)
- **T2972**: Consensus: Strategic Direction (voting matrix, confidence scores)

### 10.2 Existing Specifications

- **docs/specs/MCP-SERVER-SPECIFICATION.md**: Two-tool CQRS gateway (39KB)
- **docs/specs/CLEO-NEXUS-SPEC.md**: Cross-project intelligence (43KB)
- **docs/specs/PROJECT-LIFECYCLE-SPEC.md**: RCSD-IVTR pipeline
- **docs/specs/PROTOCOL-STACK-SPEC.md**: Base + conditional protocols

### 10.3 Architecture Documentation

- **CLAUDE.md**: Core repository guidelines
- **.cleo/templates/CLEO-INJECTION.md**: Subagent architecture (v1.0.0)
- **docs/concepts/vision.mdx**: CLEO vision statement
- **docs/guides/protocol-enforcement.md**: Protocol validation guide

### 10.4 Current State Artifacts

- **CHANGELOG.md**: v0.80.0 (Nexus release, 2026-01-26)
- **VERSION**: 0.80.0
- **lib/**: 96 library modules, 69,276 LOC
- **scripts/**: 67 CLI commands, 63,927 LOC
- **tests/**: 262 BATS test files, 100,421 LOC

### 10.5 External References

- **Cognee**: Three-tier storage, MCP architecture, pipeline abstraction
- **FastMCP**: TypeScript MCP server SDK
- **SQLite-vec**: Vector similarity extension for SQLite
- **PostgreSQL**: Target database for Tier L scale
- **pgvector**: Vector similarity extension for PostgreSQL

---

## 11. Appendices

### Appendix A: Scale Tier Definitions

| Tier | Projects | Agents | Features | Storage |
|------|----------|--------|----------|---------|
| **S** | 1 | 1 orchestrator + subagents | Task management, sessions, Graph-RAG | JSON files |
| **M** | 2-3 | 2-5 concurrent | Nexus registry, MCP interface, semantic search | SQLite |
| **L** | 3-10 | 5-20 concurrent | Agent coordination, cross-project intelligence | PostgreSQL |
| **XL** | 10-100+ | 20-100+ concurrent | Distributed agents, real-time sync, graph DB | Distributed DB |

**Current State**: Tier S (fully mature)
**Phase 0-1 Target**: Tier S → M foundation
**Phase 2-3 Target**: Tier M → L capability

### Appendix B: Technology Stack Evolution

| Layer | Phase 0 (Current) | Phase 1 (Target) | Phase 2+ (Future) |
|-------|-------------------|------------------|-------------------|
| **Interface** | Bash CLI | MCP Server (TypeScript) + CLI | MCP primary, CLI maintenance |
| **Business Logic** | Bash (lib/) | Bash + TypeScript hotspots | TypeScript majority, Bash for simple ops |
| **Storage** | JSON files | JSON + SQLite (semantic search) | SQLite/PostgreSQL hybrid |
| **Graph** | graph-cache.sh (JSON) | SQLite-vec (embeddings) | PostgreSQL + pgvector |
| **Testing** | BATS | BATS + Jest (TypeScript modules) | Jest primary, BATS for CLI |
| **Validation** | JSON Schema + custom | Same + MCP gateway validation | Same |

### Appendix C: Key Metrics Dashboard

**Phase 0 Targets**:
- Files: 163 → 100 (38% reduction)
- MCP tokens: 32,500 → <3,500 (>90% reduction)
- Largest file: 3,098 → <2,000 lines
- TODO comments: 1,111 → <100

**Phase 1 Targets**:
- Nexus users: ≥3 developers, 30+ days
- MCP queries: >500/developer/month
- Token savings: >90% validated
- Error rate: <5%

**Phase 2 Targets**:
- Semantic search: <3s query, >80% relevance
- TypeScript hotspots: 100% parity, ≥90% coverage
- Research index: <500ms query
- Test coverage: ≥90%

**Phase 3 Targets**:
- Agents: 5-20 concurrent support
- Routing latency: <100ms
- PostgreSQL: <1s queries, 10K+ tasks
- Agent utilization: >70%

---

**Specification Status**: STABLE
**Last Updated**: 2026-02-03
**Version**: 1.0.0
**Approval**: Pending HITL review
**Next Review**: End of Phase 0 (Month 2)
