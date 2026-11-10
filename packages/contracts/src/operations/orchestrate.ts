/**
 * Orchestrate Domain Operations (14 operations)
 *
 * Query operations: 8 (added orchestrate.plan — T890)
 * Mutate operations: 6
 *
 * SYNC: Canonical implementations at
 *   packages/core/src/orchestrate/*.ts (T1570: orchestrate-engine.ts deleted)
 *   packages/core/src/orchestration/*.ts
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 * @task T890 — orchestrate.plan deterministic wave+worker plan
 */

/**
 * Common orchestration types
 */

/**
 * A single execution wave grouping tasks by dependency depth.
 *
 * @remarks
 * Canonical shape matches the implementation in
 * `packages/core/src/orchestration/waves.ts`. The fields align exactly so
 * that dispatch adapters can forward core results without conversion.
 *
 * T1719: reconciled from prior contracts shape (`wave`/`taskIds`/`canRunParallel`/
 * `dependencies`) to match the core implementation shape
 * (`waveNumber`/`tasks`/`status`).
 *
 * @task T963
 * @task T1719 — shape-divergence reconciliation
 */
export interface Wave {
  /** 1-based wave number. @task T963 */
  waveNumber: number;
  /** Task IDs scheduled in this wave. @task T963 */
  tasks: string[];
  /** Computed lifecycle status of this wave. @task T1719 */
  status: 'pending' | 'in_progress' | 'completed';
}

export interface SkillDefinition {
  /** Skill name. @task T963 */
  name: string;
  /** Skill description. @task T963 */
  description: string;
  /** Skill tags. @task T963 */
  tags: string[];
  /** Preferred model. @task T963 */
  model?: string;
  /** Supported protocol phases. @task T963 */
  protocols: string[];
}

/**
 * Query Operations
 */

// orchestrate.status
/**
 * Parameters for `orchestrate.status`.
 *
 * @remarks
 * Re-synced to match `orchestrateStatus(epicId?, projectRoot?)` in
 * `packages/core/src/orchestrate/query-ops.ts`. When `epicId`
 * is omitted, the engine returns an overall status envelope across all
 * tasks in the project.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface OrchestrateStatusParams {
  /** Epic to scope the status to. Omit for project-wide status. @task T963 */
  epicId?: string;
}
/** Per-status task counts. @task T963 */
export interface OrchestrateStatusCounts {
  /** Pending tasks. @task T963 */
  pending: number;
  /** Active tasks. @task T963 */
  active: number;
  /** Blocked tasks. @task T963 */
  blocked: number;
  /** Completed tasks. @task T963 */
  done: number;
  /** Cancelled tasks (epic scope only). @task T963 */
  cancelled?: number;
}
/**
 * Epic-scoped status (returned when `epicId` is supplied). Mirrors
 * `EpicStatus` in `packages/core/src/orchestration/status.ts`.
 * @task T963
 */
export interface OrchestrateEpicStatus {
  /** Epic task id. @task T963 */
  epicId: string;
  /** Epic title. @task T963 */
  epicTitle: string;
  /** Count of direct children. @task T963 */
  totalTasks: number;
  /** Per-status breakdown of the children. @task T963 */
  byStatus: OrchestrateStatusCounts;
  /** Total wave count computed for the epic. @task T963 */
  waves: number;
  /** First non-completed wave number, or `null` when all waves done. @task T963 */
  currentWave: number | null;
}
/**
 * Project-wide status (returned when `epicId` is omitted). Mirrors
 * `OverallStatus` in `packages/core/src/orchestration/status.ts`.
 * @task T963
 */
export interface OrchestrateOverallStatus {
  /** Count of detected root epics. @task T963 */
  totalEpics: number;
  /** Total tasks in the project. @task T963 */
  totalTasks: number;
  /** Per-status breakdown of the project. @task T963 */
  byStatus: OrchestrateStatusCounts;
}
/** Result of `orchestrate.status` — union of epic-scoped and overall. @task T963 */
export type OrchestrateStatusResult = OrchestrateEpicStatus | OrchestrateOverallStatus;

// orchestrate.next
/** Parameters for `orchestrate.next`. @task T963 */
export interface OrchestrateNextParams {
  /** Epic to pull the next task from (required). @task T963 */
  epicId: string;
}
/**
 * Result of `orchestrate.next`.
 *
 * @remarks
 * Re-synced to match `orchestrateNext(epicId, projectRoot?)` in the engine.
 * The legacy `{taskId, title, recommendedSkill, reasoning}` shape was never
 * implemented — the engine returns a `nextTask | null` + alternatives
 * envelope.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface OrchestrateNextResult {
  /** Epic id that was queried. @task T963 */
  epicId: string;
  /** Next task to work on, or `null` when nothing ready. @task T963 */
  nextTask: {
    /** Task id. @task T963 */
    id: string;
    /** Task title. @task T963 */
    title: string;
    /** Priority rollup from the engine. @task T963 */
    priority: string;
  } | null;
  /** Other ready alternatives (up to 3). Absent when `nextTask` is null. @task T963 */
  alternatives?: Array<{ id: string; title: string; priority: string }>;
  /** Total ready tasks for the epic. Absent when `nextTask` is null. @task T963 */
  totalReady?: number;
  /** Human-readable hint when nothing is ready. @task T963 */
  message?: string;
}

// orchestrate.ready
/** Parameters for `orchestrate.ready`. @task T963 */
export interface OrchestrateReadyParams {
  /** Epic to compute the ready set for (required). @task T963 */
  epicId: string;
}
/**
 * A single ready-task descriptor as returned by `orchestrate.ready`.
 * @task T963
 */
