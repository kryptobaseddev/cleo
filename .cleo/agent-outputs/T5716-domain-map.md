# T5716 Domain Map -- Core Function Signatures for Cleo Facade

**Date**: 2026-03-17
**Task**: T5716
**Purpose**: Map all 10+ CLEO domain modules to their actual TypeScript function signatures for wiring into the `Cleo` facade class.

---

## Current State of `packages/core/src/cleo.ts`

The existing `cleo.ts` is a **real but partial implementation**. It:
- Has a `Cleo` class with `static forProject(projectRoot: string): Cleo`
- Has a `CleoTasksApi` interface with 7 methods: `add`, `find`, `show`, `list`, `update`, `complete`, `delete`
- Uses lazy dynamic imports to wire each method
- Only covers the `tasks` domain -- no sessions, memory, lifecycle, sticky, etc.
- Does NOT manage a `DataAccessor` instance (each call creates its own via `cwd` param)

---

## Domain 1: tasks

### Core functions found:

| Function | Signature | File |
|----------|-----------|------|
| `addTask` | `(options: AddTaskOptions, cwd?: string, accessor?: DataAccessor) => Promise<AddTaskResult>` | `src/core/tasks/add.ts:406` |
| `findTasks` | `(options: FindTasksOptions, cwd?: string, accessor?: DataAccessor) => Promise<FindTasksResult>` | `src/core/tasks/find.ts:93` |
| `showTask` | `(taskId: string, cwd?: string, accessor?: DataAccessor) => Promise<TaskDetail>` | `src/core/tasks/show.ts:28` |
| `listTasks` | `(options: ListTasksOptions, cwd?: string, accessor?: DataAccessor) => Promise<ListTasksResult>` | `src/core/tasks/list.ts:66` |
| `updateTask` | `(options: UpdateTaskOptions, cwd?: string, accessor?: DataAccessor) => Promise<UpdateTaskResult>` | `src/core/tasks/update.ts:84` |
| `completeTask` | `(options: CompleteTaskOptions, cwd?: string, accessor?: DataAccessor) => Promise<CompleteTaskResult>` | `src/core/tasks/complete.ts:116` |
| `deleteTask` | `(options: DeleteTaskOptions, cwd?: string, accessor?: DataAccessor) => Promise<DeleteTaskResult>` | `src/core/tasks/delete.ts:36` |
| `archiveTasks` | `(options: ArchiveTasksOptions, cwd?: string, accessor?: DataAccessor) => Promise<ArchiveTasksResult>` | `src/core/tasks/archive.ts:42` |
| `reparentTask` | `(data: TaskFile, opts: ReparentOptions) => Promise<ReparentResult>` | `src/core/tasks/reparent.ts:46` |
| `analyzeTaskPriority` | `(...)` | `src/core/tasks/analyze.ts:30` |

### Key options types:
- `AddTaskOptions`: title, status?, priority?, type?, parentId?, size?, phase?, description?, labels?, files?, acceptance?, depends?, notes?, position?, addPhase?, dryRun?
- `FindTasksOptions`: query?, id?, exact?, status?, field?, includeArchive?, limit?, offset?
- `ListTasksOptions`: status?, priority?, type?, parentId?, phase?, label?, children?, limit?, offset?
- `UpdateTaskOptions`: taskId, title?, status?, priority?, type?, size?, phase?, description?, labels?, addLabels?, removeLabels?, depends?, addDepends?, removeDepends?, notes?, acceptance?, files?, blockedBy?, parentId?, noAutoComplete?
- `CompleteTaskOptions`: taskId, notes?, changeset?
- `DeleteTaskOptions`: taskId, force?, cascade?

### Wiring pattern:
All task functions accept `(options, cwd?, accessor?)`. The Cleo facade passes `this.projectRoot` as `cwd`.

### Proposed facade interface:
```typescript
interface CleoTasksApi {
  add(opts: AddTaskOptions): Promise<AddTaskResult>;
  find(opts: FindTasksOptions): Promise<FindTasksResult>;
  show(taskId: string): Promise<TaskDetail>;
  list(opts?: ListTasksOptions): Promise<ListTasksResult>;
  update(opts: UpdateTaskOptions): Promise<UpdateTaskResult>;
  complete(opts: CompleteTaskOptions): Promise<CompleteTaskResult>;
  delete(opts: DeleteTaskOptions): Promise<DeleteTaskResult>;
  archive(opts?: ArchiveTasksOptions): Promise<ArchiveTasksResult>;
}
```

---

## Domain 2: task-work

### Core functions found:

