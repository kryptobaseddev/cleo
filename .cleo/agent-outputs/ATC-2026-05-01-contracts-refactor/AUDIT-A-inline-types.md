# Audit A — Inline Types Classification (cleo / core / contracts)

**Date**: 2026-05-01
**Scope**: `packages/cleo/src/`, `packages/core/src/`, `packages/contracts/src/`
**Method**: read-only grep investigation — no files modified

---

## 1. Executive Summary

| Metric | Count |
|--------|-------|
| `export type` / `export interface` in `packages/cleo/src/` (own declarations, not re-exports) | **59** |
| `export type` / `export interface` in `packages/core/src/` (own declarations) | **1 518** |
| `export type` / `export interface` in `packages/contracts/src/` | **1 337** |
| Unique type names appearing in more than one package | **128** |
| Total duplicate _instances_ across all packages | **667** |
| Types duplicated CONTRACTS+CORE (same name, different file) | **88** |
| Types duplicated CLEO+CORE (same name, different file) | **4** |
| Types duplicated within contracts itself | **7** |
| Types duplicated within core itself | **29** |
| Known coverage gaps (types in core/internal.ts but absent from contracts) | **≥15** |

**Top 5 most-impactful migrations required:**

1. **EngineResult** (`cleo/dispatch/domains/_base.ts` vs `core/engine-result.ts`) — concrete-shape interface vs. proper discriminated-union type. The `_base.ts` version is used by every domain handler (22 files). The canonical version already lives in `@cleocode/core`; the shadow in `_base.ts` must be deleted and domain handlers migrated to import from core.

2. **TaskRole / TaskScope / TaskSeverity** — duplicated verbatim between `contracts/src/task.ts` (source of truth) and `core/src/store/tasks-schema.ts` (Drizzle schema). Core schema should derive from contracts, not re-declare.

3. **Agent* family (AgentCapacity, AgentHealthStatus, AgentInstanceRow, AgentInstanceStatus, AgentType, RegisterAgentOptions)** — duplicated between `contracts/facade.ts` (consumer contract) and `core/agents/agent-registry.ts` or `core/agents/agent-schema.ts`. Core files define the type first; contracts duplicate it without importing. Direction of dependency needs inversion or explicit re-export.

4. **Nexus* family (NexusImpactResult, NexusGraphNode, NexusGraphEdge, NexusContextResult, etc.)** — 15+ types duplicated between `contracts/operations/nexus.ts` and `core/nexus/*.ts` implementation files. The contracts versions and core versions have **divergent shapes** on at least `NexusImpactResult` (verified), meaning neither can be used as-is for the other.

5. **StickyNote* family (StickyNoteStatus, StickyNotePriority, StickyNoteColor, StickyConvertResult)** — duplicated between `contracts/operations/sticky.ts` and `core/sticky/types.ts`. Core owns the implementation; contracts duplicates it without referencing core.

---

## 2. Duplicates Table (most critical first)

### Category: SHAPE CONFLICT — requires reconciliation before migration

| Type Name | Location 1 (cleo/contracts) | Location 2 (core) | Shape Match? | Recommended Canonical | Reconciliation Strategy |
|-----------|-----------------------------|--------------------|--------------|----------------------|------------------------|
| `EngineResult` | `cleo/dispatch/domains/_base.ts:20` — `interface { success: boolean; data?: unknown; error?: { code: string; ... } }` (non-discriminated) | `core/src/engine-result.ts:50` — `type EngineResult<T> = EngineSuccess<T> \| EngineFailure` (proper discriminated union, generic) | **NO — structural mismatch** | `core/engine-result.ts` | Delete `_base.ts` interface. In `wrapResult()` in `_base.ts`, the parameter typed as `EngineResult` should be changed to accept `EngineResult<unknown>` from core. The `envelopeToEngineResult()` internal helper can return `EngineResult<unknown>` directly. The 22 domain handler files import from `_base.js` only for `wrapResult`/`errorResult`/`handleErrorResult` functions — not the interface itself — so migration is purely at the function-parameter level. |
| `GateStatus` | `contracts/operations/lifecycle.ts:26` — `'passed' \| 'failed' \| 'blocked' \| null` | `contracts/status-registry.ts:65` — `(typeof GATE_STATUSES)[number]` where `GATE_STATUSES = ['pending', 'passed', 'failed', 'waived']` | **NO — value sets differ** (`blocked`/`null` vs `pending`/`waived`) | `status-registry.ts` (array-backed, single source) | `operations/lifecycle.ts` must import `GateStatus` from `status-registry.ts` and update callers that rely on `'blocked'` or `null` literal. This is a contracts-internal conflict. |
| `TaskPriority` | `contracts/operations/tasks.ts:26` — `'low' \| 'medium' \| 'high' \| 'critical'` | `contracts/task.ts:42` — `'critical' \| 'high' \| 'medium' \| 'low'` | Same values, order differs | `contracts/task.ts` (primary Task definition file) | Delete from `operations/tasks.ts`, import from `task.ts`. Order difference is irrelevant for union types but should be standardized to `critical \| high \| medium \| low` to match severity ordering. |
| `NexusImpactResult` | `contracts/operations/nexus.ts:804` — has `targetLabel: string \| null`, `why: boolean`, structured fields | `core/nexus/impact.ts:50` — has `targetName: unknown`, `targetKind: unknown`, missing `targetLabel` | **NO — divergent shapes** | `contracts/operations/nexus.ts` (consumer-facing) | Core implementation must update its result shape to match contracts and import contracts type. All 15 Nexus* duplicates should be audited for shape divergence before mass migration. |
| `DoctorReport` | `contracts/agent-registry-v3.ts:197` | `core/system/health.ts:526` | Unknown — not verified | `contracts/agent-registry-v3.ts` | Verify shapes; core implementation should import from contracts. |