export interface OrchestrateReadyTask {
  /** Task id. @task T963 */
  id: string;
  /** Task title. @task T963 */
  title: string;
  /** Engine-rolled priority. @task T963 */
  priority: string;
  /** IDs of tasks this one depends on (blocker/depends chain). @task T963 */
  depends: string[];
}
/**
 * Result of `orchestrate.ready`.
 *
 * @remarks
 * Re-synced to match `orchestrateReady(epicId, projectRoot?)`. Returns
 * the filtered ready set from `getReadyTasks` + a diagnostic `reason`
 * when empty.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface OrchestrateReadyResult {
  /** Epic id that was queried. @task T963 */
  epicId: string;
  /** Ready task set (filtered to `ready === true`). @task T963 */
  readyTasks: OrchestrateReadyTask[];
  /** Count of ready tasks (may be zero). @task T963 */
  total: number;
  /** Diagnostic reason populated when `total === 0`. @task T963 */
  reason?: string;
}

// orchestrate.analyze
/**
 * Parameters for `orchestrate.analyze`.
 *
 * @remarks
 * Re-synced: engine signature is
 * `orchestrateAnalyze(epicId?, projectRoot?, mode?)`. Mode
 * `critical-path` delegates to `orchestrateCriticalPath` — callers may
 * branch on `mode` at the dispatch layer.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface OrchestrateAnalyzeParams {
  /**
   * Epic to analyze. Required for standard mode; optional for
   * `mode: 'critical-path'` which operates across the whole project.
   * @task T963
   */
  epicId?: string;
  /** Analysis mode — `undefined` | `'critical-path'`. @task T963 */
  mode?: 'critical-path';
}
/**
 * Result of `orchestrate.analyze` (standard mode).
 *
 * @remarks
 * Returns the wave plan + dependency diagnostics from
 * `analyzeEpic` + `analyzeDependencies`.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface OrchestrateAnalyzeResult {
  /** Epic task id that was analyzed. @task T963 */
  epicId: string;
  /** Epic title (falls back to `epicId` when title unresolvable). @task T963 */
  epicTitle: string;
  /** Count of direct children. @task T963 */
  totalTasks: number;
  /** Computed wave plan. @task T963 */
  waves: Wave[];
  /** Detected circular dependency chains. @task T963 */
  circularDependencies: string[][];
  /** Dependencies that point at nonexistent task ids. @task T963 */
  missingDependencies: string[];
  /**
   * Adjacency-list dependency graph (taskId → depends-on ids).
   * @task T963
   */
  dependencyGraph: Record<string, string[]>;
}

// orchestrate.context
/**
 * Parameters for `orchestrate.context`.
 *
 * @remarks
 * Re-synced to match `orchestrateContext(epicId?, projectRoot?)` in the
 * engine. The legacy `tokens` field was unused; the real parameter is
 * an optional `epicId` that scopes the task-count basis of the estimate.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface OrchestrateContextParams {
  /** Epic id to scope the context estimate. Omit for project-wide. @task T963 */
  epicId?: string;
}
/**
 * Result of `orchestrate.context`.
 *
 * @remarks
 * Mirrors `ContextEstimation` in `packages/core/src/orchestration/context.ts`.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface OrchestrateContextResult {
  /** Epic id the estimate was scoped to, or `null` for project-wide. @task T963 */
  epicId: string | null;
  /** Count of tasks included in the estimate. @task T963 */
  taskCount: number;
  /** Count of pipeline_manifest entries (ADR-027). @task T963 */
  manifestEntries: number;
  /** Rough estimated token count (taskCount * per-task weight). @task T963 */
  estimatedTokens: number;
  /** Human-readable recommendation. @task T963 */
  recommendation: string;
  /** Context budget limits + current usage. @task T963 */
  limits: {
    /** Maximum orchestrator context budget. @task T963 */
    orchestratorBudget: number;
    /** Max files a single agent should read. @task T963 */
    maxFilesPerAgent: number;
    /** Current token usage (mirrors `estimatedTokens`). @task T963 */
    currentUsage: number;
  };
}

// orchestrate.waves
/** Parameters for `orchestrate.waves`. @task T963 */
export interface OrchestrateWavesParams {
  /** Epic to compute waves for. @task T963 */
  epicId: string;
}
export type OrchestrateWavesResult = Wave[];

// orchestrate.plan (T890)
/** Parameters for `orchestrate.plan`. @task T890 */
export interface OrchestratePlanParams {
  /** Epic task id whose children make up the plan (required). @task T890 */
  epicId: string;
  /**
   * Optional preferred agent-resolver tier override for all workers in the
   * plan (0=project, 1=global, 2=packaged). When omitted, the plan engine
   * auto-selects the tier per role.
   * @task T890
   */
  preferTier?: 0 | 1 | 2;
}

/**
 * Per-worker entry in an `orchestrate.plan` wave.
 *
 * @task T890
 */
export interface OrchestratePlanWorker {
  /** Task id this entry represents. @task T890 */
  taskId: string;
  /** Human-readable task title (defaults to `taskId` when missing). @task T890 */
  title: string;
  /**
   * Resolved agent id (falls back to `'cleo-subagent'` when unresolved).
   * @task T890
   */
  persona: string;
  /** Protocol tier (0=worker, 1=lead, 2=orchestrator). @task T890 */
  tier: 0 | 1 | 2;
  /** Role derived from the resolved agent's `orchLevel`. @task T890 */
  role: 'orchestrator' | 'lead' | 'worker';
  /** Current task status (pending/active/done/…). @task T890 */
  status: string;
  /**
   * Declared file scope for this task. Empty array when no `AC.files` set.
   * @task T890
   */
  atomicScope: { files: string[] };
  /** Orchestration level sourced from the resolved agent (0..2). @task T890 */
  orchLevel: number;
  /** Ids of tasks this task depends on (sorted for determinism). @task T890 */
  dependsOn: string[];
}

