/**
 * Acceptance-criteria immutability guard.
 *
 * Locks `task.acceptance` once a task enters the implementation pipeline
 * stage (or any later stage). Prevents the "T-THIN-WRAPPER feature-complete"
 * anti-pattern where acceptance criteria are silently reframed after work
 * has shipped to match what was actually built.
 *
 * The lock can be overridden by supplying an explicit operator `reason`,
 * which is appended to an append-only audit log at
 * `.cleo/audit/ac-changes.jsonl` together with the before/after AC, the
 * stage at which the override occurred, the timestamp and the agent
 * identifier.
 *
 * Locked stages: implementation, validation, testing, release, contribution.
 *
 * @epic T1586 Foundation Lockdown (Wave A)
 * @task T1590
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type AcceptanceItem, ExitCode, type Task } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/**
 * Pipeline stages at which acceptance criteria are considered locked.
 *
 * Once a task crosses into `implementation`, AC are treated as a binding
 * contract — any subsequent change must be operator-approved with a
 * written reason that is captured in the audit log.
 *
 * @task T1590
 */
export const AC_LOCKED_STAGES: ReadonlySet<string> = new Set([
  'implementation',
  'validation',
  'testing',
  'release',
  'contribution',
]);

/** Relative path within project root for the AC-changes audit log. */
export const AC_CHANGES_AUDIT_FILE = '.cleo/audit/ac-changes.jsonl';

/**
 * One line of the AC-changes audit log.
 *
 * Each successful override of the immutability guard appends exactly one
 * record. The file is append-only — readers MUST treat the JSONL stream
 * as the canonical history.
 *
 * @task T1590
 */
export interface AcceptanceChangeAuditEntry {
  /** ISO-8601 timestamp at which the override was recorded. */
  timestamp: string;
  /** Task whose acceptance criteria were modified. */
  taskId: string;
  /** Pipeline stage of the task at the moment of override. */
  stage: string;
  /** Operator-supplied free-text justification (required, non-empty). */
  reason: string;
  /** Acceptance criteria before the update (deep-copied snapshot). */
  oldAcceptance: AcceptanceItem[];
  /** Acceptance criteria after the update (deep-copied snapshot). */
  newAcceptance: AcceptanceItem[];
  /**
   * Identity of the agent performing the override, sourced from
   * `CLEO_AGENT_ID` and falling back to `"cleo"` when unset.
   */
  agent: string;
}

/**
 * Check whether a task's pipeline stage locks acceptance-criteria changes.
 *
 * @param stage - Current pipeline stage of the task (may be null/undefined).
 * @returns True if the stage is in {@link AC_LOCKED_STAGES}.
 *
 * @example
 * ```ts
 * isAcceptanceLocked('research');       // => false
 * isAcceptanceLocked('implementation'); // => true
 * ```
 *
 * @task T1590
 */
export function isAcceptanceLocked(stage: string | null | undefined): boolean {
  return !!stage && AC_LOCKED_STAGES.has(stage);
}

/**
 * Determine whether two acceptance-criteria arrays are structurally equal.
 *
 * Used to suppress the lock when the caller passes an unchanged AC payload
 * (a no-op should never trip the immutability guard).
 *
 * @param a - First criteria array (or null/undefined).
 * @param b - Second criteria array (or null/undefined).
 * @returns True if both arrays have identical length and elements.
 *
 * @task T1590
 */
export function acceptanceEquals(
  a: AcceptanceItem[] | null | undefined,
  b: AcceptanceItem[] | null | undefined,
): boolean {
  const aArr = a ?? [];
  const bArr = b ?? [];
  if (aArr.length !== bArr.length) return false;
  for (let i = 0; i < aArr.length; i++) {
    const left = aArr[i];
    const right = bArr[i];
    if (typeof left === 'string' && typeof right === 'string') {
      if (left !== right) return false;
      continue;
    }
    if (JSON.stringify(left) !== JSON.stringify(right)) return false;
  }
  return true;
}

/**
 * Inputs to {@link enforceAcceptanceImmutability}.
 *
 * @task T1590
 */