| Function | Signature | File |
|----------|-----------|------|
| `currentTask` | `(cwd?: string, accessor?: DataAccessor) => Promise<TaskCurrentResult>` | `src/core/task-work/index.ts:45` |
| `startTask` | `(taskId: string, cwd?: string, accessor?: DataAccessor) => Promise<TaskStartResult>` | `src/core/task-work/index.ts:67` |
| `stopTask` | `(cwd?: string, accessor?: DataAccessor) => Promise<...>` | `src/core/task-work/index.ts:159` |
| `getWorkHistory` | `(taskId: string, cwd?: string, accessor?: DataAccessor) => Promise<TaskWorkHistoryEntry[]>` | `src/core/task-work/index.ts:217` |

### Wiring pattern:
All accept `(param?, cwd?, accessor?)`. Pass `this.projectRoot` as `cwd`.

### Proposed facade interface:
```typescript
interface CleoTaskWorkApi {
  current(): Promise<TaskCurrentResult>;
  start(taskId: string): Promise<TaskStartResult>;
  stop(): Promise<unknown>;
  history(taskId: string): Promise<TaskWorkHistoryEntry[]>;
}
```

---

## Domain 3: sessions

### Core functions found:

| Function | Signature | File |
|----------|-----------|------|
| `startSession` | `(options: StartSessionOptions, cwd?, accessor?) => Promise<Session>` | `src/core/sessions/index.ts:95` |
| `endSession` | `(options?: EndSessionOptions, cwd?, accessor?) => Promise<Session>` | `src/core/sessions/index.ts:194` |
| `sessionStatus` | `(cwd?, accessor?) => Promise<...>` | `src/core/sessions/index.ts:289` |
| `resumeSession` | `(sessionId: string, cwd?, accessor?) => Promise<Session>` | `src/core/sessions/index.ts:308` |
| `listSessions` | `(options?: ListSessionsOptions, cwd?, accessor?) => Promise<Session[]>` | `src/core/sessions/index.ts:342` |
| `gcSessions` | `(cwd?, accessor?) => Promise<...>` | `src/core/sessions/index.ts:370` |
| `findSessions` | `(params: FindSessionsParams, cwd?) => Promise<MinimalSessionRecord[]>` | `src/core/sessions/find.ts:41` |
| `showSession` | `(projectRoot: string, sessionId: string) => Promise<Session>` | `src/core/sessions/session-show.ts:18` |
| `suspendSession` | `(projectRoot?, sessionId?) => Promise<...>` | `src/core/sessions/session-suspend.ts:19` |
| `switchSession` | `(projectRoot: string, sessionId: string) => Promise<Session>` | `src/core/sessions/session-switch.ts:19` |
| `getSessionStats` | `(projectRoot?) => Promise<SessionStatsResult>` | `src/core/sessions/session-stats.ts:36` |
| `recordDecision` | `(params: RecordDecisionParams, cwd?) => Promise<...>` | `src/core/sessions/decisions.ts:33` |
| `recordAssumption` | `(params: RecordAssumptionParams, cwd?) => Promise<...>` | `src/core/sessions/assumptions.ts:28` |
| `computeHandoff` | `(options: ComputeHandoffOptions) => Promise<HandoffData>` | `src/core/sessions/handoff.ts:66` |
| `persistHandoff` | `(data: HandoffData, cwd?) => Promise<void>` | `src/core/sessions/handoff.ts:247` |
| `getHandoff` | `(sessionId: string, cwd?) => Promise<HandoffData>` | `src/core/sessions/handoff.ts:271` |
| `getLastHandoff` | `(cwd?) => Promise<HandoffData | null>` | `src/core/sessions/handoff.ts:299` |
| `computeDebrief` | `(options: ComputeDebriefOptions) => Promise<DebriefData>` | `src/core/sessions/handoff.ts:422` |
| `computeBriefing` | `(options: BriefingOptions) => Promise<SessionBriefing>` | `src/core/sessions/briefing.ts:134` |

### Wiring pattern:
Most accept `(options?, cwd?, accessor?)`. A few like `showSession`, `switchSession` use `(projectRoot, sessionId)`.

### Proposed facade interface:
```typescript
interface CleoSessionsApi {
  start(opts: StartSessionOptions): Promise<Session>;
  end(opts?: EndSessionOptions): Promise<Session>;
  status(): Promise<unknown>;
  resume(sessionId: string): Promise<Session>;
  list(opts?: ListSessionsOptions): Promise<Session[]>;
  find(params: FindSessionsParams): Promise<MinimalSessionRecord[]>;
  show(sessionId: string): Promise<Session>;
  suspend(sessionId?: string): Promise<unknown>;
  switch(sessionId: string): Promise<Session>;
  stats(): Promise<SessionStatsResult>;
  handoff: {
    compute(opts: ComputeHandoffOptions): Promise<HandoffData>;
    show(sessionId: string): Promise<HandoffData>;
    last(): Promise<HandoffData | null>;
  };
  briefing(opts: BriefingOptions): Promise<SessionBriefing>;
}
```