/**
 * A single wave in the `orchestrate.plan` execution plan.
 *
 * @task T890
 */
export interface OrchestratePlanWave {
  /** 1-indexed wave number. @task T890 */
  wave: number;
  /**
   * Task id of the designated lead for this wave, or `null` when none was
   * resolved from the agent registry.
   * @task T890
   */
  leadTaskId: string | null;
  /** Ordered worker entries for this wave. @task T890 */
  workers: OrchestratePlanWorker[];
}

/**
 * Non-fatal warning emitted by `orchestrate.plan` (e.g. missing registry
 * row, no AC.files on a worker task).
 *
 * @task T890
 */
export interface OrchestratePlanWarning {
  /** Task id the warning applies to. @task T890 */
  taskId: string;
  /** Stable warning code (e.g. `'E_AGENT_NOT_FOUND'`, `'W_NO_ATOMIC_SCOPE'`). @task T890 */
  code: string;
  /** Human-readable message. @task T890 */
  message: string;
}

/**
 * Result of `orchestrate.plan`.
 *
 * @remarks
 * The plan is deterministic: given the same epic snapshot (task statuses,
 * dependencies, and `updatedAt` timestamps) the function always returns the
 * same `inputHash`. `generatedAt` is intentionally excluded from the hash
 * contract so two back-to-back calls can confirm reproducibility by comparing
 * `inputHash` values.
 *
 * @task T890
 */
export interface OrchestratePlanResult {
  /** Epic id the plan was computed for. @task T890 */
  epicId: string;
  /** Epic title (falls back to `epicId` when missing). @task T890 */
  epicTitle: string;
  /** Total number of child tasks considered (includes done tasks). @task T890 */
  totalTasks: number;
  /** Ordered waves produced by the dependency topological sort. @task T890 */
  waves: OrchestratePlanWave[];
  /** ISO 8601 timestamp when the plan was generated. @task T890 */
  generatedAt: string;
  /** `true` when the plan is reproducible from the current input snapshot. @task T890 */
  deterministic: boolean;
  /**
   * Sha256 hex digest of the sorted `(taskId, status, updatedAt, dependsOn)`
   * tuples + epicId. Identical inputs → identical hash.
   * @task T890
   */
  inputHash: string;
  /** Non-fatal warnings (graceful resolver misses, missing AC.files, …). @task T890 */
  warnings: OrchestratePlanWarning[];
}

// orchestrate.skill.list
/** Parameters for `orchestrate.skill.list`. @task T963 */
export interface OrchestrateSkillListParams {
  /** Free-text filter across skill name/tags. @task T963 */
  filter?: string;
}
export type OrchestrateSkillListResult = SkillDefinition[];

// orchestrate.bootstrap
/** Parameters for `orchestrate.bootstrap`. @task T963 */
export interface OrchestrateBootstrapParams {
  /** Bootstrap verbosity mode. @task T963 */
  speed?: 'fast' | 'full' | 'complete';
}
export interface BrainState {
  /**
   * Session summary: the caller's bound session, else the newest active row.
   * `unbound: true` marks the latter, which may be another agent's (T12500).
   * @task T963
   */
  session?: { id: string; name: string; status: string; startedAt: string; unbound?: boolean };
  /** Current task context. @task T963 */
  currentTask?: { id: string; title: string; status: string };
  /** Suggested next task with score. @task T963 */
  nextSuggestion?: { id: string; title: string; score: number };
  /** Recent decisions for the brain-state rollup. @task T963 */
  recentDecisions?: Array<{ id: string; decision: string; timestamp: string }>;
  /** Blockers currently affecting progress. @task T963 */
  blockers?: Array<{ taskId: string; title: string; blockedBy: string[] }>;
  /** Progress rollup. @task T963 */
  progress?: { total: number; done: number; active: number; blocked: number; pending: number };
  /** Context drift score + contributing factors. @task T963 */
  contextDrift?: { score: number; factors: string[] };
  /** Bootstrap envelope metadata. @task T963 */
  _meta: { speed: 'fast' | 'full' | 'complete'; generatedAt: string; version: string };
}

/**
 * Mutate Operations
 */

// orchestrate.startup
/** Parameters for `orchestrate.startup`. @task T963 */
export interface OrchestrateStartupParams {
  /** Epic id to initialize. @task T963 */
  epicId: string;
}
/**
 * Result of `orchestrate.startup`.
 *
 * @remarks
 * Re-synced to match `orchestrateStartup(epicId, projectRoot?)` + the
 * `computeStartupSummary` output + auto-init fields. The legacy shape
 * assumed nested status/analysis/firstTask envelopes; the engine actually
 * returns a flat summary + auto-init metadata.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface OrchestrateStartupResult {
  /** Epic id that was initialized. @task T963 */
  epicId: string;
  /** Epic title. @task T963 */
  epicTitle: string;
  /** Always true once startup reaches return — pipeline + research stage recorded. @task T963 */
  initialized: true;
  /** Summary rollup of the epic's children. @task T963 */
  summary: {
    /** Total child count. @task T963 */
    totalTasks: number;
    /** Wave count. @task T963 */
    totalWaves: number;
    /** Count of tasks ready to spawn. @task T963 */
    readyTasks: number;
    /** Per-status breakdown. @task T963 */
    byStatus: OrchestrateStatusCounts;
  };
  /** First wave payload, or `null` when epic has no children. @task T963 */
  firstWave: Wave | null;
  /**
   * True when this startup call auto-initialized the lifecycle to the
   * `research` stage. False when the epic already had a pipeline.
   * @task T963
   */
  autoInitialized: boolean;
  /**
   * Current pipeline stage after startup — `research` when auto-initialized,
   * `already-initialized` marker string otherwise.
   * @task T963
   */
  currentStage: string;
}

