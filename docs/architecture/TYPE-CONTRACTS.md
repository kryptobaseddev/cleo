# CLEO Type Contract Reference

**Version**: 1.0.0
**Date**: 2026-03-19
**Status**: Current (post Core Hardening Waves 0-3)

---

## Overview

This document catalogs the complete public type API of `@cleocode/core`. All types listed here are exported from the package root (`import { ... } from '@cleocode/core'`) via either namespace re-exports, flat re-exports, or the `@cleocode/contracts` passthrough.

---

## 1. Facade APIs

The `Cleo` class exposes 10 domain getter properties. Each returns an interface defining the available operations.

| Property | Interface | Description |
|----------|-----------|-------------|
| `cleo.tasks` | `TasksAPI` | Task CRUD, search, hierarchy, archive |
| `cleo.sessions` | `SessionsAPI` | Session lifecycle, handoff, debrief, decisions, context drift |
| `cleo.memory` | `MemoryAPI` | Brain observations, 3-layer retrieval, hybrid search |
| `cleo.orchestration` | `OrchestrationAPI` | Epic analysis, dependency graph, wave computation, progress |
| `cleo.lifecycle` | `LifecycleAPI` | RCASD gate enforcement, stage transitions, history |
| `cleo.release` | `ReleaseAPI` | Changelog, version bump, commit, tag, push, rollback |
| `cleo.admin` | `AdminAPI` | Task export/import |
| `cleo.sticky` | `StickyAPI` | Sticky note CRUD, archive, convert to task/memory |
| `cleo.nexus` | `NexusAPI` | Cross-project registry, discovery, permissions, sharing |
| `cleo.sync` | `SyncAPI` | Provider-agnostic task reconciliation, external task links |

### 1.1 TasksAPI

```typescript
interface TasksAPI {
  add(params: { title, description, parent?, priority?, type?, size?, phase?, labels?, depends?, notes? }): Promise<unknown>;
  find(params: { query?, id?, status?, limit? }): Promise<unknown>;
  show(taskId: string): Promise<unknown>;
  list(params?: { status?, priority?, parentId?, phase?, limit? }): Promise<unknown>;
  update(params: { taskId, title?, status?, priority?, description?, notes? }): Promise<unknown>;
  complete(params: { taskId, notes? }): Promise<unknown>;
  delete(params: { taskId, force? }): Promise<unknown>;
  archive(params?: { before?, taskIds?, dryRun? }): Promise<unknown>;
}
```

### 1.2 SessionsAPI

```typescript
interface SessionsAPI {
  start(params: { name, scope, agent? }): Promise<unknown>;
  end(params?: { note? }): Promise<unknown>;
  status(): Promise<unknown>;
  resume(sessionId: string): Promise<unknown>;
  list(params?: { status?, limit? }): Promise<unknown>;
  find(params?: { status?, scope?, query?, limit? }): Promise<unknown>;
  show(sessionId: string): Promise<unknown>;
  suspend(sessionId: string, reason?: string): Promise<unknown>;
  briefing(params?: { maxNextTasks?, scope? }): Promise<unknown>;
  handoff(sessionId: string, options?: { note?, nextAction? }): Promise<unknown>;
  gc(maxAgeHours?: number): Promise<unknown>;
  recordDecision(params: { sessionId, taskId, decision, rationale, alternatives? }): Promise<unknown>;
  recordAssumption(params: { assumption, confidence, sessionId?, taskId? }): Promise<unknown>;
  contextDrift(params?: { sessionId? }): Promise<unknown>;
  decisionLog(params?: { sessionId?, taskId? }): Promise<unknown>;
  lastHandoff(scope?: { type, epicId? }): Promise<unknown>;
}
```

### 1.3 MemoryAPI

```typescript
interface MemoryAPI {
  observe(params: { text, title?, type? }): Promise<unknown>;
  find(params: { query, limit?, tables? }): Promise<unknown>;
  fetch(params: { ids: string[] }): Promise<unknown>;
  timeline(params: { anchor, depthBefore?, depthAfter? }): Promise<unknown>;
  search(query: string, options?: { limit? }): Promise<unknown>;
  hybridSearch(query: string, options?: HybridSearchOptions): Promise<unknown>;
}
```

