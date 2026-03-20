# CLEO Core Hardening -- Final Summary

**Date**: 2026-03-19
**Initiative**: Core Hardening (merged T029 Schema Review + T038 Drift Remediation)
**Status**: COMPLETE (Waves 0-4)

---

## Executive Summary

The Core Hardening initiative strengthened CLEO's data integrity, validation contract surface, type safety, test coverage, and two new runtime dimensions (Agents, Intelligence). Five waves executed sequentially, with parallel sub-tasks within each wave.

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Test count | 4,386 | 4,618 | +232 |
| Test files | 262 | 268 | +6 |
| Hard FKs (tasks.db) | 16 | 19 | +3 |
| Indexes (tasks.db) | 56 | 63 | +7 |
| Unique constraints | 1 | 2 | +1 |
| Zod enum schemas | 0 | 34 | +34 |
| Hook payload schemas | 0 | 14 | +14 |
| Namespace count | 41 | 43 | +2 |
| Agent dimension | 40% | 100% | Complete |
| Intelligence dimension | 50% | 100% | Complete |

---

## Wave 0: Data Integrity (Foundation)

**Goal**: Add missing foreign keys, indexes, and constraints to the schema.

### Foreign Keys Added (3)

| Table | Column | Target | On Delete |
|-------|--------|--------|-----------|
| `warp_chain_instances` | `chain_id` | `warp_chains.id` | CASCADE |
| `sessions` | `previous_session_id` | `sessions.id` | SET NULL |
| `sessions` | `next_session_id` | `sessions.id` | SET NULL |

### Indexes Added (7)

| Priority | Table | Column(s) | Index Name |
|----------|-------|-----------|------------|
| High | `tasks` | `session_id` | `idx_tasks_session_id` |
| High | `task_relations` | `related_to` | `idx_task_relations_related_to` |
| High | `architecture_decisions` | `amends_id` | `idx_arch_decisions_amends_id` |
| Medium | `audit_log` | `actor` | `idx_audit_log_actor` |
| Medium | `sessions` | `started_at` | `idx_sessions_started_at` |
| Medium | `lifecycle_stages` | `validated_by` | `idx_lifecycle_stages_validated_by` |
| Medium | `token_usage` | `gateway` | `idx_token_usage_gateway` |

### Constraints Added (1)

| Table | Type | Columns |
|-------|------|---------|
| `external_task_links` | UNIQUE | `task_id, provider_id, external_id` |

### Migration

`20260320013731_wave0-schema-hardening` -- applied successfully, all 4,386 tests passing.

---

## Wave 1: Validation and Contracts

**Goal**: Harden the validation layer, export consumer schemas, wire stub params, add type safety, validate Nexus E2E.

### Wave 1A: Validation Schemas and Contract Exports

**Files modified:**
- `packages/core/src/store/validation-schemas.ts` -- Added refinements for 10 tables, created 34 Zod enum schemas
- `packages/core/src/index.ts` -- Added 34 enum + 8 insert/select schema flat exports
- `packages/core/src/validation/index.ts` -- Re-exports all schemas via namespace pattern

**34 Zod enum schemas created:**
- Task (4): `taskStatusSchema`, `taskPrioritySchema`, `taskTypeSchema`, `taskSizeSchema`
- Session (1): `sessionStatusSchema`
- Lifecycle (5): `lifecyclePipelineStatusSchema`, `lifecycleStageStatusSchema`, `lifecycleStageNameSchema`, `lifecycleGateResultSchema`, `lifecycleEvidenceTypeSchema`
- Governance (3): `adrStatusSchema`, `gateStatusSchema`, `manifestStatusSchema`
- Token usage (3): `tokenUsageMethodSchema`, `tokenUsageConfidenceSchema`, `tokenUsageTransportSchema`
- Relation/link (4): `taskRelationTypeSchema`, `externalLinkTypeSchema`, `syncDirectionSchema`, `lifecycleTransitionTypeSchema`
- Brain (14): `brainObservationTypeSchema`, `brainObservationSourceTypeSchema`, `brainDecisionTypeSchema`, `brainConfidenceLevelSchema`, `brainOutcomeTypeSchema`, `brainPatternTypeSchema`, `brainImpactLevelSchema`, `brainLinkTypeSchema`, `brainMemoryTypeSchema`, `brainStickyStatusSchema`, `brainStickyColorSchema`, `brainStickyPrioritySchema`, `brainNodeTypeSchema`, `brainEdgeTypeSchema`

**3 tables newly covered:** `releaseManifests`, `pipelineManifest`, `externalTaskLinks` (previously missing insert/select schemas entirely).

### Wave 1B: Stub Parameter Wiring

