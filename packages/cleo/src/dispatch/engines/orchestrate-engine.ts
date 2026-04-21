/**
 * Orchestrate Engine
 *
 * Thin wrapper layer that delegates to core modules.
 * All business logic lives in src/core/orchestration/.
 *
 * Wave 7a (T432): composeSpawnPayload from @cleocode/cant is now wired into
 * the orchestrateSpawnExecute path. Before the Pi adapter spawn call, the
 * composer runs JIT context assembly (context_sources from BRAIN + mental model)
 * and produces a token-budgeted systemPrompt. The resulting prompt replaces the
 * raw prepareSpawn prompt so subagents receive fully-composed context at spawn
 * time. This unblocks the ULTRAPLAN Wave 5 empirical gate (T432 blocker).
 *
 * @task T4478
 * @task T4784
 * @task T432
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type { Provider } from '@cleocode/caamp';
import type {
  AgentSpawnCapability,
  AgentTier,
  BrainState,
  CLEOSpawnAdapter,
  CLEOSpawnContext,
  ResolvedAgent,
  Task,
} from '@cleocode/contracts';
// Core module imports
import {
  AgentNotFoundError,
  orchestrationAnalyzeDependencies as analyzeDependencies,
  analyzeEpic,
  buildBrainState,
  composeSpawnPayload,
  computeEpicStatus,
  computeOverallStatus,
  computeProgress,
  computeStartupSummary,
  endParallelExecution,
  ensureGlobalSignaldockDb,
  estimateContext,
  getAccessor,
  orchestrationGetCriticalPath as getCriticalPath,
  getEnrichedWaves,
  getGlobalSignaldockDbPath,
  getLifecycleStatus,
  orchestrationGetNextTask as getNextTask,
  getParallelStatus,
  orchestrationGetReadyTasks as getReadyTasks,
  getSkillContent,
  getUnblockOpportunities,
  recordStageProgress,
  resolveAgent,
  resolveEffectiveTier,
  resolveProjectRoot,
  type SpawnPayload,
  startParallelExecution,
  validateSpawnReadiness,
} from '@cleocode/core/internal';
import { cleoErrorToEngineError, type EngineResult, engineError } from './_error.js';
import { sessionContextInject, sessionEnd, sessionStatus } from './session-engine.js';

// ---------------------------------------------------------------------------
// node:sqlite interop — matches the pattern used inside @cleocode/core so the
// plan engine can open a short-lived handle to the global signaldock.db for
// resolver lookups without routing through a long-lived cache.
// ---------------------------------------------------------------------------

const _engineRequire = createRequire(import.meta.url);
type _SignaldockDbHandle = _DatabaseSyncType;
const { DatabaseSync: _DatabaseSyncCtor } = _engineRequire('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => _DatabaseSyncType;
};

// ---------------------------------------------------------------------------
// Conduit event helper — best-effort, never throws, never blocks orchestration
// ---------------------------------------------------------------------------

/** Structured payload for a conduit orchestration event message. */
interface ConduitOrchestrationEvent {
  event: 'agent.spawned' | 'orchestrate.handoff';
  taskId: string;
  [key: string]: unknown;
}

/**
 * Send a structured orchestration event to conduit.db via the active agent
 * credential. Failures are silently swallowed — conduit events MUST NOT block
 * or alter orchestration outcomes.
 *
 * @param cwd   - Project root used to locate conduit.db and the agent registry.
 * @param to    - Recipient agent ID (e.g. 'cleo-core').
 * @param event - Structured event payload (LAFS-shaped JSON).
 */
async function sendConduitEvent(
  cwd: string,
  to: string,
  event: ConduitOrchestrationEvent,
): Promise<void> {
  try {
    const { AgentRegistryAccessor, createConduit } = await import('@cleocode/core/internal');
    const registry = new AgentRegistryAccessor(cwd);

    const conduit = await createConduit(registry);
    try {
      await conduit.send(to, JSON.stringify(event));
    } finally {
      await conduit.disconnect();
    }
  } catch {
    // Best-effort: conduit failures must never surface to callers
  }
}

type HandoffStepStatus = 'pending' | 'completed' | 'failed' | 'skipped';

interface HandoffStepState {
  status: HandoffStepStatus;
  operation: string;
  message?: string;
}

interface HandoffState {
  contextInject: HandoffStepState;
  sessionEnd: HandoffStepState;
  spawn: HandoffStepState;
}

interface OrchestrateHandoffParams {
  taskId: string;
  protocolType: string;
  note?: string;
  nextAction?: string;
  variant?: string;
  tier?: 0 | 1 | 2;
  idempotencyKey?: string;
}

interface HandoffFailureDetails {
  failedStep: 'session.context.inject' | 'session.end' | 'orchestrate.spawn';
  activeSessionId: string | null;
  endedSessionId: string | null;
  idempotency: {
    key: string | null;
    policy: 'non-idempotent';
    safeRetryFrom: 'start' | 'orchestrate.spawn';
    reason: string;
  };
  steps: HandoffState;
}

/**
 * Load all tasks from task data.
 */
async function loadTasks(projectRoot?: string): Promise<Task[]> {
  const root = projectRoot || resolveProjectRoot();
  try {
    const accessor = await getAccessor(root);
    const result = await accessor.queryTasks({});
    return result?.tasks ?? [];
  } catch {
    return [];
  }
}

/**
 * orchestrate.status - Get orchestrator status
 * @task T4478
 */
export async function orchestrateStatus(
  epicId?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const tasks = await loadTasks(root);

    if (epicId) {
      const epic = tasks.find((t) => t.id === epicId);
      if (!epic) {
        return engineError('E_NOT_FOUND', `Epic ${epicId} not found`);
      }

      const children = tasks.filter((t) => t.parentId === epicId);
      const status = computeEpicStatus(epicId, epic.title, children);

      return { success: true, data: status };
    }

    // No epicId - return overall status
    const status = computeOverallStatus(tasks);
    return { success: true, data: status };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message);
  }
}

/**
 * orchestrate.analyze - Dependency analysis
 * @task T4478
 */