### 1.4 OrchestrationAPI

```typescript
interface OrchestrationAPI {
  start(epicId: string): Promise<unknown>;
  analyze(epicId: string): Promise<unknown>;
  readyTasks(epicId: string): Promise<unknown>;
  nextTask(epicId: string): Promise<unknown>;
  context(epicId: string): Promise<unknown>;
  dependencyGraph(tasks: Task[]): unknown;
  epicStatus(epicId: string, title: string, children: Task[]): unknown;
  progress(tasks: Task[]): unknown;
}
```

### 1.5 LifecycleAPI

```typescript
interface LifecycleAPI {
  status(epicId: string): Promise<unknown>;
  startStage(epicId: string, stage: string): Promise<unknown>;
  completeStage(epicId: string, stage: string, artifacts?: string[]): Promise<unknown>;
  skipStage(epicId: string, stage: string, reason: string): Promise<unknown>;
  checkGate(epicId: string, targetStage: string): Promise<unknown>;
  history(epicId: string): Promise<unknown>;
  resetStage(epicId: string, stage: string, reason: string): Promise<unknown>;
  passGate(epicId: string, gateName: string, agent?: string): Promise<unknown>;
  failGate(epicId: string, gateName: string, reason?: string): Promise<unknown>;
  stages: readonly string[];
}
```

### 1.6 ReleaseAPI

```typescript
interface ReleaseAPI {
  prepare(params: { version, tasks?, notes? }): Promise<unknown>;
  commit(params: { version }): Promise<unknown>;
  tag(params: { version }): Promise<unknown>;
  push(params: { version, remote?, explicitPush? }): Promise<unknown>;
  rollback(params: { version, reason? }): Promise<unknown>;
  calculateVersion(current: string, bumpType: string): string;
  bumpVersion(): Promise<unknown>;
}
```

### 1.7 AdminAPI

```typescript
interface AdminAPI {
  export(params?: Record<string, unknown>): Promise<unknown>;
  import(params: Omit<ImportParams, 'cwd'>): Promise<unknown>;
}
```

### 1.8 StickyAPI

```typescript
interface StickyAPI {
  add(params: { content, tags?, priority?, color? }): Promise<unknown>;
  show(stickyId: string): Promise<unknown>;
  list(params?: { status?, color?, priority?, limit? }): Promise<unknown>;
  archive(stickyId: string): Promise<unknown>;
  purge(stickyId: string): Promise<unknown>;
  convert(params: { stickyId, targetType, title?, memoryType?, taskId? }): Promise<unknown>;
}
```

### 1.9 NexusAPI

```typescript
interface NexusAPI {
  init(): Promise<unknown>;
  register(params: { path, name?, permissions? }): Promise<unknown>;
  unregister(params: { name }): Promise<unknown>;
  list(): Promise<unknown>;
  show(params: { name }): Promise<unknown>;
  sync(params?: { name? }): Promise<unknown>;
  discover(params: { query, method?, limit? }): Promise<unknown>;
  search(params: { pattern, project?, limit? }): Promise<unknown>;
  setPermission(params: { name, level }): Promise<unknown>;
  sharingStatus(): Promise<unknown>;
}
```

### 1.10 SyncAPI

```typescript
interface SyncAPI {
  reconcile(params: {
    externalTasks: ExternalTask[];
    providerId: string;
    dryRun?: boolean;
    conflictPolicy?: ReconcileOptions['conflictPolicy'];
    defaultPhase?: string;
    defaultLabels?: string[];
  }): Promise<ReconcileResult>;
  getLinks(providerId: string): Promise<ExternalTaskLink[]>;
  getTaskLinks(taskId: string): Promise<ExternalTaskLink[]>;
  removeProviderLinks(providerId: string): Promise<number>;
}
```

---

## 2. New APIs from Core Hardening

### 2.1 Agents Module (`agents` namespace)

Added in Wave 2. Provides runtime agent instance tracking, health monitoring, self-healing, and capacity management.

**Registry Operations:**