// orchestrate.spawn
/**
 * Parameters for `orchestrate.spawn` (T882 canonical spawn contract).
 *
 * @remarks
 * Re-synced to match `orchestrateSpawn(taskId, protocolType, projectRoot, tier)`
 * in `packages/core/src/orchestrate/spawn-ops.ts`. The legacy
 * `{skill, model}` fields from earlier drafts were never implemented — the
 * T882 rebuild (v2026.4.85) introduced `protocolType` + `tier` as the
 * authoritative inputs.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 * @task T882 — canonical spawn-prompt rebuild
 */
export interface OrchestrateSpawnParams {
  /** Task ID to spawn a worker for (required). @task T963 */
  taskId: string;
  /**
   * Protocol phase dispatched to the worker (e.g. `'research'`,
   * `'implementation'`, `'validation'`). When omitted, the composer runs
   * `autoDispatch` to classify the task.
   * @task T963
   */
  protocolType?: string;
  /**
   * Spawn prompt tier per T882 (0=minimal, 1=standard with CLEO-INJECTION
   * embed, 2=full with skill excerpts + SUBAGENT-PROTOCOL-BLOCK). When
   * omitted, resolved from the agent role (orchestrator=2, lead=1, worker=0).
   * @task T963
   */
  tier?: 0 | 1 | 2;
}
/**
 * Result of `orchestrate.spawn`.
 *
 * @remarks
 * Re-synced to match the T932 `composeSpawnForTask` payload envelope returned
 * by the orchestrate engine (prompt + atomicity verdict + traceability meta).
 * Mirrors `SpawnPayload` in `packages/core/src/orchestration/spawn.ts`.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface OrchestrateSpawnResult {
  /** Task ID the spawn is about (mirrors `task.id`). @task T963 */
  taskId: string;
  /**
   * Fully-resolved spawn prompt, copy-pastable into any LLM runtime
   * (Claude, GPT-4, Gemini, open-source). Primary payload every caller
   * should consume.
   * @task T963
   */
  prompt: string;
  /**
   * The spawned agent's identity: the same id as `worktreeEnv.CLEO_AGENT_ID`,
   * its per-agent session's handle (`agent-<task>`) and the worktree lock
   * holder. Before T13494 this field carried the classifier's persona.
   * @task T963
   * @task T13494
   */
  agentId: string;
  /**
   * The agent profile the classifier routed the task to (e.g.
   * `project-security-worker`, `cleo-subagent`); mirrors
   * `meta.classify.agentId`. It names what the prompt is written for, not who
   * runs it.
   * @task T13494
   */
  persona: string;
  /** Role the agent will execute as (`orchestrator` | `lead` | `worker`). @task T963 */
  role: string;
  /** Tier of the rendered prompt (0/1/2). @task T963 */
  tier: 0 | 1 | 2;
  /** Harness hint driving dedup decisions (`claude-code` | `generic` | `bare`). @task T963 */
  harnessHint: string;
  /**
   * Atomicity gate verdict from the worker file-scope guard. When
   * `allowed=false`, the spawn was rejected and the orchestrate engine
   * surfaces an `E_ATOMICITY_VIOLATION` error envelope.
   * @task T963
   */
  atomicity: {
    /** Whether the spawn is permitted. @task T963 */
    allowed: boolean;
    /** Error code when the spawn was rejected. @task T963 */
    code?: string;
    /** Diagnostic message. @task T963 */
    message?: string;
    /** Fix hint for the violation. @task T963 */
    fixHint?: string;
  };
  /**
   * Traceability / accounting metadata. Mirrors `SpawnPayloadMeta` —
   * pinned `composerVersion: '3.0.0'` on every call.
   * @task T963
   */
  meta: {
    /** Tier the resolved agent was sourced from. @task T963 */
    sourceTier: string;
    /** Characters saved by skipping the tier-1 CLEO-INJECTION embed. @task T963 */
    dedupSavedChars: number;
    /** Character length of the final prompt. @task T963 */
    promptChars: number;
    /** Protocol phase the prompt was rendered for. @task T963 */
    protocol: string;
    /** ISO 8601 timestamp when the payload was generated. @task T963 */
    generatedAt: string;
    /** Pinned composer contract version. @task T963 */
    composerVersion: '3.0.0';
  };
  /**
   * Mirror of `meta.protocol` at the top level for legacy callers. Equals
   * the resolved protocol phase (from `protocolType` param or auto-dispatch).
   * @task T963
   */
  protocolType: string;
  /**
   * Active session id threaded into the prompt, or `null` when the
   * orchestrator had no active session at spawn time.
   * @task T963
   */
  sessionId: string | null;
  /**
   * The worktree's dependency install outcome (`skipped` under `--no-install`,
   * `deferred` when the heavy-work budget was busy, with the command the
   * worker runs instead), or `null` without a worktree.
   * @task T13524
   */
  install?: import('./worktree.js').WorktreeInstallOutcome | null;
  /**
   * Legacy mirror of the prompt/protocolType/tier bundle for readers that
   * still consume `spawnContext.*`.
   * @task T963
   */
  spawnContext: {
    /** Task id mirrored from top level. @task T963 */
    taskId: string;
    /** Protocol string from the composer. @task T963 */
    protocol: string;
    /** Resolved protocol type. @task T963 */
    protocolType: string;
    /** Tier mirror. @task T963 */
    tier: 0 | 1 | 2;
    /** Prompt mirror. @task T963 */
    prompt: string;
  };
}