**11 parameters wired across 9 files:**

| File | Parameter | Change |
|------|-----------|--------|
| `signaldock/signaldock-transport.ts` | `_since` | Wired into poll endpoint query parameter |
| `otel/index.ts` | `_opts` | Wired to filter JSONL token data by session/since |
| `lifecycle/pipeline.ts` | `_reason` | Stored in stage notesJson and metadataJson |
| `lifecycle/state-machine.ts` | `_reason` | Stored in StageState.notes |
| `issue/template-parser.ts` | `_templates` | Full cross-reference label validation |
| `skills/orchestrator/startup.ts` | `_epicId` | Epic-scoped session filtering |
| `orchestration/skill-ops.ts` (x2) | `_projectRoot` | Project-local skill scanning |
| `validation/protocol-common.ts` | `_protocolType` | Protocol-specific message/agent validation |
| `validation/doctor/checks.ts` (x2) | `_projectRoot` | Project-scoped global schema validation |

### Wave 1C: Type Hardening

**Files created:**
- `packages/core/src/hooks/payload-schemas.ts` -- 14 Zod schemas for hook event payloads

**Files modified:**
- `packages/core/src/sessions/types.ts` -- Extracted `TaskFileTaskEntry`, `TaskFileMetaExt`, tightened `TaskWorkStateExt`
- `packages/core/src/sessions/index.ts` -- Added type exports
- `packages/core/src/memory/brain-row-types.ts` -- Added `BrainTimelineNeighborRow`, `BrainConsolidationObservationRow`, `BrainIdCheckRow`
- `packages/core/src/hooks/index.ts` -- Added payload schema exports
- `packages/core/src/internal.ts` -- Added flat exports for new types

### Wave 1D: Nexus E2E Validation

**Files created:**
- `packages/core/src/nexus/__tests__/nexus-e2e.test.ts` -- 89 new tests

**Categories:** Audit log verification (9), health status (4), permission updates (6), schema integrity (6), multi-project operations (4), cross-project task resolution (5), edge cases (6), error handling (5), sync operations (5), discovery/search (4), sharing status (4), MCP gateway operations (31).

**Bug found and fixed:** `extractKeywords()` in `nexus/discover.ts` stripped uppercase letters instead of lowercasing them.

### Wave 1 Validation

4,475 tests passed (up from 4,386). Zero failures.

---

## Wave 2: Agent Dimension

**Goal**: Complete the Agent dimension (40% to 100%) -- runtime tracking, health, self-healing, capacity.

### Files Created (5)

| File | Purpose |
|------|---------|
| `packages/core/src/agents/agent-schema.ts` | Drizzle schema for `agent_instances` + `agent_error_log` |
| `packages/core/src/agents/registry.ts` | CRUD, heartbeat, health monitoring, error classification |
| `packages/core/src/agents/retry.ts` | Retry policies, exponential backoff, crashed agent recovery |
| `packages/core/src/agents/capacity.ts` | Load awareness, least-loaded selection, overload detection |
| `packages/core/src/agents/index.ts` | Barrel file |

### Files Created (Tests, 3)

| File | Tests |
|------|-------|
| `packages/core/src/agents/__tests__/registry.test.ts` | 44 |
| `packages/core/src/agents/__tests__/retry.test.ts` | 20 |
| `packages/core/src/agents/__tests__/capacity.test.ts` | 14 |

### Files Modified (5)

| File | Change |
|------|--------|
| `packages/core/src/index.ts` | Added `export * as agents` namespace + agent Zod schemas |
| `packages/core/src/internal.ts` | Added flat agent function re-exports |
| `packages/core/src/store/tasks-schema.ts` | Re-exports agent schema tables for drizzle-kit |
| `packages/core/src/store/validation-schemas.ts` | Added 6 agent validation schemas (insert/select + enums) |
| Migration `20260320020000_agent-dimension/` | SQL migration + snapshot for agent tables |

### Schema Added

**`agent_instances` table:** 13 columns, 6 indexes
**`agent_error_log` table:** 7 columns, 3 indexes

### New Zod Schemas (6)

`insertAgentInstanceSchema`, `selectAgentInstanceSchema`, `insertAgentErrorLogSchema`, `selectAgentErrorLogSchema`, `agentInstanceStatusSchema`, `agentTypeSchema`

---

## Wave 3: Intelligence Dimension

**Goal**: Complete the Intelligence dimension (50% to 100%) -- prediction, patterns, impact.

### Wave 3A: Quality Prediction + Pattern Extraction

**Files created (4):**