| Function | Signature | Purpose |
|----------|-----------|---------|
| `registerAgent` | `(opts: RegisterAgentOptions) => Promise<AgentInstanceRow>` | Create a new agent with starting status |
| `deregisterAgent` | `(id: string) => Promise<void>` | Mark agent as stopped |
| `heartbeat` | `(id: string) => Promise<AgentInstanceStatus>` | Update heartbeat, return current status |
| `listAgentInstances` | `(filters?: ListAgentFilters) => Promise<AgentInstanceRow[]>` | Multi-field filtered listing |
| `getAgentInstance` | `(id: string) => Promise<AgentInstanceRow \| null>` | Lookup by ID |
| `updateAgentStatus` | `(id: string, opts: UpdateStatusOptions) => Promise<void>` | Status transitions with error tracking |
| `incrementTasksCompleted` | `(id: string) => Promise<void>` | Atomic counter increment |
| `generateAgentId` | `() => string` | Format: `agt_{YYYYMMDDHHmmss}_{6hex}` |

**Health Monitoring:**

| Function | Signature | Purpose |
|----------|-----------|---------|
| `checkAgentHealth` | `(thresholdMs?: number) => Promise<AgentInstanceRow[]>` | Find agents with stale heartbeats |
| `markCrashed` | `(id: string, reason?: string) => Promise<void>` | Set crashed status with error logging |
| `getHealthReport` | `(thresholdMs?: number) => Promise<AgentHealthReport>` | Full status summary |

**Self-Healing / Retry:**

| Function | Signature | Purpose |
|----------|-----------|---------|
| `createRetryPolicy` | `(opts?) => RetryPolicy` | Configurable retry policy |
| `withRetry` | `<T>(fn, policy?) => Promise<RetryResult<T>>` | Wrap async fn with retry logic |
| `shouldRetry` | `(error, attempt, policy) => boolean` | Determine if retry is warranted |
| `calculateDelay` | `(attempt, policy) => number` | Exponential backoff with jitter |
| `recoverCrashedAgents` | `(thresholdMs?) => Promise<AgentRecoveryResult>` | Recover crashed agents |
| `classifyError` | `(error) => AgentErrorType` | Classify as retriable/permanent/unknown |

**Capacity Tracking:**

| Function | Signature | Purpose |
|----------|-----------|---------|
| `getAvailableCapacity` | `() => Promise<number>` | Sum capacity of active/idle agents |
| `findLeastLoadedAgent` | `(type?) => Promise<AgentInstanceRow \| null>` | Agent with highest capacity |
| `updateCapacity` | `(id, capacity) => Promise<void>` | Set capacity (0.0-1.0) |
| `isOverloaded` | `(threshold?) => Promise<boolean>` | System below capacity threshold |
| `getCapacitySummary` | `(threshold?) => Promise<CapacitySummary>` | Full capacity summary |

**Types exported:** `AgentInstanceRow`, `NewAgentInstanceRow`, `AgentErrorLogRow`, `NewAgentErrorLogRow`, `AgentInstanceStatus`, `AgentType`, `AgentErrorType`, `AgentHealthReport`, `ListAgentFilters`, `RegisterAgentOptions`, `UpdateStatusOptions`, `RetryPolicy`, `RetryResult`, `AgentRecoveryResult`, `CapacitySummary`

### 2.2 Intelligence Module (`intelligence` namespace)

Added in Wave 3. Provides quality prediction, pattern extraction, and impact analysis.

**Prediction:**

| Function | Signature | Purpose |
|----------|-----------|---------|
| `calculateTaskRisk` | `(taskId, taskAccessor, brainAccessor) => Promise<RiskAssessment>` | Multi-factor risk scoring |
| `predictValidationOutcome` | `(taskId, stage, taskAccessor, brainAccessor) => Promise<ValidationPrediction>` | Gate pass likelihood |
| `gatherLearningContext` | `(task, brainAccessor) => Promise<LearningContext>` | Applicable learnings for a task |

**Pattern Extraction:**

