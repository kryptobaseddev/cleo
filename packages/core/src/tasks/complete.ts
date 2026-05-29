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
import {
  type AutoCompleteWorktreeResult,
  maybeAutoCompleteWorktreeForTask,
} from '../orchestrate/worktree-complete.js';
import { getProjectRoot, resolveOrCwd } from '../paths.js';
import { buildSagaAutoCloseEvidence, findSagasGroupingTask } from '../sagas/storage.js';
import { wrapWithAgentSession } from '../sessions/agent-session-adapter.js';
import { requireActiveSession } from '../sessions/session-enforcement.js';
import { trackBackgroundOp } from '../store/background-ops.js';
import type { DataAccessor, TransactionAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { getActiveSession } from '../store/session-store.js';
import {
  appendAcCoverageForceBypass,
  appendAcWaiverAudit,
  applyWaivers,
  computeAcCoverage,
  readOwnerOverride,
  resolveWaivers,
  type UnsatisfiedAc,
} from './ac-coverage-gate.js';
import { buildRollupEvidence, isCoordinationParent } from './coordination-parent.js';
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
  /**
   * Reason for overriding the `E_EPIC_HAS_PENDING_CHILDREN` guard.
   *
   * When provided, `cleo complete <epicId>` is allowed even if the epic still
   * has pending or active children. The override is audited to
   * `.cleo/audit/premature-close.jsonl` (ADR-051 pattern).
   *
   * @task T1632
   */
  overrideReason?: string;
  /**
   * Comma-separated AC tokens (UUIDs or `AC<n>` aliases) that the caller
   * waives from the AC-coverage gate (T10509). Each token MUST resolve to
   * an AC row on the task. The {@link waiveReason} is mandatory whenever
   * this field is set; supplying `waiveAc` without `waiveReason` is rejected
   * with `E_AC_COVERAGE_INCOMPLETE`.
   *
   * Waivers are recorded to `.cleo/audit/ac-waiver.jsonl` for forensic
   * traceability per ADR-079-r4 §4.
   *
   * @task T10509
   * @saga T10377 (SG-IVTR-AC-BINDING)
   */
  waiveAc?: string;
  /**
   * Justification text for the {@link waiveAc} waiver. Mandatory whenever
   * `waiveAc` is non-empty. Captured verbatim in the audit row.
   *
   * @task T10509
   */
  waiveReason?: string;
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
 * Resolve the absolute project root to write audit logs to. The gate
 * call site has `cwd` as an optional parameter; we re-use the same
 * canonical fallback the rest of `completeTask` uses ({@link getProjectRoot}).
 *
 * @internal
 * @task T10509
 */
function projectRootForGate(cwd: string | undefined): string {
  return cwd ?? getProjectRoot();
}

/**
 * Enforce the AC-coverage gate (T10509). Throws when:
 *   - Any AC has zero `evidence_ac_bindings` rows AND no override clears it.
 *   - `--waive-ac` was supplied without a non-empty `--waive-reason`.
 *
 * Override precedence (highest first):
 *   1. `CLEO_OWNER_OVERRIDE=1` + reason — full bypass; logged to
 *      `force-bypass.jsonl`; coverage check still runs so the audit row
 *      captures the offenders for post-mortem.
 *   2. `--waive-ac` + `--waive-reason` — per-AC waiver; logged to
 *      `ac-waiver.jsonl`; the residual unsatisfied set MUST be empty.
 *
 * The gate is a NO-OP for tasks with zero ACs.
 *
 * @internal
 * @task T10509
 */
type AcCoverageAccessor = Pick<DataAccessor, 'getAcRows' | 'getAcBindings'>;

async function enforceAcCoverageGate(
  options: CompleteTaskOptions,
  projectRoot: string,
  accessor: AcCoverageAccessor,
): Promise<void> {
  // 1. Validate `--waive-ac` arrives with a reason. Operators that pass
  //    `--waive-ac` alone get a hard rejection — the reason is the
  //    forensic anchor that justifies skipping the gate.
  const waiveCsv = options.waiveAc?.trim();
  if (waiveCsv !== undefined && waiveCsv.length > 0) {
    const reason = options.waiveReason?.trim() ?? '';
    if (reason.length === 0) {
      throw new CleoError(
        ExitCode.AC_COVERAGE_INCOMPLETE,
        '--waive-ac requires --waive-reason "<text>" — the reason is the audit anchor.',
        {
          fix: 'Re-run with --waive-reason "<justification>" (the reason is captured in .cleo/audit/ac-waiver.jsonl).',
          details: {
            field: 'waiveReason',
            codeName: 'E_AC_COVERAGE_INCOMPLETE',
            missingFlag: 'waiveReason',
          },
        },
      );
    }
  }

  // 2. Compute base coverage. Short-circuit on zero-AC tasks.
  const coverage = await computeAcCoverage(options.taskId, accessor as DataAccessor);
  if (coverage.ok) return;

  // 3. Owner-override path (highest precedence) — log the bypass with
  //    the FULL unsatisfied list so the audit row captures what was
  //    skipped. The bypass is recorded BEFORE returning so a process
  //    crash between audit + completion still leaves a forensic trail.
  const ownerReason = readOwnerOverride();
  if (ownerReason !== null) {
    await appendAcCoverageForceBypass(
      {
        kind: 'ac-coverage',
        timestamp: new Date().toISOString(),
        taskId: options.taskId,
        reason: ownerReason,
        actor: process.env['CLEO_AGENT_ID'] ?? 'cleo',
        unsatisfied: coverage.unsatisfied,
      },
      projectRoot,
    );
    return;
  }

  // 4. Waiver path — resolve the tokens against the task's AC rows,
  //    subtract the waived set from the unsatisfied list, AND require
  //    the residual to be empty. Partial waivers that leave any AC
  //    unaddressed are rejected — operators must either waive all
  //    offenders or provide programmatic evidence for the rest.
  let residual: UnsatisfiedAc[] = coverage.unsatisfied;
  let unresolvedTokens: string[] = [];
  if (waiveCsv !== undefined && waiveCsv.length > 0) {
    const acRows = await accessor.getAcRows(options.taskId);
    const resolved = resolveWaivers(waiveCsv, acRows);
    unresolvedTokens = resolved.unresolved;
    residual = applyWaivers(coverage.unsatisfied, new Set(resolved.acIds));

    // Write the audit row BEFORE deciding to fail or pass — even
    // partial waivers that get rejected MUST be recorded so a worker
    // cannot mask exploration of the gate.
    await appendAcWaiverAudit(
      {
        timestamp: new Date().toISOString(),
        taskId: options.taskId,
        waivedAcs: resolved.acIds,
        waivedAliases: resolved.aliases,
        reason: (options.waiveReason ?? '').trim(),
        actor: process.env['CLEO_AGENT_ID'] ?? 'cleo',
        unresolvedTokens,
      },
      projectRoot,
    );

    if (residual.length === 0 && unresolvedTokens.length === 0) return;
  }

  // 5. Gate fails — surface the structured error with the residual ACs
  //    AND any unresolved waiver tokens so the operator sees both
  //    classes of problem in one shot.
  const offenderList = residual.map((u) => `${u.alias} (${u.acId})`).join(', ');
  const unresolvedHint =
    unresolvedTokens.length > 0 ? ` Unresolved waive tokens: ${unresolvedTokens.join(', ')}.` : '';
  throw new CleoError(
    ExitCode.AC_COVERAGE_INCOMPLETE,
    `Task ${options.taskId} cannot complete — ${residual.length} acceptance criterion/criteria have no evidence bindings: ${offenderList}.${unresolvedHint}`,
    {
      fix:
        'Either (1) record evidence via `cleo verify <taskId> --gate … --evidence …` so a binding row is written, ' +
        '(2) pass `--waive-ac "<csv>" --waive-reason "<text>"` to record an audited waiver, or ' +
        '(3) set CLEO_OWNER_OVERRIDE=1 + CLEO_OWNER_OVERRIDE_REASON=<text> for a full bypass.',
      details: {
        field: 'acceptance',
        codeName: 'E_AC_COVERAGE_INCOMPLETE',
        unsatisfied: residual,
        unresolvedTokens,
      },
    },
  );
}

/**
 * Execute the task-completion critical section under the tasks DB write lock.
 *
 * The concrete SQLite accessor backs `transaction()` with `BEGIN IMMEDIATE` at
 * the outermost boundary, so the AC completion gate and status/autoclose writes
 * run in one atomic write transaction instead of validating on a stale read
 * snapshot and flipping `status='done'` later.
 *
 * @task T10595
 */
export async function withTaskWriteTransaction<T>(
  accessor: DataAccessor,
  fn: (tx: TransactionAccessor) => Promise<T>,
): Promise<T> {
  return accessor.transaction(fn);
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
  const acc = accessor ?? (await getTaskAccessor(cwd));
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
  // archived tasks are treated as satisfied (equivalent to done) — T1954
  if (task.depends?.length) {
    const deps = await acc.loadTasks(task.depends);
    const incompleteDeps = deps
      .filter((d) => d.status !== 'done' && d.status !== 'cancelled' && d.status !== 'archived')
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

  // ---- T1632: Premature-close guard (E_EPIC_HAS_PENDING_CHILDREN) ----
  // Prevent the T1467+T1603 bug class: reject direct `cleo complete <epicId>`
  // when any child is still pending or active.  --override-reason bypasses the
  // guard but ALWAYS appends an audit entry to .cleo/audit/premature-close.jsonl
  // so the decision is traceable.  This supersedes the legacy `noAutoComplete`
  // path which silently skipped the check — that field only suppresses
  // the *auto*-complete rollup (triggered by sibling completion), not a direct
  // `complete` call on the epic itself.
  const children = await acc.getChildren(options.taskId);
  const pendingChildren = children.filter((c) => c.status !== 'done' && c.status !== 'cancelled');
  if (pendingChildren.length > 0 && task.type === 'epic') {
    if (!options.overrideReason) {
      throw new CleoError(
        ExitCode.EPIC_HAS_PENDING_CHILDREN,
        `Epic ${options.taskId} has ${pendingChildren.length} pending/active children: ${pendingChildren.map((c) => c.id).join(', ')}`,
        {
          fix:
            `Complete all children first, or pass --override-reason "<reason>" to bypass ` +
            `(audited to .cleo/audit/premature-close.jsonl).`,
        },
      );
    }

    // Override supplied — audit the decision before proceeding.
    try {
      const { appendPrematureCloseAudit } = await import('./premature-close-audit.js');
      await appendPrematureCloseAudit(
        {
          epicId: options.taskId,
          pendingChildIds: pendingChildren.map((c) => c.id),
          overrideReason: options.overrideReason,
          timestamp: new Date().toISOString(),
          agent: process.env['CLEO_AGENT_ID'] ?? 'cleo',
        },
        cwd,
      );
    } catch (err) {
      // Audit write failure must not block the completion — warn only.
      console.warn(
        '[complete] failed to write premature-close audit:',
        err instanceof Error ? err.message : String(err),
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
      projectRoot: resolveOrCwd(cwd),
      label: `complete:${options.taskId}`,
    },
    async () =>
      withTaskWriteTransaction(acc, async (tx) => {
        // ---- T10509/T10595: AC-coverage gate (load-bearing IVTR closure) ----
        //
        // The coverage rows are read after BEGIN IMMEDIATE has acquired the
        // tasks DB write lock and before any status writes occur, so the gate
        // decision and status='done'/autoclose updates commit or roll back as
        // one atomic unit.
        //
        // ---- T10644: Auto-bind ACs when all verification gates are green ----
        // Workers often complete all 3 gates (implemented/testsPassed/qaPassed)
        // but skip the AC evidence binding step. When all gates are green, we
        // auto-create `coverage` bindings for any ACs lacking bindings so the
        // complete gate passes without manual SQL injection by the Prime.
        if (task.verification?.passed === true) {
          const acRows = await acc.getAcRows(options.taskId);
          if (acRows.length > 0) {
            const acIds = acRows.map((ac) => ac.id);
            const bindings = await acc.getAcBindings(acIds);
            const boundAcIds = new Set(bindings.map((b: any) => b.acId));
            const unbound = acRows.filter((ac) => !boundAcIds.has(ac.id));
            if (unbound.length > 0) {
              await tx.insertAcBindings(
                unbound.map((ac) => ({
                  id: `auto-coverage-${ac.id.slice(0, 8)}`,
                  evidenceAtomId: 'auto-coverage-verification-passed',
                  acId: ac.id,
                  bindingType: 'coverage' as const,
                })),
              );
            }
          }
        }

        await enforceAcCoverageGate(options, projectRootForGate(cwd), tx);

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
        // T1632: auto-complete fires only when ALL siblings are terminal AND
        // the epic's own verification evidence is satisfied (verifyEpicHasEvidence).
        // This closes the gap where an epic with no verification would silently
        // roll up to done just because its last child finished.
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
              // T1632: When enforcement is strict + verification enabled, only
              // auto-close if the epic's evidence gates are satisfied.
              // `verifyEpicHasEvidence` returns true when:
              //   (a) the epic has direct evidence atoms on any gate, OR
              //   (b) all non-cancelled children will be done+verified after this write.
              // For the rollup case the current task is not yet persisted, so we
              // must check condition (b) with the updated siblings view — treat the
              // current task as done+verified for this check.
              // When enforcement is off or advisory, skip the check (preserve existing
              // behaviour where any terminal-sibling rollup closes the epic).
              const needsEvidenceCheck =
                enforcement.verificationEnabled && enforcement.lifecycleMode === 'strict';

              const epicEvidencePassed = needsEvidenceCheck
                ? await verifyEpicHasEvidence(parent, {
                    ...acc,
                    getChildren: async (parentId: string) => {
                      if (parentId !== parent.id) return acc.getChildren(parentId);
                      // Overlay the current task as done+verified so the check sees the
                      // post-write state without a DB round-trip.
                      return siblings.map((c) => {
                        if (c.id !== task.id) return c;
                        return {
                          ...c,
                          status: 'done' as const,
                          verification: c.verification ?? task.verification ?? undefined,
                        };
                      });
                    },
                  } as typeof acc)
                : true;

              if (epicEvidencePassed) {
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
        }

        // T9040: Coordination parent auto-rollup.
        //
        // A "coordination parent" is a non-epic task (type='task'|'subtask') that
        // has NO own implementation files — its scope was fully delivered by its
        // children. When the last pending child completes, synthesize rollup
        // verification evidence from the children's gate state and auto-complete
        // the parent so it does not stay `pending` forever.
        //
        // Epics already have their own rollup path above (via verifyEpicHasEvidence).
        // This branch handles the remaining `type!='epic'` case.
        //
        // The rollup fires only when ALL siblings (excluding the current task, which
        // is not yet persisted as 'done') are terminal (done or cancelled).
        if (task.parentId) {
          const coordinationParent = await acc.loadSingleTask(task.parentId);
          if (
            coordinationParent &&
            coordinationParent.type !== 'epic' &&
            coordinationParent.type !== 'saga' &&
            !autoCompleted.includes(coordinationParent.id)
          ) {
            const cpChildren = await acc.getChildren(coordinationParent.id);
            // Guard: require at least one registered child and check isCoordinationParent
            // before examining terminal status so we don't touch tasks with own files.
            if (
              cpChildren.length > 0 &&
              isCoordinationParent(coordinationParent, cpChildren.length)
            ) {
              const allCpDone = cpChildren.every(
                (c) => c.id === task.id || c.status === 'done' || c.status === 'cancelled',
              );
              if (allCpDone) {
                // Synthesize verification evidence from children's gate state.
                // The overlay adds the current task (not yet in DB) as done so
                // buildRollupEvidence sees the post-write view.
                const childrenForRollup: Task[] = cpChildren.map((c) =>
                  c.id === task.id ? { ...c, status: 'done' as const } : c,
                );
                coordinationParent.verification = buildRollupEvidence(
                  coordinationParent.id,
                  childrenForRollup,
                );
                coordinationParent.status = 'done';
                coordinationParent.completedAt = now;
                coordinationParent.updatedAt = now;
                // T871: coordination parents that auto-complete must also reach a
                // terminal pipelineStage to stay in sync with Studio/dashboards.
                if (!isTerminalPipelineStage(coordinationParent.pipelineStage)) {
                  coordinationParent.pipelineStage = 'contribution';
                }
                autoCompleted.push(coordinationParent.id);
                autoCompletedTasks.push(coordinationParent);
              }
            }
          }
        }

        // T10116 + T10425: Saga auto-close (mirrors epic auto-close lines ~480-541).
        //
        // Sagas link to their member Epics via canonical `parentId` containment:
        // member Epics carry `parentId=<sagaId>`, and Sagas are `type='saga'`.
        //
        // The existing epic + coordination-parent branches above only walk the
        // `parentId` column, so a saga whose member just completed would stay
        // `pending` forever — the T10090 drift bug class (T9787, T9800,
        // T9831 all manifested this way). T10425 (Saga T10326 L1) added the
        // new-shape + Epic→Task→Subtask regression coverage that pins this
        // branch.
        //
        // This branch fires whenever the completing task is a member of one
        // or more sagas. For each saga that groups this task:
        //   1. Skip if the saga is already terminal (idempotency).
        //   2. Skip if we have already queued it on this `completeTask` call.
        //   3. Resolve member IDs via `parentId=<sagaId>`.
        //   4. Auto-close only when EVERY non-cancelled member is terminal
        //      (`done` or `cancelled`), treating the current task as `done`
        //      because its DB write happens immediately after this branch.
        //   5. Synthesize a verification envelope citing the closing event,
        //      the member rollup digest, and ADR-073 §1.2 / ADR-083 §2.6 (AC4).
        //
        // The saga loop runs after the coordination-parent branch so a task
        // that is BOTH a coordination-parent child AND a saga member rolls
        // both up in a single call. Each saga is appended to the same
        // `autoCompletedTasks` list so the transaction below upserts every
        // synthesized close in one commit.
        const sagasGroupingThisTask = await findSagasGroupingTask(acc, task.id);
        for (const saga of sagasGroupingThisTask) {
          if (saga.status === 'done' || saga.status === 'cancelled') continue;
          if (autoCompleted.includes(saga.id)) continue;

          const memberResult = await acc.queryTasks({ parentId: saga.id });
          const memberTasks = memberResult.tasks;
          const memberIds = memberTasks.map((member) => member.id);
          if (memberIds.length === 0) continue;

          // Overlay the current task as `done` so the rollup check sees the
          // post-write state without a DB round-trip — same approach used by
          // the epic auto-close branch above.
          const allMembersTerminal = memberTasks.every((m) => {
            if (m.id === task.id) return true;
            return m.status === 'done' || m.status === 'cancelled';
          });
          if (!allMembersTerminal) continue;

          // Synthesize evidence + flip the saga to terminal. The saga write
          // joins `autoCompletedTasks` so the transaction below upserts it
          // alongside the current task and any epic / coordination-parent
          // that also rolled up.
          const terminalMemberIds = memberTasks
            .filter((m) => m.id === task.id || m.status === 'done' || m.status === 'cancelled')
            .map((m) => m.id);
          saga.verification = buildSagaAutoCloseEvidence(saga.id, terminalMemberIds, now);
          saga.status = 'done';
          saga.completedAt = now;
          saga.updatedAt = now;
          // T871: keep `pipelineStage` aligned with `status='done'`.
          if (!isTerminalPipelineStage(saga.pipelineStage)) {
            saga.pipelineStage = 'contribution';
          }
          autoCompleted.push(saga.id);
          autoCompletedTasks.push(saga);
        }

        // Writes join the BEGIN IMMEDIATE transaction opened by
        // withTaskWriteTransaction above, keeping the gate decision and status
        // changes atomic (T10595).
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

        // llmtxt tracks `documentIds` when contribute() returns a shape
        // matching `{ documentId?: string }`. CLEO tasks are not llmtxt
        // documents, so we return an empty object here — eventCount still
        // ticks to 1 on success, which is the signal the receipt needs.
        return {};
      }),
  );

  // Compute newly unblocked tasks: dependents whose deps are now all satisfied
  // archived tasks are treated as satisfied (equivalent to done) — T1954
  const dependents = await acc.getDependents(options.taskId);
  const unblockedTasks: Array<Pick<TaskRef, 'id' | 'title'>> = [];
  for (const dep of dependents) {
    if (dep.status === 'done' || dep.status === 'cancelled' || dep.status === 'archived') continue;
    if (dep.depends?.length) {
      const depDeps = await acc.loadTasks(dep.depends);
      const stillUnresolved = depDeps.filter(
        (d) =>
          d.id !== options.taskId &&
          d.status !== 'done' &&
          d.status !== 'cancelled' &&
          d.status !== 'archived',
      );
      if (stillUnresolved.length === 0) {
        unblockedTasks.push({ id: dep.id, title: dep.title });
      }
    } else {
      unblockedTasks.push({ id: dep.id, title: dep.title });
    }
  }

  // T9175: Worktree integration MUST happen before teardown — merge first,
  // then prune. The previous `teardownWorktree` call destroyed the worktree
  // before any merge ran, leaving the worker's commits stranded on
  // `task/<id>` with no operator-visible integration.
  //
  // `completeAgentWorktreeIntegration` performs (ADR-062):
  //   1. rebase inside the worktree onto the project's default branch
  //   2. `git checkout <default>` + `git merge --no-ff task/<id>`
  //   3. prune the worktree dir + delete the branch
  //   4. append an audit entry to .cleo/audit/worktree-integration.jsonl
  //
  // On failure (rebase conflict, missing branch, non-git dir, etc.) the
  // worktree + branch are PRESERVED so the operator can recover via
  // `cleo orchestrate worktree-complete <id>`. Completion is never blocked
  // — the verified evidence already proved the work shipped; recovery is
  // operator-driven.
  try {
    const { completeAgentWorktreeIntegration } = await import('../spawn/branch-lock.js');
    const integration = completeAgentWorktreeIntegration(options.taskId, projectRoot, {
      taskTitle: task.title,
    });
    if (!integration.merged && integration.error) {
      getLogger('tasks:complete').warn(
        {
          taskId: options.taskId,
          mergeError: integration.error,
          worktreeRemoved: integration.worktreeRemoved,
        },
        '[T9175] worktree integration failed — branch + worktree preserved for manual recovery',
      );
    }
  } catch (err) {
    getLogger('tasks:complete').debug(
      { err: err instanceof Error ? err.message : String(err) },
      '[T9175] worktree integration helper unavailable — skipping',
    );
  }

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
  // Tracked (T10490) so the test harness can flush it before tearing down the
  // shared SQLite singleton; production still runs it fully detached.
  trackBackgroundOp(
    import('../memory/graph-auto-populate.js')
      .then(({ upsertGraphNode, addGraphEdge }) =>
        (async () => {
          const projectRoot = resolveOrCwd(cwd);
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
      }),
  );

  // Dispatch PostToolUse hook — triggers observer, quality feedback, and memory bridge refresh.
  // This is the missing link between "task completed" and "brain processes it" (T555).
  try {
    const { hooks } = await import('../hooks/registry.js');
    await hooks
      .dispatch('PostToolUse', resolveOrCwd(cwd), {
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
  /**
   * T9548 — Auto-invoke worktree-complete diagnostic envelope.
   *
   * Populated when `cleo complete <taskId>` runs and the auto-invoke hook
   * either runs the worktree-integration SDK or short-circuits (no worktree
   * exists, `CLEO_NO_AUTO_WORKTREE_COMPLETE=1`, or SDK threw). Absent when
   * task completion itself failed (no auto-merge is attempted on failure).
   *
   * @task T9548
   */
  worktreeAutoComplete?: AutoCompleteWorktreeResult;
}>;

/**
 * Options forwarded through the EngineResult-returning wrappers.
 *
 * These mirror the fields in {@link CompleteTaskOptions} that need to flow
 * from CLI → dispatch domain → core. Adding them here keeps the two layers
 * in sync without requiring a breaking change to the public `CompleteTaskOptions`
 * interface.
 *
 * @task T1632
 */
export interface TaskCompleteEngineOptions {
  /** Completion notes. */
  notes?: string;
  /**
   * Reason for overriding the `E_EPIC_HAS_PENDING_CHILDREN` guard.
   * @see CompleteTaskOptions.overrideReason
   */
  overrideReason?: string;
  /** Reason for acknowledging CRITICAL nexus impact risk. */
  acknowledgeRisk?: string;
  /**
   * Comma-separated AC tokens (UUIDs or `AC<n>` aliases) waived from the
   * AC-coverage gate. {@link waiveReason} is mandatory whenever this is set.
   * @see CompleteTaskOptions.waiveAc
   * @task T10509
   */
  waiveAc?: string;
  /**
   * Justification text for the {@link waiveAc} waiver.
   * @see CompleteTaskOptions.waiveReason
   * @task T10509
   */
  waiveReason?: string;
}

/**
 * Complete a task (set status to done), wrapped in EngineResult.
 *
 * Stamps modified_by + session_id provenance on successful completion
 * (T1222 / CLEO-VALID-27).
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to complete
 * @param notesOrOptions - Completion notes (string, legacy) OR an options object
 * @returns EngineResult with the completed task, auto-completed parents, and unblocked tasks
 *
 * @task T1568
 * @task T1632
 * @epic T1566
 */
export async function taskComplete(
  projectRoot: string,
  taskId: string,
  notesOrOptions?: string | TaskCompleteEngineOptions,
): Promise<CompleteEngineResult> {
  const opts: TaskCompleteEngineOptions =
    typeof notesOrOptions === 'string' ? { notes: notesOrOptions } : (notesOrOptions ?? {});
  try {
    const accessor = await getTaskAccessor(projectRoot);
    const result = await completeTask(
      {
        taskId,
        notes: opts.notes,
        overrideReason: opts.overrideReason,
        acknowledgeRisk: opts.acknowledgeRisk,
        waiveAc: opts.waiveAc,
        waiveReason: opts.waiveReason,
      },
      projectRoot,
      accessor,
    );

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

    // T9548 — auto-invoke worktree-complete after a successful completion.
    //
    // The wrapper is best-effort and idempotent:
    //  - Skips when CLEO_NO_AUTO_WORKTREE_COMPLETE=1 is set.
    //  - Skips when no CLEO worktree exists for the task.
    //  - Re-running on an already-integrated worktree returns outcome='noop'
    //    courtesy of the audit-log idempotency check inside the SDK.
    //  - Throws are caught and surfaced as outcome='sdk-threw' — they never
    //    derail the task completion (which has already landed in the DB).
    //
    // Audit-log entries are written ONLY by the inner SDK and ONLY when a
    // real lifecycle event occurs. The env-disabled and no-worktree paths
    // are pure no-ops with no on-disk side effects.
    const worktreeAutoComplete: AutoCompleteWorktreeResult = maybeAutoCompleteWorktreeForTask(
      taskId,
      projectRoot,
    );

    return engineSuccess({
      task: result.task as TaskRecord,
      ...(result.autoCompleted && { autoCompleted: result.autoCompleted }),
      ...(result.unblockedTasks && { unblockedTasks: result.unblockedTasks }),
      worktreeAutoComplete,
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
 * @param notesOrOptions - Completion notes (string, legacy) OR an options object
 * @returns EngineResult with the completed task, auto-completed parents, and unblocked tasks
 *
 * @task T1568
 * @task T1632
 * @adr ADR-051
 * @epic T1566
 */
export async function completeTaskStrict(
  projectRoot: string,
  taskId: string,
  notesOrOptions?: string | TaskCompleteEngineOptions,
): Promise<CompleteEngineResult> {
  const opts: TaskCompleteEngineOptions =
    typeof notesOrOptions === 'string' ? { notes: notesOrOptions } : (notesOrOptions ?? {});
  try {
    const config = await loadConfig(projectRoot);
    const lifecycleMode = config.lifecycle?.mode ?? 'strict';

    // 1. Evidence staleness re-check (T832 / ADR-051 Decision 8).
    if (lifecycleMode === 'strict') {
      const accessor = await getTaskAccessor(projectRoot);
      const task = await accessor.loadSingleTask(taskId);
      if (task?.verification?.evidence) {
        const evidenceEntries = Object.entries(task.verification.evidence);
        const staleGates: Array<{ gate: string; failures: string[] }> = [];
        for (const [gate, ev] of evidenceEntries) {
          if (!ev) continue;
          // T9245: pass gate so revalidate can enforce the
          // critical-gate override-rejection rule.
          const check = await revalidateEvidence(ev, projectRoot, gate as VerificationGate);
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
      const accessor = await getTaskAccessor(projectRoot);
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
      const accessor = await getTaskAccessor(projectRoot);
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
    return taskComplete(projectRoot, taskId, opts);
  } catch (err: unknown) {
    const e = err as { message?: string };
    return engineError('E_INTERNAL', e?.message ?? 'Failed to complete task (strict mode)');
  }
}