// orchestrate.handoff
/** Parameters for `orchestrate.handoff`. @task T963 */
export interface OrchestrateHandoffParams {
  /** Task id to hand off to. @task T963 */
  taskId: string;
  /** Protocol phase for the successor spawn. @task T963 */
  protocolType: string;
  /** Free-form session-end note. @task T963 */
  note?: string;
  /** Next-action hint for the successor. @task T963 */
  nextAction?: string;
  /** Context injection variant (skill preset). @task T963 */
  variant?: string;
  /** Tier override for the spawn prompt. @task T963 */
  tier?: 0 | 1 | 2;
  /** Client-supplied idempotency key for handoff retries. @task T963 */
  idempotencyKey?: string;
  /**
   * Skip worktree provisioning for the successor spawn (T1878 follow-up).
   *
   * Set to `true` in test fixtures that run in non-git temp directories.
   * Passed through to {@link orchestrateSpawn} as the `noWorktree` flag.
   * @task T1880
   */
  noWorktree?: boolean;
}
/** Result of `orchestrate.handoff`. @task T963 */
export interface OrchestrateHandoffResult {
  /** Task id that was handed off to. @task T963 */
  taskId: string;
  /** Session id that was active before handoff. @task T963 */
  predecessorSessionId: string;
  /** Session id that was ended. @task T963 */
  endedSessionId: string;
  /** Protocol type resolved for the successor. @task T963 */
  protocolType: string;
}

// orchestrate.validate
/** Validation issue surfaced by `orchestrate.validate`. @task T963 */
export interface OrchestrateValidationIssue {
  /** Stable issue code (e.g. `V_NOT_FOUND`, `V_UNMET_DEP`, `V_MISSING_TITLE`). @task T963 */
  code: string;
  /** Human-readable diagnostic message. @task T963 */
  message: string;
  /** Issue severity (`error` | `warning` | `info`). @task T963 */
  severity: string;
}
/** Parameters for `orchestrate.validate`. @task T963 */
export interface OrchestrateValidateParams {
  /** Task id to validate. @task T963 */
  taskId: string;
}
/**
 * Result of `orchestrate.validate`.
 *
 * @remarks
 * Re-synced to match `validateSpawnReadiness` in
 * `packages/core/src/orchestration/validate-spawn.ts`. The legacy shape
 * (`{blockers, lifecycleGate, recommendations}`) never matched the engine;
 * the real output is a `{ready, issues}` envelope.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface OrchestrateValidateResult {
  /** Task id that was validated. @task T963 */
  taskId: string;
  /** Task title snapshot. @task T963 */
  title: string;
  /** True when the task passed every readiness check. @task T963 */
  ready: boolean;
  /** Issues preventing spawn (empty array when `ready === true`). @task T963 */
  issues: OrchestrateValidationIssue[];
}

// orchestrate.parallel.start
/** Parameters for `orchestrate.parallel.start`. @task T963 */
export interface OrchestrateParallelStartParams {
  /** Epic id. @task T963 */
  epicId: string;
  /** Wave number to launch. @task T963 */
  wave: number;
}
/** Result of `orchestrate.parallel.start`. @task T963 */
export interface OrchestrateParallelStartResult {
  /** Wave number launched. @task T963 */
  wave: number;
  /** Task IDs in the wave. @task T963 */
  taskIds: string[];
  /** ISO 8601 start timestamp. @task T963 */
  started: string;
}

// orchestrate.parallel.end
/** Parameters for `orchestrate.parallel.end`. @task T963 */
export interface OrchestrateParallelEndParams {
  /** Epic id. @task T963 */
  epicId: string;
  /** Wave number that ended. @task T963 */
  wave: number;
}
/** Result of `orchestrate.parallel.end`. @task T963 */
export interface OrchestrateParallelEndResult {
  /** Wave number. @task T963 */
  wave: number;
  /** Tasks that completed successfully. @task T963 */
  completed: number;
  /** Tasks that failed. @task T963 */
  failed: number;
  /** Wave duration (ISO 8601 duration string). @task T963 */
  duration: string;
}

// orchestrate.report
/** Parameters for `orchestrate.report`. @task T10631 */
export interface OrchestrateReportParams {
  /** Epic to compute the readiness report for (required). @task T10631 */
  epicId: string;
  /** Page number (1-indexed) for paginated output. @task T10631 */
  page?: number;
  /** Page size for paginated output (default 50, max 200). @task T10631 */
  pageSize?: number;
}

/**
 * A group of tasks sharing the same readiness classification.
 * @task T10631
 */
export interface OrchestrateReportGroup {
  /** Group label: ready, blocked, blockedBy, gateBlocked, invalid. @task T10631 */
  group: 'ready' | 'blocked' | 'blockedBy' | 'gateBlocked' | 'invalid';
  /** Human-readable group description. @task T10631 */
  label: string;
  /** Count of tasks in this group (before pagination). @task T10631 */
  count: number;
  /** Tasks in this group (paginated). @task T10631 */
  tasks: OrchestrateReportEntry[];
}

/**
 * A single task entry in the readiness report.
 * @task T10631
 */