### Category: CONTRACTS+CORE duplicates (contracts is canonical; core must import)

These 88 type names appear in both packages. In all cases where contracts already defines the type, core implementations should import from `@cleocode/contracts` rather than redeclaring.

| Type Name | Contracts Location | Core Location (shadow) | Callers in core | Priority |
|-----------|-------------------|------------------------|-----------------|----------|
| `TaskRole` | `contracts/task.ts:53` | `core/store/tasks-schema.ts:99` | Schema file only | HIGH — Drizzle schema types should derive from contracts |
| `TaskScope` | `contracts/task.ts:66` | `core/store/tasks-schema.ts:115` | Schema file only | HIGH |
| `TaskSeverity` | `contracts/task.ts:78` | `core/store/tasks-schema.ts:131` | Schema file only | HIGH |
| `AgentCapacity` | `contracts/facade.ts:162` | `core/agents/agent-registry.ts:50` | agent-registry.ts | HIGH |
| `AgentHealthStatus` | `contracts/facade.ts:180` | `core/agents/health-monitor.ts:42` | health-monitor.ts | HIGH |
| `AgentInstanceRow` | `contracts/facade.ts:118` | `core/agents/agent-schema.ts:103` | agent-schema.ts (Drizzle infer) | MEDIUM — Drizzle `$inferSelect` can't import contracts type; keep core version |
| `AgentInstanceStatus` | `contracts/facade.ts:96` | `core/agents/agent-schema.ts:107` | Schema file | MEDIUM |
| `AgentType` | `contracts/facade.ts:110` | `core/agents/agent-schema.ts:108` | Schema file | MEDIUM |
| `RegisterAgentOptions` | `contracts/facade.ts:148` | `core/agents/registry.ts:47` | registry.ts | HIGH |
| `BrainMemoryTier` | `contracts/brain.ts:21` | `core/store/memory-schema.ts:30` | memory-schema.ts | HIGH |
| `BrainCognitiveType` | `contracts/brain.ts:33` | `core/store/memory-schema.ts:48` | memory-schema.ts | HIGH |
| `BrainSourceConfidence` | `contracts/brain.ts:48` | `core/store/memory-schema.ts:66` | memory-schema.ts | HIGH |
| `BrainNodeType` | `contracts/operations/brain.ts:68` | `core/store/memory-schema.ts:864` | memory-schema.ts | HIGH |
| `BrainObservationType` | `contracts/facade.ts:46` | `core/memory/brain-retrieval.ts:151` | brain-retrieval.ts | HIGH |
| `BrainSearchHit` | `contracts/operations/brain.ts:563` | `core/memory/brain-row-types.ts:25` | brain-row-types.ts | HIGH |
| `ContradictionDetail` | `contracts/brain.ts:75` | `core/memory/index.ts:853` | memory/index.ts | HIGH |
| `MemoryBridgeConfig` | `contracts/memory.ts:56` | `core/memory/memory-bridge.ts:32` | memory-bridge.ts | HIGH |
| `ManifestEntry` | `contracts/operations/research.ts:30` | `core/memory/index.ts:45` + `core/memory/pipeline-manifest-sqlite.ts:44` + `core/skills/types.ts:369` + `core/validation/compliance.ts:39` + `core/validation/manifest.ts:20` | Multiple core files | CRITICAL — 6 occurrences, including 5 in core |
| `ResearchEntry` | `contracts/operations/research.ts:14` | `core/memory/index.ts:25` | memory/index.ts | HIGH |
| `StickyNoteStatus` | `contracts/operations/sticky.ts:22` | `core/sticky/types.ts:13` | sticky/ops.ts etc | HIGH |
| `StickyNotePriority` | `contracts/operations/sticky.ts:32` | `core/sticky/types.ts:23` | sticky/ops.ts | HIGH |
| `StickyNoteColor` | `contracts/operations/sticky.ts:27` | `core/sticky/types.ts:18` | sticky/ops.ts | HIGH |
| `StickyConvertResult` | `contracts/operations/sticky.ts:225` | `core/sticky/ops.ts:103` | sticky/ops.ts | HIGH |
| `SpawnContext` | `contracts/spawn.ts:14` | `core/orchestration/index.ts:116` | orchestration/index.ts | HIGH |
| `SpawnResult` | `contracts/spawn.ts:21` | `core/sentient/tick.ts:214` | sentient/tick.ts | HIGH |
| `DecisionRecord` | `contracts/operations/session.ts:117` | `core/sessions/types.ts:91` | sessions/types.ts | HIGH |
| `SessionHistoryEntry` | `contracts/operations/session.ts:182` | `core/sessions/session-history.ts:14` | session-history.ts | HIGH |
| `TaskStartResult` | `contracts/facade.ts:253` | `core/task-work/index.ts:41` | task-work/index.ts | HIGH |
| `TaskDepsResult` | `contracts/results.ts:276` | `core/phases/deps.ts:55` | phases/deps.ts | HIGH |
| `Wave` | `contracts/operations/orchestrate.ts:18` | `core/orchestration/waves.ts:11` | orchestration/waves.ts | HIGH |
| `LifecycleHistoryEntry` | `contracts/operations/lifecycle.ts:108` | `core/lifecycle/index.ts:545` | lifecycle/index.ts | HIGH |
| `EvidenceRecord` | `contracts/evidence-record.ts:174` | `core/lifecycle/evidence.ts:24` | lifecycle/evidence.ts | HIGH |
| `ComplianceMetrics` | `contracts/operations/validate.ts:22` | `core/validation/compliance.ts:18` | validation/compliance.ts | MEDIUM |
| `DependencyCheckResult` | `contracts/dependency.ts:51` | `core/tasks/dependency-check.ts:12` | tasks/dependency-check.ts | MEDIUM |
| `ReleaseGate` | `contracts/operations/release.ts:12` | `core/release/release-config.ts:183` | release-config.ts | MEDIUM |
| `ChangelogSection` | `contracts/operations/release.ts:19` | `core/ui/changelog.ts:109` | ui/changelog.ts | MEDIUM |
| `ModelTransport` | `contracts/operations/llm.ts:13` | `core/llm/types-config.ts:16` + `core/llm/types.ts:34` | llm module | HIGH |
| `PromptCachePolicyMode` | `contracts/operations/llm.ts:16` | `core/llm/types-config.ts:19` | llm module | HIGH |
| `PromptCachePolicy` | `contracts/operations/llm.ts:19` | `core/llm/types-config.ts:22` | llm module | HIGH |
| `LLMCallResult` | `contracts/operations/llm.ts:103` | `core/llm/types-config.ts:57` | llm module | HIGH |
| `ModelConfig` | `contracts/operations/llm.ts:29` | `core/llm/types-config.ts:32` | llm module | HIGH |
| `HybridSearchOptions` | `contracts/facade.ts:49` | `core/memory/brain-search.ts:831` | brain-search.ts | MEDIUM |
| `BlastRadius` | `contracts/facade.ts:235` | `core/intelligence/types.ts:334` | intelligence/types.ts | MEDIUM |
| `BlastRadiusSeverity` | `contracts/facade.ts:200` | `core/intelligence/types.ts:329` | intelligence/types.ts | MEDIUM |
| `ImpactedTask` | `contracts/facade.ts:203` | `core/intelligence/types.ts:258` | intelligence/types.ts | MEDIUM |
| `ImpactReport` | `contracts/facade.ts:221` | `core/intelligence/types.ts:296` | intelligence/types.ts | MEDIUM |
| `HealthCheck` | `contracts/operations/system.ts:11` | `core/system/health.ts:125` | system/health.ts | MEDIUM |
| `DoctorReport` | `contracts/agent-registry-v3.ts:197` | `core/system/health.ts:526` | system/health.ts | MEDIUM — shapes may diverge |
| `ArchiveMetadata` | `contracts/archive.ts:10` | `core/system/archive-analytics.ts:20` | archive-analytics.ts | MEDIUM |
| `ArchiveReportType` | `contracts/archive.ts:23` | `core/system/archive-analytics.ts:37` | archive-analytics.ts | MEDIUM |
| `CycleTimeDistribution` | `contracts/archive.ts:63` | `core/system/archive-analytics.ts:77` | archive-analytics.ts | MEDIUM |
| `CycleTimePercentiles` | `contracts/archive.ts:71` | `core/system/archive-analytics.ts:85` | archive-analytics.ts | MEDIUM |
| `BackupScope` | `contracts/backup-manifest.ts:24` | `core/store/sqlite-backup.ts:327` | sqlite-backup.ts | MEDIUM |
| `ArchiveFields` | `contracts/data-accessor.ts:41` | `core/store/db-helpers.ts:23` | db-helpers.ts | MEDIUM |
| `LogQueryResult` | `contracts/results.ts:157` | `core/observability/types.ts:95` | observability/types.ts | LOW |
| `LogLevel` | `contracts/config.ts:72` | `core/migration/logger.ts:25` | migration/logger.ts | LOW |
| `DispatchStrategy` | `contracts/operations/skills.ts:15` | `core/skills/types.ts:214` | skills/types.ts | LOW |
| `SkillSummary` | `contracts/operations/skills.ts:17` | `core/skills/types.ts:122` | skills/types.ts | LOW |
| `ValidationIssue` | `contracts/operations/skills.ts:68` | `core/orchestration/validate-spawn.ts:13` + `core/skills/validation.ts:24` | 2 core files | LOW |
| `IssueSeverity` | `contracts/operations/issues.ts:13` | `core/skills/validation.ts:21` | skills/validation.ts | LOW |
| `GateName` | `contracts/warp-chain.ts:41` | `core/validation/verification.ts:29` | verification.ts | LOW |
| `GateResult` | `contracts/warp-chain.ts:169` | `core/memory/extraction-gate.ts:72` | extraction-gate.ts | LOW |
| `ProtocolType` | `contracts/warp-chain.ts:26` | `core/orchestration/protocol-validators.ts:72` | protocol-validators.ts | LOW |
| `AdrStatus` | `contracts/status-registry.ts:64` | `core/orchestration/protocol-validators.ts:654` | protocol-validators.ts | LOW |
| `SigilCard` | `contracts/operations/memory.ts:1212` | `core/nexus/sigil.ts:39` | nexus/sigil.ts | LOW |
| **Nexus family (15 types)** | `contracts/operations/nexus.ts` | `core/nexus/*.ts` | nexus module | MEDIUM-HIGH — shapes must be verified before migration |