---

## Domain 4: memory

### Core functions found:

**Research/Manifest** (`src/core/memory/index.ts`):

| Function | Signature | File |
|----------|-----------|------|
| `addResearch` | `(options: AddResearchOptions, cwd?) => Promise<ResearchEntry>` | `index.ts:103` |
| `showResearch` | `(researchId: string, cwd?) => Promise<ResearchEntry>` | `index.ts:154` |
| `listResearch` | `(options?: ListResearchOptions, cwd?) => Promise<ResearchEntry[]>` | `index.ts:169` |
| `pendingResearch` | `(cwd?) => Promise<ResearchEntry[]>` | `index.ts:190` |
| `linkResearch` | `(taskId: string, researchId: string, cwd?) => Promise<...>` | `index.ts:198` |
| `updateResearch` | `(...) => Promise<...>` | `index.ts:230` |
| `statsResearch` | `(cwd?) => Promise<{...}>` | `index.ts:256` |
| `archiveResearch` | `(cwd?) => Promise<{...}>` | `index.ts:295` |
| `readManifest` | `(cwd?) => Promise<ManifestEntry[]>` | `index.ts:320` |
| `appendManifest` | `(entry: ManifestEntry, cwd?) => Promise<void>` | `index.ts:342` |
| `queryManifest` | `(options: ManifestQueryOptions, cwd?) => Promise<...>` | `index.ts:351` |
| `searchManifest` | `(query: string, cwd?) => Promise<...>` | `index.ts:510` |
| `findContradictions` | `(cwd?) => Promise<ContradictionDetail[]>` | `index.ts:754` |

**Brain** (`src/core/memory/brain-*.ts`):

| Function | Signature | File |
|----------|-----------|------|
| `searchBrain` | `(projectRoot, query, options?) => Promise<...>` | `brain-search.ts:277` |
| `hybridSearch` | `(query, projectRoot, options?) => Promise<...>` | `brain-search.ts:567` |
| `searchBrainCompact` | `(projectRoot, params) => Promise<...>` | `brain-retrieval.ts:135` |
| `timelineBrain` | `(projectRoot, params) => Promise<...>` | `brain-retrieval.ts:241` |
| `fetchBrainEntries` | `(projectRoot, params) => Promise<...>` | `brain-retrieval.ts:374` |
| `observeBrain` | `(projectRoot, params) => Promise<...>` | `brain-retrieval.ts:507` |
| `populateEmbeddings` | `(projectRoot) => Promise<...>` | `brain-retrieval.ts:615` |

**Decisions/Learnings/Patterns** (`src/core/memory/decisions.ts`, `learnings.ts`, `patterns.ts`):

| Function | Signature | File |
|----------|-----------|------|
| `storeDecision` | `(projectRoot, params) => Promise<...>` | `decisions.ts:76` |
| `recallDecision` | `(projectRoot, query) => Promise<...>` | `decisions.ts:134` |
| `searchDecisions` | `(projectRoot, params?) => Promise<...>` | `decisions.ts:148` |
| `listDecisions` | `(projectRoot, params?) => Promise<...>` | `decisions.ts:182` |
| `updateDecisionOutcome` | `(projectRoot, id, outcome) => Promise<...>` | `decisions.ts:205` |
| `storeLearning` | `(projectRoot, params) => Promise<...>` | `learnings.ts:46` |
| `searchLearnings` | `(projectRoot, params?) => Promise<...>` | `learnings.ts:94` |
| `learningStats` | `(projectRoot) => Promise<...>` | `learnings.ts:133` |
| `storePattern` | `(projectRoot, params) => Promise<...>` | `patterns.ts:55` |
| `searchPatterns` | `(projectRoot, params?) => Promise<...>` | `patterns.ts:110` |
| `patternStats` | `(projectRoot) => Promise<...>` | `patterns.ts:142` |

**Memory Bridge** (`src/core/memory/memory-bridge.ts`):

| Function | Signature | File |
|----------|-----------|------|
| `generateMemoryBridgeContent` | `(projectRoot) => Promise<string>` | `memory-bridge.ts:83` |
| `writeMemoryBridge` | `(projectRoot, content) => Promise<void>` | `memory-bridge.ts:198` |
| `refreshMemoryBridge` | `(projectRoot) => Promise<void>` | `memory-bridge.ts:237` |

**Auto-Extract** (`src/core/memory/auto-extract.ts`):

