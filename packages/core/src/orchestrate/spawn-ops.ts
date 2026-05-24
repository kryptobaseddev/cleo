/**
 * Orchestrate Spawn Operations
 *
 * orchestrateSpawn, orchestrateSpawnExecute, orchestrateSpawnSelectProvider,
 * and private spawn helpers migrated from
 * packages/cleo/src/dispatch/engines/orchestrate-engine.ts.
 *
 * # T9545 — Spawn hang root cause + timeout supervisor + auto-cleanup
 *
 * **Root cause (file:line evidence):**
 * The spawn pipeline invokes git/`cp` subprocesses through helpers in
 * `packages/worktree/src/git.ts:23` (`gitSync`), `:40` (`gitSilent`),
 * `:57` (`gitAsync`) — none had an `execFileSync` / `execFile` `timeout`
 * option set. The same gap existed at
 * `packages/worktree/src/worktree-list.ts:110`,
 * `packages/worktree/src/compat.ts:195`, and
 * `packages/worktree/src/copy-on-write.ts:99,104`.
 *
 * When `.git/index.lock` contention persists, a wedged `git worktree add`
 * (called from `worktree-create.ts:193,209,214`) would block
 * {@link spawnWorktree} forever, silently wedging `orchestrateSpawn`. The
 * parent CLI exited without surfacing the hang.
 *
 * Additionally, the original T9545 supervisor (v2026.5.99) **preserved**
 * partially-provisioned worktrees on timeout, requiring callers to manually
 * run `cleo orchestrate worktree.prune` to recover. The Saga T10176 / D010
 * verdict reversed that decision: orphan worktrees compound across parallel
 * agent waves, so spawn timeouts now auto-cleanup.
 *
 * **Fix (T9545 — Saga T10176):**
 * 1. Every subprocess call in the spawn pipeline now has an explicit
 *    `timeout` option (`DEFAULT_GIT_TIMEOUT_MS = 60_000` in
 *    `packages/worktree/src/git.ts`).
 * 2. `orchestrateSpawn` runs under an overall {@link AbortController} budget
 *    (`SPAWN_BUDGET_MS = 60_000`). On budget exhaustion the function returns
 *    an `E_TIMEOUT` envelope rather than hanging.
 * 3. Progress logs (`engine:orchestrate`) emit at each major step:
 *    `validate-readiness`, `provision-worktree`, `compose-prompt`,
 *    `persist-state` — giving the orchestrator observability.
 * 4. **(Saga T10176 / D010 — reversed)** On timeout the supervisor invokes
 *    {@link destroyWorktree} with its own bounded budget
 *    ({@link CLEANUP_BUDGET_MS}) so any partial worktree is automatically
 *    unwound (unlock + remove + branch delete + audit log + sentinel index
 *    eviction). Cleanup is idempotent — re-invocation against an absent
 *    worktree succeeds silently. Cleanup failures are captured in
 *    `error.details.cleanup` and never overwrite the original timeout cause.
 *
 * Pattern mirrors {@link runGitWithLockRetry} from
 * `packages/core/src/release/engine-ops.ts:86-182` (T9501).
 *
 * @task T1570
 * @task T4478
 * @task T5236
 * @task T932
 * @task T1238
 * @task T1140
 * @task T1253
 * @task T9545
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentSpawnCapability,
  CLEOSpawnAdapter,
  CLEOSpawnContext,
  WorktreeHook,
} from '@cleocode/contracts';
import { destroyWorktree, runWorktreeHooks } from '@cleocode/worktree';
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
import { getProjectRoot } from '../paths.js';
import { spawnWorktree } from '../sentient/worktree-dispatch.js';
import { initializeDefaultAdapters, spawnRegistry } from '../spawn/adapter-registry.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { getActiveSession } from '../store/session-store.js';
import { provisionIsolatedShell } from '../tools/sdk/isolation.js';
import { openSignaldockDbForComposer } from './plan.js';

export type { EngineResult };

// ---------------------------------------------------------------------------
// T9545 — Spawn pipeline timeout supervisor
// ---------------------------------------------------------------------------

/**
 * Overall budget for a single {@link orchestrateSpawn} invocation in
 * milliseconds. Enforced via an {@link AbortController} that races against
 * the spawn pipeline; on expiry an `E_TIMEOUT` envelope is returned.
 *
 * 180s mirrors `DEFAULT_GIT_TIMEOUT_MS` so the wrapper never fires before a
 * single bounded subprocess would have surfaced its own timeout error. The
 * prior 60s budget caused every spawn on large-repo monorepos (10k+ files)
 * to fail with `E_WORKTREE_PROVISION_FAILED` because `git worktree add`
 * routinely exceeded 60s during cold checkout (T9823).
 *
 * @task T9545
 * @task T9823
 */