export async function orchestrateAnalyze(
  epicId?: string,
  projectRoot?: string,
  mode?: string,
): Promise<EngineResult> {
  // Mode: critical-path (delegates to critical path engine)
  if (mode === 'critical-path') {
    return orchestrateCriticalPath(projectRoot);
  }

  // Default mode: analysis (requires epicId)
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required for standard analysis');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await analyzeEpic(epicId, root, accessor);

    // Add dependency graph and circular dep detection via core analyze module
    const tasks = await loadTasks(root);
    const children = tasks.filter((t) => t.parentId === epicId);
    const depAnalysis = analyzeDependencies(children, tasks);

    return {
      success: true,
      data: {
        epicId: result.epicId,
        epicTitle: tasks.find((t) => t.id === epicId)?.title || epicId,
        totalTasks: result.totalTasks,
        waves: result.waves,
        circularDependencies: depAnalysis.circularDependencies,
        missingDependencies: depAnalysis.missingDependencies,
        dependencyGraph: depAnalysis.dependencyGraph,
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * orchestrate.ready - Get parallel-safe tasks (ready to execute)
 * @task T4478
 */
export async function orchestrateReady(
  epicId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    // T929: verify the epic exists before computing the ready-set so that a
    // nonexistent epicId returns E_NOT_FOUND (exit 4) instead of success:{total:0}.
    const tasks = await loadTasks(root);
    const epic = tasks.find((t) => t.id === epicId);
    if (!epic) {
      return engineError('E_NOT_FOUND', `Epic ${epicId} not found`);
    }
    const accessor = await getAccessor(root);
    const readyTasks = await getReadyTasks(epicId, root, accessor);
    const ready = readyTasks.filter((t) => t.ready);

    // T929: when no tasks are ready, include a diagnostic reason so callers
    // can distinguish "all done" from "all blocked" without a second query.
    let reason: string | undefined;
    if (ready.length === 0) {
      const all = readyTasks;
      const blockedCount = all.filter((t) => !t.ready && t.blockers.length > 0).length;
      if (all.length === 0) {
        reason = 'epic has no children';
      } else if (blockedCount === all.length) {
        reason = 'all children have unmet dependencies';
      } else {
        reason = 'no tasks with unmet dependencies found; check child task statuses';
      }
    }

    return {
      success: true,
      data: {
        epicId,
        readyTasks: ready.map((t) => ({
          id: t.taskId,
          title: t.title,
          priority: 'medium', // getReadyTasks doesn't return priority
          depends: t.blockers,
        })),
        total: ready.length,
        ...(reason !== undefined && { reason }),
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * orchestrate.next - Next task to spawn
 * @task T4478
 */
export async function orchestrateNext(epicId: string, projectRoot?: string): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const nextTask = await getNextTask(epicId, root, accessor);

    if (!nextTask) {
      return {
        success: true,
        data: {
          epicId,
          nextTask: null,
          message: 'No tasks ready to spawn. All pending tasks may have unmet dependencies.',
        },
      };
    }

    // Get all ready tasks for alternatives
    const readyTasks = await getReadyTasks(epicId, root, accessor);
    const ready = readyTasks.filter((t) => t.ready);

    return {
      success: true,
      data: {
        epicId,
        nextTask: { id: nextTask.taskId, title: nextTask.title, priority: 'medium' },
        alternatives: ready
          .slice(1, 4)
          .map((t) => ({ id: t.taskId, title: t.title, priority: 'medium' })),
        totalReady: ready.length,
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * orchestrate.waves - Compute dependency waves
 * @task T4478
 */
export async function orchestrateWaves(
  epicId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await getEnrichedWaves(epicId, root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * orchestrate.context - Context usage check
 * @task T4478
 */
export async function orchestrateContext(
  epicId?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const tasks = await loadTasks(root);

    let taskCount = tasks.length;
    if (epicId) {
      taskCount = tasks.filter((t) => t.parentId === epicId).length;
    }

    const contextData = estimateContext(taskCount, root, epicId);
    return { success: true, data: contextData };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message);
  }
}

/**
 * orchestrate.validate - Validate spawn readiness for a task
 * @task T4478
 */
export async function orchestrateValidate(
  taskId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId) {
    return engineError('E_INVALID_INPUT', 'taskId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await validateSpawnReadiness(taskId, root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_VALIDATION', (err as Error).message);
  }
}

/**
 * orchestrate.spawn.select - Select best provider for spawn based on required capabilities
 * @task T5236
 */
export async function orchestrateSpawnSelectProvider(
  capabilities: Array<
    | 'supportsSubagents'
    | 'supportsProgrammaticSpawn'
    | 'supportsInterAgentComms'
    | 'supportsParallelSpawn'
  >,
  _projectRoot?: string,
): Promise<EngineResult> {
  if (!capabilities || capabilities.length === 0) {
    return engineError('E_INVALID_INPUT', 'At least one capability is required');
  }

  try {
    const { initializeDefaultAdapters, spawnRegistry } = await import('@cleocode/core/internal');
    const { getAllProviders, getProvidersBySpawnCapability, providerSupportsById } = await import(
      '@cleocode/caamp'
    );

    await initializeDefaultAdapters();

    // Get providers matching all required capabilities
    let matchingProviders: Provider[] = [];

    if (capabilities.length === 1) {
      // Single capability - use direct filter
      matchingProviders = getProvidersBySpawnCapability(capabilities[0]);
    } else {
      // Multiple capabilities - find intersection
      const providerSets = capabilities.map(
        (cap) => new Set(getProvidersBySpawnCapability(cap).map((p: Provider) => p.id)),
      );

      // Find intersection of all provider IDs
      const allProviders = await spawnRegistry.listSpawnCapable();
      const intersection = allProviders
        .filter((adapter) => providerSets.every((set) => set.has(adapter.providerId)))
        .map((adapter) => getAllProviders().find((p: Provider) => p.id === adapter.providerId))
        .filter((provider): provider is Provider => provider !== undefined);

      matchingProviders = intersection;
    }

    if (matchingProviders.length === 0) {
      return {
        success: false,
        error: {
          code: 'E_SPAWN_NO_PROVIDER',
          message: `No provider found with all required capabilities: ${capabilities.join(', ')}`,
          exitCode: 60,
        },
      };
    }

    // Get first registered adapter for the matching providers
    const adapter = matchingProviders
      .map((p: { id: string }) => spawnRegistry.getForProvider(p.id))
      .find((a: unknown): a is CLEOSpawnAdapter => a !== undefined);

    if (!adapter) {
      return {
        success: false,
        error: {
          code: 'E_SPAWN_NO_ADAPTER',
          message: 'No spawn adapter registered for matching providers',
          exitCode: 60,
        },
      };
    }

    // Verify adapter can actually spawn
    const canSpawn = await adapter.canSpawn();
    if (!canSpawn) {
      return {
        success: false,
        error: {
          code: 'E_SPAWN_ADAPTER_UNAVAILABLE',
          message: `Selected adapter '${adapter.id}' cannot spawn in current environment`,
          exitCode: 63,
        },
      };
    }

    return {
      success: true,
      data: {
        providerId: adapter.providerId,
        adapterId: adapter.id,
        capabilities: capabilities.filter((cap) =>
          providerSupportsById(adapter.providerId, `spawn.${cap}`),
        ),
      },
    };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message);
  }
}

/**
 * orchestrate.spawn.execute - Execute spawn for a task using adapter registry
 * @task T5236
 */
export async function orchestrateSpawnExecute(
  taskId: string,
  adapterId?: string,
  protocolType?: string,
  projectRoot?: string,
  tier?: 0 | 1 | 2,
): Promise<EngineResult> {
  const cwd = projectRoot ?? process.cwd();

  try {
    // Get spawn registry
    const { initializeDefaultAdapters, spawnRegistry } = await import('@cleocode/core/internal');
    await initializeDefaultAdapters();

    // Find adapter
    let adapter: CLEOSpawnAdapter | undefined;
    if (adapterId) {
      adapter = spawnRegistry.get(adapterId);
    } else {
      // Auto-select first capable adapter
      const capable = await spawnRegistry.listSpawnCapable();
      adapter = capable[0];
    }

    if (!adapter) {
      return {
        success: false,
        error: {
          code: 'E_SPAWN_NO_ADAPTER',
          message: 'No spawn adapter available for this provider',
          exitCode: 60,
        },
      };
    }

    // Verify provider supports subagents using providerSupportsById
    const { providerSupportsById } = await import('@cleocode/caamp');
    if (!providerSupportsById(adapter.providerId, 'spawn.supportsSubagents')) {
      return {
        success: false,
        error: {
          code: 'E_SPAWN_CAPABILITY_UNSUPPORTED',
          message: `Provider ${adapter.providerId} does not support spawning subagents`,
          exitCode: 60,
        },
      };
    }

    // Route the spawn through the canonical composer (T932). This activates
    // atomicity, harness dedup, resolved-agent metadata, and traceability
    // meta — all returned in a single SpawnPayload envelope.
    const { getActiveSession } = await import('@cleocode/core/internal');
    let activeSessionId: string | null = null;
    try {
      const active = await getActiveSession(cwd);
      activeSessionId = active?.id ?? null;
    } catch {
      activeSessionId = null;
    }

    const payload = await composeSpawnForTask(taskId, cwd, {
      tier,
      sessionId: activeSessionId,
      protocol: protocolType,
    });

    // Atomicity violations short-circuit the spawn so the adapter never sees
    // a rejected payload. Full verdict is preserved under `error.details`.
    if (!payload.atomicity.allowed) {
      return {
        success: false,
        error: {
          code: payload.atomicity.code ?? 'E_ATOMICITY_VIOLATION',
          message: payload.atomicity.message ?? 'Atomicity gate rejected spawn',
          exitCode: 69,
          details: {
            taskId,
            atomicity: payload.atomicity,
            meta: payload.meta,
            fix: payload.atomicity.fixHint,
          },
        },
      };
    }

    // Build CLEO spawn context from core spawn payload
    const { getSpawnCapableProviders } = await import('@cleocode/caamp');
    const providers = getSpawnCapableProviders();
    const provider = providers.find((p: { id: string }) => p.id === adapter.providerId);

    if (!provider) {
      return {
        success: false,
        error: {
          code: 'E_SPAWN_NO_PROVIDER',
          message: `Provider ${adapter.providerId} not found`,
          exitCode: 60,
        },
      };
    }

    // The raw prompt from the composer is passed to the adapter unchanged.
    // CANT bundle compilation, mental model injection, and identity bootstrap
    // are all handled inside buildCantEnrichedPrompt() at the adapter layer
    // (packages/adapters/src/cant-context.ts). The agentDef is not currently
    // threaded through composeSpawnPayload (T891 will classify + resolve a
    // full CANT team envelope); until then the adapter receives the prompt
    // alone and falls back to its own mental-model injection defaults.
    const rawPrompt = payload.prompt;

    const cleoSpawnContext: CLEOSpawnContext = {
      taskId: payload.taskId,
      protocol: protocolType || payload.meta.protocol,
      prompt: rawPrompt,
      provider: provider.id,
      options: {
        prompt: rawPrompt,
      },
      workingDirectory: cwd,
      tokenResolution: {
        resolved: [],
        unresolved: [],
        totalTokens: 0,
      },
    };

    // Wave 6-C/D: Capacity-aware routing — find the least-loaded agent and
    // attach it as a preferred routing hint on the spawn options.
    // Best-effort: if no agents are registered or the check throws, fall
    // through to default spawn behavior without blocking.
    try {
      const { findLeastLoadedAgent } = await import('@cleocode/core/internal');
      const leastLoaded = await findLeastLoadedAgent(undefined, cwd);
      if (leastLoaded) {
        cleoSpawnContext.options = {
          ...cleoSpawnContext.options,
          preferredAgent: leastLoaded.id,
        };
      }
    } catch {
      // Capacity check is best-effort — never block spawn
    }

    // Dispatch SubagentStart hook BEFORE spawning — triggers brain observation
    // recording and conduit messaging for the agent lifecycle (T555).
    try {
      const { hooks } = await import('@cleocode/core/internal');
      await hooks
        .dispatch('SubagentStart', cwd, {
          timestamp: new Date().toISOString(),
          taskId,
          agentId: cleoSpawnContext.options?.preferredAgent ?? `worker-${taskId}`,
          role: protocolType || 'worker',
          providerId: adapter.providerId,
        })
        .catch(() => {
          /* Hooks are best-effort — never block spawn */
        });
    } catch {
      /* Hook registry unavailable — non-fatal */
    }

    // Execute spawn
    const result = await adapter.spawn(cleoSpawnContext);

    // Dispatch SubagentStop hook AFTER spawn returns — records completion
    // status in brain and conduit (T555).
    try {
      const { hooks } = await import('@cleocode/core/internal');
      await hooks
        .dispatch('SubagentStop', cwd, {
          timestamp: new Date().toISOString(),
          taskId,
          agentId: cleoSpawnContext.options?.preferredAgent ?? `worker-${taskId}`,
          status: result.status,
          instanceId: result.instanceId,
        })
        .catch(() => {
          /* Hooks are best-effort — never block spawn */
        });
    } catch {
      /* Hook registry unavailable — non-fatal */
    }

    // Best-effort: record spawn event in conduit.db so agents can observe
    // orchestration activity. Never awaited in a blocking way — fires and
    // the main return path continues regardless of conduit outcome.
    void sendConduitEvent(cwd, 'cleo-core', {
      event: 'agent.spawned',
      taskId,
      instanceId: result.instanceId,
      status: result.status,
      providerId: adapter.providerId,
      adapterId: adapter.id,
      tier: tier ?? null,
      spawnedAt: new Date().toISOString(),
    });

    return {
      success: true,
      data: {
        instanceId: result.instanceId,
        status: result.status,
        providerId: adapter.providerId,
        taskId,
        timing: result.timing,
        tier: tier ?? null,
        atomicity: payload.atomicity,
        meta: payload.meta,
        agentId: payload.agentId,
        role: payload.role,
        harnessHint: payload.harnessHint,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_SPAWN_FAILED',
        message: error instanceof Error ? error.message : 'Unknown spawn error',
        exitCode: 60,
      },
    };
  }
}

/**
 * Open a short-lived signaldock db handle for composer lookups.
 *
 * Mirrors the pattern used by {@link orchestratePlan}: we intentionally do
 * NOT cache this handle — the resolver contract owns its own lifecycle and
 * callers must close the returned handle when the batch completes.
 *
 * @returns Open {@link _SignaldockDbHandle} bound to the global signaldock.db.
 * @task T932
 */
async function openSignaldockDbForComposer(): Promise<_SignaldockDbHandle> {
  await ensureGlobalSignaldockDb();
  const dbPath = getGlobalSignaldockDbPath();
  const db = new _DatabaseSyncCtor(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * Compose a spawn payload through {@link composeSpawnPayload} with a task-id
 * lookup shortcut.
 *
 * Centralizes the composer invocation used by both {@link orchestrateSpawn}
 * and {@link orchestrateSpawnExecute} so every spawn emit path in the engine
 * routes through the same canonical composer.
 *
 * @param taskId         - Task to render the spawn for.
 * @param root           - Absolute project root.
 * @param options        - Composer overrides (tier, sessionId, role, …).
 * @returns Full {@link SpawnPayload} envelope with atomicity + meta surfaced.
 * @task T932
 */
async function composeSpawnForTask(
  taskId: string,
  root: string,
  options: {
    tier?: 0 | 1 | 2;
    sessionId?: string | null;
    role?: AgentSpawnCapability;
    protocol?: string;
    skipAtomicityCheck?: boolean;
  } = {},
): Promise<SpawnPayload> {
  const accessor = await getAccessor(root);
  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  // T1014: Auto-promote epics to lead role so atomicity file-scope check is
  // bypassed. Epics coordinate atomic workers — they are inherently broad in
  // scope and must not be blocked by the worker file-scope gate.
  const inferredRole: AgentSpawnCapability | undefined =
    options.role ?? (task.type === 'epic' ? 'lead' : undefined);

  // T892: When no explicit tier is supplied, apply the auto-tier heuristics
  // (role matrix + size/type/label overrides) instead of the default role-only
  // mapping. Callers that pass an explicit tier always win.
  const effectiveTier: 0 | 1 | 2 | undefined =
    options.tier !== undefined
      ? options.tier
      : resolveEffectiveTier(task, inferredRole ?? 'worker', undefined);

  const db = await openSignaldockDbForComposer();
  try {
    return await composeSpawnPayload(db, task, {
      tier: effectiveTier,
      projectRoot: root,
      sessionId: options.sessionId ?? null,
      role: inferredRole,
      protocol: options.protocol,
      skipAtomicityCheck: options.skipAtomicityCheck ?? false,
    });
  } finally {
    db.close();
  }
}

/**
 * orchestrate.spawn - Generate spawn prompt for a task.
 *
 * Every spawn emit in the engine routes through
 * {@link composeSpawnPayload} (T932) so atomicity, harness-hint dedup, and
 * traceability metadata are active on every orchestrate spawn. Legacy
 * {@link prepareSpawn} is no longer called directly from this path.
 *
 * The response envelope surfaces:
 *
 *  - `atomicity` — the worker file-scope gate verdict
 *  - `meta.composerVersion` — pinned to `'3.0.0'` for the T932 composer path
 *  - `meta.dedupSavedChars` — characters saved via harness-hint dedup
 *  - `meta.promptChars` — total rendered prompt length
 *  - `meta.sourceTier` — registry tier the resolved agent was sourced from
 *
 * Atomicity violations return an `E_ATOMICITY_VIOLATION` error envelope with
 * the full verdict attached to `error.details.atomicity` so callers can
 * inspect the rejection reason before retrying.
 *
 * @task T4478
 * @task T932
 */
export async function orchestrateSpawn(
  taskId: string,
  protocolType?: string,
  projectRoot?: string,
  tier?: 0 | 1 | 2,
): Promise<EngineResult> {
  if (!taskId) {
    return engineError('E_INVALID_INPUT', 'taskId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();

    // Validate readiness first.
    // T929: a V_NOT_FOUND issue means the task ID doesn't exist in the DB —
    // surface E_NOT_FOUND (exit 4) so callers get a clear, actionable error
    // instead of a generic spawn-validation failure that obscures the root cause.
    const accessor = await getAccessor(root);
    const validation = await validateSpawnReadiness(taskId, root, accessor);
    if (!validation.ready) {
      const notFound = validation.issues.some((i) => i.code === 'V_NOT_FOUND');
      if (notFound) {
        return engineError('E_NOT_FOUND', `Task ${taskId} not found`, {
          fix: `cleo find "${taskId}"`,
        });
      }
      return engineError('E_SPAWN_VALIDATION_FAILED', `Task ${taskId} is not ready to spawn`, {
        details: { issues: validation.issues },
      });
    }

    // Thread the orchestrator's active session id into the spawn prompt so
    // the subagent logs every mutation against the same session. Failure to
    // load the session is non-fatal — the prompt degrades gracefully with a
    // "no active session" notice.
    let activeSessionId: string | null = null;
    try {
      const { getActiveSession } = await import('@cleocode/core/internal');
      const active = await getActiveSession(root);
      activeSessionId = active?.id ?? null;
    } catch {
      activeSessionId = null;
    }

    // Route every spawn through the canonical composer (T932). Atomicity,
    // harness-hint dedup, resolved-agent metadata, and traceability meta are
    // all populated here — prepareSpawn/buildSpawnPrompt are NOT called
    // directly from this path anymore.
    const payload = await composeSpawnForTask(taskId, root, {
      tier,
      sessionId: activeSessionId,
      protocol: protocolType,
    });

    // Surface atomicity violations as a first-class error envelope so callers
    // can react programmatically. The full verdict is attached to
    // `error.details.atomicity` so diagnostics are preserved.
    if (!payload.atomicity.allowed) {
      return engineError(
        payload.atomicity.code ?? 'E_ATOMICITY_VIOLATION',
        payload.atomicity.message ?? 'Atomicity gate rejected spawn',
        {
          details: {
            taskId,
            atomicity: payload.atomicity,
            meta: payload.meta,
          },
          fix: payload.atomicity.fixHint,
        },
      );
    }

    // T1118 L1+L2 — Create a git worktree for this task and build the spawn env.
    // Non-fatal: if worktree creation fails (e.g. not a git repo, git not installed),
    // we degrade gracefully and emit a warning so spawn continues without isolation.
    let worktreeResult: import('@cleocode/contracts').WorktreeSpawnResult | null = null;
    try {
      const { buildWorktreeSpawnResult, createAgentWorktree, ensureGitShimDir } = await import(
        '@cleocode/core/internal'
      );
      const worktree = createAgentWorktree(taskId, root);
      const shimDir = ensureGitShimDir(root);
      worktreeResult = buildWorktreeSpawnResult(worktree, shimDir);
    } catch (wtErr) {
      getLogger('engine:orchestrate').warn(
        { taskId, err: wtErr },
        `T1118 worktree creation failed for ${taskId} — spawning without isolation: ${wtErr instanceof Error ? wtErr.message : String(wtErr)}`,
      );
    }

    // Prepend the branch-isolation preamble to the spawn prompt when worktree was created.
    const finalPrompt = worktreeResult
      ? `${worktreeResult.preamble}\n${payload.prompt}`
      : payload.prompt;

    // Return shape: `prompt` at the top level is the primary payload every
    // caller should consume. `atomicity` + `meta` surface the T932 composer
    // guarantees. `spawnContext` mirrors the prompt for legacy readers.
    return {
      success: true,
      data: {
        taskId,
        prompt: finalPrompt,
        agentId: payload.agentId,
        role: payload.role,
        tier: payload.tier,
        harnessHint: payload.harnessHint,
        atomicity: payload.atomicity,
        meta: payload.meta,
        // T1118 L1+L2 — worktree binding for harness adapters.
        worktree: worktreeResult?.worktree ?? null,
        worktreeEnv: worktreeResult?.envVars ?? null,
        worktreeCwd: worktreeResult?.cwd ?? null,
        spawnContext: {
          taskId: payload.taskId,
          protocol: payload.meta.protocol,
          protocolType: protocolType || payload.meta.protocol,
          tier: payload.tier,
          prompt: finalPrompt,
        },
        protocolType: protocolType || payload.meta.protocol,
        sessionId: activeSessionId,
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * orchestrate.startup - Initialize orchestration for an epic.
 *
 * Auto-initializes the RCASD-IVTR lifecycle at the 'research' stage if the
 * epic has not already been initialized. This is idempotent — a second call
 * detects the existing pipeline and skips re-initialization.
 *
 * Result data includes:
 * - `autoInitialized`  — true if this call created the lifecycle pipeline
 * - `currentStage`     — 'research' when newly initialized, 'already-initialized' otherwise
 *
 * @task T4478
 * @task T785
 */
export async function orchestrateStartup(
  epicId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);

    const tasks = await loadTasks(root);
    const epic = tasks.find((t) => t.id === epicId);
    if (!epic) {
      return engineError('E_NOT_FOUND', `Epic ${epicId} not found`);
    }

    const children = tasks.filter((t) => t.parentId === epicId);
    const readyTasks = await getReadyTasks(epicId, root, accessor);
    const ready = readyTasks.filter((t) => t.ready);

    // Auto-initialize lifecycle at 'research' stage if not already initialized.
    // getLifecycleStatus returns initialized:false when no pipeline exists.
    // recordStageProgress creates the pipeline + stage record idempotently via
    // ensureLifecycleContext, so re-invoking orchestrateStartup is safe.
    const lifecycleStatus = await getLifecycleStatus(epicId, root);
    let autoInitialized = false;
    let currentStage: string;

    if (!lifecycleStatus.initialized) {
      await recordStageProgress(epicId, 'research', 'in_progress', undefined, root);
      autoInitialized = true;
      currentStage = 'research';
    } else {
      currentStage = 'already-initialized';
    }

    const summary = computeStartupSummary(epicId, epic.title, children, ready.length);
    return { success: true, data: { ...summary, autoInitialized, currentStage } };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * orchestrate.bootstrap - Load brain state for agent bootstrapping
 * @task T4478
 * @task T4657
 */
export async function orchestrateBootstrap(
  projectRoot?: string,
  params?: { speed?: 'fast' | 'full' | 'complete' },
): Promise<EngineResult<BrainState>> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const brain = await buildBrainState(root, params, accessor);
    return { success: true, data: brain };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message);
  }
}

/**
 * orchestrate.critical-path - Find the longest dependency chain
 * @task T4478
 */
export async function orchestrateCriticalPath(projectRoot?: string): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await getCriticalPath(root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message);
  }
}

/**
 * orchestrate.unblock-opportunities - Analyze dependency graph for unblocking opportunities
 * @task T4478
 */
export async function orchestrateUnblockOpportunities(projectRoot?: string): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await getUnblockOpportunities(root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message);
  }
}

/**
 * orchestrate.parallel - Manage parallel execution (start/end)
 * @task T4632
 */
export async function orchestrateParallel(
  action: 'start' | 'end',
  epicId: string,
  wave?: number,
  projectRoot?: string,
): Promise<EngineResult> {
  if (action === 'start') {
    if (wave === undefined || wave === null) {
      return engineError('E_INVALID_INPUT', 'wave number is required for start action');
    }
    return orchestrateParallelStart(epicId, wave, projectRoot);
  }

  if (action === 'end') {
    // wave is technically optional for end if we want to end ANY parallel execution,
    // but the current implementation expects wave.
    // However, endParallelExecution calls endParallelExecution(epicId, wave, root)
    if (wave === undefined || wave === null) {
      // If wave is not provided, maybe we can find the active one?
      // For now, let's require it to match the underlying signature or default to 0/current?
      // The underlying `endParallelExecution` signature is `(epicId: string, wave: number, root: string)`.
      // Let's require it for now to be safe, or check if we can improve this.
      return engineError('E_INVALID_INPUT', 'wave number is required for end action');
    }
    return orchestrateParallelEnd(epicId, wave, projectRoot);
  }

  return engineError('E_INVALID_INPUT', `Unknown parallel action: ${action}`);
}

/**
 * orchestrate.parallel.start - Start parallel execution for a wave
 * @task T4632
 */
export async function orchestrateParallelStart(
  epicId: string,
  wave: number,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }
  if (wave === undefined || wave === null) {
    return engineError('E_INVALID_INPUT', 'wave number is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await startParallelExecution(epicId, wave, root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Failed to start parallel execution');
  }
}

/**
 * orchestrate.parallel.end - End parallel execution for a wave
 * @task T4632
 */
export async function orchestrateParallelEnd(
  epicId: string,
  wave: number,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const result = await endParallelExecution(epicId, wave, root);

    if (result.alreadyEnded) {
      return {
        success: true,
        data: {
          epicId,
          wave,
          message: 'No parallel execution was active',
          alreadyEnded: true,
        },
      };
    }

    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Failed to end parallel execution');
  }
}

/**
 * orchestrate.check - Check current orchestration state
 * @task T4632
 */
export async function orchestrateCheck(projectRoot?: string): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const parallelState = await getParallelStatus(root);
    const tasks = await loadTasks(root);

    const activeTasks = tasks.filter((t) => t.status === 'active');
    const progress = computeProgress(tasks);

    return {
      success: true,
      data: {
        parallelExecution: {
          active: parallelState.active,
          epicId: parallelState.epicId || null,
          wave: parallelState.wave || null,
          tasks: parallelState.tasks || [],
          startedAt: parallelState.startedAt || null,
        },
        activeTasks: activeTasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
        progress,
      },
    };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message);
  }
}

/**
 * orchestrate.skill.inject - Read skill content for injection into agent context
 * @task T4632
 */
export function orchestrateSkillInject(skillName: string, projectRoot?: string): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = getSkillContent(skillName, root);
    return { success: true, data: result };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * orchestrate.handoff - Composite session handoff + successor spawn
 *
 * Step order is explicit and fixed:
 * 1) session.context.inject
 * 2) session.end
 * 3) orchestrate.spawn
 *
 * Idempotency policy:
 * - Non-idempotent overall. A retry after step 2 can duplicate spawn output.
 * - Failures include exact step state and a safe retry entry point.
 */