| Function | Signature | Purpose |
|----------|-----------|---------|
| `extractPatternsFromHistory` | `(taskAccessor, brainAccessor, options?) => Promise<DetectedPattern[]>` | Auto-detect patterns |
| `matchPatterns` | `(taskId, taskAccessor, brainAccessor) => Promise<PatternMatch[]>` | Match task against known patterns |
| `storeDetectedPattern` | `(detected, brainAccessor) => Promise<string>` | Save pattern to brain_patterns |
| `updatePatternStats` | `(patternId, outcome, brainAccessor) => Promise<PatternStatsUpdate>` | Update frequency/success rate |

**Impact Analysis:**

| Function | Signature | Purpose |
|----------|-----------|---------|
| `analyzeTaskImpact` | `(taskId, accessor?, cwd?) => Promise<ImpactAssessment>` | Full dependency impact assessment |
| `analyzeChangeImpact` | `(taskId, changeType, accessor?, cwd?) => Promise<ChangeImpact>` | Predict effects of a change |
| `calculateBlastRadius` | `(taskId, accessor?, cwd?) => Promise<BlastRadius>` | Quantified scope of impact |

**Types exported:** `RiskFactor`, `RiskAssessment`, `ValidationPrediction`, `DetectedPattern`, `PatternMatch`, `PatternExtractionOptions`, `PatternStatsUpdate`, `LearningContext`, `ImpactAssessment`, `ChangeImpact`, `AffectedTask`, `BlastRadius`, `BlastRadiusSeverity`, `ChangeType`

---

## 3. Validation Schemas

### 3.1 Zod Enum Schemas (34 total)

All exported from the public barrel as flat re-exports. Each wraps the corresponding `as const` array as single source of truth.

**Task enums (4):**

| Schema | Values |
|--------|--------|
| `taskStatusSchema` | `pending`, `active`, `blocked`, `done`, `cancelled`, `archived` |
| `taskPrioritySchema` | `critical`, `high`, `medium`, `low` |
| `taskTypeSchema` | `epic`, `task`, `subtask` |
| `taskSizeSchema` | `small`, `medium`, `large` |

**Session enums (1):**

| Schema | Values |
|--------|--------|
| `sessionStatusSchema` | `active`, `ended`, `orphaned`, `suspended` |

**Lifecycle enums (6):**

| Schema | Values |
|--------|--------|
| `lifecyclePipelineStatusSchema` | `active`, `completed`, `blocked`, `failed`, `cancelled`, `aborted` |
| `lifecycleStageStatusSchema` | `not_started`, `in_progress`, `blocked`, `completed`, `skipped`, `failed` |
| `lifecycleStageNameSchema` | `research`, `consensus`, `architecture_decision`, `specification`, `decomposition`, `implementation`, `validation`, `testing`, `release`, `contribution` |
| `lifecycleGateResultSchema` | `pass`, `fail`, `warn` |
| `lifecycleEvidenceTypeSchema` | `file`, `url`, `manifest` |
| `lifecycleTransitionTypeSchema` | `automatic`, `manual`, `forced` |

**Governance enums (3):**

| Schema | Values |
|--------|--------|
| `adrStatusSchema` | `proposed`, `accepted`, `superseded`, `deprecated` |
| `gateStatusSchema` | `pending`, `passed`, `failed`, `waived` |
| `manifestStatusSchema` | `completed`, `partial`, `blocked`, `archived` |

**Token usage enums (3):**

| Schema | Values |
|--------|--------|
| `tokenUsageMethodSchema` | `otel`, `provider_api`, `tokenizer`, `heuristic` |
| `tokenUsageConfidenceSchema` | `real`, `high`, `estimated`, `coarse` |
| `tokenUsageTransportSchema` | `cli`, `mcp`, `api`, `agent`, `unknown` |

**Relation/link enums (3):**

| Schema | Values |
|--------|--------|
| `taskRelationTypeSchema` | `related`, `blocks`, `duplicates`, `absorbs`, `fixes`, `extends`, `supersedes` |
| `externalLinkTypeSchema` | `created`, `matched`, `manual` |
| `syncDirectionSchema` | `inbound`, `outbound`, `bidirectional` |

**Brain enums (12):**