export interface OrchestrateReportEntry {
  /** Task id. @task T10631 */
  id: string;
  /** Task title. @task T10631 */
  title: string;
  /** Task priority. @task T10631 */
  priority: string;
  /** Task status. @task T10631 */
  status: string;
  /** Reason for the classification (e.g. blockedBy ids, gate names). @task T10631 */
  reason: string;
  /** Gate status summary (only for gateBlocked group). @task T10631 */
  gates?: Record<string, boolean>;
}

/**
 * Result of `orchestrate.report`.
 * @task T10631
 */
export interface OrchestrateReportResult {
  /** Epic id that was queried. @task T10631 */
  epicId: string;
  /** Epic title. @task T10631 */
  epicTitle: string;
  /** Total child task count (before grouping/pagination). @task T10631 */
  totalTasks: number;
  /** Grouped readiness report. @task T10631 */
  groups: OrchestrateReportGroup[];
  /** Pagination metadata. @task T10631 */
  pagination: {
    /** Current page (1-indexed). @task T10631 */
    page: number;
    /** Page size. @task T10631 */
    pageSize: number;
    /** Total pages available. @task T10631 */
    totalPages: number;
    /** Total entries across all groups (before pagination). @task T10631 */
    totalEntries: number;
  };
}

// ---------------------------------------------------------------------------
// Lead/worker split (epic T14351)
//
// A lead plans and delegates; workers do the work and report back. The lead's
// write and network tools are stripped so it cannot do the work itself, and a
// worker's report must carry proof the lead can check. Gated by the config key
// `orchestrate.leadWorker.v1` (default off).
// ---------------------------------------------------------------------------

/**
 * Tools a lead is denied under the lead/worker split: every tool that writes
 * files, runs commands or reaches the network. A lead only reads, plans and
 * delegates.
 *
 * @task T14356
 * @epic T14351
 */
export const LEAD_DENIED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
] as const;

/**
 * One tool name a lead is denied. Member of {@link LEAD_DENIED_TOOLS}.
 *
 * @task T14356
 */
export type LeadDeniedTool = (typeof LEAD_DENIED_TOOLS)[number];

/**
 * Whether a provider can remove tools from a spawned lead.
 *
 * - `'enforced'` — the provider strips the denied tools; the lead cannot call them.
 * - `'unsupported'` — the provider cannot strip them. Spawning a lead there with
 *   the split on is refused with `E_LEAD_TOOLS_UNSTRIPPED`.
 *
 * @task T14356
 */
export type LeadToolStripSupport = 'enforced' | 'unsupported';

/**
 * How a lead runs (T14363, owner decision):
 *
 * - `interactive` (default): a Claude session in the caller's terminal
 *   (stdio inherited, not detached). The owner types to it; it asks
 *   decisions with `AskUserQuestion`.
 * - `detached`: a background run. Owner decisions go to the owner's AgentMBX
 *   mailbox as a structured `hitl.request`, and the lead waits there.
 *
 * @task T14363
 */
export type LeadMode = 'interactive' | 'detached';

/**
 * Built-in tool an interactive lead may use to ask the owner (T14363).
 *
 * @task T14363
 */
export const LEAD_ASK_TOOL = 'AskUserQuestion';

/**
 * AgentMBX recipient for owner decisions of a detached lead (T14363).
 *
 * @task T14363
 */
export const LEAD_OWNER_MAILBOX = 'owner';

/**
 * AgentMBX MCP server name a lead may load beside the runner (T14423).
 *
 * @task T14423
 */
export const LEAD_MAILBOX_MCP_SERVER = 'mbx';

/**
 * The MCP servers a lead spawn loaded (T14423). A lead loads ONLY the runner
 * ({@link LEAD_RUNNER_MCP_SERVER}) and, when the user configured it, the
 * AgentMBX server ({@link LEAD_MAILBOX_MCP_SERVER}); every other user MCP
 * server is shut out, since one with shell or file tools would hand back
 * what the tool strip removed.
 *
 * @task T14423
 * @epic T14351
 */
export interface LeadMcpReport {
  /** Server names the lead loads, the runner first. */
  readonly servers: readonly string[];
  /**
   * `loaded` when the user-level mbx server was found, validated and passed;
   * `not-configured` when there is none; `refused` when an entry failed the
   * checks (not the agentmbx binary, a path inside the project, ...).
   */
  readonly mailbox: 'loaded' | 'not-configured' | 'refused';
  /** Why the mbx entry was refused (with `mailbox: 'refused'`). */
  readonly warning?: string;
}

/**
 * Tool policy applied to a lead spawn under the lead/worker split.
 *
 * @task T14356
 * @epic T14351
 */
export interface LeadToolPolicy {
  /** Tools removed from the lead. Normally {@link LEAD_DENIED_TOOLS}. */
  deniedTools: readonly LeadDeniedTool[];
  /** Whether the spawning provider can enforce {@link LeadToolPolicy.deniedTools}. */
  stripSupport: LeadToolStripSupport;
}

/**
 * MCP server name of the lead command runner. The lead reaches it as
 * {@link LEAD_RUNNER_TOOL}.
 *
 * @task T14374
 */
export const LEAD_RUNNER_MCP_SERVER = 'cleo-lead';

/**
 * Tool name the lead command runner serves.
 *
 * @task T14374
 */
export const LEAD_RUNNER_TOOL_NAME = 'cleo_run';

/**
 * Provider-qualified name of the lead command runner tool: the one way a lead
 * without Bash runs a command. It takes an argv array, never a shell string.
 *
 * @task T14374
 * @epic T14351
 */