export async function orchestrateHandoff(
  params: OrchestrateHandoffParams,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.taskId) {
    return engineError('E_INVALID_INPUT', 'taskId is required');
  }

  if (!params.protocolType) {
    return engineError('E_INVALID_INPUT', 'protocolType is required');
  }

  const root = projectRoot || resolveProjectRoot();

  const steps: HandoffState = {
    contextInject: { status: 'pending', operation: 'session.context.inject' },
    sessionEnd: { status: 'pending', operation: 'session.end' },
    spawn: { status: 'pending', operation: 'orchestrate.spawn' },
  };

  const idempotency = {
    key: params.idempotencyKey ?? null,
    policy: 'non-idempotent' as const,
    safeRetryFrom: 'start' as 'start' | 'orchestrate.spawn',
    reason:
      'session.end and orchestrate.spawn mutate state and may be executed independently on retry',
  };

  let activeSessionId: string | null = null;
  let endedSessionId: string | null = null;

  const failWithStep = (
    code: string,
    message: string,
    failedStep: HandoffFailureDetails['failedStep'],
    safeRetryFrom: 'start' | 'orchestrate.spawn',
  ): EngineResult => {
    idempotency.safeRetryFrom = safeRetryFrom;
    return engineError(code, message, {
      details: {
        failedStep,
        activeSessionId,
        endedSessionId,
        idempotency,
        steps,
      } satisfies HandoffFailureDetails,
      fix:
        safeRetryFrom === 'orchestrate.spawn'
          ? 'Retry only step 3 with mutate orchestrate spawn'
          : 'Retry from step 1 with mutate orchestrate handoff',
      alternatives: [
        {
          action: 'Run canonical multi-op fallback manually',
          command:
            'mutate session context.inject -> mutate session end -> mutate orchestrate spawn',
        },
      ],
    });
  };

  const preflight = await sessionStatus(root);
  if (!preflight.success) {
    return failWithStep(
      preflight.error?.code ?? 'E_NOT_INITIALIZED',
      preflight.error?.message ?? 'Unable to load session status',
      'session.context.inject',
      'start',
    );
  }

  if (!preflight.data?.hasActiveSession || !preflight.data.session?.id) {
    steps.contextInject.status = 'skipped';
    steps.contextInject.message = 'No active session available for handoff';
    steps.sessionEnd.status = 'skipped';
    steps.sessionEnd.message = 'No active session available for handoff';
    steps.spawn.status = 'skipped';
    steps.spawn.message = 'No active session available for handoff';
    return failWithStep(
      'E_SESSION_REQUIRED',
      'orchestrate.handoff requires an active session',
      'session.end',
      'start',
    );
  }

  activeSessionId = preflight.data.session.id;

  const injectResult = sessionContextInject(
    params.protocolType,
    { taskId: params.taskId, variant: params.variant },
    root,
  );

  if (!injectResult.success) {
    steps.contextInject.status = 'failed';
    steps.contextInject.message = injectResult.error?.message;
    steps.sessionEnd.status = 'skipped';
    steps.sessionEnd.message = 'Blocked by session.context.inject failure';
    steps.spawn.status = 'skipped';
    steps.spawn.message = 'Blocked by session.context.inject failure';
    return failWithStep(
      injectResult.error?.code ?? 'E_GENERAL',
      injectResult.error?.message ?? 'Failed to inject handoff context',
      'session.context.inject',
      'start',
    );
  }

  steps.contextInject.status = 'completed';
  steps.contextInject.message = 'Handoff context injected';

  const endResult = await sessionEnd(root, params.note);
  if (!endResult.success) {
    steps.sessionEnd.status = 'failed';
    steps.sessionEnd.message = endResult.error?.message;
    steps.spawn.status = 'skipped';
    steps.spawn.message = 'Blocked by session.end failure';
    return failWithStep(
      endResult.error?.code ?? 'E_GENERAL',
      endResult.error?.message ?? 'Failed to end predecessor session',
      'session.end',
      'start',
    );
  }

  endedSessionId = endResult.data?.sessionId ?? null;
  if (endedSessionId !== activeSessionId) {
    steps.sessionEnd.status = 'failed';
    steps.sessionEnd.message = `Ended session '${endedSessionId ?? 'null'}' does not match active session '${activeSessionId}'`;
    steps.spawn.status = 'skipped';
    steps.spawn.message = 'Blocked by session mismatch';
    return failWithStep(
      'E_CONCURRENT_SESSION',
      'Active session changed during orchestrate.handoff',
      'session.end',
      'start',
    );
  }

  steps.sessionEnd.status = 'completed';
  steps.sessionEnd.message = `Ended session ${endedSessionId}`;

  const spawnResult = await orchestrateSpawn(params.taskId, params.protocolType, root, params.tier);
  if (!spawnResult.success) {
    steps.spawn.status = 'failed';
    steps.spawn.message = spawnResult.error?.message;
    return failWithStep(
      spawnResult.error?.code ?? 'E_GENERAL',
      spawnResult.error?.message ?? 'Failed to prepare successor spawn context',
      'orchestrate.spawn',
      'orchestrate.spawn',
    );
  }

  steps.spawn.status = 'completed';
  steps.spawn.message = `Spawn prepared for ${params.taskId}`;

  // Best-effort: record handoff event in conduit.db so orchestrators and
  // observers can track session transitions. Never blocks the return.
  void sendConduitEvent(root, 'cleo-core', {
    event: 'orchestrate.handoff',
    taskId: params.taskId,
    protocolType: params.protocolType,
    predecessorSessionId: activeSessionId,
    endedSessionId,
    note: params.note ?? null,
    nextAction: params.nextAction ?? null,
    handoffAt: new Date().toISOString(),
  });

  return {
    success: true,
    data: {
      taskId: params.taskId,
      predecessorSessionId: activeSessionId,
      endedSessionId,
      protocolType: params.protocolType,
      note: params.note ?? null,
      nextAction: params.nextAction ?? null,
      idempotency,
      steps,
      contextInject: injectResult.data,
      spawn: spawnResult.data,
    },
  };
}

