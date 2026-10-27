/**
 * Read-only staleness of a task's recorded gates (T14037): the checks
 * `cleo complete` applies, run where a reader looks, so `cleo show` and
 * `cleo done --plan` say a recorded pass no longer stands before complete
 * refuses it.
 *
 * Two rules, both the ones complete uses:
 *  - re-validation of each recorded gate's hard atoms ({@link revalidateEvidence}:
 *    a commit gone, a file or report whose bytes changed);
 *  - for `testsPassed` / `qaPassed`, the superseded rules
 *    ({@link testsPassedSupersededReason}, {@link qaPassedSupersededReason}): a
 *    moved tree, or a scoped result that does not carry across the merge.
 *
 * Executes no tool and records nothing. A commit re-validation may refresh
 * its revalidation cache, as complete's does.
 *
 * @task T14037
 */

import type { Task, VerificationGate } from '@cleocode/contracts';
import {
  type ChangeMergeState,
  type MergedVerdict,
  qaPassedSupersededReason,
  taskChangeMergeState,
  testsPassedSupersededReason,
} from './affected-scope.js';
import { resolveChangeSetRoot } from './change-set.js';
import { revalidateEvidence } from './evidence.js';
import { captureTreeHash } from './tool-cache.js';

/** One recorded gate whose evidence no longer stands. */
export interface GateStaleness {
  /** The gate recorded as passed. */
  readonly gate: VerificationGate;
  /** Why it no longer stands, naming the atoms, files or commits involved. */
  readonly reason: string;
  /** Which rule refused it: atom re-validation, or the superseded rule. */
  readonly source: 'revalidate' | 'superseded';
}

/** The lazy merge state and tree the superseded rules read. */
export interface GateStalenessProbe {
  /** Merge state of the task's change; resolved only when a rule needs it. */
  readonly mergeState: () =>
    | Promise<ChangeMergeState | MergedVerdict>
    | ChangeMergeState
    | MergedVerdict;
  /** Current tree hash of the task's checkout. */
  readonly currentTree: () => Promise<string | null> | string | null;
  /** The task's checkout. */
  readonly root: () => string;
}

/**
 * Every recorded passed gate of `task` whose evidence no longer stands.
 *
 * @param task - The task (its `verification` is read).
 * @param storeRoot - CLEO store root.
 * @param probe - Merge state, tree and root; defaults to the task's change-set root.
 * @returns The stale gates, in gate order; empty when every recorded pass stands.
 * @example
 * ```ts
 * for (const s of await gateStaleness(task, root)) console.warn(`${s.gate}: ${s.reason}`);
 * ```
 * @task T14037
 */
export async function gateStaleness(
  task: Task,
  storeRoot: string,
  probe?: GateStalenessProbe,
): Promise<GateStaleness[]> {
  const verification = task.verification;
  if (!verification?.evidence || task.status === 'done') return [];
  let merge: ReturnType<typeof taskChangeMergeState> | undefined;
  const p: GateStalenessProbe = probe ?? {
    mergeState: () => {
      merge ??= taskChangeMergeState(task, storeRoot);
      return merge;
    },
    currentTree: () => captureTreeHash(resolveChangeSetRoot(storeRoot, task.id).root),
    root: () => resolveChangeSetRoot(storeRoot, task.id).root,
  };
  const stale: GateStaleness[] = [];
  for (const [name, evidence] of Object.entries(verification.evidence)) {
    const gate = name as VerificationGate;
    if (!evidence || verification.gates?.[gate] !== true) continue;
    const check = await revalidateEvidence(evidence, storeRoot, gate);
    if (!check.stillValid) {
      stale.push({
        gate,
        reason: check.failedAtoms.map((f) => f.reason).join('; '),
        source: 'revalidate',
      });
      continue;
    }
    const superseded =
      gate === 'testsPassed'
        ? await testsPassedSupersededReason(evidence.atoms, p)
        : gate === 'qaPassed'
          ? await qaPassedSupersededReason(evidence.atoms, p)
          : null;
    if (superseded) stale.push({ gate, reason: superseded, source: 'superseded' });
  }
  return stale;
}
