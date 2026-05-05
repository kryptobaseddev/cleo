/**
 * Orchestrate Spawn Operations
 *
 * orchestrateSpawn, orchestrateSpawnExecute, orchestrateSpawnSelectProvider,
 * and private spawn helpers migrated from
 * packages/cleo/src/dispatch/engines/orchestrate-engine.ts.
 *
 * @task T1570
 * @task T4478
 * @task T5236
 * @task T932
 * @task T1238
 * @task T1140
 * @task T1253
 */

import type { AgentSpawnCapability, CLEOSpawnAdapter, CLEOSpawnContext } from '@cleocode/contracts';
import { findLeastLoadedAgent } from '../agents/capacity.js';
import { substituteCantAgentBody } from '../agents/variable-substitution.js';
import { type EngineResult, engineError } from '../engine-result.js';
import { selectHarnessSpawnProvider } from '../harness/spawn-provider-selection.js';
import type { HarnessSpawnCapability } from '../harness/types.js';
import { hooks } from '../hooks/registry.js';
import { getLogger } from '../logger.js';
import type { SpawnPayload } from '../orchestration/spawn.js';
import { composeSpawnPayload } from '../orchestration/spawn.js';
import type { ConduitSubscriptionConfig } from '../orchestration/spawn-prompt.js';
import { resolveEffectiveTier } from '../orchestration/tier-selector.js';
import { validateSpawnReadiness } from '../orchestration/validate-spawn.js';
import { spawnWorktree } from '../sentient/worktree-dispatch.js';
import { initializeDefaultAdapters, spawnRegistry } from '../spawn/adapter-registry.js';
import { getAccessor } from '../store/data-accessor.js';
import { resolveProjectRoot } from '../store/file-utils.js';
import { getActiveSession } from '../store/session-store.js';
import { provisionIsolatedShell } from '../tools/sdk/isolation.js';
import { openSignaldockDbForComposer } from './plan.js';

export type { EngineResult };

// ---------------------------------------------------------------------------
// Conduit event helper — best-effort, never throws, never blocks orchestration
// ---------------------------------------------------------------------------

