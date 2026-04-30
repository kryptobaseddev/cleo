/**
 * Task completion logic.
 * @task T4461
 * @epic T4454
 */

import type { Task, TaskRecord, TaskRef, VerificationGate } from '@cleocode/contracts';
// safeAppendLog replaced by tx.appendLog inside transaction (T023)
import { ExitCode } from '@cleocode/contracts';
import { getRawConfigValue, loadConfig } from '../config.js';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { getIvtrState, type IvtrPhase } from '../lifecycle/ivtr-loop.js';
import { getLogger } from '../logger.js';
import { getProjectRoot } from '../paths.js';
import { wrapWithAgentSession } from '../sessions/agent-session-adapter.js';
import { requireActiveSession } from '../sessions/session-enforcement.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { getActiveSession } from '../store/session-store.js';
import { createAcceptanceEnforcement } from './enforcement.js';
import { revalidateEvidence } from './evidence.js';
import { validateNexusImpactGate } from './nexus-impact-gate.js';
import { isTerminalPipelineStage, isValidPipelineStage } from './pipeline-stage.js';

/**
 * IVTR execution stages — tasks in these stages auto-advance to 'release'
 * when marked complete (cleo complete TXXX).  T719.
 *
 * Historical note: prior to T871 this set drove the only pipeline-stage
 * side-effect of `cleo complete`. T871 adds a second (always-fires) step
 * that sets `pipelineStage='contribution'` so status and pipeline_stage
 * stay in sync — the Studio pipeline DONE column depends on this.
 */
const EXECUTION_STAGES_FOR_RELEASE = new Set(['implementation', 'validation', 'testing']);

/** Options for completing a task. */
export interface CompleteTaskOptions {
  taskId: string;
  notes?: string;
  changeset?: string;
  /** Reason for acknowledging CRITICAL impact risk (bypasses nexusImpact gate). */
  acknowledgeRisk?: string;
}

/**
 * Summary of the llmtxt ContributionReceipt emitted when wrapping
 * completion in an AgentSession (T947). The full receipt is persisted
 * to `.cleo/audit/receipts.jsonl`; here we surface only the
 * correlation fields the CLI needs for display.
 */
export interface TaskCompletionReceiptSummary {
  /** 128-bit unguessable session id from llmtxt. */
  receiptId: string;
  /** Ed25519 signature (present for RemoteBackend; stub until llmtxt T461). */
  signature?: string;
}

/** Result of completing a task. */
export interface CompleteTaskResult {
  task: Task;
  autoCompleted?: string[];
  unblockedTasks?: Array<Pick<TaskRef, 'id' | 'title'>>;
  /**
   * llmtxt ContributionReceipt correlation (T947). Absent when the
   * AgentSession adapter degraded to a no-op (peer deps missing) or
   * when running in VITEST with no audit layer.
   */
  receipt?: TaskCompletionReceiptSummary;
}

interface CompletionEnforcement {
  acceptanceMode: 'off' | 'warn' | 'block';
  acceptanceRequiredForPriorities: string[];
  verificationEnabled: boolean;
  verificationRequiredGates: VerificationGate[];
  verificationMaxRounds: number;
  lifecycleMode: 'strict' | 'warn' | 'advisory' | 'none' | 'off';
}

const DEFAULT_VERIFICATION_REQUIRED_GATES: VerificationGate[] = [
  'implemented',
  'testsPassed',
  'qaPassed',
  'securityPassed',
  'documented',
];

const VERIFICATION_GATES = new Set<VerificationGate>([
  'implemented',
  'testsPassed',
  'qaPassed',
  'cleanupDone',
  'securityPassed',
  'documented',
]);

function isVerificationGate(value: string): value is VerificationGate {
  return VERIFICATION_GATES.has(value as VerificationGate);
}

