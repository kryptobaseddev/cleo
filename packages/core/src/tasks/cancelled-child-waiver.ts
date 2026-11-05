/**
 * The one cancelled-child waiver guard `cleo complete` and `cleo done` share
 * (T14266, T14223).
 *
 * A cancelled child is settled (no work remains) but its work was not
 * delivered, so a parent may close over it only with an audited
 * `--waive-cancelled-children "<reason>"` (T10538, PM-Core V2 design-point 4).
 * Both verbs ask this module the same question with the same flag: `complete`
 * throws the refusal, the `done` plan turns it into a blocker, and `done`
 * then completes through `complete`, which records the waiver audit.
 *
 * @task T14266
 * @task T14223
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';

/** The verb a waiver decision is made for; it names the command in the fix. */
export type CancelledChildWaiverVerb = 'complete' | 'done';

/** The outcome of {@link decideCancelledChildWaiver}. */
export interface CancelledChildWaiverDecision {
  /** Ids of the parent's cancelled children. */
  readonly cancelledChildIds: readonly string[];
  /** True when no cancelled child blocks completion (none exist, or a waiver covers them). */
  readonly allowed: boolean;
  /** The trimmed waiver reason when one was given and is needed. */
  readonly waiverReason?: string;
  /** Why completion is refused, when it is. */
  readonly message?: string;
  /** The command that resolves the refusal, when it is refused. */
  readonly fix?: string;
}

/**
 * Decide whether a parent may complete over its cancelled children.
 *
 * @param parentId - The parent being completed.
 * @param children - The parent's direct children.
 * @param waiverReason - The `--waive-cancelled-children` reason, if given.
 * @param verb - The command asking, for the fix text.
 * @returns The decision; `allowed` is false only when cancelled children exist and no reason was given.
 */
export function decideCancelledChildWaiver(
  parentId: string,
  children: ReadonlyArray<{ id: string; status: string }>,
  waiverReason: string | undefined,
  verb: CancelledChildWaiverVerb,
): CancelledChildWaiverDecision {
  const cancelledChildIds = children.filter((c) => c.status === 'cancelled').map((c) => c.id);
  if (cancelledChildIds.length === 0) return { cancelledChildIds, allowed: true };
  const reason = waiverReason?.trim();
  if (reason) return { cancelledChildIds, allowed: true, waiverReason: reason };
  const n = cancelledChildIds.length;
  return {
    cancelledChildIds,
    allowed: false,
    message:
      `Task ${parentId} has ${n} cancelled child${n === 1 ? '' : 'ren'} that must be waived or ` +
      `replaced before completion: ${cancelledChildIds.join(', ')}. Pass ` +
      `--waive-cancelled-children "<reason>" (audited) or replace the work with a done child.`,
    fix:
      `Cancelled children represent work that was NOT done; they cannot silently satisfy ` +
      `parent completion. Re-open and finish the work, replace it with a done child, or ` +
      `record an audited waiver: 'cleo ${verb} ${parentId} --waive-cancelled-children "<reason>"' ` +
      `(cite the replacement task id in the reason when applicable; audited to ` +
      `.cleo/audit/cancelled-child-waiver.jsonl).`,
  };
}

/**
 * Refuse completion with {@link ExitCode.CANCELLED_CHILD_NO_WAIVER} unless the
 * cancelled children are waived, and record the waiver audit when they are.
 *
 * @param parentId - The parent being completed.
 * @param children - The parent's direct children.
 * @param waiverReason - The `--waive-cancelled-children` reason, if given.
 * @param cwd - Project root for the audit file.
 * @throws {CleoError} When cancelled children exist and no waiver reason was given.
 */
export async function assertCancelledChildrenWaived(
  parentId: string,
  children: ReadonlyArray<{ id: string; status: string }>,
  waiverReason: string | undefined,
  cwd: string | undefined,
): Promise<void> {
  const decision = decideCancelledChildWaiver(parentId, children, waiverReason, 'complete');
  if (!decision.allowed) {
    // @sync-invariant none:input-shape an un-waived cancelled child refuses completion before any write
    throw new CleoError(ExitCode.CANCELLED_CHILD_NO_WAIVER, decision.message ?? '', {
      fix: decision.fix,
      details: { field: 'cancelledChildIds', cancelledChildIds: [...decision.cancelledChildIds] },
    });
  }
  if (decision.waiverReason === undefined) return;
  try {
    const { appendCancelledChildWaiverAudit } = await import('./cancelled-child-waiver-audit.js');
    await appendCancelledChildWaiverAudit(
      {
        parentId,
        cancelledChildIds: [...decision.cancelledChildIds],
        waiverReason: decision.waiverReason,
        timestamp: new Date().toISOString(),
        agent: process.env['CLEO_AGENT_ID'] ?? 'cleo',
      },
      cwd,
    );
  } catch (err) {
    // Audit write failure must not block the completion — warn only.
    console.warn(
      '[complete] failed to write cancelled-child-waiver audit:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