// ---------------------------------------------------------------------------
// orchestrate.plan (T889 / W3-6)
// ---------------------------------------------------------------------------

/**
 * Input envelope for {@link orchestratePlan}.
 *
 * @task T889 / W3-6
 */
export interface OrchestratePlanInput {
  /** Epic task id whose children make up the plan. */
  epicId: string;
  /** Absolute path to the project root (used to open tasks.db). */
  projectRoot: string;
  /** Preferred agent-resolver tier when a classifier result has a registry row. */
  preferTier?: 0 | 1 | 2;
}

/**
 * Per-worker entry emitted by {@link orchestratePlan}.
 *
 * @task T889 / W3-6
 */
export interface PlanWorkerEntry {
  /** Task id this entry represents. */
  taskId: string;
  /** Human-readable task title (defaults to `taskId` when missing). */
  title: string;
  /** Resolved agent id (falls back to `'cleo-subagent'` when unresolved). */
  persona: string;
  /** Protocol tier (0=worker, 1=lead, 2=orchestrator). */
  tier: 0 | 1 | 2;
  /** Role derived from `orchLevel`. */
  role: 'orchestrator' | 'lead' | 'worker';
  /** Declared file scope for this task. Empty array when no AC.files set. */
  atomicScope: { files: string[] };
  /** Orchestration level sourced from the resolved agent (0..2). */
  orchLevel: number;
  /** Current task status (pending/active/done/…). */
  status: string;
  /** Ids of tasks this task depends on (sorted for determinism). */
  dependsOn: string[];
}