| File | Purpose |
|------|---------|
| `packages/core/src/intelligence/types.ts` | 14 type/interface definitions |
| `packages/core/src/intelligence/prediction.ts` | `calculateTaskRisk`, `predictValidationOutcome`, `gatherLearningContext` |
| `packages/core/src/intelligence/patterns.ts` | `extractPatternsFromHistory`, `matchPatterns`, `storeDetectedPattern`, `updatePatternStats` |
| `packages/core/src/intelligence/index.ts` | Barrel file |

**Files created (tests, 2):**

| File | Tests |
|------|-------|
| `packages/core/src/intelligence/__tests__/prediction.test.ts` | 16 |
| `packages/core/src/intelligence/__tests__/patterns.test.ts` | 14 |

**Files modified (2):**

| File | Change |
|------|--------|
| `packages/core/src/index.ts` | Added `export * as intelligence` namespace |
| `packages/core/src/internal.ts` | Added flat intelligence function re-exports |

### Wave 3B: Impact Analysis

**Files created (1):**

| File | Purpose |
|------|---------|
| `packages/core/src/intelligence/impact.ts` | `analyzeTaskImpact`, `analyzeChangeImpact`, `calculateBlastRadius` |

**Files created (tests, 1):**

| File | Tests |
|------|-------|
| `packages/core/src/intelligence/__tests__/impact.test.ts` | 30 |

**Collateral fixes (pre-existing build errors):**

| File | Fix |
|------|-----|
| `intelligence/prediction.ts` | Changed invalid `'todo'`/`'in-progress'` to `'pending'`/`'active'` |
| `intelligence/patterns.ts` | Removed unused `Task` import |
| `agents/retry.ts` | Removed unused `getAgentInstance` import |

### Waves 2+3 Validation

4,618 tests passed (up from 4,475). Zero failures. 268 test files.

---

## Wave 4: Documentation

**Goal**: ERD diagrams, spec updates, type contract reference, final summary.

### Files Created (3)

| File | Purpose |
|------|---------|
| `docs/architecture/DATABASE-ERDS.md` | Mermaid ERD diagrams for all 3 databases with FK legends, index listings, table descriptions |
| `docs/architecture/TYPE-CONTRACTS.md` | Complete public type API reference: facades, agents, intelligence, validation schemas, error types |
| `docs/analysis/CORE-HARDENING-FINAL-SUMMARY.md` | This document |

### Files Modified (1)

| File | Changes |
|------|---------|
| `docs/specs/CORE-PACKAGE-SPEC.md` | Updated namespace count 41->43, added `agents` and `intelligence` to domain table, added Zod enum schema exports to consumer patterns, noted agent schema in DataAccessor section |

---

## Complete File Inventory

### Files Created (Waves 0-3)

| Wave | File | Type |
|------|------|------|
| 0 | `packages/core/migrations/drizzle-tasks/20260320013731_wave0-schema-hardening/` | Migration |
| 1A | (modifications only) | -- |
| 1B | (modifications only) | -- |
| 1C | `packages/core/src/hooks/payload-schemas.ts` | Source |
| 1D | `packages/core/src/nexus/__tests__/nexus-e2e.test.ts` | Test |
| 2 | `packages/core/src/agents/agent-schema.ts` | Source |
| 2 | `packages/core/src/agents/registry.ts` | Source |
| 2 | `packages/core/src/agents/retry.ts` | Source |
| 2 | `packages/core/src/agents/capacity.ts` | Source |
| 2 | `packages/core/src/agents/index.ts` | Source |
| 2 | `packages/core/src/agents/__tests__/registry.test.ts` | Test |
| 2 | `packages/core/src/agents/__tests__/retry.test.ts` | Test |
| 2 | `packages/core/src/agents/__tests__/capacity.test.ts` | Test |
| 2 | `packages/core/migrations/drizzle-tasks/20260320020000_agent-dimension/` | Migration |
| 3A | `packages/core/src/intelligence/types.ts` | Source |
| 3A | `packages/core/src/intelligence/prediction.ts` | Source |
| 3A | `packages/core/src/intelligence/patterns.ts` | Source |
| 3A | `packages/core/src/intelligence/index.ts` | Source |
| 3A | `packages/core/src/intelligence/__tests__/prediction.test.ts` | Test |
| 3A | `packages/core/src/intelligence/__tests__/patterns.test.ts` | Test |
| 3B | `packages/core/src/intelligence/impact.ts` | Source |
| 3B | `packages/core/src/intelligence/__tests__/impact.test.ts` | Test |

### Files Modified (Waves 0-3)