_(NexusGraphNode, NexusGraphEdge, NexusContextResult, NexusClustersResult, NexusCommunityEntry, NexusDiffResult, NexusFlowEntry, NexusFlowsResult, NexusHotPath, NexusHotPathsResult, NexusHotNode, NexusHotNodesResult, NexusColdSymbol, NexusColdSymbolsResult, NexusPermissionLevel, NexusProjectStats, NexusHealthStatus — see operations/nexus.ts for full list)_

### Category: CONTRACTS-INTERNAL duplicates (within contracts/ itself)

| Type Name | Location 1 | Location 2 | Shape Match? | Recommended Resolution |
|-----------|-----------|-----------|--------------|----------------------|
| `GateStatus` | `operations/lifecycle.ts:26` — `'passed' \| 'failed' \| 'blocked' \| null` | `status-registry.ts:65` — `'pending' \| 'passed' \| 'failed' \| 'waived'` | **NO — conflict** | Canonical is `status-registry.ts`. `operations/lifecycle.ts` definition is inconsistent (extra `null`, missing `pending`/`waived`). Must reconcile value sets before deduplication. |
| `TaskPriority` | `operations/tasks.ts:26` — `'low' \| 'medium' \| 'high' \| 'critical'` | `task.ts:42` — `'critical' \| 'high' \| 'medium' \| 'low'` | Structurally same, order differs | `task.ts` is canonical. Delete from `operations/tasks.ts`. |
| `SessionStartResult` | `operations/session.ts:216` | `session.ts:148` | Unknown | `session.ts` is canonical. Re-export from `operations/session.ts`. |
| `AttachmentKind` | `attachment.ts:174` | `operations/docs.ts:56` | Likely same | `attachment.ts` is canonical. `operations/docs.ts` should re-export. |
| `AttachmentMetadata` | `attachment.ts:185` | `operations/docs.ts:63` | Likely same | `attachment.ts` is canonical. `operations/docs.ts` should re-export. |
| `ConduitSendResult` | `conduit.ts:123` | `operations/conduit.ts:188` | Unknown | `conduit.ts` is canonical. `operations/conduit.ts` should re-export. |
| `NexusWikiResult` | `nexus-wiki-ops.ts:25` | `operations/nexus.ts:903` | Unknown | `operations/nexus.ts` is canonical. Delete `nexus-wiki-ops.ts` version or vice versa. |