/**
 * A single wave in the execution plan.
 *
 * @task T889 / W3-6
 */
export interface PlanWave {
  /** 1-indexed wave number. */
  wave: number;
  /** Task id of the designated lead for this wave, or `null` when none. */
  leadTaskId: string | null;
  /** Ordered worker entries for this wave. */
  workers: PlanWorkerEntry[];
}

/**
 * Warning surfaced by {@link orchestratePlan} (e.g. missing agent registry row).
 *
 * @task T889 / W3-6
 */
export interface PlanWarning {
  /** Task id the warning applies to. */
  taskId: string;
  /** Stable warning code (e.g. `'E_AGENT_NOT_FOUND'`). */
  code: string;
  /** Human-readable message. */
  message: string;
}

/**
 * Result envelope returned by {@link orchestratePlan}.
 *
 * @task T889 / W3-6
 */
export interface OrchestratePlanResult {
  /** Epic id the plan was computed for. */
  epicId: string;
  /** Epic title (falls back to `epicId` when missing). */
  epicTitle: string;
  /** Total number of child tasks considered. */
  totalTasks: number;
  /** Ordered waves produced by the dependency topological sort. */
  waves: PlanWave[];
  /** ISO 8601 timestamp when the plan was generated. */
  generatedAt: string;
  /** `true` when the plan is reproducible from the current input snapshot. */
  deterministic: boolean;
  /** Sha256 of the sorted `(taskId, status, updatedAt, dependsOn)` tuples + epicId. */
  inputHash: string;
  /** Non-fatal warnings (graceful resolver misses, missing AC.files, …). */
  warnings: PlanWarning[];
}