| Schema | Values |
|--------|--------|
| `brainObservationTypeSchema` | `discovery`, `change`, `feature`, `bugfix`, `decision`, `refactor` |
| `brainObservationSourceTypeSchema` | `agent`, `session-debrief`, `claude-mem`, `manual` |
| `brainDecisionTypeSchema` | `architecture`, `technical`, `process`, `strategic`, `tactical` |
| `brainConfidenceLevelSchema` | `low`, `medium`, `high` |
| `brainOutcomeTypeSchema` | `success`, `failure`, `mixed`, `pending` |
| `brainPatternTypeSchema` | `workflow`, `blocker`, `success`, `failure`, `optimization` |
| `brainImpactLevelSchema` | `low`, `medium`, `high` |
| `brainLinkTypeSchema` | `produced_by`, `applies_to`, `informed_by`, `contradicts` |
| `brainMemoryTypeSchema` | `decision`, `pattern`, `learning`, `observation` |
| `brainStickyStatusSchema` | `active`, `converted`, `archived` |
| `brainStickyColorSchema` | `yellow`, `blue`, `green`, `red`, `purple` |
| `brainStickyPrioritySchema` | `low`, `medium`, `high` |

**Graph enums (2):**

| Schema | Values |
|--------|--------|
| `brainNodeTypeSchema` | `task`, `doc`, `file`, `concept` |
| `brainEdgeTypeSchema` | `depends_on`, `relates_to`, `implements`, `documents` |

**Agent enums (2):**

| Schema | Values |
|--------|--------|
| `agentInstanceStatusSchema` | `starting`, `active`, `idle`, `error`, `crashed`, `stopped` |
| `agentTypeSchema` | `orchestrator`, `executor`, `researcher`, `architect`, `validator`, `documentor`, `custom` |

### 3.2 Insert/Select Schemas (20 pairs)

Drizzle-derived Zod schemas with business-logic refinements. Each pair provides an `insert*Schema` (for write validation) and `select*Schema` (for read validation).

| Table | Insert Schema | Select Schema | Notable Refinements |
|-------|--------------|---------------|---------------------|
| `tasks` | `insertTaskSchema` | `selectTaskSchema` | `id`: `/^T\d{3,}$/`, `title`: min 1, max 120, `description`: max 2000 |
| `sessions` | `insertSessionSchema` | `selectSessionSchema` | `name`: min 1, max 200 |
| `task_dependencies` | `insertTaskDependencySchema` | `selectTaskDependencySchema` | -- |
| `task_relations` | `insertTaskRelationSchema` | `selectTaskRelationSchema` | `reason`: max 500 |
| `task_work_history` | `insertWorkHistorySchema` | `selectWorkHistorySchema` | -- |
| `lifecycle_pipelines` | `insertLifecyclePipelineSchema` | `selectLifecyclePipelineSchema` | `id`, `taskId`: min 1 |
| `lifecycle_stages` | `insertLifecycleStageSchema` | `selectLifecycleStageSchema` | `id`, `pipelineId`: min 1, reasons: max 1000 |
| `lifecycle_gate_results` | `insertLifecycleGateResultSchema` | `selectLifecycleGateResultSchema` | `gateName`: min 1, max 100, `checkedBy`: min 1, max 100 |
| `lifecycle_evidence` | `insertLifecycleEvidenceSchema` | `selectLifecycleEvidenceSchema` | -- |
| `lifecycle_transitions` | `insertLifecycleTransitionSchema` | `selectLifecycleTransitionSchema` | -- |
| `schema_meta` | `insertSchemaMetaSchema` | `selectSchemaMetaSchema` | -- |
| `audit_log` | `insertAuditLogSchema` | `selectAuditLogSchema` | `id`: UUID, `action`: min 1, max 100, `actor`: min 1, max 50 |
| `token_usage` | `insertTokenUsageSchema` | `selectTokenUsageSchema` | `provider`: min 1, max 100, `model`: max 200 |
| `architecture_decisions` | `insertArchitectureDecisionSchema` | `selectArchitectureDecisionSchema` | `title`: min 1, max 200, `content`: min 1 |
| `manifest_entries` | `insertManifestEntrySchema` | `selectManifestEntrySchema` | -- |
| `pipeline_manifest` | `insertPipelineManifestSchema` | `selectPipelineManifestSchema` | `type`: min 1, max 100, `content`: min 1 |
| `release_manifests` | `insertReleaseManifestSchema` | `selectReleaseManifestSchema` | `version`: semver regex |
| `external_task_links` | `insertExternalTaskLinkSchema` | `selectExternalTaskLinkSchema` | `externalUrl`: URL format, `externalTitle`: max 500 |
| `agent_instances` | `insertAgentInstanceSchema` | `selectAgentInstanceSchema` | `id`: `/^agt_\d{14}_[0-9a-f]{6}$/` |
| `agent_error_log` | `insertAgentErrorLogSchema` | `selectAgentErrorLogSchema` | -- |

