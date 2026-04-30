/**
 * Orchestrate Plan Operations
 *
 * orchestratePlan, plan interfaces, and private plan helpers migrated from
 * packages/cleo/src/dispatch/engines/orchestrate-engine.ts.
 *
 * @task T1570
 * @task T889
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type { AgentTier, ResolvedAgent, Task } from '@cleocode/contracts';
import type { OrchestratePlanResult } from '@cleocode/contracts/operations/orchestrate';
import { type EngineResult, engineError } from '../engine-result.js';
import { AgentNotFoundError, resolveAgent } from '../store/agent-resolver.js';
import {
  ensureGlobalSignaldockDb,
  getGlobalSignaldockDbPath,
} from '../store/signaldock-sqlite.js';
import { getAccessor } from '../store/data-accessor.js';
import { resolveProjectRoot } from '../store/file-utils.js';
import { getEnrichedWaves } from '../orchestration/waves.js';
import { loadTasks } from './query-ops.js';

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

export type { EngineResult };

// ---------------------------------------------------------------------------
// Plan interfaces (exported)
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

// ---------------------------------------------------------------------------
// Private plan helpers
// ---------------------------------------------------------------------------

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
 * Open a short-lived signaldock db handle for composer lookups.
 *
 * Mirrors the pattern used by {@link orchestratePlan}: we intentionally do
 * NOT cache this handle — the resolver contract owns its own lifecycle and
 * callers must close the returned handle when the batch completes.
 *
 * @returns Open {@link _SignaldockDbHandle} bound to the global signaldock.db.
 * @task T932
 */
export async function openSignaldockDbForComposer(): Promise<_SignaldockDbHandle> {
  await ensureGlobalSignaldockDb();
  const dbPath = getGlobalSignaldockDbPath();
  const db = new _DatabaseSyncCtor(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * Map a numeric tier (0|1|2) used by the CLI/domain boundary to the
 * string-typed {@link AgentTier} understood by the resolver.
 *
 * @param tier - Numeric tier from input.
 * @returns Resolver-compatible tier or `undefined` when out of range.
 * @task T889 / W3-6
 */
export function numericToAgentTier(tier: 0 | 1 | 2): AgentTier | undefined {
  if (tier === 0) return 'project';
  if (tier === 1) return 'global';
  if (tier === 2) return 'packaged';
  return undefined;
}

// ---------------------------------------------------------------------------
// orchestrate.plan (T889 / W3-6)
// ---------------------------------------------------------------------------

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
            if (resolved.resolverWarning) {
              warnings.push({
                taskId: task.id,
                code: 'agent_fallback_universal_base',
                message: resolved.resolverWarning,
              });
            }
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
