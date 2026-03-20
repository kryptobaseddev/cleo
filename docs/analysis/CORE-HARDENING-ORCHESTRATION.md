# CLEO Core Hardening Orchestration Plan

Version: 1.0.0
Status: ACTIVE
Date: 2026-03-19

## Overview

Merged T029 (Schema Review) + T038 (Drift Remediation) into unified Core Hardening initiative.
Five waves, executed sequentially with parallel sub-tasks where safe.

## Wave 0: Data Integrity (Foundation)

### 0A: Missing Hard Foreign Keys
- `warp_chain_instances.chain_id` -> `warp_chains.id` (ON DELETE CASCADE)
- `sessions.previous_session_id` -> `sessions.id` (ON DELETE SET NULL)
- `sessions.next_session_id` -> `sessions.id` (ON DELETE SET NULL)

### 0B: Missing Indexes (High Priority)
- `tasks(session_id)` - session filtering
- `task_relations(related_to)` - reverse lookups
- `architecture_decisions(amends_id)` - amendment chain queries
- `external_task_links(provider_id, external_id)` - composite for reconciliation

### 0C: Missing Indexes (Medium Priority)
- `audit_log(actor)` - who performed actions
- `sessions(started_at)` - temporal queries
- `lifecycle_stages(validated_by)` - validation audits
- `token_usage(gateway)` - per-gateway analysis

### 0D: Missing Constraints
- UNIQUE on `external_task_links(task_id, provider_id, external_id)`

### 0E: Migration + Validation
- Generate Drizzle migration for all schema changes
- Run full test suite

## Wave 1: Validation & Contracts

### 1A: Shared Contract Exports
- Export Zod validation schemas from @cleocode/core for consumers
- Create `@cleocode/core/schemas` or similar subpath export
- Eliminate CleoOS schema duplication

### 1B: Zod Refinement Expansion
- Add business logic refinements to ALL table schemas (currently only tasks + auditLog)
- Status transition validation
- Cross-field validation (e.g., completedAt required when status=done)

### 1C: Hook Payload Validation
- Add Zod schemas for each HookPayload variant
- Runtime validation at handler call sites

### 1D: Nexus End-to-End Validation
- Test all Nexus operations against real data
- Validate orphan detection
- Test cross-project references

### 1E: Type Hardening
- Fix loose TaskFileExt typing
- Consolidate dual skill type representations (CAAMP vs CLEO)
- Ensure BrainRowTypes cover all raw SQL queries

## Wave 2: Agent Dimension (40% -> 100%)

### 2A: Agent Registry
- Track active agents, capacity, history
- Schema + operations

### 2B: Health Monitoring
- Crash detection within 30s
- Heartbeat protocol

### 2C: Self-Healing
- Automatic retry with exponential backoff
- Error classification and recovery strategies

### 2D: Load Balancing
- Capacity awareness
- Work distribution

## Wave 3: Intelligence (50% -> 100%)

### 3A: Quality Prediction
- Risk scoring for tasks
- Confidence-based validation

### 3B: Pattern Extraction
- Learn from execution history
- Automatic pattern detection from brain data

### 3C: Memory CLI Parity
- Expose 60+ core memory functions via CLI
- Bridge MCP-only operations to CLI

### 3D: Impact Analysis
- Predict downstream effects of changes
- Dependency-aware risk assessment

## Wave 4: Documentation

### 4A: ERD Diagrams
- All 3 databases (tasks.db, brain.db, nexus.db)
- FK relationships, indexes

### 4B: Spec Alignment
- Update CORE-PACKAGE-SPEC to match implementation
- Document all type contracts
- Verify export chain documentation

## Cross-Cutting: TODO/Import Audit

- Find and COMPLETE all TODO/FIXME/HACK comments
- Wire all unused imports (no removal without validation)
- Investigate all '_' prefixed ignores
- Zero TODOs remaining at end

## Agent Context Budget

Hard cap: 185,000 tokens per agent.
Handoff protocol: Agent MUST checkpoint progress and spawn successor if approaching limit.

## Files Map

| File | Wave | Purpose |
|------|------|---------|
| `packages/core/src/store/tasks-schema.ts` | 0 | FKs, indexes, constraints |
| `packages/core/src/store/brain-schema.ts` | 0 | Review soft FKs |
| `packages/core/src/store/nexus-schema.ts` | 0 | Review soft FKs |
| `packages/core/src/store/validation-schemas.ts` | 1 | Zod refinements |
| `packages/core/src/index.ts` | 1 | Export shared schemas |
| `packages/core/src/hooks/types.ts` | 1 | Payload validation |
| `packages/core/src/sessions/types.ts` | 1 | Fix TaskFileExt |
| `packages/core/src/cleo.ts` | 1 | Facade API types |
| `packages/core/src/skills/types.ts` | 1 | Consolidate dual types |
| `packages/core/src/memory/brain-row-types.ts` | 1 | Complete coverage |
