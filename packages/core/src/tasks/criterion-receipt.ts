/**
 * Per-criterion receipt — bind a decision or a stored document to ONE
 * acceptance criterion that names no code path (T14199).
 *
 * ## Why this exists
 *
 * The owner override audit (T14041, doc `owner-override-audit`, class A)
 * found criteria waived on code tasks that were really met by an owner
 * decision, a design note or a filing. A code task's gates take no
 * `decision:` and no document-only `files:`, so the only way to cover such a
 * criterion was to waive it. A receipt covers it honestly instead.
 *
 * ## The guardrail
 *
 * - A receipt writes ONE `evidence_ac_bindings` row for ONE criterion of the
 *   task, and an audit-log entry. It never touches `verification`: the
 *   `implemented`, `testsPassed` and `qaPassed` gates still owe their own
 *   code evidence.
 * - A criterion that names a code path (the T14065 token rule,
 *   {@link criterionCodePaths}) is refused, naming the token: code proves it.
 * - Only `text` criteria take a receipt; child-task and evidence-bound
 *   criteria have their own proof.
 *
 * @task T14199
 */

import { randomUUID } from 'node:crypto';
import type { EvidenceAtom, TaskVerification } from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { type ParsedAtom, parseEvidence, validateAtom } from './evidence.js';
import { isDocumentEvidencePath } from './gate-notes.js';
import { criterionCodePaths } from './verification-policy.js';

/** `tasks_audit_log.action` recorded for every per-criterion receipt. */
export const CRITERION_RECEIPT_ACTION = 'criterion.receipt';

/** Input of {@link recordCriterionReceipt}. */
export interface CriterionReceiptParams {
  /** The task whose criterion the receipt covers. */
  taskId: string;
  /** One `satisfies:<taskId>#AC<n>` plus `decision:<id>` and/or stored-document `files:` atoms. */
  evidence: string;
  /** Who recorded it, for the audit log. */
  agent?: string;
}

/** Result of a recorded receipt. */
export interface CriterionReceiptResult {
  /** The task whose criterion is covered. */
  taskId: string;
  /** The criterion's alias, e.g. `AC2`. */
  criterion: string;
  /** The criterion's canonical id. */
  acId: string;
  /** The binding's evidence atom id: `receipt:<records>-><taskId>#AC<n>`. */
  evidenceAtomId: string;
  /** The task's gates, unchanged by the receipt. */
  gates: TaskVerification['gates'];
}

/** The receipt's record atoms, as they appear in its binding id. */
function recordLabel(records: readonly ParsedAtom[]): string {
  return records
    .map((atom) =>
      atom.kind === 'decision'
        ? `decision:${atom.decisionId}`
        : atom.kind === 'files'
          ? `files:${atom.paths.join(',')}`
          : atom.kind,
    )
    .join('+');
}

/**
 * Record a per-criterion receipt: bind a `decision:` or a stored-document
 * `files:` atom to one criterion of the task, covering only that criterion
 * in the AC-coverage gate. The task's gates are left exactly as they were.
 *
 * @param projectRoot - Absolute project root.
 * @param params - The task, the evidence string and the recording agent.
 * @returns The binding, or the refusal naming why.
 * @task T14199
 */