async function loadCompletionEnforcement(cwd?: string): Promise<CompletionEnforcement> {
  // In VITEST, use permissive defaults when config keys are absent.
  // Tests that need enforcement write their own config, which overrides these defaults.
  const isTest = !!process.env.VITEST;

  const config = await loadConfig(cwd);
  const acceptance = config.enforcement?.acceptance;
  const verificationCfg = config.verification;
  const acceptanceMode = acceptance?.mode ?? (isTest ? 'off' : 'block');
  const acceptanceRequiredForPriorities =
    acceptance?.requiredForPriorities ?? (isTest ? [] : ['critical', 'high', 'medium', 'low']);
  // Use getRawConfigValue to read only the project-level config (no DEFAULTS cascade).
  // This ensures the isTest fallback activates when verification.enabled is not explicitly set.
  const rawVerificationEnabled = await getRawConfigValue('verification.enabled', cwd);
  const verificationEnabled =
    rawVerificationEnabled !== undefined ? (rawVerificationEnabled as boolean) : !isTest;
  const verificationRequiredGates =
    (verificationCfg?.requiredGates ?? []).filter(isVerificationGate).length > 0
      ? (verificationCfg?.requiredGates ?? []).filter(isVerificationGate)
      : DEFAULT_VERIFICATION_REQUIRED_GATES;
  const verificationMaxRounds = verificationCfg?.maxRounds ?? 5;
  const lifecycleMode = config.lifecycle?.mode ?? (isTest ? 'off' : 'strict');

  return {
    acceptanceMode,
    acceptanceRequiredForPriorities,
    verificationEnabled,
    verificationRequiredGates,
    verificationMaxRounds,
    lifecycleMode,
  };
}

/**
 * Check whether an epic has sufficient evidence to complete.
 *
 * An epic satisfies the evidence requirement if ANY of the following is true:
 * 1. It has at least one direct evidence atom on any verification gate.
 * 2. All of its children (excluding cancelled) have `status='done'` AND
 *    `verification.passed=true`.
 *
 * Returns `true` when the epic may proceed; `false` when it must be rejected.
 *
 * @param task - The epic task to check.
 * @param acc - Data accessor used to load children.
 * @returns `true` when evidence is sufficient; `false` otherwise.
 * @task T1404
 */
export async function verifyEpicHasEvidence(task: Task, acc: DataAccessor): Promise<boolean> {
  // Condition 1: direct evidence atoms on any gate
  if (task.verification?.evidence) {
    const gates = task.verification.evidence;
    const hasAtoms = Object.values(gates).some(
      (gateEvidence) => gateEvidence != null && gateEvidence.atoms.length > 0,
    );
    if (hasAtoms) return true;
  }

  // Condition 2: all non-cancelled children are done+verified
  const children = await acc.getChildren(task.id);
  const nonCancelled = children.filter((c) => c.status !== 'cancelled');
  if (
    nonCancelled.length > 0 &&
    nonCancelled.every((c) => c.status === 'done' && c.verification?.passed === true)
  ) {
    return true;
  }

  return false;
}

/**
 * Complete a task by ID.
 * Handles dependency checking and optional auto-completion of epics.
 * @task T4461
 */