---

## 4. Hook Payload Schemas (14 schemas)

Runtime Zod validation schemas for lifecycle hook event payloads. Defined in `packages/core/src/hooks/payload-schemas.ts`.

| Schema | Event | Key Fields |
|--------|-------|------------|
| `HookPayloadSchema` | (base) | `timestamp`, `sessionId?`, `taskId?`, `providerId?`, `metadata?` |
| `OnSessionStartPayloadSchema` | `onSessionStart` | `sessionId`, `name`, `scope`, `agent?` |
| `OnSessionEndPayloadSchema` | `onSessionEnd` | `sessionId`, `duration`, `tasksCompleted[]` |
| `OnToolStartPayloadSchema` | `onToolStart` | `taskId`, `taskTitle`, `previousTask?` |
| `OnToolCompletePayloadSchema` | `onToolComplete` | `taskId`, `taskTitle`, `status` |
| `OnFileChangePayloadSchema` | `onFileChange` | `filePath`, `changeType`, `sizeBytes?` |
| `OnErrorPayloadSchema` | `onError` | `errorCode`, `message`, `domain?`, `operation?` |
| `OnPromptSubmitPayloadSchema` | `onPromptSubmit` | `gateway`, `domain`, `operation`, `source?` |
| `OnResponseCompletePayloadSchema` | `onResponseComplete` | `gateway`, `domain`, `operation`, `success`, `durationMs?` |
| `OnWorkAvailablePayloadSchema` | `onWorkAvailable` | `taskIds[]`, `epicId?`, `chainId?`, `reason?` |
| `OnAgentSpawnPayloadSchema` | `onAgentSpawn` | `agentId`, `role`, `adapterId?`, `taskId?` |
| `OnAgentCompletePayloadSchema` | `onAgentComplete` | `agentId`, `role`, `status`, `summary?` |
| `OnCascadeStartPayloadSchema` | `onCascadeStart` | `cascadeId`, `chainId?`, `tesseraId?`, `taskIds?` |
| `OnPatrolPayloadSchema` | `onPatrol` | `watcherId`, `patrolType`, `scope?` |

Validator function: `validatePayload(event: HookEvent, payload: unknown): PayloadValidationResult`

---

## 5. Error Types

### 5.1 CleoError

The primary error class for all CLEO operations:

```typescript
class CleoError extends Error {
  readonly exitCode: ExitCode;
  readonly details?: ProblemDetails;
}
```

### 5.2 ProblemDetails (RFC 9457)

```typescript
interface ProblemDetails {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
}
```

### 5.3 EngineResult

Dispatch layer result type:

```typescript
type EngineResult<T = unknown> = {
  success: boolean;
  data?: T;
  error?: unknown;
  exitCode?: ExitCode;
};
```

### 5.4 Error Catalog

| Export | Purpose |
|--------|---------|
| `ERROR_CATALOG` | Map of all registered error definitions |
| `getErrorDefinition(code)` | Look up by ExitCode |
| `getAllErrorDefinitions()` | Get all definitions |
| `getErrorDefinitionByLafsCode(code)` | Look up by LAFS error code |

---

## 6. Key Interfaces for Consumers

### 6.1 DataAccessor

The primary storage abstraction. All core modules that persist data accept a `DataAccessor` parameter. Defined in `@cleocode/contracts`.