/**
 * Prefix-based classifier stub used until T891 wires the CANT team registry.
 *
 * Mapping: task-id or title prefix → agentId. The lookup is conservative — if
 * nothing matches, the caller receives `'cleo-subagent'` so resolution still
 * succeeds at the fallback tier.
 *
 * @task T889 / W3-6
 */
const CLASSIFIER_RULES: ReadonlyArray<{ test: RegExp; agentId: string }> = [
  { test: /^(docs?|doc)[:\s-]/i, agentId: 'docs-worker' },
  { test: /^tests?[:\s-]/i, agentId: 'tests-worker' },
  { test: /^release[:\s-]/i, agentId: 'release-worker' },
  { test: /^security[:\s-]/i, agentId: 'security-worker' },
];

/**
 * Derive the agentId to classify a task against. Applied before resolver
 * lookup so graceful fallback can swap in `'cleo-subagent'` when the row
 * is absent.
 *
 * @param task - Task whose title/labels guide the classifier.
 * @returns Agent business id to resolve.
 * @task T889 / W3-6
 */
function classifyTaskToAgent(task: Task): string {
  const title = task.title ?? '';
  for (const rule of CLASSIFIER_RULES) {
    if (rule.test.test(title)) return rule.agentId;
  }
  // Label-based fallback: honour the first label that names a known worker.
  for (const label of task.labels ?? []) {
    for (const rule of CLASSIFIER_RULES) {
      if (rule.test.test(label)) return rule.agentId;
    }
  }
  return 'cleo-subagent';
}