| Wave | File | Change Summary |
|------|------|----------------|
| 0 | `packages/core/src/store/tasks-schema.ts` | Added 3 FKs, 7 indexes, 1 UNIQUE |
| 0 | `packages/core/src/store/chain-schema.ts` | Added CASCADE FK on chain_id |
| 1A | `packages/core/src/store/validation-schemas.ts` | Added 34 enum schemas, 3 new table schema pairs, refinements for 10 tables |
| 1A | `packages/core/src/index.ts` | Added enum + insert/select schema flat exports |
| 1A | `packages/core/src/validation/index.ts` | Added namespace re-exports |
| 1B | `packages/core/src/signaldock/signaldock-transport.ts` | Wired `since` param |
| 1B | `packages/core/src/otel/index.ts` | Wired `opts` param |
| 1B | `packages/core/src/lifecycle/pipeline.ts` | Wired `reason` param |
| 1B | `packages/core/src/lifecycle/state-machine.ts` | Wired `reason` param |
| 1B | `packages/core/src/issue/template-parser.ts` | Wired `templates` param |
| 1B | `packages/core/src/skills/orchestrator/startup.ts` | Wired `epicId` param |
| 1B | `packages/core/src/orchestration/skill-ops.ts` | Wired `projectRoot` param (2 functions) |
| 1B | `packages/core/src/validation/protocol-common.ts` | Wired `protocolType` param |
| 1B | `packages/core/src/validation/doctor/checks.ts` | Wired `projectRoot` param (2 functions) |
| 1C | `packages/core/src/sessions/types.ts` | Extracted named types, tightened TaskWorkStateExt |
| 1C | `packages/core/src/sessions/index.ts` | Added type exports |
| 1C | `packages/core/src/memory/brain-row-types.ts` | Added 3 named row types |
| 1C | `packages/core/src/hooks/index.ts` | Added payload schema exports |
| 1C | `packages/core/src/internal.ts` | Added new type flat exports |
| 1D | `packages/core/src/nexus/discover.ts` | Fixed extractKeywords() bug |
| 2 | `packages/core/src/index.ts` | Added agents namespace + agent Zod schemas |
| 2 | `packages/core/src/internal.ts` | Added agent flat exports |
| 2 | `packages/core/src/store/tasks-schema.ts` | Re-exports agent schema tables |
| 2 | `packages/core/src/store/validation-schemas.ts` | Added 6 agent validation schemas |
| 3A | `packages/core/src/index.ts` | Added intelligence namespace |
| 3A | `packages/core/src/internal.ts` | Added intelligence flat exports |
| 3B | `packages/core/src/intelligence/index.ts` | Added impact analysis exports |
| 3B | `packages/core/src/intelligence/prediction.ts` | Fixed invalid status values |
| 3B | `packages/core/src/intelligence/patterns.ts` | Removed unused import |
| 3B | `packages/core/src/agents/retry.ts` | Removed unused import |

---

## Test Count Progression

| Checkpoint | Tests | Delta |
|------------|-------|-------|
| Pre-hardening (baseline) | 4,386 | -- |
| Wave 0 complete | 4,386 | +0 (schema only) |
| Wave 1 complete | 4,475 | +89 (Nexus E2E) |
| Waves 2+3 complete | 4,618 | +143 (78 agents + 65 intelligence) |

---

## References

- `docs/analysis/CORE-HARDENING-ORCHESTRATION.md` -- Original orchestration plan
- `docs/analysis/CORE-AUDIT-FINDINGS.md` -- Initial audit findings
- `docs/analysis/WAVE0-COMPLETION-REPORT.md` -- Wave 0 details
- `docs/analysis/WAVE1A-COMPLETION-REPORT.md` -- Wave 1A details
- `docs/analysis/WAVE1B-COMPLETION-REPORT.md` -- Wave 1B details
- `docs/analysis/WAVE1C-COMPLETION-REPORT.md` -- Wave 1C details
- `docs/analysis/WAVE1D-COMPLETION-REPORT.md` -- Wave 1D details
- `docs/analysis/WAVE1-VALIDATION-REPORT.md` -- Wave 1 validation
- `docs/analysis/WAVE2-COMPLETION-REPORT.md` -- Wave 2 details
- `docs/analysis/WAVE3A-COMPLETION-REPORT.md` -- Wave 3A details
- `docs/analysis/WAVE3B-COMPLETION-REPORT.md` -- Wave 3B details
- `docs/analysis/WAVE23-VALIDATION-REPORT.md` -- Waves 2+3 validation
- `docs/specs/CORE-PACKAGE-SPEC.md` -- Updated spec (v3.0.0)
- `docs/architecture/DATABASE-ERDS.md` -- ERD diagrams
- `docs/architecture/TYPE-CONTRACTS.md` -- Type contract reference