export const SPAWN_BUDGET_MS = 180_000;

/**
 * Bounded budget for the timeout-cleanup pass (Saga T10176 / D010). Cleanup
 * itself must not be allowed to hang — if `destroyWorktree` fails to return
 * within this window the timeout envelope reports the cleanup error in
 * `error.details.cleanup` and the caller falls back to `cleo worktree prune`.
 *
 * 5s is intentionally aggressive: `destroyWorktree` only runs a handful of
 * fast `git` commands (`unlock`, `remove --force`, `branch -D`) plus a
 * filesystem rm fallback.
 *
 * @task T9545
 */
export const CLEANUP_BUDGET_MS = 5_000;

/**
 * Step name emitted in spawn-pipeline progress logs. Used by the integration
 * test harness to assert each major step is announced.
 *
 * @task T9545
 */
export type SpawnPipelineStep =
  | 'validate-readiness'
  | 'lint-changesets'
  | 'provision-worktree'
  | 'compose-prompt'
  | 'persist-state'
  | 'budget-exceeded';

/**
 * Result shape returned by {@link runTimeoutCleanup}. Surfaced on the
 * `E_TIMEOUT` envelope under `error.details.cleanup` so callers can verify
 * the orphan-worktree state was actually unwound.
 *
 * @task T9545
 */
export interface TimeoutCleanupResult {
  /** True when `destroyWorktree` completed (or there was nothing to clean). */
  attempted: boolean;
  /** True when the worktree was successfully removed (or already absent). */
  worktreeRemoved: boolean;
  /** True when the task branch was deleted (or already absent). */
  branchDeleted: boolean;
  /** Captured error message when cleanup failed or exceeded its own budget. */
  error?: string;
  /** Milliseconds the cleanup pass took. */
  elapsedMs: number;
}

/**
 * Best-effort, bounded cleanup of a partially-provisioned worktree after the
 * spawn supervisor fires. Idempotent: re-running against an absent worktree
 * returns `worktreeRemoved: true` without erroring. Wrapped in its own
 * `setTimeout` so cleanup itself can never wedge the timeout envelope.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param taskId      - Task ID whose worktree is being cleaned up.
 * @returns Structured cleanup outcome (never throws).
 * @task T9545
 */