export const LEAD_RUNNER_TOOL = `mcp__${LEAD_RUNNER_MCP_SERVER}__${LEAD_RUNNER_TOOL_NAME}` as const;

/**
 * Binary the lead command runner may execute.
 *
 * @task T14374
 */
export type LeadCommandBinary = 'cleo' | 'gh';

/**
 * How a lead-runner flag is parsed: `boolean` takes no value; `value` takes
 * the next argv word (which must not start with `-`) or an inline
 * `--flag=value`.
 *
 * @task T14374
 */
export type LeadFlagArity = 'boolean' | 'value';

/**
 * One allowed command, allow-only at every level: the full command path, the
 * flags it accepts with their arity, how many positional words it takes, and
 * the flags that must be set. Anything not listed is refused.
 *
 * @task T14374
 */
export interface LeadCommandRule {
  /** Full command path after the binary, down to a leaf, e.g. `['review', 'verdict']`. */
  readonly verb: readonly string[];
  /** Flags the command accepts, keyed by their full token (`--json`), with arity. */
  readonly flags?: Readonly<Record<string, LeadFlagArity>>;
  /** Most positional words allowed after the path. @defaultValue 0 */
  readonly positionals?: number;
  /**
   * Positional words must be plain numbers (a PR number or run id), so a URL
   * cannot point the command at another repository.
   */
  readonly numericPositionals?: boolean;
  /** Flags the parse must show set (a boolean set true, a value flag given a value). */
  readonly requireFlags?: readonly string[];
}

/**
 * Global `cleo` output flags (parsed by the CLI entry for every command) that
 * a lead may add after any allowed `cleo` command.
 *
 * @task T14374
 */
export const LEAD_CLEO_GLOBAL_FLAGS: Readonly<Record<string, LeadFlagArity>> = {
  '--json': 'boolean',
  '--human': 'boolean',
  '--quiet': 'boolean',
  '--full': 'boolean',
  '--verbose': 'boolean',
  '--summary': 'boolean',
  '--describe': 'boolean',
  '--field': 'value',
  '--fields': 'value',
  '--output': 'value',
  '--mvi': 'value',
};

/**
 * Commands a lead may run through {@link LEAD_RUNNER_TOOL}: read, plan,
 * dispatch and review verbs only, plus `merge train` (T14371), which merges only
 * PRs green on their exact head and reviewed per AC. Nothing here edits files,
 * pushes or answers an owner gate; anything not listed is refused.
 *
 * Each rule names a leaf command with no subcommands (checked against the
 * CLI command manifest), so neither a flag nor a flag value can select a
 * different subcommand; `briefing` is absent because it has one (`inject`).
 * `gh` positionals must be numbers, so a URL cannot reach another repo. `orchestrate` lists only its
 * read/plan/dispatch sub-verbs: never `worktree-complete` (merges),
 * `approve`/`reject` (owner gate), `lead-runner`, `prune`, `ivtr`,
 * `bootstrap` or `conduit-*`. `gh` takes no `--repo`, `--web`, `--watch`,
 * `--body-file`, `--edit-last` or `--delete-last`; a comment is `--body` text.
 *
 * @task T14374
 * @epic T14351
 */
export const LEAD_COMMAND_ALLOWLIST: Readonly<
  Record<LeadCommandBinary, readonly LeadCommandRule[]>