/**
 * Map an `orchLevel` integer to a {@link PlanWorkerEntry.role} label.
 *
 * @param orchLevel - 0 (orchestrator), 1 (lead), or 2+ (worker).
 * @returns Role string.
 * @task T889 / W3-6
 */
function orchLevelToRole(orchLevel: number): 'orchestrator' | 'lead' | 'worker' {
  if (orchLevel <= 0) return 'orchestrator';
  if (orchLevel === 1) return 'lead';
  return 'worker';
}

/**
 * Map a role to its canonical protocol tier.
 *
 * Per W3-6 spec: orchestrator → 2, lead → 1, worker → 0. This inversion of
 * the `orchLevel` numbering keeps higher-privilege roles on higher tiers
 * (tier 2 = full protocol, tier 0 = minimal prompt).
 *
 * @param role - Role label.
 * @returns Tier 0, 1, or 2.
 * @task T889 / W3-6
 */
function roleToTier(role: 'orchestrator' | 'lead' | 'worker'): 0 | 1 | 2 {
  if (role === 'orchestrator') return 2;
  if (role === 'lead') return 1;
  return 0;
}

/**
 * Compute a deterministic sha256 over the plan's input snapshot so callers
 * can detect whether identical inputs produced the same plan.
 *
 * Hashed tuple: `(taskId, status, updatedAt || '', dependsOn.sort().join(','))`
 * for every child in lexicographic task-id order, then the `epicId` as a
 * trailing component. `generatedAt` is intentionally excluded — it would
 * make every plan non-deterministic by construction.
 *
 * @param epicId   - Epic id the plan targets.
 * @param children - Child tasks considered (snapshot).
 * @returns Hex-encoded sha256 digest.
 * @task T889 / W3-6
 */