| Function | Signature | File |
|----------|-----------|------|
| `extractTaskCompletionMemory` | `(projectRoot, task, parentTask?) => Promise<void>` | `auto-extract.ts:25` |
| `extractSessionEndMemory` | `(projectRoot, sessionData, taskDetails) => Promise<void>` | `auto-extract.ts:93` |

### Wiring pattern:
Mixed -- some use `cwd?` (research/manifest), others use `projectRoot` as first arg (brain, decisions, learnings, patterns). Facade should normalize to projectRoot.

### Proposed facade interface:
```typescript
interface CleoMemoryApi {
  brain: {
    search(query: string, options?: object): Promise<unknown>;
    timeline(anchorId: string, options?: object): Promise<unknown>;
    fetch(ids: string[]): Promise<unknown>;
    observe(text: string, options?: object): Promise<unknown>;
  };
  decisions: {
    store(params: object): Promise<unknown>;
    search(params?: object): Promise<unknown>;
    list(params?: object): Promise<unknown>;
  };
  learnings: {
    store(params: object): Promise<unknown>;
    search(params?: object): Promise<unknown>;
  };
  patterns: {
    store(params: object): Promise<unknown>;
    search(params?: object): Promise<unknown>;
  };
  research: {
    add(opts: AddResearchOptions): Promise<ResearchEntry>;
    show(id: string): Promise<ResearchEntry>;
    list(opts?: ListResearchOptions): Promise<ResearchEntry[]>;
  };
  bridge: {
    refresh(): Promise<void>;
  };
}
```

---

## Domain 5: orchestration

### Core functions found:

| Function | Signature | File |
|----------|-----------|------|
| `startOrchestration` | `(epicId: string, cwd?, accessor?) => Promise<OrchestratorSession>` | `index.ts:85` |
| `analyzeEpic` | `(epicId: string, cwd?, accessor?) => Promise<AnalysisResult>` | `index.ts:120` |
| `getReadyTasks` | `(epicId: string, cwd?, accessor?) => Promise<TaskReadiness[]>` | `index.ts:165` |
| `getNextTask` | `(epicId: string, cwd?, accessor?) => Promise<TaskReadiness | null>` | `index.ts:195` |
| `prepareSpawn` | `(taskId: string, cwd?, accessor?) => Promise<SpawnContext>` | `index.ts:212` |
| `validateSpawnOutput` | `(taskId: string, output: string, cwd?) => Promise<...>` | `index.ts:245` |
| `getOrchestratorContext` | `(epicId: string, cwd?, accessor?) => Promise<...>` | `index.ts:266` |
| `autoDispatch` | `(task: Task) => string` (pure) | `index.ts:343` |
| `resolveTokens` | `(template: string, context: object) => string` (pure) | `index.ts:423` |
| `buildDependencyGraph` | `(tasks: Task[]) => Map<string, Set<string>>` (pure) | `analyze.ts:33` |
| `detectCircularDependencies` | `(tasks, graph?) => CircularDependency[]` (pure) | `analyze.ts:55` |
| `analyzeDependencies` | `(children: Task[], allTasks: Task[]) => DependencyAnalysis` (pure) | `analyze.ts:122` |
| `estimateContext` | `(options) => ContextEstimation` | `context.ts:54` |
| `countManifestEntries` | `(projectRoot: string) => number` | `context.ts:33` |
| `computeEpicStatus` | `(epicId, title, children) => EpicStatus` (pure) | `status.ts` |
| `computeOverallStatus` | `(tasks) => OverallStatus` (pure) | `status.ts` |
| `computeProgress` | `(tasks) => ProgressMetrics` (pure) | `status.ts` |
| `computeStartupSummary` | `(epicId, title, children, readyCount) => StartupSummary` (pure) | `status.ts` |
| `getCriticalPath` | `(epicId, cwd?) => Promise<CriticalPathResult>` | `critical-path.ts:26` |
| `startParallelExecution` | `(...)` | `parallel.ts:44` |

### Wiring pattern:
Most accept `(epicId, cwd?, accessor?)`. Pass `this.projectRoot` as `cwd`.

### Proposed facade interface:
```typescript
interface CleoOrchestrationApi {
  start(epicId: string): Promise<OrchestratorSession>;
  analyze(epicId: string): Promise<AnalysisResult>;
  ready(epicId: string): Promise<TaskReadiness[]>;
  next(epicId: string): Promise<TaskReadiness | null>;
  spawn(taskId: string): Promise<SpawnContext>;
  context(epicId: string): Promise<unknown>;
  criticalPath(epicId: string): Promise<CriticalPathResult>;
}
```

---

## Domain 6: lifecycle

### Core functions found:

| Function | Signature | File |
|----------|-----------|------|
| `getLifecycleState` | `(epicId: string, cwd?) => Promise<RcasdManifest>` | `index.ts:146` |
| `startStage` | `(epicId: string, stage: string, cwd?) => Promise<...>` | `index.ts:167` |
| `completeStage` | `(epicId: string, stage: string, cwd?) => Promise<...>` | `index.ts:206` |
| `skipStage` | `(epicId: string, stage: string, cwd?) => Promise<...>` | `index.ts:241` |
| `checkGate` | `(epicId: string, gate: string, cwd?) => Promise<GateCheckResult>` | `index.ts:275` |
| `getLifecycleStatus` | `(epicId: string, cwd?) => Promise<...>` | `index.ts:347` |
| `getLifecycleHistory` | `(epicId: string, cwd?) => Promise<...>` | `index.ts:505` |
| `getLifecycleGates` | `(epicId: string, cwd?) => Promise<...>` | `index.ts:606` |
| `checkStagePrerequisites` | `(epicId: string, targetStage: string, cwd?) => Promise<...>` | `index.ts:681` |
| `recordStageProgress` | `(epicId: string, stage: string, progress: object, cwd?) => Promise<...>` | `index.ts:818` |
| `passGate` | `(epicId: string, gate: string, cwd?) => Promise<...>` | `index.ts:972` |
| `failGate` | `(epicId: string, gate: string, reason: string, cwd?) => Promise<...>` | `index.ts:1027` |
| `listEpicsWithLifecycle` | `(cwd?) => Promise<string[]>` | `index.ts:1079` |
| `skipStageWithReason` | `(epicId, stage, reason, cwd?) => Promise<...>` | `index.ts:919` |
| `resetStage` | `(epicId, stage, reason, cwd?) => Promise<...>` | `index.ts:933` |

### Chain operations (WARP chains):
| Function | Signature | File |
|----------|-----------|------|
| `addChain` | `(chain: WarpChain, projectRoot) => Promise<void>` | `chain-store.ts:45` |
| `showChain` | `(id: string, projectRoot) => Promise<WarpChain | null>` | `chain-store.ts:72` |
| `listChains` | `(projectRoot) => Promise<WarpChain[]>` | `chain-store.ts:87` |
| `findChains` | `(criteria, projectRoot) => Promise<WarpChain[]>` | `chain-store.ts:99` |
| `createInstance` | `(chainId, epicId, projectRoot) => Promise<...>` | `chain-store.ts:144` |
| `advanceInstance` | `(instanceId, gateResult, projectRoot) => Promise<...>` | `chain-store.ts:250` |

### Evidence operations:
| Function | Signature | File |
|----------|-----------|------|
| `recordEvidence` | `(epicId, stage, evidence, cwd?) => Promise<EvidenceRecord>` | `evidence.ts:50` |
| `getEvidence` | `(epicId, stage?, cwd?) => Promise<EvidenceRecord[]>` | `evidence.ts:106` |
| `linkProvenance` | `(epicId, stage, filePath, cwd?) => Promise<EvidenceRecord>` | `evidence.ts:166` |
| `getEvidenceSummary` | `(epicId, cwd?) => Promise<...>` | `evidence.ts:193` |

### Wiring pattern:
All lifecycle functions use `(epicId, ..., cwd?)` -- no DataAccessor param. They access SQLite internally via dynamic import.

### Proposed facade interface:
```typescript
interface CleoLifecycleApi {
  state(epicId: string): Promise<RcasdManifest>;
  status(epicId: string): Promise<unknown>;
  startStage(epicId: string, stage: string): Promise<unknown>;
  completeStage(epicId: string, stage: string): Promise<unknown>;
  checkGate(epicId: string, gate: string): Promise<GateCheckResult>;
  passGate(epicId: string, gate: string): Promise<unknown>;
  history(epicId: string): Promise<unknown>;
  gates(epicId: string): Promise<unknown>;
  listEpics(): Promise<string[]>;
}
```

---

## Domain 7: release

### Core functions found:

| Function | Signature | File |
|----------|-----------|------|
| `buildArtifact` | `(config: ArtifactConfig) => Promise<ArtifactResult>` | `artifacts.ts:486` |
| `validateArtifact` | `(config: ArtifactConfig) => Promise<ArtifactResult>` | `artifacts.ts:505` |
| `publishArtifact` | `(config: ArtifactConfig) => Promise<ArtifactResult>` | `artifacts.ts:521` |
| `writeChangelogSection` | `(version, entries, cwd?) => Promise<...>` | `changelog-writer.ts:74` |
| `resolveChannelFromBranch` | `(branch: string, config?) => ReleaseChannel` | `channel.ts:45` |
| `validateVersionChannel` | `(version, channel) => ChannelValidationResult` | `channel.ts:118` |
| `detectCIPlatform` | `(projectDir?) => CIPlatform | null` | `ci.ts:34` |
| `generateCIConfig` | `(platform, cwd?) => string` | `ci.ts:141` |
| `createPullRequest` | `(opts: PRCreateOptions) => Promise<PRResult>` | `github-pr.ts:214` |
| `checkEpicCompleteness` | `(epicId, cwd?) => Promise<EpicCompletenessResult>` | `guards.ts:52` |