> = {
  cleo: [
    { verb: ['orchestrate', 'start'], positionals: 1 },
    { verb: ['orchestrate', 'status'], flags: { '--epic': 'value', '--merge-queue': 'boolean' } },
    { verb: ['orchestrate', 'dashboard'], flags: { '--window': 'value' } },
    { verb: ['orchestrate', 'roll-up'], positionals: 1, flags: { '--wave': 'value' } },
    {
      verb: ['orchestrate', 'analyze'],
      positionals: 1,
      flags: { '--mode': 'value', '--tasks': 'value' },
    },
    {
      verb: ['orchestrate', 'ready'],
      positionals: 1,
      flags: { '--ignore-deps-validate': 'boolean', '--via': 'value' },
    },
    {
      verb: ['orchestrate', 'report'],
      positionals: 1,
      flags: { '--page': 'value', '--page-size': 'value' },
    },
    { verb: ['orchestrate', 'next'], positionals: 1 },
    {
      verb: ['orchestrate', 'waves'],
      positionals: 1,
      flags: { '--via': 'value', '--hide-completed': 'boolean' },
    },
    { verb: ['orchestrate', 'plan'], positionals: 1, flags: { '--tier': 'value' } },
    {
      verb: ['orchestrate', 'spawn'],
      positionals: 1,
      flags: {
        '--protocol': 'value',
        '--tier': 'value',
        '--scope': 'value',
        '--orchestrator-defer': 'boolean',
        '--lead-mbx': 'value',
        '--base': 'value',
        '--include-deps': 'boolean',
        '--resume': 'boolean',
      },
    },
    {
      verb: ['orchestrate', 'validate'],
      positionals: 1,
      flags: { '--file': 'value', '--manifest': 'boolean' },
    },
    { verb: ['orchestrate', 'context'], positionals: 1 },
    { verb: ['orchestrate', 'parallel'], positionals: 2, flags: { '--wave': 'value' } },
    { verb: ['orchestrate', 'unblock'] },
    { verb: ['orchestrate', 'classify'], positionals: 1 },
    { verb: ['orchestrate', 'fanout-status'], flags: { '--manifest-entry-id': 'value' } },
    { verb: ['orchestrate', 'handoff'], positionals: 1, flags: { '--protocol': 'value' } },
    { verb: ['orchestrate', 'spawn-execute'], positionals: 1, flags: { '--base': 'value' } },
    { verb: ['orchestrate', 'fanout'], positionals: 1, flags: { '--tasks': 'value' } },
    { verb: ['orchestrate', 'pending'] },
    {
      verb: ['show'],
      positionals: 50,
      flags: { '--history': 'boolean', '--relations': 'boolean' },
    },
    {
      verb: ['find'],
      positionals: 1,
      flags: {
        '--id': 'value',
        '--exact': 'boolean',
        '--fuzzy': 'boolean',
        '--status': 'value',
        '--in': 'value',
        '--include-archive': 'boolean',
        '--limit': 'value',
        '--all': 'boolean',
        '--offset': 'value',
        '--kind': 'value',
        '--urgent': 'boolean',
        '--label': 'value',
        '--parent': 'value',
      },
    },
    {
      verb: ['list'],
      flags: {
        '--include-archive': 'boolean',
        '--parent': 'value',
        '--status': 'value',
        '--priority': 'value',
        '--type': 'value',
        '--severity': 'value',
        '--kind': 'value',
        '--phase': 'value',
        '--label': 'value',
        '--limit': 'value',
        '--offset': 'value',
        '--all': 'boolean',
      },
    },
    { verb: ['review', 'packet'], positionals: 1, flags: { '--task': 'value' } },
    { verb: ['review', 'check'], positionals: 1, flags: { '--task': 'value', '--ac': 'value' } },
    {
      verb: ['review', 'verdict'],
      positionals: 1,
      flags: {
        '--task': 'value',
        '--ac': 'value',
        '--met': 'boolean',
        '--unmet': 'boolean',
        '--reason': 'value',
        '--packet': 'value',
        '--answers': 'value',
      },
    },
    {
      verb: ['done'],
      flags: { '--from-merge': 'value', '--dry-run': 'boolean' },
      requireFlags: ['--from-merge', '--dry-run'],
    },
    {
      verb: ['memory', 'find'],
      positionals: 1,
      flags: {
        '--type': 'value',
        '--docs': 'boolean',
        '--history': 'boolean',
        '--pattern-type': 'value',
        '--min-confidence': 'value',
        '--actionable': 'boolean',
        '--limit': 'value',
        '--agent': 'value',
      },
    },
    { verb: ['memory', 'fetch'], positionals: 50 },
    { verb: ['session', 'status'] },
    {
      verb: ['decide', 'ask'],
      flags: {
        '--state': 'value',
        '--question': 'value',
        '--noul': 'value',
        '--timeout-ms': 'value',
        '--profile': 'value',
      },
    },
    { verb: ['merge', 'train'], flags: { '--dry-run': 'boolean', '--execute': 'boolean' } },
  ],
  gh: [
    {
      verb: ['pr', 'view'],
      positionals: 1,
      numericPositionals: true,
      flags: { '--json': 'value', '--jq': 'value', '--template': 'value', '--comments': 'boolean' },
    },
    {
      verb: ['pr', 'list'],
      flags: {
        '--state': 'value',
        '--limit': 'value',
        '--search': 'value',
        '--label': 'value',
        '--author': 'value',
        '--base': 'value',
        '--head': 'value',
        '--draft': 'boolean',
        '--json': 'value',
        '--jq': 'value',
      },
    },
    {
      verb: ['pr', 'checks'],
      positionals: 1,
      numericPositionals: true,
      flags: { '--json': 'value', '--jq': 'value', '--required': 'boolean' },
    },
    {
      verb: ['pr', 'diff'],
      positionals: 1,
      numericPositionals: true,
      flags: { '--name-only': 'boolean', '--patch': 'boolean', '--color': 'value' },
    },
    {
      verb: ['pr', 'comment'],
      positionals: 1,
      numericPositionals: true,
      flags: { '--body': 'value' },
      requireFlags: ['--body'],
    },
    {
      verb: ['run', 'list'],
      flags: {
        '--branch': 'value',
        '--workflow': 'value',
        '--limit': 'value',
        '--status': 'value',
        '--commit': 'value',
        '--event': 'value',
        '--user': 'value',
        '--json': 'value',
        '--jq': 'value',
      },
    },
    {
      verb: ['run', 'view'],
      positionals: 1,
      numericPositionals: true,
      flags: {
        '--log': 'boolean',
        '--log-failed': 'boolean',
        '--job': 'value',
        '--attempt': 'value',
        '--verbose': 'boolean',
        '--exit-status': 'boolean',
        '--json': 'value',
        '--jq': 'value',
      },
    },
  ],
};

/**
 * One piece of proof backing a worker's conclusion: a command it ran with its
 * exit code, an artifact it produced (a PR url, a file path, a commit sha), or
 * both. A proof entry with no field set proves nothing and is rejected with
 * `E_WORKER_REPORT_PROOF`.
 *
 * @task T14356
 */
export interface WorkerProof {
  /** Command the worker ran, verbatim. */
  command?: string;
  /** Exit code of {@link WorkerProof.command}. */
  exitCode?: number;
  /** Artifact the worker produced: a PR url, file path or commit sha. */
  artifact?: string;
}

/**
 * The report a worker returns to its lead: one conclusion, the blocker (or
 * `null`), and the proof behind the conclusion.
 *
 * @task T14356
 * @epic T14351
 */
export interface WorkerReport {
  /** One-line result of the worker's task. */
  conclusion: string;
  /** What stopped the worker, or `null` when nothing did. */
  blocker: string | null;
  /** Proof for {@link WorkerReport.conclusion}. Checked by the lead (T14361). */
  proof: WorkerProof[];
}