### Category: CORE-INTERNAL duplicates (within core/ itself — 29 names)

| Type Name | Locations | Note |
|-----------|-----------|------|
| `ManifestEntry` | `memory/index.ts:45`, `memory/pipeline-manifest-sqlite.ts:44`, `skills/types.ts:369`, `validation/compliance.ts:39`, `validation/manifest.ts:20` (ALSO in contracts) | 6 total occurrences. Most impactful core-internal duplicate. |
| `ProtocolViolation` | `compliance/protocol-rules.ts:44`, `orchestration/protocol-validators.ts:13`, `validation/protocol-common.ts:18` | All three define same interface with minor field variance (fix optional vs required). Centralize in `compliance/protocol-rules.ts`. |
| `ProtocolValidationResult` | `compliance/protocol-rules.ts:54`, `orchestration/protocol-validators.ts:21`, `validation/protocol-common.ts:25` | Same pattern as above. |
| `ValidationError` | `adrs/validate.ts:22`, `validation/engine.ts:53`, `validation/schema-validator.ts:40` | Three independent definitions. |
| `ValidationResult` | `adrs/validate.ts:28`, `tasks/enforcement.ts:4`, `validation/engine.ts:60`, `validation/schema-validator.ts:32` | Four definitions. |
| `CriticalPathResult` | `nexus/deps.ts:68`, `orchestration/critical-path.ts:17`, `phases/deps.ts:69` | Three definitions likely with different shapes. |
| `CheckResult` | `scaffold.ts:54`, `schema-management.ts:49`, `validation/doctor/checks.ts:32` | Three definitions. |
| `MigrationResult` | `migration/index.ts:98`, `store/migrate-signaldock-to-conduit.ts:50`, `store/migration-sqlite.ts:72` | Three definitions. |
| `ScaffoldResult` | `hooks.ts:18`, `injection.ts:28`, `scaffold.ts:41` | Three definitions. |
| `AnalysisResult` | `orchestration/index.ts:138`, `tasks/analyze.ts:11` | Two definitions. |
| `AtomicityResult` | `orchestration/atomicity.ts:61`, `tasks/atomicity.ts:10` | Two definitions. |
| `CycleTimeDistribution` | `system/archive-analytics.ts:77` (also in contracts/archive.ts) | Core-internal; see CONTRACTS+CORE above. |
| `CycleTimePercentiles` | `system/archive-analytics.ts:85` (also in contracts/archive.ts) | Same. |
| `EnforcementMode` | `lifecycle/index.ts:109`, `sessions/session-enforcement.ts:37` | Two definitions within core. |
| `DependencyAnalysis` | `orchestration/analyze.ts:22`, `skills/types.ts:316` | Two definitions. |
| `DependencyWave` | `skills/types.ts:304`, `tasks/graph-ops.ts:13` | Two definitions. |
| `DispatchResult` | `playbooks/agent-dispatcher.ts:98`, `skills/types.ts:217` | Two definitions. |
| `DriftReport` | `sessions/drift-watchdog.ts:36`, `validation/docs-sync.ts:25` | Two definitions. |
| `EnrichedWave` | `formatters/waves.ts:53`, `orchestration/waves.ts:57` | Two definitions (formatters variant may extend orchestration type). |
| `FlatTreeNode` | `formatters/tree.ts:159`, `tasks/task-ops.ts:53` | Two definitions. |
| `ImportResult` | `admin/import.ts:27`, `snapshot/index.ts:65` | Two definitions with different semantics. |
| `IssueTemplate` | `issue/template-parser.ts:32`, `templates/parser.ts:34` | Two definitions. |
| `ManifestValidationResult` | `skills/types.ts:385`, `validation/manifest.ts:42` | Two definitions. |
| `Skill` | `skills/types.ts:107`, `store/signaldock-schema.ts:430` | Two definitions (Drizzle infer vs domain type). |
| `SkillSearchPath` | `skills/skill-paths.ts:27`, `skills/types.ts:203` | Two definitions within skills module. |
| `SchemaCompatWarning` | `store/backup-unpack.ts:94`, `store/restore-conflict-report.ts:54` | Two definitions in backup/restore module. |
| `SystemInfo` | `platform.ts:236`, `system/platform-paths.ts:50` | Two definitions in platform module. |
| `TestFramework` | `orchestration/protocol-validators.ts:891`, `store/project-detect.ts:29` | Two definitions with different shapes. |
| `VerificationResult` | `migration/checksum.ts:21`, `validation/operation-verification-gates.ts:75` | Two definitions with different semantics. |