### Proposed facade interface:
```typescript
interface CleoReleaseApi {
  channel(branch: string): ReleaseChannel;
  checkCompleteness(epicId: string): Promise<EpicCompletenessResult>;
  createPR(opts: PRCreateOptions): Promise<PRResult>;
  writeChangelog(version: string, entries: unknown): Promise<unknown>;
}
```

---

## Domain 8: admin

### Core functions found:

| Function | Signature | File |
|----------|-----------|------|
| `exportTasks` | `(params: ExportParams) => Promise<ExportResult>` | `export.ts:71` |
| `importTasks` | `(params: ImportParams) => Promise<ImportResult>` | `import.ts:49` |
| `exportTasksPackage` | `(params: ExportTasksParams) => Promise<ExportTasksResult>` | `export-tasks.ts:112` |
| `importTasksPackage` | `(params: ImportTasksParams) => Promise<ImportTasksResult>` | `import-tasks.ts:80` |
| `computeHelp` | `(allOps, tier, verbose) => HelpResult` | `help.ts:134` |
| `getSyncStatus` | `(projectRoot) => Promise<{...}>` | `sync.ts:48` |
| `clearSyncState` | `(projectRoot, ...) => Promise<SyncClearResult>` | `sync.ts:105` |

### Proposed facade interface:
```typescript
interface CleoAdminApi {
  export(params: ExportParams): Promise<ExportResult>;
  import(params: ImportParams): Promise<ImportResult>;
  help(tier?: number, domain?: string): HelpResult;
  syncStatus(): Promise<unknown>;
}
```

---

## Domain 9: nexus

### Core functions found:

| Function | Signature | File |
|----------|-----------|------|
| `nexusDeps` | `(project?, depth?) => Promise<DepsResult>` | `deps.ts:202` |
| `buildGlobalGraph` | `() => Promise<NexusGlobalGraph>` | `deps.ts:133` |
| `criticalPath` | `() => Promise<CriticalPathResult>` | `deps.ts:349` |
| `blockingAnalysis` | `(taskQuery: string) => Promise<BlockingAnalysisResult>` | `deps.ts:427` |
| `orphanDetection` | `() => Promise<OrphanEntry[]>` | `deps.ts:472` |
| `discoverRelated` | `(query, options?) => Promise<NexusDiscoverResult>` | `discover.ts:158` |
| `searchAcrossProjects` | `(query, options?) => Promise<NexusSearchResult>` | `discover.ts:269` |
| `getPermission` | `(nameOrHash: string) => Promise<NexusPermissionLevel>` | `permissions.ts:55` |
| `checkPermission` | `(nameOrHash, required) => Promise<boolean>` | `permissions.ts:67` |
| `setPermission` | `(nameOrHash, level) => Promise<...>` | `permissions.ts:124` |
| `parseQuery` | `(query: string) => NexusParsedQuery` | `query.ts` |
| `resolveTask` | `(query: string) => Promise<NexusResolvedTask>` | `query.ts` |
| `migrateJsonToSqlite` | `() => Promise<number>` | `migrate-json-to-sqlite.ts:32` |

**Note**: Nexus is global (uses `~/.cleo/nexus.db`). It does NOT take `projectRoot` or `cwd`. The facade may expose nexus as a separate static property rather than project-bound.

### Proposed facade interface:
```typescript
interface CleoNexusApi {
  deps(project?: string): Promise<DepsResult>;
  criticalPath(): Promise<CriticalPathResult>;
  discover(query: string): Promise<NexusDiscoverResult>;
  search(query: string): Promise<NexusSearchResult>;
  permissions: {
    get(nameOrHash: string): Promise<NexusPermissionLevel>;
    check(nameOrHash: string, required: string): Promise<boolean>;
    set(nameOrHash: string, level: string): Promise<unknown>;
  };
}
```

---

## Domain 10: sticky

### Core functions found:

| Function | Signature | File |
|----------|-----------|------|
| `addSticky` | `(params: CreateStickyParams, projectRoot: string) => Promise<StickyNote>` | `create.ts:40` |
| `getSticky` | `(id: string, projectRoot: string) => Promise<StickyNote | null>` | `show.ts:39` |
| `listStickies` | `(params: ListStickiesParams, projectRoot: string) => Promise<StickyNote[]>` | `list.ts:39` |
| `archiveSticky` | `(id: string, projectRoot: string) => Promise<StickyNote | null>` | `archive.ts:39` |
| `purgeSticky` | `(id: string, projectRoot: string) => Promise<StickyNote | null>` | `purge.ts:38` |
| `convertStickyToTask` | `(params, projectRoot) => Promise<...>` | `convert.ts:21` |
| `convertStickyToMemory` | `(params, projectRoot) => Promise<...>` | `convert.ts:84` |
| `convertStickyToTaskNote` | `(params, projectRoot) => Promise<...>` | `convert.ts:143` |
| `convertStickyToSessionNote` | `(params, projectRoot) => Promise<...>` | `convert.ts:209` |

### Wiring pattern:
All accept `(params, projectRoot)` -- projectRoot is the **second** argument (not `cwd`).

### Proposed facade interface:
```typescript
interface CleoStickyApi {
  add(params: CreateStickyParams): Promise<StickyNote>;
  show(id: string): Promise<StickyNote | null>;
  list(params?: ListStickiesParams): Promise<StickyNote[]>;
  archive(id: string): Promise<StickyNote | null>;
  purge(id: string): Promise<StickyNote | null>;
  convert(params: ConvertStickyParams): Promise<unknown>;
}
```

---

## Additional Domains (tools, check/validation, skills)

### skills (tools domain)

Key functions: `findSkill`, `discoverAllSkills`, `generateManifest`, `autoDispatch` (skill dispatch), `prepareSpawnContext`, `prepareSpawnMulti`.

### validation (check domain)

Key functions: `detectDrift` (docs sync), doctor checks (`checkCliInstallation`, `checkCliVersion`, etc.), compliance functions (`checkManifestEntry`, `scoreSubagentCompliance`, `calculateTokenEfficiency`), chain validation (`validateChain`).

---

## DataAccessor Interface

**Source**: `src/store/data-accessor.ts`

```typescript
interface DataAccessor {
  readonly engine: 'sqlite';

  // Task data
  loadTaskFile(): Promise<TaskFile>;
  saveTaskFile(data: TaskFile): Promise<void>;

  // Archive data
  loadArchive(): Promise<ArchiveFile | null>;
  saveArchive(data: ArchiveFile): Promise<void>;

  // Session data
  loadSessions(): Promise<Session[]>;
  saveSessions(sessions: Session[]): Promise<void>;

  // Audit log
  appendLog(entry: Record<string, unknown>): Promise<void>;

  // Lifecycle
  close(): Promise<void>;

  // Fine-grained task operations (optional)
  upsertSingleTask?(task: Task): Promise<void>;
  archiveSingleTask?(taskId: string, fields: ArchiveFields): Promise<void>;
  removeSingleTask?(taskId: string): Promise<void>;
  addRelation?(taskId: string, relatedTo: string, relationType: string, reason?: string): Promise<void>;

  // Metadata (optional)
  getMetaValue?<T>(key: string): Promise<T | null>;
  setMetaValue?(key: string, value: unknown): Promise<void>;
  getSchemaVersion?(): Promise<string | null>;
}
```

Factory: `createDataAccessor(_engine?: 'sqlite', cwd?: string): Promise<DataAccessor>` -- always creates SQLite-backed, safety-wrapped accessor.

---

## Build System Notes

### Current `build.mjs` adapterMap entries:

```javascript
const adapterMap = {
  '@cleocode/adapter-claude-code': resolve(__dirname, 'packages/adapters/claude-code/src/index.ts'),
  '@cleocode/adapter-opencode': resolve(__dirname, 'packages/adapters/opencode/src/index.ts'),
  '@cleocode/adapter-cursor': resolve(__dirname, 'packages/adapters/cursor/src/index.ts'),
  '@cleocode/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
  '@cleocode/core': resolve(__dirname, 'packages/core/src/index.ts'),
};
```

- `@cleocode/core` is already in the adapter map and resolves to `packages/core/src/index.ts`
- The main build produces two bundles: `dist/cli/index.js` and `dist/mcp/index.js`
- All `@cleocode/*` packages are bundled inline (not external)
- Only `proper-lockfile`, `write-file-atomic`, `@modelcontextprotocol/sdk` are external

### Vitest aliases (mirror the esbuild map):

```javascript
resolve: {
  alias: {
    '@cleocode/adapter-claude-code': resolve('packages/adapters/claude-code/src/index.ts'),
    '@cleocode/adapter-opencode': resolve('packages/adapters/opencode/src/index.ts'),
    '@cleocode/adapter-cursor': resolve('packages/adapters/cursor/src/index.ts'),
    '@cleocode/contracts': resolve('packages/contracts/src/index.ts'),
    '@cleocode/core': resolve('packages/core/src/index.ts'),
  }
}
```