export interface EnforceAcceptanceImmutabilityOptions {
  /** Task being mutated; only `id`, `pipelineStage` and `acceptance` are read. */
  task: Pick<Task, 'id' | 'pipelineStage' | 'acceptance'>;
  /** New acceptance payload supplied by the caller (undefined → no AC change). */
  newAcceptance: AcceptanceItem[] | undefined;
  /** Operator-supplied override reason (undefined → no override requested). */
  reason: string | undefined;
  /** Project root used to locate the audit log directory. */
  projectRoot?: string | undefined;
}

/**
 * Enforce the AC-immutability guard for a task update.
 *
 * Behaviour:
 *  - When `newAcceptance` is `undefined`, the call is a no-op.
 *  - When the task is not in a locked stage, the call is a no-op.
 *  - When the new AC is structurally identical to the existing AC, the call
 *    is a no-op (idempotent updates are always allowed).
 *  - When the task is in a locked stage and `reason` is missing or empty,
 *    a {@link CleoError} with {@link ExitCode.AC_LOCKED} is thrown.
 *  - When the task is in a locked stage and `reason` is provided, an audit
 *    entry is appended to `.cleo/audit/ac-changes.jsonl`.
 *
 * @param options - {@link EnforceAcceptanceImmutabilityOptions}.
 * @throws CleoError(AC_LOCKED) when the AC are locked and no reason is given.
 *
 * @example
 * ```ts
 * enforceAcceptanceImmutability({
 *   task,
 *   newAcceptance: ['AC1', 'AC2', 'AC3'],
 *   reason: 'operator approved scope expansion',
 *   projectRoot: '/project',
 * });
 * ```
 *
 * @task T1590
 */
export function enforceAcceptanceImmutability(options: EnforceAcceptanceImmutabilityOptions): void {
  const { task, newAcceptance, reason, projectRoot } = options;

  // No AC change → guard does not apply.
  if (newAcceptance === undefined) return;

  // Task is not in a locked stage → guard does not apply.
  if (!isAcceptanceLocked(task.pipelineStage)) return;

  // Idempotent payload → no-op even when locked.
  if (acceptanceEquals(task.acceptance, newAcceptance)) return;

  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!trimmedReason) {
    throw new CleoError(
      ExitCode.AC_LOCKED,
      `Acceptance criteria locked at stage ${task.pipelineStage}. Reframing AC after implementation is anti-pattern. Use --reason '<X>' to override with audit log entry.`,
      {
        fix: `cleo update ${task.id} --acceptance "..." --reason "<why this change is acceptable>"`,
        details: {
          field: 'acceptance',
          stage: task.pipelineStage ?? null,
          taskId: task.id,
        },
      },
    );
  }

  // Override path: append audit entry.
  appendAcceptanceChangeAudit({
    projectRoot: projectRoot ?? process.cwd(),
    taskId: task.id,
    stage: task.pipelineStage ?? '',
    reason: trimmedReason,
    oldAcceptance: task.acceptance ?? [],
    newAcceptance,
  });
}

/**
 * Append a single {@link AcceptanceChangeAuditEntry} to
 * `.cleo/audit/ac-changes.jsonl`.
 *
 * Errors are deliberately swallowed (best-effort write) so audit failures
 * never block a legitimate operator-approved update. The path mirrors
 * `force-bypass.jsonl` and `contract-violations.jsonl` (ADR-039).
 *
 * @task T1590
 */
function appendAcceptanceChangeAudit(input: {
  projectRoot: string;
  taskId: string;
  stage: string;
  reason: string;
  oldAcceptance: AcceptanceItem[];
  newAcceptance: AcceptanceItem[];
}): void {
  try {
    const filePath = join(input.projectRoot, AC_CHANGES_AUDIT_FILE);
    mkdirSync(dirname(filePath), { recursive: true });
    const entry: AcceptanceChangeAuditEntry = {
      timestamp: new Date().toISOString(),
      taskId: input.taskId,
      stage: input.stage,
      reason: input.reason,
      // Deep-copy AC arrays so later mutation of the source object cannot
      // retroactively rewrite the audit record.
      oldAcceptance: JSON.parse(JSON.stringify(input.oldAcceptance)) as AcceptanceItem[],
      newAcceptance: JSON.parse(JSON.stringify(input.newAcceptance)) as AcceptanceItem[],
      agent: process.env['CLEO_AGENT_ID'] ?? 'cleo',
    };
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' });
  } catch {
    // non-fatal — audit writes must never block the operation
  }
}