Key methods: `loadSingleTask`, `queryTasks`, `upsertSingleTask`, `updateTaskFields`, `transaction`, `getActiveSession`, `close`.

### 6.2 ExternalTaskProvider / ExternalTask

Provider-agnostic task sync interface:

```typescript
interface ExternalTask {
  externalId: string;
  title: string;
  status: ExternalTaskStatus;
  priority?: string;
  url?: string;
  labels?: string[];
}
```

### 6.3 CLEOProviderAdapter

Main adapter interface for AI provider integrations (Claude Code, OpenCode, Cursor):

Sub-interfaces: `AdapterHookProvider`, `AdapterSpawnProvider`, `AdapterInstallProvider`, `AdapterPathProvider`, `AdapterContextMonitorProvider`, `AdapterTransportProvider`.

### 6.4 Cleo Facade

```typescript
class Cleo {
  static init(projectRoot: string, options?: CleoInitOptions): Promise<Cleo>;
  static forProject(projectRoot: string): Cleo;
  readonly projectRoot: string;
  get tasks(): TasksAPI;
  get sessions(): SessionsAPI;
  get memory(): MemoryAPI;
  get orchestration(): OrchestrationAPI;
  get lifecycle(): LifecycleAPI;
  get release(): ReleaseAPI;
  get admin(): AdminAPI;
  get sticky(): StickyAPI;
  get nexus(): NexusAPI;
  get sync(): SyncAPI;
}
```

---

## 7. Namespace Summary

All 43 namespaces exported from `@cleocode/core`:

| # | Namespace | Source |
|---|-----------|--------|
| 1 | `agents` | `agents/index.js` |
| 2 | `adapters` | `adapters/index.js` |
| 3 | `admin` | `admin/index.js` |
| 4 | `adrs` | `adrs/index.js` |
| 5 | `caamp` | `caamp/index.js` |
| 6 | `codebaseMap` | `codebase-map/index.js` |
| 7 | `compliance` | `compliance/index.js` |
| 8 | `context` | `context/index.js` |
| 9 | `coreHooks` | `hooks/index.js` |
| 10 | `inject` | `inject/index.js` |
| 11 | `intelligence` | `intelligence/index.js` |
| 12 | `issue` | `issue/index.js` |
| 13 | `lifecycle` | `lifecycle/index.js` |
| 14 | `coreMcp` | `mcp/index.js` |
| 15 | `memory` | `memory/index.js` |
| 16 | `metrics` | `metrics/index.js` |
| 17 | `migration` | `migration/index.js` |
| 18 | `nexus` | `nexus/index.js` |
| 19 | `observability` | `observability/index.js` |
| 20 | `orchestration` | `orchestration/index.js` |
| 21 | `otel` | `otel/index.js` |
| 22 | `phases` | `phases/index.js` |
| 23 | `pipeline` | `pipeline/index.js` |
| 24 | `reconciliation` | `reconciliation/index.js` |
| 25 | `release` | `release/index.js` |
| 26 | `remote` | `remote/index.js` |
| 27 | `research` | `research/index.js` |
| 28 | `roadmap` | `roadmap/index.js` |
| 29 | `routing` | `routing/index.js` |
| 30 | `security` | `security/index.js` |
| 31 | `sequence` | `sequence/index.js` |
| 32 | `sessions` | `sessions/index.js` |
| 33 | `signaldock` | `signaldock/index.js` |
| 34 | `skills` | `skills/index.js` |
| 35 | `snapshot` | `snapshot/index.js` |
| 36 | `spawn` | `spawn/index.js` |
| 37 | `stats` | `stats/index.js` |
| 38 | `sticky` | `sticky/index.js` |
| 39 | `system` | `system/index.js` |
| 40 | `taskWork` | `task-work/index.js` |
| 41 | `tasks` | `tasks/index.js` |
| 42 | `templates` | `templates/index.js` |
| 43 | `ui` | `ui/index.js` |
| -- | `validation` | `validation/index.js` |

Note: `validation` is the 44th namespace export but maps to the `check` domain in the Circle of Ten rather than being a distinct domain.