export async function completeTask(
  options: CompleteTaskOptions,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<CompleteTaskResult> {
  const acc = accessor ?? (await getAccessor(cwd));
  const task = await acc.loadSingleTask(options.taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${options.taskId}`, {
      fix: `Use 'cleo find "${options.taskId}"' to search`,
    });
  }

  await requireActiveSession('tasks.complete', cwd);

  const enforcement = await loadCompletionEnforcement(cwd);

  // Already done
  if (task.status === 'done') {
    throw new CleoError(ExitCode.TASK_COMPLETED, `Task ${options.taskId} is already completed`, {
      fix: `To reopen, run cleo update ${options.taskId} --status active`,
      details: { field: 'status', expected: 'not done', actual: 'done' },
    });
  }

  // Check if task has incomplete dependencies
  if (task.depends?.length) {
    const deps = await acc.loadTasks(task.depends);
    const incompleteDeps = deps
      .filter((d) => d.status !== 'done' && d.status !== 'cancelled')
      .map((d) => d.id);
    if (incompleteDeps.length > 0) {
      throw new CleoError(
        ExitCode.DEPENDENCY_ERROR,
        `Task ${options.taskId} has incomplete dependencies: ${incompleteDeps.join(', ')}`,
        {
          fix: `Complete dependencies first: ${incompleteDeps.map((d) => `cleo complete ${d}`).join(', ')}`,
        },
      );
    }
  }

  const acceptanceEnforcement = await createAcceptanceEnforcement(cwd);
  const completionValidation = acceptanceEnforcement.validateCompletion(task);
  if (!completionValidation.valid) {
    throw new CleoError(
      completionValidation.exitCode ?? ExitCode.VALIDATION_ERROR,
      completionValidation.error!,
      { fix: completionValidation.fix },
    );
  }

  if (enforcement.verificationEnabled && task.type !== 'epic') {
    if (!task.verification) {
      throw new CleoError(
        ExitCode.VERIFICATION_INIT_FAILED,
        `Task ${options.taskId} is missing verification metadata`,
        {
          fix: `Initialize verification for ${options.taskId} before completion`,
        },
      );
    }

    if (task.verification.round > enforcement.verificationMaxRounds) {
      throw new CleoError(
        ExitCode.MAX_ROUNDS_EXCEEDED,
        `Task ${options.taskId} exceeded verification max rounds (${enforcement.verificationMaxRounds})`,
        {
          fix: `Review failure log and resolve blockers before retrying completion`,
        },
      );
    }

    const missingRequiredGates = enforcement.verificationRequiredGates.filter(
      (gate) => task.verification?.gates?.[gate] !== true,
    );

    if (missingRequiredGates.length > 0 || task.verification.passed !== true) {
      const exitCode =
        enforcement.lifecycleMode === 'strict'
          ? ExitCode.LIFECYCLE_GATE_FAILED
          : ExitCode.GATE_DEPENDENCY;

      throw new CleoError(
        exitCode,
        `Task ${options.taskId} failed verification gates: ${missingRequiredGates.join(', ') || 'verification.passed=false'}`,
        {
          fix: `Set required verification gates before completion: ${enforcement.verificationRequiredGates.join(', ')}`,
        },
      );
    }
  }

  // ---- T1404 / P1-4: Epic closure requires direct evidence or verified children ----
  // Epics with no evidence atoms and no verified children cannot silently complete.
  // This gate fires only under strict lifecycle mode with verification enabled,
  // matching the same conditions as the non-epic verification block above.
  if (
    enforcement.verificationEnabled &&
    enforcement.lifecycleMode === 'strict' &&
    task.type === 'epic'
  ) {
    const evidenceSatisfied = await verifyEpicHasEvidence(task, acc);
    if (!evidenceSatisfied) {
      throw new CleoError(
        ExitCode.LIFECYCLE_GATE_FAILED,
        `Epic ${options.taskId} cannot complete without direct evidence atoms or verified children`,
        {
          fix:
            `Either add direct evidence via 'cleo verify ${options.taskId} --gate implemented --evidence "..."' ` +
            `or ensure all children have status=done with verification.passed=true.`,
        },
      );
    }
  }

  // ---- IVTR Breaking-Change Gate (EP3-T8): Check nexusImpact risk ----
  const projectRoot = cwd ?? getProjectRoot();
  const gateResult = await validateNexusImpactGate(task, projectRoot);

  if (!gateResult.passed && !options.acknowledgeRisk) {
    // Gate failed and worker did not provide acknowledgment
    throw new CleoError(
      gateResult.exitCode ?? ExitCode.NEXUS_IMPACT_CRITICAL,
      gateResult.error ?? 'CRITICAL impact risk detected',
      {
        fix: 'Either fix the CRITICAL symbols or pass --acknowledge-risk "<reason>" to bypass the gate',
        details: {
          field: 'criticalSymbols',
          criticalSymbols: gateResult.criticalSymbols?.map((s) => ({
            symbol: s.symbolName ?? s.symbolId,
            risk: s.mergedRiskScore,
            narrative: s.narrative,
          })),
        },
      },
    );
  }

  // If gate passed or worker acknowledged risk, optionally audit the acknowledgment
  if (
    options.acknowledgeRisk &&
    gateResult.criticalSymbols &&
    gateResult.criticalSymbols.length > 0
  ) {
    // Write acknowledgment to audit file
    try {
      const { appendNexusRiskAck } = await import('./nexus-risk-audit.js');
      await appendNexusRiskAck({
        taskId: options.taskId,
        symbols: gateResult.criticalSymbols.map((s) => ({
          symbolId: s.symbolId,
          symbolName: s.symbolName ?? undefined,
          risk: s.mergedRiskScore,
        })),
        reason: options.acknowledgeRisk,
        timestamp: new Date().toISOString(),
        agent: process.env.CLEO_AGENT_ID ?? 'cleo',
      });
    } catch (err) {
      console.warn(
        '[complete] failed to audit nexus risk acknowledgment:',
        err instanceof Error ? err.message : String(err),
      );
      // Do not fail the completion on audit write failure; just warn
    }
  }

  // Check if task has incomplete children
  const children = await acc.getChildren(options.taskId);
  const incompleteChildren = children.filter(
    (c) => c.status !== 'done' && c.status !== 'cancelled',
  );
  if (incompleteChildren.length > 0 && task.type === 'epic') {
    if (!task.noAutoComplete) {
      throw new CleoError(
        ExitCode.HAS_CHILDREN,
        `Epic ${options.taskId} has ${incompleteChildren.length} incomplete children: ${incompleteChildren.map((c) => c.id).join(', ')}`,
        {
          fix: `Complete children first or use 'cleo update ${options.taskId} --no-auto-complete'`,
        },
      );
    }
  }

  const now = new Date().toISOString();
  const before = { ...task };

  // ── T947 Step 2: wrap state mutation + transaction in an AgentSession ──
  //
  // Every CLEO task completion is a "contribution" in llmtxt vocabulary.
  // `wrapWithAgentSession` opens a standalone llmtxt backend, calls
  // session.contribute(fn), then closes and persists the signed
  // ContributionReceipt to `.cleo/audit/receipts.jsonl`. When the
  // llmtxt peer dependencies (`better-sqlite3`, `drizzle-orm/better-sqlite3`)
  // are absent, the wrapper degrades to invoking `fn` unwrapped and
  // returning `receipt: null` — observable behaviour is unchanged.
  //
  // The closure below holds the ORIGINAL state-write logic verbatim.
  // We only promote the `autoCompleted` / `autoCompletedTasks` arrays
  // out of the closure scope so the post-transaction return block can
  // still read them. This preserves ADR-051 evidence-gate semantics
  // and the existing transaction contract (tx.upsertSingleTask +
  // tx.appendLog).
  const autoCompleted: string[] = [];
  const autoCompletedTasks: Task[] = [];

  const { receipt } = await wrapWithAgentSession(
    {
      sessionId:
        typeof process.env.CLEO_SESSION_ID === 'string' && process.env.CLEO_SESSION_ID.length > 0
          ? process.env.CLEO_SESSION_ID
          : undefined,
      agentId: process.env.CLEO_AGENT_ID ?? 'cleo',
      projectRoot: cwd ?? process.cwd(),
      label: `complete:${options.taskId}`,
    },
    async () => {
      // Auto-advance pipelineStage: IVTR execution stages → release (T719)
      // When a task is completed, advance from implementation/validation/testing to release.
      // This mirrors the lifecycle model: completing work exits the IVTR phase.
      const completionStage = task.pipelineStage;
      if (
        completionStage &&
        isValidPipelineStage(completionStage) &&
        EXECUTION_STAGES_FOR_RELEASE.has(completionStage)
      ) {
        task.pipelineStage = 'release';
      }

      // T871: Always sync pipelineStage to a terminal value on completion.
      // `contribution` is the natural terminal stage (RCASD-IVTR+C). This keeps
      // `status=done` and `pipelineStage=contribution` aligned so downstream
      // consumers (Studio Pipeline Kanban, dashboards) can rely on either signal
      // without drift. The write is below so it always wins over the
      // `implementation/validation/testing → release` nudge above — completed
      // tasks should never linger in a pre-terminal stage.
      if (!isTerminalPipelineStage(task.pipelineStage)) {
        task.pipelineStage = 'contribution';
      }

      // Update task
      task.status = 'done';
      task.completedAt = now;
      task.updatedAt = now;

      if (options.notes) {
        const timestampedNote = `${new Date()
          .toISOString()
          .replace('T', ' ')
          .replace(/\.\d+Z$/, ' UTC')}: ${options.notes}`;
        if (!task.notes) task.notes = [];
        task.notes.push(timestampedNote);
      }

      if (options.changeset) {
        if (!task.notes) task.notes = [];
        task.notes.push(`Changeset: ${options.changeset}`);
      }

      // Check if parent epic should auto-complete
      if (task.parentId) {
        const parent = await acc.loadSingleTask(task.parentId);
        if (parent && parent.type === 'epic' && !parent.noAutoComplete) {
          const siblings = await acc.getChildren(parent.id);
          // Guard: only auto-complete if the epic has at least one registered child.
          // An empty siblings list means no children are recorded in the DB, which
          // would vacuously satisfy .every() and incorrectly auto-complete the epic.
          // The current task is not yet 'done' in DB, so match it by ID.
          const allDone =
            siblings.length > 0 &&
            siblings.every(
              (c) => c.id === task.id || c.status === 'done' || c.status === 'cancelled',
            );
          if (allDone) {
            parent.status = 'done';
            parent.completedAt = now;
            parent.updatedAt = now;
            // T871: Auto-completed epics must also reach a terminal pipelineStage.
            if (!isTerminalPipelineStage(parent.pipelineStage)) {
              parent.pipelineStage = 'contribution';
            }
            autoCompleted.push(parent.id);
            autoCompletedTasks.push(parent);
          }
        }
      }

      // Wrap writes in a transaction for TOCTOU safety (T023)
      await acc.transaction(async (tx) => {
        await tx.upsertSingleTask(task);
        for (const parentTask of autoCompletedTasks) {
          await tx.upsertSingleTask(parentTask);
        }
        await tx.appendLog({
          id: `log-${Math.floor(Date.now() / 1000)}-${(await import('node:crypto')).randomBytes(3).toString('hex')}`,
          timestamp: new Date().toISOString(),
          action: 'task_completed',
          taskId: options.taskId,
          actor: 'system',
          details: { title: task.title, previousStatus: before.status },
          before: null,
          after: { title: task.title, previousStatus: before.status },
        });
      });

      // llmtxt tracks `documentIds` when contribute() returns a shape
      // matching `{ documentId?: string }`. CLEO tasks are not llmtxt
      // documents, so we return an empty object here — eventCount still
      // ticks to 1 on success, which is the signal the receipt needs.
      return {};
    },
  );

  // Compute newly unblocked tasks: dependents whose deps are now all satisfied
  const dependents = await acc.getDependents(options.taskId);
  const unblockedTasks: Array<Pick<TaskRef, 'id' | 'title'>> = [];
  for (const dep of dependents) {
    if (dep.status === 'done' || dep.status === 'cancelled') continue;
    if (dep.depends?.length) {
      const depDeps = await acc.loadTasks(dep.depends);
      const stillUnresolved = depDeps.filter(
        (d) => d.id !== options.taskId && d.status !== 'done' && d.status !== 'cancelled',
      );
      if (stillUnresolved.length === 0) {
        unblockedTasks.push({ id: dep.id, title: dep.title });
      }
    } else {
      unblockedTasks.push({ id: dep.id, title: dep.title });
    }
  }

  // T1462: Auto-prune the task worktree when the task is completed.
  // This runs best-effort and never blocks or fails the completion.
  import('../spawn/branch-lock.js')
    .then(({ pruneWorktree }) => {
      try {
        pruneWorktree(options.taskId, projectRoot);
      } catch {
        /* best-effort — worktree may not exist */
      }
    })
    .catch(() => {
      /* module unavailable — non-fatal */
    });

  // NOTE: Memory bridge refresh is now handled by the onToolComplete hook
  // via memory-bridge-refresh.ts (T138). No direct call needed here.

  // Task-completion memory is intentionally NOT written here.
  // The legacy extractTaskCompletionMemory function was removed (produced
  // O(tasks x labels) noise — see T523 CA1 spec). Durable knowledge is now
  // extracted from session transcripts at session end via the LLM extraction
  // gate in memory/llm-extraction.ts.

  // Auto-populate brain graph nodes for the completed task (best-effort, T537).
  // Graph topology is still written here — only the noise-producing memory
  // row writes were removed.
  import('../memory/graph-auto-populate.js')
    .then(({ upsertGraphNode, addGraphEdge }) =>
      (async () => {
        const projectRoot = cwd ?? process.cwd();
        await upsertGraphNode(
          projectRoot,
          `task:${task.id}`,
          'task',
          `${task.id}: ${task.title}`.substring(0, 200),
          1.0,
          task.title,
          { status: 'done', priority: task.priority },
        );
        if (task.parentId) {
          await upsertGraphNode(
            projectRoot,
            `epic:${task.parentId}`,
            'epic',
            task.parentId,
            1.0,
            '',
          );
          await addGraphEdge(
            projectRoot,
            `task:${task.id}`,
            `epic:${task.parentId}`,
            'part_of',
            1.0,
            'auto:task-complete',
          );
        }
      })(),
    )
    .catch(() => {
      /* Graph population is best-effort */
    });

  // Dispatch PostToolUse hook — triggers observer, quality feedback, and memory bridge refresh.
  // This is the missing link between "task completed" and "brain processes it" (T555).
  try {
    const { hooks } = await import('../hooks/registry.js');
    await hooks
      .dispatch('PostToolUse', cwd ?? process.cwd(), {
        timestamp: new Date().toISOString(),
        taskId: options.taskId,
        taskTitle: task.title,
        previousStatus: before.status,
        newStatus: 'done',
        unblockedCount: unblockedTasks.length,
      })
      .catch(() => {
        /* Hooks are best-effort — never block task completion */
      });
  } catch {
    /* Hook registry unavailable — non-fatal */
  }

  // T947 Step 2: surface the llmtxt ContributionReceipt summary on
  // the return envelope so CLI / agents can reference `receiptId` for
  // audit queries. When the AgentSession adapter degraded to a no-op
  // (peer deps missing), `receipt` is null and we omit the field to
  // preserve backward-compatible shape.
  const receiptSummary: TaskCompletionReceiptSummary | undefined =
    receipt !== null
      ? {
          receiptId: receipt.sessionId,
          ...(receipt.signature ? { signature: receipt.signature } : {}),
        }
      : undefined;

  return {
    task,
    ...(autoCompleted.length > 0 && { autoCompleted }),
    ...(unblockedTasks.length > 0 && { unblockedTasks }),
    ...(receiptSummary ? { receipt: receiptSummary } : {}),
  };
}

// ---------------------------------------------------------------------------
// EngineResult-returning wrappers (T1568 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

type CompleteEngineResult = EngineResult<{
  task: TaskRecord;
  autoCompleted?: string[];
  unblockedTasks?: Array<{ id: string; title: string }>;
}>;

/**
 * Complete a task (set status to done), wrapped in EngineResult.
 *
 * Stamps modified_by + session_id provenance on successful completion
 * (T1222 / CLEO-VALID-27).
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to complete
 * @param notes - Optional completion notes
 * @returns EngineResult with the completed task, auto-completed parents, and unblocked tasks
 *
 * @task T1568
 * @epic T1566
 */
export async function taskComplete(
  projectRoot: string,
  taskId: string,
  notes?: string,
): Promise<CompleteEngineResult> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await completeTask({ taskId, notes }, projectRoot, accessor);

    // T1222 / CLEO-VALID-27: stamp modified_by + session_id on every successful completion.
    // Best-effort — failure here must not roll back the completion that already landed.
    try {
      const agentId = process.env['CLEO_AGENT_ID'] ?? 'cleo';
      let sessionId: string | null =
        typeof process.env['CLEO_SESSION_ID'] === 'string' &&
        process.env['CLEO_SESSION_ID'].length > 0
          ? process.env['CLEO_SESSION_ID']
          : null;
      const activeSession = await getActiveSession(projectRoot);
      if (activeSession?.id) {
        sessionId = activeSession.id;
      }
      await accessor.updateTaskFields(taskId, { modifiedBy: agentId, sessionId });
    } catch {
      // Provenance write failure is non-fatal.
    }

    return engineSuccess({
      task: result.task as TaskRecord,
      ...(result.autoCompleted && { autoCompleted: result.autoCompleted }),
      ...(result.unblockedTasks && { unblockedTasks: result.unblockedTasks }),
    });
  } catch (err: unknown) {
    const e = err as { message?: string };
    return engineError('E_INTERNAL', e?.message ?? 'Failed to complete task');
  }
}

/**
 * Complete a task with strict IVTR + evidence-staleness enforcement.
 *
 * Enforcement path (T832 / ADR-051 Decision 3+8):
 * 1. Evidence staleness re-check: every verification.evidence record is re-validated.
 * 2. IVTR enforcement in strict mode: ivtr_state.currentPhase MUST be 'released'.
 * 3. Parent-epic lifecycle gate: child task completion is blocked while the parent
 *    epic is still in a planning stage.
 * 4. Verification_json null check.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to complete
 * @param notes - Optional completion notes
 * @returns EngineResult with the completed task, auto-completed parents, and unblocked tasks
 *
 * @task T1568
 * @adr ADR-051
 * @epic T1566
 */
export async function completeTaskStrict(
  projectRoot: string,
  taskId: string,
  notes?: string,
): Promise<CompleteEngineResult> {
  try {
    const config = await loadConfig(projectRoot);
    const lifecycleMode = config.lifecycle?.mode ?? 'strict';

    // 1. Evidence staleness re-check (T832 / ADR-051 Decision 8).
    if (lifecycleMode === 'strict') {
      const accessor = await getAccessor(projectRoot);
      const task = await accessor.loadSingleTask(taskId);
      if (task?.verification?.evidence) {
        const evidenceEntries = Object.entries(task.verification.evidence);
        const staleGates: Array<{ gate: string; failures: string[] }> = [];
        for (const [gate, ev] of evidenceEntries) {
          if (!ev) continue;
          const check = await revalidateEvidence(ev, projectRoot);
          if (!check.stillValid) {
            staleGates.push({
              gate,
              failures: check.failedAtoms.map((f: { reason: string }) => f.reason),
            });
          }
        }
        if (staleGates.length > 0) {
          const message =
            `Task ${taskId} evidence is stale. ` +
            staleGates.map((sg) => `Gate '${sg.gate}': ${sg.failures.join('; ')}`).join(' | ');
          return engineError<{
            task: TaskRecord;
            autoCompleted?: string[];
            unblockedTasks?: Array<{ id: string; title: string }>;
          }>('E_EVIDENCE_STALE', message, {
            details: { taskId, staleGates },
            fix:
              `Re-capture evidence for the stale gates via ` +
              `'cleo verify ${taskId} --gate <gate> --evidence <updated>' ` +
              `then retry 'cleo complete ${taskId}'. See ADR-051.`,
          });
        }
      }
    }

    // 2. IVTR enforcement only applies in strict mode.
    if (lifecycleMode === 'strict') {
      const ivtrState = await getIvtrState(taskId, { cwd: projectRoot });

      if (ivtrState !== null && ivtrState.currentPhase !== 'released') {
        const requiredPhases: Array<Exclude<IvtrPhase, 'released'>> = [
          'implement',
          'validate',
          'test',
        ];
        const failedPhases: string[] = [];
        for (const phase of requiredPhases) {
          const hasPassed = ivtrState.phaseHistory.some(
            (e) => e.phase === phase && e.passed === true,
          );
          if (!hasPassed) {
            failedPhases.push(`Phase '${phase}' has no passing entry`);
          }
        }

        const activeEntry = ivtrState.phaseHistory.findLast((e) => e.completedAt === null);
        if (activeEntry) {
          failedPhases.push(
            `Phase '${activeEntry.phase}' is currently in-progress (not completed)`,
          );
        }

        return engineError<{
          task: TaskRecord;
          autoCompleted?: string[];
          unblockedTasks?: Array<{ id: string; title: string }>;
        }>(
          'E_IVTR_INCOMPLETE',
          `Task ${taskId} IVTR loop is not complete — currentPhase='${ivtrState.currentPhase}', not 'released'`,
          {
            details: { taskId, currentPhase: ivtrState.currentPhase, failedPhases },
            fix: `Advance the IVTR loop to 'released' via 'cleo orchestrate ivtr ${taskId} --next'. Evidence-based bypass: CLEO_OWNER_OVERRIDE=1 on 'cleo verify' (audited, see ADR-051).`,
          },
        );
      }
    }

    // 3. Parent-epic lifecycle gate check on child complete (T788 LOOM-04).
    if (lifecycleMode === 'strict' || lifecycleMode === 'advisory') {
      const accessor = await getAccessor(projectRoot);
      const task = await accessor.loadSingleTask(taskId);
      if (task?.parentId) {
        const parent = await accessor.loadSingleTask(task.parentId);
        if (parent?.type === 'epic') {
          const earlyStages = new Set([
            'research',
            'consensus',
            'architecture_decision',
            'specification',
            'decomposition',
          ]);
          const epicStage = parent.pipelineStage ?? null;
          if (epicStage && earlyStages.has(epicStage)) {
            const msg =
              `Task ${taskId} cannot complete: parent epic ${task.parentId} is still in ` +
              `'${epicStage}' stage. Advance the epic past decomposition before completing children.`;
            if (lifecycleMode === 'strict') {
              return engineError<{
                task: TaskRecord;
                autoCompleted?: string[];
                unblockedTasks?: Array<{ id: string; title: string }>;
              }>('E_LIFECYCLE_GATE_FAILED', msg, {
                exitCode: ExitCode.LIFECYCLE_GATE_FAILED,
                details: {
                  taskId,
                  parentEpicId: task.parentId,
                  epicStage,
                  requiredStages: ['implementation', 'validation', 'testing', 'release'],
                },
                fix:
                  `Advance the parent epic via 'cleo lifecycle complete ${task.parentId} ${epicStage}' ` +
                  `and then the next stages. Lifecycle advancement automatically updates the parent epic's pipelineStage (ADR-051 Decision 5).`,
              });
            }
            getLogger('engine:lifecycle').warn(
              { taskId, parentEpicId: task.parentId, epicStage, mode: lifecycleMode },
              `[ADVISORY] parent-epic lifecycle gate: ${msg}`,
            );
          }
        }
      }
    }

    // 4. T1222 / CLEO-VALID-26: verify verification_json is not NULL before delegating.
    if (lifecycleMode === 'strict') {
      const accessor = await getAccessor(projectRoot);
      const task = await accessor.loadSingleTask(taskId);
      if (task && task.type !== 'epic' && !task.verification) {
        return engineError<{
          task: TaskRecord;
          autoCompleted?: string[];
          unblockedTasks?: Array<{ id: string; title: string }>;
        }>(
          'E_EVIDENCE_MISSING',
          `Task ${taskId} has no verification record (verification_json IS NULL). ` +
            `Run 'cleo verify' with programmatic evidence before completing. See ADR-051.`,
          {
            details: { taskId, verificationStatus: 'null' },
            fix:
              `Initialize and populate verification gates: ` +
              `'cleo verify ${taskId} --gate implemented --evidence "commit:<sha>;files:<list>"' ` +
              `and other required gates, then retry 'cleo complete ${taskId}'.`,
          },
        );
      }
    }

    // No IVTR state, or lifecycle not strict, or already released — delegate normally.
    return taskComplete(projectRoot, taskId, notes);
  } catch (err: unknown) {
    const e = err as { message?: string };
    return engineError('E_INTERNAL', e?.message ?? 'Failed to complete task (strict mode)');
  }
}