function computePlanInputHash(epicId: string, children: Task[]): string {
  const sorted = [...children].sort((a, b) => a.id.localeCompare(b.id));
  const parts = sorted.map((t) => {
    const depends = (t.depends ?? []).slice().sort().join(',');
    return `${t.id}|${t.status ?? ''}|${t.updatedAt ?? ''}|${depends}`;
  });
  parts.push(`epic:${epicId}`);
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * Resolve a task's agent row with graceful fallback.
 *
 * On success returns the `ResolvedAgent`. On `AgentNotFoundError` (or any
 * other resolver failure), returns `null` so the caller can substitute
 * `'cleo-subagent'` and emit a warning.
 *
 * @param db        - Open global signaldock.db handle (caller owns lifecycle).
 * @param agentId   - Business id from the classifier.
 * @param preferTier - Optional preferred registry tier.
 * @returns Resolved row or `null` when unresolved.
 * @task T889 / W3-6
 */
function resolveAgentGraceful(
  db: _SignaldockDbHandle,
  agentId: string,
  preferTier?: AgentTier,
): ResolvedAgent | null {
  try {
    return resolveAgent(db, agentId, preferTier ? { preferTier } : {});
  } catch (err) {
    if (err instanceof AgentNotFoundError) return null;
    throw err;
  }
}

/**
 * Generate a deterministic, machine-readable execution plan for an epic.
 *
 * The plan groups children into waves via the same topological sort used by
 * `orchestrate ready --epic` and `orchestrate waves` (`getEnrichedWaves`),
 * then enriches every task with a classifier agent id, resolved persona,
 * atomic scope (AC.files), and role/tier derived from the resolved agent's
 * `orchLevel`. Each wave exposes a `leadTaskId` (first lead or, failing
 * that, the first orchestrator) to simplify downstream spawn dispatch.
 *
 * Determinism: given identical inputs (task snapshot + epic id), the
 * function returns the same `inputHash`. `generatedAt` is NOT part of the
 * hash so two back-to-back invocations confirm reproducibility by hash
 * equality.
 *
 * Validation: rejects non-epic ids (`type !== 'epic'` AND no children) with
 * `E_VALIDATION`; rejects missing epics with `E_NOT_FOUND`.
 *
 * @param input - {@link OrchestratePlanInput} envelope.
 * @returns Engine result wrapping {@link OrchestratePlanResult}.
 * @task T889 / W3-6
 */
export async function orchestratePlan(
  input: OrchestratePlanInput,
): Promise<EngineResult<OrchestratePlanResult>> {
  if (!input?.epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  const root = input.projectRoot || resolveProjectRoot();

  try {
    const tasks = await loadTasks(root);
    const epic = tasks.find((t) => t.id === input.epicId);

    if (!epic) {
      return engineError('E_NOT_FOUND', `Epic ${input.epicId} not found`);
    }

    const children = tasks.filter((t) => t.parentId === input.epicId);
    const isEpic = epic.type === 'epic' || children.length > 0;
    if (!isEpic) {
      return engineError(
        'E_VALIDATION',
        `Task ${input.epicId} is not an epic (type=${epic.type ?? 'unknown'}, children=${children.length})`,
        {
          fix: `Run 'cleo add --parent ${input.epicId}' to add children, or select a real epic id.`,
        },
      );
    }

    // Reuse the canonical wave computation used by orchestrate ready / waves.
    const accessor = await getAccessor(root);
    const enriched = await getEnrichedWaves(input.epicId, root, accessor);

    // Open a short-lived handle to the global signaldock.db for resolver lookups.
    // We intentionally do NOT cache this handle — the resolver contract owns
    // its own lifecycle and we close after the batch.
    await ensureGlobalSignaldockDb();
    const dbPath = getGlobalSignaldockDbPath();
    const db = new _DatabaseSyncCtor(dbPath);
    db.exec('PRAGMA foreign_keys = ON');

    const warnings: PlanWarning[] = [];
    const preferTier =
      input.preferTier === undefined ? undefined : numericToAgentTier(input.preferTier);

    const plannedWaves: PlanWave[] = [];
    try {
      for (const wave of enriched.waves) {
        const workers: PlanWorkerEntry[] = [];
        for (const taskRef of wave.tasks) {
          const task = children.find((c) => c.id === taskRef.id);
          if (!task) continue;

          const classifiedAgentId = classifyTaskToAgent(task);
          const resolved = resolveAgentGraceful(db, classifiedAgentId, preferTier);

          let persona = classifiedAgentId;
          let orchLevel = 2; // default to worker
          if (resolved) {
            persona = resolved.agentId;
            orchLevel = resolved.orchLevel;
          } else {
            persona = 'cleo-subagent';
            // Try to resolve the fallback too so we pick up its orchLevel
            // (packaged seed agents ship with orchLevel 2). If even the
            // fallback misses, keep orchLevel at the worker default.
            const fallback = resolveAgentGraceful(db, 'cleo-subagent', preferTier);
            if (fallback) orchLevel = fallback.orchLevel;
            warnings.push({
              taskId: task.id,
              code: 'E_AGENT_NOT_FOUND',
              message: `Classifier produced '${classifiedAgentId}' for ${task.id}; agent not registered. Falling back to 'cleo-subagent'.`,
            });
          }

          const role = orchLevelToRole(orchLevel);
          const tier = roleToTier(role);
          const files = task.files ?? [];
          if (role === 'worker' && files.length === 0) {
            warnings.push({
              taskId: task.id,
              code: 'W_NO_ATOMIC_SCOPE',
              message: `Worker task ${task.id} has no AC.files declared; atomicScope will be empty and may be rejected by checkAtomicity.`,
            });
          }

          const dependsOn = (task.depends ?? []).slice().sort();

          workers.push({
            taskId: task.id,
            title: task.title ?? task.id,
            persona,
            tier,
            role,
            atomicScope: { files: [...files] },
            orchLevel,
            status: task.status,
            dependsOn,
          });
        }

        // Lead selection: first lead; else first orchestrator; else null.
        const leadWorker =
          workers.find((w) => w.role === 'lead') ??
          workers.find((w) => w.role === 'orchestrator') ??
          null;

        plannedWaves.push({
          wave: wave.waveNumber,
          leadTaskId: leadWorker ? leadWorker.taskId : null,
          workers,
        });
      }
    } finally {
      db.close();
    }

    const inputHash = computePlanInputHash(input.epicId, children);

    return {
      success: true,
      data: {
        epicId: input.epicId,
        epicTitle: epic.title ?? input.epicId,
        totalTasks: children.length,
        waves: plannedWaves,
        generatedAt: new Date().toISOString(),
        deterministic: true,
        inputHash,
        warnings,
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * Map a numeric tier (0|1|2) used by the CLI/domain boundary to the
 * string-typed {@link AgentTier} understood by the resolver.
 *
 * @param tier - Numeric tier from input.
 * @returns Resolver-compatible tier or `undefined` when out of range.
 * @task T889 / W3-6
 */
function numericToAgentTier(tier: 0 | 1 | 2): AgentTier | undefined {
  if (tier === 0) return 'project';
  if (tier === 1) return 'global';
  if (tier === 2) return 'packaged';
  return undefined;
}