export async function recordCriterionReceipt(
  projectRoot: string,
  params: CriterionReceiptParams,
): Promise<EngineResult<CriterionReceiptResult>> {
  const { taskId } = params;
  const fix = `cleo verify ${taskId} --criterion --evidence 'decision:<id>;satisfies:${taskId}#AC<n>'`;
  const accessor = await getTaskAccessor(projectRoot);
  const task = await accessor.loadSingleTask(taskId);
  // @sync-invariant none:input-shape an unknown task is refused before any write
  if (!task) return engineError('E_NOT_FOUND', `Task ${taskId} not found`);
  if (task.status === 'done')
    // @sync-invariant none:input-shape a done task takes no new evidence (ADR-051 §11.1); nothing is written
    return engineError(
      'E_ALREADY_DONE',
      `Task ${taskId} is already done — a receipt cannot be added to a completed task (ADR-051 §11.1)`,
    );

  let atoms: ParsedAtom[];
  try {
    atoms = parseEvidence(params.evidence).atoms;
  } catch (err) {
    // @sync-invariant none:input-shape an unparseable evidence string is refused before any write
    if (err instanceof CleoError) return engineError('E_VALIDATION', err.message, { fix });
    throw err;
  }
  const targets = atoms.filter((atom) => atom.kind === 'satisfies');
  const records = atoms.filter((atom) => atom.kind === 'decision' || atom.kind === 'files');
  const other = atoms.find(
    (atom) => atom.kind !== 'satisfies' && atom.kind !== 'decision' && atom.kind !== 'files',
  );
  const target = targets[0];
  if (other || targets.length !== 1 || target?.kind !== 'satisfies' || records.length === 0)
    // @sync-invariant none:input-shape a receipt's atom set is checked before any write
    return engineError(
      'E_EVIDENCE_INVALID',
      `a criterion receipt takes exactly one satisfies:${taskId}#AC<n> and a decision:<id> or a ` +
        `files: atom naming stored documents${other ? `; ${other.kind}: is not one of them` : ''}. ` +
        'Gate evidence goes to cleo verify --gate.',
      { fix },
    );
  if (target.targetTaskId !== taskId)
    // @sync-invariant none:input-shape a receipt binds only the task's own criterion; nothing is written
    return engineError(
      'E_EVIDENCE_INVALID',
      `a receipt on ${taskId} covers one of ${taskId}'s own criteria, not ${target.targetTaskId}'s`,
      { fix },
    );
  const codeFile = records
    .flatMap((atom) => (atom.kind === 'files' ? atom.paths : []))
    .find((path) => !isDocumentEvidencePath(path));
  if (codeFile !== undefined)
    // @sync-invariant none:input-shape a non-document file is refused before any write
    return engineError(
      'E_EVIDENCE_INVALID',
      `files: ${codeFile} is not a stored document. A receipt takes documents only; code evidence ` +
        `proves the gates (cleo verify ${taskId} --gate implemented --evidence ...).`,
      { fix },
    );

  const resolved = await validateAtom(target, projectRoot, taskId);
  // @sync-invariant none:input-shape a criterion that does not resolve is refused before any write
  if (!resolved.ok) return engineError(resolved.codeName, resolved.reason, { fix });
  const acId = resolved.atom.kind === 'satisfies' ? resolved.atom.resolvedAcUuid : undefined;
  const row = (await accessor.getAcRows(taskId)).find((r) => r.id === acId);
  if (!row)
    // @sync-invariant none:input-shape a criterion missing from the task is refused before any write
    return engineError('E_AC_BINDING_TARGET_AC_NOT_FOUND', `${taskId} has no such criterion`, {
      fix,
    });
  const criterion = `AC${row.ordinal}`;
  if (row.kind !== 'text')
    // @sync-invariant none:input-shape child-task and evidence-bound criteria carry their own proof; nothing is written
    return engineError(
      'E_CRITERION_RECEIPT_REFUSED',
      `${taskId} ${criterion} is a ${row.kind} criterion with its own proof; a receipt covers only a text criterion`,
    );
  const codePath = criterionCodePaths(row.text)[0];
  if (codePath !== undefined)
    // @sync-invariant none:input-shape a criterion naming code is refused before any write (T14065 token rule)
    return engineError(
      'E_CRITERION_NAMES_CODE',
      `${taskId} ${criterion} names the code path ${codePath} (the T14065 token rule), so code evidence ` +
        'proves it and a decision or document receipt cannot.',
      {
        fix: `cleo verify ${taskId} --gate implemented --evidence '<commit or pr>;files:<changed paths>;satisfies:${taskId}#${criterion}'`,
      },
    );

  const validated: EvidenceAtom[] = [];
  for (const record of records) {
    const result = await validateAtom(record, projectRoot, taskId);
    // @sync-invariant none:input-shape an unproven decision or document is refused before any write
    if (!result.ok) return engineError(result.codeName, result.reason, { fix });
    validated.push(result.atom);
  }

  const evidenceAtomId = `receipt:${recordLabel(records)}->${taskId}#${criterion}`;
  await accessor.transaction(async (tx) => {
    await tx.insertAcBindings([
      { id: randomUUID(), evidenceAtomId, acId: row.id, bindingType: 'satisfies' },
    ]);
    await tx.appendLog({
      action: CRITERION_RECEIPT_ACTION,
      taskId,
      actor: params.agent ?? 'unknown',
      details: { criterion, acId: row.id, evidenceAtomId, atoms: validated },
    });
  });
  return engineSuccess({
    taskId,
    criterion,
    acId: row.id,
    evidenceAtomId,
    gates: { ...(task.verification?.gates ?? {}) },
  });
}