### Category: CLEO+CORE duplicates (cleo must import from core)

| Type Name | Cleo Location | Core Location | Issue | Resolution |
|-----------|--------------|---------------|-------|------------|
| `EngineResult` | `cleo/dispatch/domains/_base.ts:20` (interface) | `core/engine-result.ts:50` (discriminated union type) | Shape conflict — see #1 above | Delete cleo version; domain handlers already re-export core's `EngineResult` from engines |
| `RateLimitConfig` | `cleo/dispatch/middleware/rate-limiter.ts:16` | `core/security/input-sanitization.ts:197` | Shape unknown; cleo's version has `limit`/`remaining`/`windowMs` fields | Verify shapes; if identical, cleo imports from core |
| `RepairResult` | `cleo/migrations/2026-04-25-t991-parent-link-repair.ts:83` | `core/sequence/index.ts:229` | Unrelated types sharing a common name; migration-specific vs sequence-specific | Both A: STAY — unrelated contexts, generic name collision |
| `Resolution` | `cleo/dispatch/registry.ts:43` | `core/store/restore-json-merge.ts:77` | Unrelated types sharing a common name | Both A: STAY — dispatch-registry resolution vs JSON-merge resolution |

---

## 3. Migration Candidates Table

### From `packages/cleo/src/` → `packages/contracts/src/`

These cleo types are consumer-facing or cross-package contract shapes:

| Type Name | Current Location | Recommended Move | Blast Radius (callers) | Notes |
|-----------|-----------------|-----------------|----------------------|-------|
| `DispatchRequest` | `cleo/dispatch/types.ts:84` | `contracts/` (new file `dispatch.ts`) | ~12 cleo files; also used by `cleo-os` adapter | Consumer-facing — SDK users invoking the dispatch layer need this type |
| `DispatchResponse` | `cleo/dispatch/types.ts:147` | `contracts/dispatch.ts` | ~15 cleo files; `cleo-os` adapter | Consumer-facing |
| `DispatchError` | `cleo/dispatch/types.ts:122` | `contracts/dispatch.ts` | ~8 cleo files | Consumer-facing; referenced in error handling |
| `DomainHandler` | `cleo/dispatch/types.ts:182` | `contracts/dispatch.ts` | ~12 domain handler files | Cross-package contract for domain implementations |
| `Gateway` | `cleo/dispatch/types.ts:16` | `contracts/dispatch.ts` | Many files | Already-narrow type; should be SSoT in contracts |
| `CanonicalDomain` | `cleo/dispatch/types.ts:72` | `contracts/dispatch.ts` | Many files | Cross-package reference for domain names |
| `Middleware` | `cleo/dispatch/types.ts:206` | `contracts/dispatch.ts` | ~5 middleware files | Dispatch middleware contract |
| `OperationDef` | `cleo/dispatch/registry.ts:14` | `contracts/` | ~5 files | Operation registry contract |
| `BackgroundJob` | `cleo/dispatch/lib/background-jobs.ts:33` | `contracts/` | 3 files | Could be needed by external orchestrators |

### From `packages/cleo/src/` → STAY (A classification)

See section 4.

### From `packages/core/src/` → `packages/contracts/src/`

These core types are exposed via `internal.ts` and used by cross-package consumers but have no contracts counterpart:

| Type Name | Current Location | Recommended Move | Priority | Notes |
|-----------|-----------------|-----------------|----------|-------|
| `ProjectHealthReport` | `core/system/project-health.ts:158` | `contracts/system.ts` | HIGH | Exported via `core/internal.ts`; external consumers need it |
| `FullHealthReport` | `core/system/project-health.ts:202` | `contracts/system.ts` | HIGH | Same |
| `GlobalHealthReport` | `core/system/project-health.ts:185` | `contracts/system.ts` | HIGH | Same |
| `DiagnosticsResult` | `core/system/health.ts:145` | `contracts/system.ts` | HIGH | Exported via `core/internal.ts` |
| `HealthResult` | `core/system/health.ts:131` | `contracts/system.ts` | HIGH | Exported via `core/internal.ts` |
| `BackfillResult` | `core/backfill/index.ts:47` | `contracts/backfill.ts` | MEDIUM | Exported via `core/internal.ts` |
| `BackfillOptions` | `core/backfill/index.ts:25` | `contracts/backfill.ts` | MEDIUM | Same |
| `BackfillTaskChange` | `core/backfill/index.ts:35` | `contracts/backfill.ts` | MEDIUM | Same |
| `BootstrapContext` | `core/bootstrap.ts:30` | `contracts/` | LOW | Used by postinstall/self-update |
| `BootstrapOptions` | `core/bootstrap.ts:37` | `contracts/` | LOW | Same |
| `RetryPolicy` | `core/agents/retry.ts:23` | `contracts/agents.ts` | MEDIUM | Agent SDK users need retry policy types |
| `RetryResult<T>` | `core/agents/retry.ts:130` | `contracts/agents.ts` | MEDIUM | Same |
| `AgentRecoveryResult` | `core/agents/retry.ts:200` | `contracts/agents.ts` | MEDIUM | Same |
| `CapacitySummary` | `core/agents/capacity.ts:108` | `contracts/agents.ts` | LOW | Capacity management type |
| `AdrRecord` | `core/adrs/types.ts:28` | `contracts/adr.ts` | LOW | External consumers may need ADR types |

---

## 4. STAY Justifications (A classification)

### `packages/cleo/src/` types that legitimately remain:

| Type Name | Location | Reason to Stay |
|-----------|----------|----------------|
| `AuditColumnBackfillEntry` | `backfill/audit-columns.ts:36` | One-time migration artifact specific to the git-lineage reconstruction logic for T1321. CLI-only internal detail. |
| `AuditColumnBackfillResult` | `backfill/audit-columns.ts:60` | Same — CLI migration artifact. |
| `AuditColumnBackfillOptions` | `backfill/audit-columns.ts:78` | Same. |
| `ProfileValidation` | `cli/commands/agent-profile-status.ts:30` | CLI rendering type for agent profile display. Not a cross-package contract. |
| `ProfileStatus` | `cli/commands/agent-profile-status.ts:59` | CLI-only display type. |
| `RunDoctorProjectsOptions` | `cli/commands/doctor-projects.ts:34` | CLI command invocation options. Thin dispatch wrapper. |
| `ProgressOptions` | `cli/progress.ts:10` | Terminal progress bar rendering — CLI-only. |
| `CliOutputOptions` | `cli/renderers/index.ts:119` | CLI rendering helper — no external consumer. |
| `CliErrorDetails` | `cli/renderers/index.ts:293` | CLI error rendering — no external consumer. |
| `LafsShapeViolation` | `cli/renderers/lafs-validator.ts:37` | CLI-only LAFS shape validation for output rendering. |
| `RenderWavesMode` | `cli/renderers/system.ts:239` | CLI rendering enum. |
| `RenderWavesOptions` | `cli/renderers/system.ts:244` | CLI rendering options. |
| `TreeContext` | `cli/tree-context.ts:20` | CLI tree rendering internal. |
| `OpsFromCore<C>` | `dispatch/adapters/typed.ts:141` | Internal dispatch generic utility; cleo-specific adapter type. |
| `TypedOpRecord` | `dispatch/adapters/typed.ts:165` | Internal dispatch type. |
| `TypedDomainHandler<O>` | `dispatch/adapters/typed.ts:187` | Internal dispatch type. |
| `SessionContext` | `dispatch/context/session-context.ts:14` | Dispatch-layer session context; internal to cleo dispatch pipeline. |
| `DispatcherConfig` | `dispatch/dispatcher.ts:66` | Internal dispatcher configuration. Not consumed externally. |
| `KnownProviderId` | `dispatch/domains/admin/smoke-provider.ts:51` | Admin-only literal type for provider smoke tests. |
| `CanonViolation` | `dispatch/domains/check/canon.ts:25` | Canon check implementation type — internal to cleo domain handler. |
| `CanonDocAssertion` | `dispatch/domains/check/canon.ts:35` | Same. |
| `CanonCheckResult` | `dispatch/domains/check/canon.ts:45` | Same. |
| `CanonCheckParams` | `dispatch/domains/check/canon.ts:167` | Same. |
| `IvtrOps` | `dispatch/domains/ivtr.ts:404` | Internal ops helper type for IVTR domain. |
| `NexusImpactAffectedSymbol` | `dispatch/domains/nexus.ts:1133` | Local rendering type inside nexus domain handler. |
| `OrchestrateDispatchOps` | `dispatch/domains/orchestrate.ts:513` | Internal ops helper. |
| `PipelineOps` | `dispatch/domains/pipeline.ts:446` | Internal ops helper. |
| `PlaybookRuntimeOverrides` | `dispatch/domains/playbook.ts:90` | Local playbook handler option type. |
| `ReleaseOps` | `dispatch/domains/release.ts:87` | Internal ops helper. |
| `StickyDispatchOps` | `dispatch/domains/sticky.ts:175` | Internal ops helper. |
| `BackgroundJobManagerConfig` | `dispatch/lib/background-jobs.ts:57` | Internal background job manager config. |
| `LifecycleEnforcementConfig` | `dispatch/lib/defaults.ts:20` | Dispatch config fragment — internal to the dispatcher. |
| `ProtocolValidationConfig` | `dispatch/lib/defaults.ts:32` | Same. |
| `DispatchConfig` | `dispatch/lib/defaults.ts:41` | Dispatcher configuration type — may belong in contracts if SDK users configure dispatch. HITL decision. |
| `GatewayMetaRecord` | `dispatch/lib/gateway-meta.ts:27` | Internal gateway metadata utility type. |
| `MviTier` | `dispatch/lib/projections.ts:18` | Distinct from `MVILevel` in lafs — cleo-internal dispatch projection tier. |
| `ProjectionConfig` | `dispatch/lib/projections.ts:27` | Internal projection config for field filtering. |
| `_ProtoEnvelopeStub` | `dispatch/lib/proto-envelope.ts:27` | Intentionally underscore-prefixed stub; internal compatibility shim. |
| `ProjectionContext` | `dispatch/middleware/projection.ts:19` | Internal middleware context. |
| `RateLimitConfig` | `dispatch/middleware/rate-limiter.ts:16` | See CLEO+CORE entry. Verify against core version before deciding. |
| `RateLimitingConfig` | `dispatch/middleware/rate-limiter.ts:29` | Dispatch-level rate limiting config. |
| `OperationDef` | `dispatch/registry.ts:14` | Registry internal — borderline; see migration candidates. |
| `Resolution` | `dispatch/registry.ts:43` | Dispatch-specific resolution type; unrelated to core's JSON-merge resolution. STAY. |
| `Source` | `dispatch/types.ts:19` | `'cli'` literal — may broaden in the future; for now CLI-only. |
| `Tier` | `dispatch/types.ts:27` | Dispatch tier (0/1/2). CLI-internal detail. |
| `DispatchNext` | `dispatch/types.ts:198` | Internal middleware continuation type. |
| `ChildTaskId` | `migrations/2026-04-25-t991-parent-link-repair.ts:64` | One-time migration artifact. |
| `RepairResult` | `migrations/2026-04-25-t991-parent-link-repair.ts:83` | One-time migration artifact (distinct from core's `RepairResult`). |
| `MigrationSummary` | `migrations/2026-04-25-t991-parent-link-repair.ts:94` | One-time migration artifact. |
| `BackgroundJob` | `dispatch/lib/background-jobs.ts:33` | Borderline — see migration candidates above. |

**Note on `DispatchRequest` / `DispatchResponse` / `DispatchError` / `DomainHandler`:**  
These are currently STAY by default (cleo-internal), but the audit recommends migrating them to `contracts/dispatch.ts` because SDK consumers (`cleo-os`, potential external adapters) currently re-type these shapes in `packages/cleo-os`. This is a HITL architectural decision.

---

## 5. Coverage Gaps in `contracts/`

Types that external consumers need but that are absent from `contracts/`:

| Missing Type | Currently Lives In | Why It Belongs in Contracts |
|-------------|-------------------|----------------------------|
| `ProjectHealthReport` | `core/system/project-health.ts` | Exported from `core/internal.ts`; CleoOS doctor, admin smoke test, self-update all consume it |
| `FullHealthReport` | `core/system/project-health.ts` | Same — returned by `cleo doctor` command output |
| `GlobalHealthReport` | `core/system/project-health.ts` | Same — referenced in `cleo/cli/commands/self-update.ts` |
| `DiagnosticsResult` | `core/system/health.ts` | Returned by `diagnostics` domain — consumer-visible |
| `HealthResult` | `core/system/health.ts` | Returned by system health checks — consumer-visible |
| `BackfillResult` | `core/backfill/index.ts` | Exported via `core/internal.ts`; external tools using backfill need the result type |
| `BackfillOptions` | `core/backfill/index.ts` | Same — options for `backfillTasks()` |
| `BackfillTaskChange` | `core/backfill/index.ts` | Same |
| `RetryPolicy` | `core/agents/retry.ts` | Agent SDK users who implement retry logic need this |
| `RetryResult<T>` | `core/agents/retry.ts` | Same |
| `AgentRecoveryResult` | `core/agents/retry.ts` | Same |
| `BootstrapContext` | `core/bootstrap.ts` | Returned by `bootstrapGlobalCleo()`; exported via `core/index.ts` |
| `BootstrapOptions` | `core/bootstrap.ts` | Same |
| `Platform` | `core/platform.ts` | Exported from `core/index.ts` |
| `CapacitySummary` | `core/agents/capacity.ts` | Agent capacity management output |
| `AdrRecord` / `AdrFrontmatter` | `core/adrs/types.ts` | ADR tooling consumers need these shapes |
| `SessionBriefingShowResult` | `contracts/operations/session.ts:171` | **Already noted in contracts** but typed as `unknown` — should be properly typed using `SessionBriefing` from core |

---

## 6. Special Finding: EngineResult Conflict — Detailed Analysis

**File 1**: `packages/cleo/src/dispatch/domains/_base.ts:20`
```typescript
// Non-discriminated interface — cannot narrow on success
export interface EngineResult {
  success: boolean;
  data?: unknown;
  page?: import('@cleocode/lafs').LAFSPage;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    exitCode?: number;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
    problemDetails?: ProblemDetails;
  };
}
```

**File 2**: `packages/core/src/engine-result.ts:50`
```typescript
// Proper discriminated union — narrows cleanly on success/failure
export type EngineResult<T = unknown> = EngineSuccess<T> | EngineFailure;
// EngineSuccess<T>: { readonly success: true; readonly data: T; readonly page?: LAFSPage }
// EngineFailure:    { readonly success: false; readonly error: EngineErrorPayload }
```

**Structural differences:**
- `_base.ts` version has `error.problemDetails` in the error shape; `engine-result.ts` does not
- `_base.ts` version has `data?: unknown` (optional, non-discriminated); `engine-result.ts` has `data: T` (required on success branch, absent on failure branch)
- `_base.ts` interface is not generic; `engine-result.ts` is generic `<T>`
- `_base.ts` `error.code` is `string`; `engine-result.ts` `error.code` is also `string` — no conflict there

**Usage pattern in cleo:** The domain handlers import `wrapResult()` / `errorResult()` / `handleErrorResult()` from `_base.ts`, which accept the local `EngineResult` interface. The engines (`diagnostics-engine.ts`, `lifecycle-engine.ts`, etc.) already re-export `EngineResult` from `@cleocode/core` — meaning the engines are using the correct type. The domain handlers use `_base.ts`'s version only implicitly (the local function signatures). The `problemDetails` field in `_base.ts` is passed through to `DispatchResponse.error.problemDetails`; this field needs to be added to `EngineErrorPayload` in `core/engine-result.ts` before migration.

**Reconciliation recommendation:**
1. Add `problemDetails?: ProblemDetails` to `EngineErrorPayload` in `core/engine-result.ts`
2. Remove `export interface EngineResult` from `_base.ts`
3. Update `wrapResult()` parameter to `EngineResult<unknown>` from `@cleocode/core`
4. Update `envelopeToEngineResult()` return type accordingly

---

## 7. LAFS Envelope Shape Conformance Note

The `contracts/src/lafs.ts` defines `LAFSEnvelope<T>`, `LafsSuccess<T>`, `LafsError`, `GatewayEnvelope<T>`, `GatewayMeta` etc., which are structurally compatible with `@cleocode/lafs` package types (the comment on line 116-118 of `contracts/lafs.ts` confirms this intent). No LAFS-related type duplication was found that contradicts the `@cleocode/lafs` source; contracts acts as a re-export proxy for LAFS types that cannot take a direct dependency on `@cleocode/lafs`.

The `DispatchResponse.error.problemDetails` field (in `cleo/dispatch/types.ts`) references `ProblemDetails` from `@cleocode/core` — this is correct and consistent with RFC 9457 error shape. No migration needed for LAFS shape types.

---

## 8. Recommended Migration Priority Order

For HITL sequencing of actual migration work:

**Wave 1 — Contracts-internal deduplication (no code migration needed, zero blast radius):**
- `TaskPriority` — delete from `operations/tasks.ts`
- `SessionStartResult` — re-export in `operations/session.ts` from `session.ts`
- `AttachmentKind` / `AttachmentMetadata` — re-export in `operations/docs.ts` from `attachment.ts`
- `ConduitSendResult` — re-export in `operations/conduit.ts` from `conduit.ts`
- `NexusWikiResult` — resolve which file is canonical, delete the other

**Wave 2 — Core fixes (import from contracts instead of redeclaring, high-confidence shape matches):**
- `BrainMemoryTier`, `BrainCognitiveType`, `BrainSourceConfidence` — core/store/memory-schema.ts imports from contracts/brain.ts
- `StickyNote*` family — core/sticky/types.ts imports from contracts/operations/sticky.ts
- `TaskRole`, `TaskScope`, `TaskSeverity` — core/store/tasks-schema.ts imports from contracts/task.ts
- `DecisionRecord` — core/sessions/types.ts imports from contracts/operations/session.ts
- `SessionHistoryEntry` — core/sessions/session-history.ts imports from contracts/operations/session.ts
- LLM family — core/llm/types-config.ts imports from contracts/operations/llm.ts
- `EvidenceRecord` — core/lifecycle/evidence.ts imports from contracts/evidence-record.ts

**Wave 3 — EngineResult reconciliation (highest-impact single fix):**
- Add `problemDetails` to core's `EngineErrorPayload`
- Delete `_base.ts` EngineResult interface
- Update `wrapResult()` parameter type

**Wave 4 — Coverage gaps (add missing types to contracts):**
- `ProjectHealthReport`, `FullHealthReport`, `GlobalHealthReport`, `DiagnosticsResult`, `HealthResult`
- `BackfillResult`, `BackfillOptions`, `BackfillTaskChange`
- `RetryPolicy`, `RetryResult`, `AgentRecoveryResult`

**Wave 5 — DispatchRequest/Response/Error migration to contracts (requires HITL decision):**
- Create `contracts/dispatch.ts`
- Migrate 8-10 dispatch types
- Update all cleo and cleo-os import sites

**Wave 6 — Nexus family shape verification and migration:**
- Verify all 15+ Nexus* types for shape divergence
- Reconcile divergent shapes (NexusImpactResult confirmed divergent)
- Migrate core/nexus/*.ts to import from contracts/operations/nexus.ts

---

*Generated by architectural read-only audit on 2026-05-01. No files were modified during this investigation.*