export async function runTimeoutCleanup(
  projectRoot: string,
  taskId: string,
): Promise<TimeoutCleanupResult> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race<TimeoutCleanupResult>([
      destroyWorktree(projectRoot, {
        taskId,
        deleteBranch: true,
        force: true,
        reason: 'spawn-timeout-cleanup',
      }).then<TimeoutCleanupResult>((r) => ({
        attempted: true,
        worktreeRemoved: r.worktreeRemoved,
        branchDeleted: r.branchDeleted,
        ...(r.error !== undefined ? { error: r.error } : {}),
        elapsedMs: Date.now() - startedAt,
      })),
      new Promise<TimeoutCleanupResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              attempted: true,
              worktreeRemoved: false,
              branchDeleted: false,
              error: `Cleanup exceeded ${CLEANUP_BUDGET_MS}ms budget — orphan may remain`,
              elapsedMs: Date.now() - startedAt,
            }),
          CLEANUP_BUDGET_MS,
        );
      }),
    ]);
    return result;
  } catch (err) {
    return {
      attempted: true,
      worktreeRemoved: false,
      branchDeleted: false,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Race a promise against an `AbortSignal`. Resolves with the promise's value
 * when it settles first; rejects with a tagged "E_TIMEOUT" error when the
 * signal aborts first.
 *
 * The original promise is NOT cancelled — Node's stdlib does not propagate
 * cancellation into in-flight tasks. The supervisor wrapper relies on every
 * subprocess having its own `timeout` so the underlying child eventually
 * exits even after the parent has returned.
 *
 * @param promise   - The work to race.
 * @param signal    - Abort signal that fires on budget exhaustion.
 * @param stepName  - Step name embedded in the timeout error message.
 * @returns The work's resolved value.
 * @throws Error tagged `E_TIMEOUT` when `signal.aborted` fires first.
 * @task T9545
 */
async function raceAgainstAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  stepName: SpawnPipelineStep,
): Promise<T> {
  if (signal.aborted) {
    const err = new Error(
      `E_TIMEOUT: spawn pipeline step '${stepName}' aborted (budget ${SPAWN_BUDGET_MS}ms exceeded)`,
    );
    (err as Error & { code?: string }).code = 'E_TIMEOUT';
    throw err;
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      const err = new Error(
        `E_TIMEOUT: spawn pipeline step '${stepName}' aborted (budget ${SPAWN_BUDGET_MS}ms exceeded)`,
      );
      (err as Error & { code?: string }).code = 'E_TIMEOUT';
      reject(err);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Run the lint-changesets hygiene gate.
 *
 * Executes `node scripts/lint-changesets.mjs` from the project root.
 * Returns `ok: true` when the linter exits 0 (or when the script is absent,
 * so the gate is non-blocking in non-monorepo contexts).
 * Returns `ok: false` with the captured stderr when the linter exits non-zero.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Gate result with ok flag and optional error output.
 * @task T10448
 */
export function runLintChangesets(projectRoot: string): { ok: boolean; error?: string } {
  const scriptPath = join(projectRoot, 'scripts', 'lint-changesets.mjs');

  if (!existsSync(scriptPath)) {
    // Non-monorepo context — gate is a no-op so spawn isn't blocked.
    return { ok: true };
  }

  try {
    execFileSync(process.execPath, [scriptPath], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: string }).stderr)
        : '';
    const stdout =
      err && typeof err === 'object' && 'stdout' in err
        ? String((err as { stdout?: string }).stdout)
        : '';
    const message = stderr || stdout || (err instanceof Error ? err.message : String(err));
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Worktree hooks loader — best-effort, never throws
// ---------------------------------------------------------------------------

/**
 * Load declarative worktree hooks from `.cleo/worktree-hooks.json`.
 * Returns an empty array when the file is absent or malformed.
 */
async function loadWorktreeHooks(projectRoot: string): Promise<WorktreeHook[]> {
  try {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const hooksPath = join(projectRoot, '.cleo', 'worktree-hooks.json');
    const raw = readFileSync(hooksPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as WorktreeHook[];
    }
  } catch {
    // Absent or malformed — graceful degradation.
  }
  return [];
}

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
    /**
     * Glob patterns excluded from the worktree (T9226). When set, a
     * `## Worktree Scope` section is injected into the spawn prompt.
     *
     * @task T9226
     */
    spawnCloneExclude?: readonly string[];
    /**
     * T9214 / T10430 atomicity waiver. When `'orchestrator-defer'`, flows
     * through to {@link composeSpawnPayload}'s `scope` option so the worker
     * file-scope gate records an auditable `atomicity_waiver` rather than
     * rejecting the spawn with `E_ATOMICITY_NO_SCOPE`. Distinct from
     * `spawnCloneExclude` (worktree-tree filter) — this governs the
     * file-scope gate only.
     *
     * @task T9214
     * @task T10430
     */
    atomicityScope?: 'orchestrator-defer';
  } = {},
): Promise<SpawnPayload> {
  const accessor = await getTaskAccessor(root);
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
      spawnCloneExclude: options.spawnCloneExclude,
      // T10430 — pass the atomicity waiver into the composer. When set to
      // 'orchestrator-defer', checkAtomicity grants the spawn for a worker
      // without declared files and stamps atomicity_waiver in the result.
      ...(options.atomicityScope ? { scope: options.atomicityScope } : {}),
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
 * Options accepted by {@link orchestrateSpawnExecute} that go beyond the
 * primitive positional args. Currently used by T9548 to thread the auto-merge
 * toggle through without breaking the existing 5-arg signature.
 *
 * @task T9548
 */
export interface OrchestrateSpawnExecuteOpts {
  /**
   * When `true` (default), auto-invoke {@link completeWorktreeForTask} after
   * a successful worker spawn returns. Idempotent — re-running on an already
   * completed worktree is a no-op. Set to `false` to skip the auto-merge step
   * (e.g. when the orchestrator wants to inspect the worktree before
   * integration, or for `--no-auto-complete` flows).
   *
   * @default true
   */
  autoComplete?: boolean;
}

/**
 * orchestrate.spawn.execute - Execute spawn for a task using adapter registry
 *
 * T9548 — after a successful spawn returns, the function auto-invokes
 * {@link completeWorktreeForTask} so the worker's worktree is merged
 * (`git merge --no-ff` per ADR-062) back into the project default branch
 * and pruned. The behaviour is idempotent and can be disabled by passing
 * `autoComplete: false` in {@link OrchestrateSpawnExecuteOpts}.
 *
 * @param taskId - Task to spawn.
 * @param adapterId - Optional adapter id to use. Auto-selects if not provided.
 * @param protocolType - Optional protocol type override.
 * @param projectRoot - Optional project root path.
 * @param tier - Optional spawn tier (0=worker, 1=lead, 2=orchestrator).
 * @param opts - Optional behaviour overrides (T9548 auto-complete toggle).
 * @returns Engine result with spawn execution data.
 * @task T5236
 * @task T9548
 */
export async function orchestrateSpawnExecute(
  taskId: string,
  adapterId?: string,
  protocolType?: string,
  projectRoot?: string,
  tier?: 0 | 1 | 2,
  opts: OrchestrateSpawnExecuteOpts = {},
): Promise<EngineResult> {
  const cwd = getProjectRoot(projectRoot);
  const autoComplete = opts.autoComplete ?? true;

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

    // Run declarative post-start worktree hooks after the agent is spawned.
    // Best-effort: never block the orchestration on hook failures.
    try {
      const worktreeHooks = await loadWorktreeHooks(cwd);
      if (worktreeHooks.length > 0 && agentWorkingDirectory !== cwd) {
        await runWorktreeHooks(worktreeHooks, 'post-start', agentWorkingDirectory);
      }
    } catch {
      /* Worktree hooks are best-effort — never block spawn */
    }

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

    // ---- T9548 — Auto-invoke worktree-complete post-success. --------------
    //
    // After the worker has returned a clean exit, integrate its worktree back
    // to the project default branch via the canonical ADR-062 merge path.
    // The call is idempotent: re-running on an already-completed worktree
    // returns `outcome: 'noop'`. Merge conflicts preserve the worktree.
    //
    // The auto-invoke is gated by:
    //  1. `opts.autoComplete !== false`
    //  2. The worker returning a non-zero exit code is treated as failure —
    //     the worktree is preserved and the auto-complete step skipped so
    //     the operator can inspect the failed work.
    //  3. Failure to import / run the SDK is non-fatal: the spawn envelope
    //     is returned unchanged.
    let autoCompleteOutcome:
      | {
          ran: boolean;
          outcome: import('./worktree-complete.js').CompleteWorktreeForTaskResult['outcome'];
          reason: string;
        }
      | { ran: false; reason: string } = { ran: false, reason: 'autoComplete disabled' };

    if (autoComplete && result.exitCode === 0) {
      try {
        const { completeWorktreeForTask } = await import('./worktree-complete.js');
        const completion = completeWorktreeForTask(taskId, cwd);
        autoCompleteOutcome = {
          ran: true,
          outcome: completion.outcome,
          reason: completion.reason,
        };
        getLogger('engine:orchestrate').info(
          { taskId, outcome: completion.outcome, reason: completion.reason },
          'T9548 auto-complete invoked',
        );
      } catch (err) {
        // Auto-complete is best-effort. The spawn itself succeeded; surface
        // the integration error in the envelope but do not fail the spawn.
        const message = err instanceof Error ? err.message : String(err);
        autoCompleteOutcome = { ran: false, reason: `auto-complete failed: ${message}` };
        getLogger('engine:orchestrate').warn(
          { taskId, err: message },
          'T9548 auto-complete threw — spawn envelope returned unchanged',
        );
      }
    } else if (!autoComplete) {
      autoCompleteOutcome = { ran: false, reason: 'autoComplete disabled (--no-auto-complete)' };
    } else {
      // exitCode !== 0 — worker failed; preserve worktree for inspection.
      autoCompleteOutcome = {
        ran: false,
        reason: `worker exitCode=${result.exitCode} — worktree preserved for inspection`,
      };
    }

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
          // T9548 — auto-complete diagnostics surfaced for orchestrator visibility.
          autoComplete: autoCompleteOutcome,
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
 * T9545 — every invocation runs under a {@link SPAWN_BUDGET_MS} overall
 * timeout enforced via an {@link AbortController}. When the budget expires
 * the function returns an `E_TIMEOUT` envelope without deleting any
 * partially-provisioned worktree (the lifecycle prune step handles orphan
 * cleanup). Progress is logged per step via the `engine:orchestrate` logger
 * so a wedged step is observable in real time.
 *
 * @param taskId - Task to generate spawn prompt for.
 * @param protocolType - Optional protocol type override.
 * @param projectRoot - Optional project root path.
 * @param tier - Optional spawn tier (0=worker, 1=lead, 2=orchestrator).
 * @param noWorktree - If true, skip worktree provisioning.
 * @param spawnScope - T9807 sparse-checkout cone path (governs the worktree's
 *   checked-out tree). Distinct from `atomicityScope`.
 * @param atomicityScope - T9214 / T10430 atomicity waiver. When
 *   `'orchestrator-defer'`, the composer routes the waiver into
 *   {@link composeSpawnPayload} so the worker file-scope gate grants the
 *   spawn and records `atomicity_waiver: 'orchestrator-scope-tier1-call'`
 *   instead of returning `E_ATOMICITY_NO_SCOPE`.
 * @returns Engine result with spawn prompt data.
 * @task T4478
 * @task T932
 * @task T9545
 * @task T9214
 * @task T10430
 */
export async function orchestrateSpawn(
  taskId: string,
  protocolType?: string,
  projectRoot?: string,
  tier?: 0 | 1 | 2,
  noWorktree?: boolean,
  spawnScope?: string,
  atomicityScope?: 'orchestrator-defer',
): Promise<EngineResult> {
  if (!taskId) {
    return engineError('E_INVALID_INPUT', 'taskId is required');
  }

  // T9545 — overall budget supervisor. Fires once SPAWN_BUDGET_MS elapses;
  // every async step in the pipeline below is raced against the resulting
  // AbortSignal so a wedged subprocess cannot block the parent indefinitely.
  const budgetCtrl = new AbortController();
  const budgetTimer = setTimeout(() => budgetCtrl.abort(), SPAWN_BUDGET_MS);
  const spawnLogger = getLogger('engine:orchestrate');
  const spawnStartedAt = Date.now();

  /**
   * Partial-state tracker — populated as the pipeline provisions resources.
   * The timeout envelope reads from this on abort so cleanup can target the
   * exact worktree that was being built when the budget blew.
   *
   * @task T9545
   */
  const partialState: { worktreePath?: string; worktreeBranch?: string; rootResolved?: string } =
    {};

  /**
   * Build the E_TIMEOUT envelope AND run bounded auto-cleanup on the
   * partially-provisioned worktree (Saga T10176 / D010). The original T9545
   * supervisor preserved orphan worktrees; the saga reversed that decision
   * so spawn timeouts now self-heal.
   */
  const buildTimeoutEnvelope = async (step: SpawnPipelineStep): Promise<EngineResult> => {
    const partial = {
      ...(partialState.worktreePath ? { worktreePath: partialState.worktreePath } : {}),
      ...(partialState.worktreeBranch ? { worktreeBranch: partialState.worktreeBranch } : {}),
    };
    spawnLogger.error(
      { taskId, step, elapsedMs: Date.now() - spawnStartedAt, partial },
      `T9545 spawn budget (${SPAWN_BUDGET_MS}ms) exceeded at step '${step}' — running auto-cleanup`,
    );

    // Run bounded cleanup ONLY when a worktree was actually provisioned —
    // skip otherwise so we don't churn against absent state. destroyWorktree
    // is idempotent (returns worktreeRemoved=true when the path is already
    // gone) so repeated invocations are safe.
    let cleanup: TimeoutCleanupResult | undefined;
    if (partialState.worktreePath && partialState.rootResolved) {
      try {
        cleanup = await runTimeoutCleanup(partialState.rootResolved, taskId);
        spawnLogger.info({ taskId, cleanup }, 'T9545 auto-cleanup completed after spawn timeout');
      } catch (cleanupErr) {
        // runTimeoutCleanup never throws, but guard anyway so the envelope
        // construction can never fail.
        cleanup = {
          attempted: true,
          worktreeRemoved: false,
          branchDeleted: false,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          elapsedMs: 0,
        };
      }
    }

    return engineError(
      'E_TIMEOUT',
      `Spawn pipeline exceeded ${SPAWN_BUDGET_MS}ms budget at step '${step}'`,
      {
        details: {
          taskId,
          step,
          budgetMs: SPAWN_BUDGET_MS,
          elapsedMs: Date.now() - spawnStartedAt,
          partial,
          ...(cleanup ? { cleanup } : {}),
        },
        fix:
          cleanup && !cleanup.worktreeRemoved
            ? 'Auto-cleanup did not remove the worktree — run `cleo worktree prune --taskId <id>` to force-remove the orphan, then retry the spawn.'
            : 'Auto-cleanup removed the partial worktree — safe to retry the spawn directly.',
      },
    );
  };

  try {
    const root = getProjectRoot(projectRoot);
    partialState.rootResolved = root;
    spawnLogger.info(
      { taskId, tier, noWorktree, budgetMs: SPAWN_BUDGET_MS },
      'T9545 spawn pipeline started',
    );

    // Step 1: Validate readiness.
    // T929: a V_NOT_FOUND issue means the task ID doesn't exist in the DB —
    // surface E_NOT_FOUND (exit 4) so callers get a clear, actionable error
    // instead of a generic spawn-validation failure that obscures the root cause.
    spawnLogger.info({ taskId, step: 'validate-readiness' }, 'validating spawn readiness');
    const accessor = await raceAgainstAbort(
      getTaskAccessor(root),
      budgetCtrl.signal,
      'validate-readiness',
    );
    const validation = await raceAgainstAbort(
      validateSpawnReadiness(taskId, root, accessor),
      budgetCtrl.signal,
      'validate-readiness',
    );
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

    // T10448 — Pre-spawn hygiene gate: validate changesets before composing
    // the prompt. Fail fast so malformed entries are caught before any
    // worktree is provisioned or an agent is dispatched.
    spawnLogger.info({ taskId, step: 'lint-changesets' }, 'running changeset hygiene gate');
    const lintResult = runLintChangesets(root);
    if (!lintResult.ok) {
      spawnLogger.error(
        { taskId, error: lintResult.error },
        'T10448 changeset hygiene gate failed',
      );
      return engineError(
        'E_CHANGESET_HYGIENE_FAILED',
        'Changeset hygiene gate failed — malformed .changeset/*.md entries detected',
        {
          details: {
            taskId,
            lintOutput: lintResult.error,
          },
          fix: 'Run `node scripts/lint-changesets.mjs` to see every offending entry. Canonical kinds: feat|fix|perf|refactor|docs|test|chore|breaking.',
        },
      );
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
    /** T9226 — patterns actually excluded from the worktree. */
    let appliedWorktreeExcludePatterns: readonly string[] | undefined;

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
      //
      // T9545: the spawnWorktree call is the historical hang site — wrap it
      // in the budget supervisor so a wedged git child cannot block forever.
      spawnLogger.info({ taskId, step: 'provision-worktree' }, 'provisioning worktree');
      try {
        // T9226 — spawn-clone-exclude: exclude heavyweight artefacts to keep
        // the worktree lean (T9337 removed per-task verifier exclusions).
        const { SPAWN_CLONE_EXCLUDE_PATTERNS } = await import('../orchestration/spawn-prompt.js');
        sdkWorktreeResult = await raceAgainstAbort(
          spawnWorktree(root, {
            taskId,
            spawnCloneExclude: SPAWN_CLONE_EXCLUDE_PATTERNS,
            ...(spawnScope ? { spawnScope } : {}),
          }),
          budgetCtrl.signal,
          'provision-worktree',
        );
        worktreePath = sdkWorktreeResult.path;
        worktreeBranch = sdkWorktreeResult.branch;
        // T9545 — record for the timeout supervisor so auto-cleanup can target
        // this exact worktree if a later pipeline step blows the budget.
        partialState.worktreePath = worktreePath;
        partialState.worktreeBranch = worktreeBranch;
        const extResult =
          sdkWorktreeResult as import('@cleocode/contracts').CreateWorktreeResult & {
            appliedExcludePatterns?: string[];
          };
        appliedWorktreeExcludePatterns = extResult.appliedExcludePatterns ?? [
          ...SPAWN_CLONE_EXCLUDE_PATTERNS,
        ];
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
    //
    // T9545: bounded by the overall spawn budget — a stalled DB or composer
    // step now surfaces as E_TIMEOUT instead of wedging the parent.
    spawnLogger.info({ taskId, step: 'compose-prompt' }, 'generating spawn prompt');
    const payload = await raceAgainstAbort(
      composeSpawnForTask(taskId, root, {
        tier,
        sessionId: activeSessionId,
        protocol: protocolType,
        worktreePath,
        worktreeBranch,
        conduitSubscription,
        spawnCloneExclude: appliedWorktreeExcludePatterns,
        // T10430 — forward the atomicity waiver into the composer's scope
        // option so workers without explicit AC.files can be spawned when
        // an orchestrator passes `--orchestrator-defer`.
        ...(atomicityScope ? { atomicityScope } : {}),
      }),
      budgetCtrl.signal,
      'compose-prompt',
    );

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

    // T9545 — last major step before return: persist-state. The envelope
    // returned here is what callers consume to dispatch the agent.
    spawnLogger.info(
      { taskId, step: 'persist-state', elapsedMs: Date.now() - spawnStartedAt },
      'persisting spawn envelope',
    );

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
    // T9545 — when our budget supervisor aborts a step, the helper throws
    // an Error with `code === 'E_TIMEOUT'`. Surface a structured envelope
    // AND run bounded auto-cleanup on the partial worktree (Saga T10176 /
    // D010 — reversed the original "preserve partial state" decision).
    if (code === 'E_TIMEOUT') {
      // Best-effort: extract the step name from the message so the envelope
      // tells the caller exactly which step blew the budget.
      const message = (err as Error).message;
      const stepMatch = /step '([^']+)'/.exec(message);
      const step = (stepMatch?.[1] ?? 'budget-exceeded') as SpawnPipelineStep;
      return await buildTimeoutEnvelope(step);
    }
    return engineError(code, (err as Error).message);
  } finally {
    // T9545 — always release the budget timer so the Node event loop can exit.
    clearTimeout(budgetTimer);
  }
}