/** Structured payload for a conduit orchestration event message. */
export interface ConduitOrchestrationEvent {
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
export async function sendConduitEvent(
  cwd: string,
  to: string,
  event: ConduitOrchestrationEvent,
): Promise<void> {
  try {
    const { AgentRegistryAccessor, createConduit } = await import('../internal.js');
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

// ---------------------------------------------------------------------------
// CANT body substitution (T1238)
// ---------------------------------------------------------------------------

/**
 * Diagnostics payload returned by {@link applyCantBodySubstitution}.
 *
 * Surfaced in `orchestrate.spawn.execute` results under
 * `data.meta.templateSubstitution` so CI and audit pipelines can detect
 * template drift (missing vars as project-context.json evolves).
 *
 * @task T1238
 */
interface CantBodySubstitutionResult {
  /** `true` when at least one variable was resolved. */
  applied: boolean;
  /** Number of variables successfully resolved. */
  resolvedCount: number;
  /** Variables referenced but unresolved (lenient mode). */
  missing: string[];
  /** `true` when `.cleo/project-context.json` was loaded and parsed. */
  projectContextLoaded: boolean;
  /** Diagnostic reason when substitution did not run (no cant path, read error). */
  reason?: string;
  /**
   * Resolved CANT agent body to embed in the spawn prompt. `null` when
   * substitution was skipped (no agent file, IO error, no template vars).
   */
  resolvedBody: string | null;
}

/**
 * Apply T1238 mustache `{{var}}` substitution to the resolved CANT agent body.
 *
 * This is the integration hook for the spawn-time substitution contract: the
 * orchestrate engine calls it AFTER `composeSpawnPayload` has resolved the
 * agent from the 4-tier registry and BEFORE the adapter receives the spawn
 * prompt. Failures degrade to a no-op so the spawn path remains resilient.
 *
 * @param payload - Spawn payload produced by `composeSpawnForTask`.
 * @param cwd - Project root for resolving `.cleo/project-context.json`.
 * @param ctx - Session-scoped context injected into the resolver.
 * @returns Diagnostic envelope with resolved body + missing-var report.
 * @task T1238
 */
async function applyCantBodySubstitution(
  payload: SpawnPayload,
  cwd: string,
  ctx: { taskId: string; sessionId: string | null; protocol: string },
): Promise<CantBodySubstitutionResult> {
  const empty: CantBodySubstitutionResult = {
    applied: false,
    resolvedCount: 0,
    missing: [],
    projectContextLoaded: false,
    resolvedBody: null,
  };

  const cantPath = payload.resolvedAgent?.cantPath;
  if (!cantPath) {
    return { ...empty, reason: 'resolved agent has no cantPath' };
  }

  const [{ existsSync, readFileSync }] = await Promise.all([import('node:fs')]);

  if (!existsSync(cantPath)) {
    return { ...empty, reason: `cant file not found at ${cantPath}` };
  }

  let body: string;
  try {
    body = readFileSync(cantPath, 'utf-8');
  } catch (err) {
    return {
      ...empty,
      reason: `Failed to read cant body: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const sessionContext: Record<string, unknown> = {
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    protocol: ctx.protocol,
    agentId: payload.agentId,
    role: payload.role,
    tier: payload.tier,
    harnessHint: payload.harnessHint,
  };
  if (payload.taskId) sessionContext.spawnTaskId = payload.taskId;

  const result = substituteCantAgentBody(body, {
    projectRoot: cwd,
    sessionContext,
    env: process.env,
    options: { strict: false, warnMissing: false },
  });

  return {
    applied: result.resolved.length > 0,
    resolvedCount: result.resolved.length,
    missing: result.missing,
    projectContextLoaded: result.projectContextLoaded,
    resolvedBody: result.text,
  };
}

// ---------------------------------------------------------------------------
// Spawn composer helper (shared by orchestrateSpawn + orchestrateSpawnExecute)
// ---------------------------------------------------------------------------

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
export async function composeSpawnForTask(
  taskId: string,
  root: string,
  options: {
    tier?: 0 | 1 | 2;
    sessionId?: string | null;
    role?: AgentSpawnCapability;
    protocol?: string;
    skipAtomicityCheck?: boolean;
    /** Pre-provisioned worktree path — emits Worktree Setup section (T1140). */
    worktreePath?: string;
    /** Branch name for the worktree (T1140). */
    worktreeBranch?: string;
    /**
     * CONDUIT A2A subscription configuration derived from the task's parent
     * epic. When present the spawn prompt gains a `## CONDUIT Subscription`
     * section (tier 1+). Omit for tier-0 or top-level tasks.
     *
     * @task T1253
     */
    conduitSubscription?: ConduitSubscriptionConfig;
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
      worktreePath: options.worktreePath,
      worktreeBranch: options.worktreeBranch,
      conduitSubscription: options.conduitSubscription,
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Public orchestrate spawn operations
// ---------------------------------------------------------------------------

/**
 * orchestrate.spawn.select - Select best provider for spawn based on required capabilities
 *
 * @param capabilities - Required harness capabilities to filter providers.
 * @param _projectRoot - Optional project root path (unused but kept for API parity).
 * @returns Engine result with provider selection data.
 * @task T5236
 */
export async function orchestrateSpawnSelectProvider(
  capabilities: HarnessSpawnCapability[],
  _projectRoot?: string,
): Promise<EngineResult> {
  return selectHarnessSpawnProvider(capabilities);
}

/**
 * orchestrate.spawn.execute - Execute spawn for a task using adapter registry
 *
 * @param taskId - Task to spawn.
 * @param adapterId - Optional adapter id to use. Auto-selects if not provided.
 * @param protocolType - Optional protocol type override.
 * @param projectRoot - Optional project root path.
 * @param tier - Optional spawn tier (0=worker, 1=lead, 2=orchestrator).
 * @returns Engine result with spawn execution data.
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

    // T1238 — Apply mustache `{{var}}` substitution to the resolved CANT
    // agent body BEFORE it becomes part of the spawn prompt. The substitution
    // engine loads `.cleo/project-context.json` (via core paths) and merges
    // it with the orchestrator's session context; bindings are left empty
    // for now (T891 will thread classifier-produced overrides here).
    //
    // Best-effort: missing agent file / unresolved variables degrade to a
    // lenient substitution — the original prompt still flows to the adapter
    // and the diagnostics are surfaced under `data.meta.templateSubstitution`.
    const templateSubstitution = await applyCantBodySubstitution(payload, cwd, {
      taskId,
      sessionId: activeSessionId,
      protocol: protocolType ?? payload.meta.protocol,
    });

    // The raw prompt from the composer is passed to the adapter unchanged.
    // CANT bundle compilation, mental model injection, and identity bootstrap
    // are all handled inside buildCantEnrichedPrompt() at the adapter layer
    // (packages/adapters/src/cant-context.ts). When a resolved CANT agent
    // body was substituted (T1238), it is prepended to the composer prompt
    // so subagents receive the fully-resolved template alongside the
    // standard spawn context.
    const rawPrompt = templateSubstitution.resolvedBody
      ? `${templateSubstitution.resolvedBody}\n\n${payload.prompt}`
      : payload.prompt;

    // T1759 — Worktree provisioning + centralized isolation.
    //
    // Provision a worktree for the task so the agent runs in its own isolated
    // branch. On success, `provisionIsolatedShell` computes the authoritative
    // cwd, env-var block, and preamble from the single source of truth. On
    // failure (non-git repo, git not installed, etc.) we degrade gracefully and
    // fall back to the project root so spawn continues without isolation.
    let agentWorkingDirectory = cwd;
    let agentEnvOverride: Record<string, string> | undefined;
    try {
      const worktreeResult = await spawnWorktree(cwd, { taskId });
      const isolation = provisionIsolatedShell({
        worktreePath: worktreeResult.path,
        branch: worktreeResult.branch,
        role: 'worker',
        projectHash: worktreeResult.projectHash,
      });
      agentWorkingDirectory = isolation.cwd;
      agentEnvOverride = isolation.env;
    } catch {
      // Worktree provisioning failure — spawn continues without isolation.
      // This matches the graceful-degradation policy of orchestrateSpawn.
      getLogger('engine:orchestrate').warn(
        { taskId },
        'T1759 worktree provisioning failed in orchestrateSpawnExecute — spawning without isolation',
      );
    }

    const cleoSpawnContext: CLEOSpawnContext = {
      taskId: payload.taskId,
      protocol: protocolType || payload.meta.protocol,
      prompt: rawPrompt,
      provider: provider.id,
      options: {
        prompt: rawPrompt,
        ...(agentEnvOverride !== undefined ? { env: agentEnvOverride } : {}),
      },
      workingDirectory: agentWorkingDirectory,
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
        meta: {
          ...payload.meta,
          // T1238 — variable substitution diagnostics surfaced for audit.
          templateSubstitution: {
            applied: templateSubstitution.applied,
            resolvedCount: templateSubstitution.resolvedCount,
            missing: templateSubstitution.missing,
            projectContextLoaded: templateSubstitution.projectContextLoaded,
            ...(templateSubstitution.reason !== undefined
              ? { reason: templateSubstitution.reason }
              : {}),
          },
        },
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
 * orchestrate.spawn - Generate spawn prompt for a task.
 *
 * Every spawn emit in the engine routes through
 * {@link composeSpawnPayload} (T932) so atomicity, harness-hint dedup, and
 * traceability metadata are active on every orchestrate spawn. Legacy
 * `prepareSpawn` is no longer called directly from this path.
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
 * @param taskId - Task to generate spawn prompt for.
 * @param protocolType - Optional protocol type override.
 * @param projectRoot - Optional project root path.
 * @param tier - Optional spawn tier (0=worker, 1=lead, 2=orchestrator).
 * @param noWorktree - If true, skip worktree provisioning.
 * @returns Engine result with spawn prompt data.
 * @task T4478
 * @task T932
 */
export async function orchestrateSpawn(
  taskId: string,
  protocolType?: string,
  projectRoot?: string,
  tier?: 0 | 1 | 2,
  noWorktree?: boolean,
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
      const active = await getActiveSession(root);
      activeSessionId = active?.id ?? null;
    } catch {
      activeSessionId = null;
    }

    // T1253 — Derive CONDUIT subscription config from the task's parent epic.
    //
    // For tier-1+ spawns, the spawn prompt gains a `## CONDUIT Subscription`
    // section so the subagent knows which wave and coordination topics to use.
    // Derivation is best-effort: failures are silently swallowed so spawn is
    // never blocked by a CONDUIT config read error.
    //
    // Topic naming convention (per T1252 spec):
    //   wave topic  : "epic-<epicId>.wave-<taskId>"   (taskId as waveId proxy)
    //   coord topic : "epic-<epicId>.coordination"
    //
    // For top-level tasks (no parentId) the section is omitted entirely.
    let conduitSubscription: ConduitSubscriptionConfig | undefined;
    const effectiveTierForConduit = tier ?? 1; // default before composeSpawnForTask resolves it
    if (effectiveTierForConduit >= 1) {
      try {
        const taskRecord = await accessor.loadSingleTask(taskId);
        if (taskRecord?.parentId) {
          const epicId = taskRecord.parentId;
          conduitSubscription = {
            epicId,
            waveId: Number.parseInt(taskId.replace(/\D/g, '').slice(-4) || '1', 10),
            peerId: `cleo-agent-${taskId.toLowerCase()}`,
          };
        }
      } catch {
        // Best-effort: CONDUIT config derivation must never block spawn.
      }
    }

    // T1140 — Worktree provisioning (SDK-first per D023 / ADR-055).
    //
    // Worktrees are created by default for every spawn. The `--no-worktree`
    // flag opts out and logs an audit entry so the choice is traceable.
    //
    // When provisioning fails (non-git repo, git not installed, etc.) we
    // degrade gracefully — spawn continues without isolation, same as T1118.
    let sdkWorktreeResult: import('@cleocode/contracts').CreateWorktreeResult | null = null;
    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;

    if (noWorktree) {
      // Explicit opt-out — log to audit so it's always traceable.
      getLogger('engine:orchestrate').info(
        { taskId },
        'T1140 --no-worktree: worktree provisioning skipped (audit logged)',
      );
      try {
        await accessor.appendLog({
          action: 'orchestrate.spawn.no-worktree',
          taskId,
          actor: 'orchestrate-engine',
          details: { reason: '--no-worktree flag set by caller', taskId },
        });
      } catch {
        // Audit log is best-effort — never block spawn.
      }
    } else {
      // Default: provision via the SDK dispatch layer (worktree-dispatch.ts).
      // Routes through @cleocode/worktree per D023 SDK-first contract.
      //
      // T1878: Provisioning errors are no longer swallowed. A failure here
      // means the spawn prompt's `## Worktree Setup` section would be omitted,
      // causing workers to hallucinate paths. Surface the error as a structured
      // LAFS envelope so callers can react programmatically.
      try {
        sdkWorktreeResult = await spawnWorktree(root, { taskId });
        worktreePath = sdkWorktreeResult.path;
        worktreeBranch = sdkWorktreeResult.branch;
      } catch (wtErr) {
        const message = wtErr instanceof Error ? wtErr.message : String(wtErr);
        getLogger('engine:orchestrate').error(
          { taskId, err: wtErr },
          `T1878 worktree provisioning failed for ${taskId}: ${message}`,
        );
        return engineError('E_WORKTREE_PROVISION_FAILED', message, {
          details: { taskId, cause: message },
          fix: 'Check git repository state, branch availability, and disk space. Run `git worktree list` and `git branch --list task/<taskId>` to diagnose.',
        });
      }
    }

    // Route every spawn through the canonical composer (T932). Atomicity,
    // harness-hint dedup, resolved-agent metadata, and traceability meta are
    // all populated here — prepareSpawn/buildSpawnPrompt are NOT called
    // directly from this path anymore.
    //
    // T1140: worktreePath and worktreeBranch are passed through so the
    // composer can emit the `## Worktree Setup (REQUIRED)` section in the
    // prompt body (replacing the old preamble prepend pattern from T1118).
    //
    // T1253: conduitSubscription derived above from task.parentId is threaded
    // through so the `## CONDUIT Subscription` section appears on tier-1+ prompts.
    const payload = await composeSpawnForTask(taskId, root, {
      tier,
      sessionId: activeSessionId,
      protocol: protocolType,
      worktreePath,
      worktreeBranch,
      conduitSubscription,
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

    // T1140: The worktree section is now emitted by buildSpawnPrompt (inside
    // composeSpawnForTask above) as `## Worktree Setup (REQUIRED)`. The prompt
    // is used as-is — no legacy preamble prepend needed for SDK results.
    const finalPrompt = payload.prompt;

    // Build a WorktreeSpawnResult-compatible envelope from the SDK result so
    // harness adapters that read worktree/worktreeEnv/worktreeCwd continue to
    // work without modification (backward-compat shim).
    const worktreeAdapterResult: import('@cleocode/contracts').WorktreeSpawnResult | null =
      sdkWorktreeResult
        ? {
            worktree: {
              path: sdkWorktreeResult.path,
              branch: sdkWorktreeResult.branch,
              taskId: sdkWorktreeResult.taskId,
              baseRef: sdkWorktreeResult.baseRef,
              projectHash: sdkWorktreeResult.projectHash,
              createdAt: sdkWorktreeResult.createdAt,
              locked: sdkWorktreeResult.locked,
            },
            envVars: sdkWorktreeResult.envVars,
            cwd: sdkWorktreeResult.path,
            preamble: sdkWorktreeResult.preamble,
          }
        : null;

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
        // T1118 L1+L2 / T1140 — worktree binding for harness adapters.
        worktree: worktreeAdapterResult?.worktree ?? null,
        worktreeEnv: worktreeAdapterResult?.envVars ?? null,
        worktreeCwd: worktreeAdapterResult?.cwd ?? null,
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