---

## esbuild Bundle Strategy for packages/core

### Current State

`packages/core/src/index.ts` re-exports everything from `../../../src/core/index.ts`. It is NOT independently bundled -- it is consumed via the adapterMap in the main build.

### Option B: Self-contained esbuild bundle

To make `packages/core/dist/index.js` a standalone distributable:

1. **Add a new entry point** in `build.mjs` (or a separate `packages/core/build.mjs`):
   ```javascript
   await esbuild.build({
     entryPoints: ['packages/core/src/index.ts'],
     outdir: 'packages/core/dist',
     bundle: true,
     platform: 'node',
     target: 'node20',
     format: 'esm',
     sourcemap: true,
     external: [
       'proper-lockfile',
       'write-file-atomic',
       'drizzle-orm',
       'better-sqlite3',
       '@cleocode/lafs-protocol',
       '@cleocode/caamp',
     ],
   });
   ```

2. **Key challenge**: `src/core/` imports from `../../store/` (DataAccessor, SQLite, etc.) and `../../types/` (Task, Session types). These are NOT in `src/core/` -- they are sibling directories. The esbuild bundle must include these transitively.

3. **What gets bundled in**:
   - All of `src/core/` (~38 domain modules)
   - `src/store/data-accessor.ts` + `src/store/sqlite-data-accessor.ts` + related
   - `src/types/` (Task, Session, ExitCode types)
   - `src/validation/` (imported by some core modules)

4. **What stays external**:
   - `drizzle-orm` (peer dependency)
   - `better-sqlite3` (native module, peer dependency)
   - `@cleocode/lafs-protocol`, `@cleocode/caamp` (separate packages)
   - `proper-lockfile`, `write-file-atomic` (native modules)

5. **package.json for @cleocode/core**:
   ```json
   {
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "peerDependencies": {
       "drizzle-orm": "^1.0.0",
       "better-sqlite3": "^11.0.0"
     }
   }
   ```

### Risk Notes

- The `src/store/` dependency chain is deep -- `data-accessor.ts` dynamically imports `sqlite-data-accessor.ts`, which imports `better-sqlite3`, `drizzle-orm`, schema files, migration files, etc.
- Dynamic imports (`await import(...)`) used in several core modules will need careful handling in esbuild (they become separate chunks or get bundled depending on configuration).
- The `cleo.ts` facade uses dynamic imports for lazy loading -- this pattern is compatible with esbuild bundling.

---

## src/core/index.ts Barrel Structure

The barrel exports 32 namespace re-exports + ~80 direct utility re-exports:

**Namespace re-exports** (all 32):
`adapters`, `admin`, `adrs`, `caamp`, `codebaseMap`, `compliance`, `context`, `coreHooks`, `inject`, `issue`, `lifecycle`, `coreMcp`, `memory`, `metrics`, `migration`, `nexus`, `observability`, `orchestration`, `otel`, `phases`, `pipeline`, `release`, `remote`, `research`, `roadmap`, `routing`, `security`, `sequence`, `sessions`, `signaldock`, `skills`, `snapshot`, `spawn`, `stats`, `sticky`, `system`, `taskWork`, `tasks`, `templates`, `ui`, `validation`

**Direct utility re-exports**: CleoError, paths, config, logger, init, scaffold, platform, output, pagination, audit, hooks, injection, etc.

---

## Summary Table

| Domain | # Core Functions | Param Pattern | Uses DataAccessor? | Wired in cleo.ts? |
|--------|-----------------|---------------|-------------------|-------------------|
| tasks | 10+ | `(opts, cwd?, accessor?)` | Yes (optional) | Yes (7 methods) |
| task-work | 4 | `(param?, cwd?, accessor?)` | Yes (optional) | No |
| sessions | 18+ | Mixed: `(opts, cwd?)` + `(projectRoot, id)` | Some | No |
| memory | 30+ | Mixed: `(cwd?)` + `(projectRoot, params)` | No | No |
| orchestration | 15+ | `(epicId, cwd?, accessor?)` + pure functions | Some | No |
| lifecycle | 15+ | `(epicId, stage?, cwd?)` | No (internal SQLite) | No |
| release | 10+ | Mixed patterns | No | No |
| admin | 7+ | Mixed: `(params)` + `(projectRoot)` | No | No |
| nexus | 13+ | Global (no projectRoot) | No | No |
| sticky | 9 | `(params, projectRoot)` | No | No |

**All 10 domains have working core functions.** Only `tasks` (7 of 10+ methods) is currently wired into the Cleo facade class.
