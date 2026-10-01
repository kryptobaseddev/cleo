/**
 * `cleo complete` proves testsPassed/qaPassed from merged CI itself (T12960).
 *
 * Once a task's PR has merged, its required CI on the merge commit is the
 * strongest test evidence there is (D11149), and the scoped or targeted runs
 * recorded before merge stop counting (D11150, T12656, T12965). Rather than
 * refuse and send the agent off to run the whole suite locally, completion
 * synthesizes the `ci:<pr>` atom, validates it through the one gate-write path
 * (`validateGateVerify`, so nothing here is a second validator), and records it
 * with a note saying who recorded it and why. Red or still-running CI is a
 * refusal that says to wait for CI — never to run the suite.
 *
 * @task T12960
 * @task T12656
 * @task T12965
 */

import type { AcRow, EvidenceAtom, Task, VerificationGate } from '@cleocode/contracts';
import type { EngineResult } from '../engine-result.js';
import { readCiSatisfies } from '../release/ci-evidence.js';
import type { GateVerifyParams, GateVerifyResult } from '../validation/engine-ops.js';
import {
  affectedScopeSupersededReason,
  type ChangeMergeState,
  isAffectedOnly,
  taskChangeMergeState,
  testRunTreeMismatchReason,
} from './affected-scope.js';
import type { ChangeSetDeps } from './change-set.js';
import { resolveEvidenceExecutionRoot } from './evidence.js';
import { captureTreeIdentity } from './tree-identity.js';

/** Gates merged CI can attest (D11149). */
const CI_GATES: readonly VerificationGate[] = ['testsPassed', 'qaPassed'];

/** Injectable I/O for {@link satisfyGatesFromMergedCi}. */
export interface MergedCiDeps {
  /** Change-set I/O for the merge-state lookup (tests inject `gh`). */
  changeSet?: ChangeSetDeps;
  /** Whether the project accepts `ci:<pr>` evidence; defaults to `evidence.ciSatisfies`. */
  ciSatisfies?: (storeRoot: string) => boolean;
  /** Current tracked tree hash of the execution root; defaults to `git`. */
  currentTree?: (storeRoot: string) => string | null;
  /** Canonical acceptance criteria of the task; defaults to the task store. */
  acRows?: (storeRoot: string, taskId: string) => Promise<readonly AcRow[]>;
  /** The gate write; defaults to `validateGateVerify`. */
  recordGates?: (
    storeRoot: string,
    params: GateVerifyParams,
  ) => Promise<EngineResult<GateVerifyResult>>;
}

/** What {@link satisfyGatesFromMergedCi} did. */
export type MergedCiOutcome =
  | {
      /** CI evidence was validated and recorded for {@link gates}. */
      kind: 'recorded';
      /** The PR whose merge-commit CI was recorded (`<n>` or `<component>@<n>`). */
      pr: string;
      /** Gates recorded from that CI. */
      gates: VerificationGate[];
    }
  | {
      /**
       * The change merged, but its required CI is red or still running: wait
       * for CI and retry. Running the suite locally is not the remedy.
       */
      kind: 'wait-for-ci';
      /** Why the CI does not hold, for the refusal. */
      reason: string;
    }
  | {
      /** Nothing recorded; the ordinary gate checks decide. */
      kind: 'skipped';
      /** Why the recorded testsPassed no longer stands, when it does not. */
      testsPassedReason: string | null;
      /** Why merged CI could not stand in, when it was tried. */
      ciUnavailable?: string;
    };

/** The `ci:` reference for a task's merged PR, or null when none is known. */
function prRefFromImplemented(task: Task): string | null {
  const atoms = task.verification?.evidence?.implemented?.atoms ?? [];
  const pr = atoms.findLast((a): a is Extract<EvidenceAtom, { kind: 'pr' }> => a.kind === 'pr');
  if (!pr) return null;
  return pr.componentPrNumber !== undefined
    ? `${pr.componentPrNumber}@${pr.prNumber}`
    : String(pr.prNumber);
}

/** `satisfies:` links for a CI write: the gate's prior criteria, else implemented's. */
function criterionLinks(task: Task, gate: VerificationGate, rows: readonly AcRow[]): string[] {
  const evidence = task.verification?.evidence;
  const prior = evidence?.[gate]?.scope?.criteria ?? [];
  const ids = (prior.length > 0 ? prior : (evidence?.implemented?.scope?.criteria ?? [])).map(
    (link) => link.criterionId,
  );
  return rows
    .filter((row) => ids.includes(row.id))
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((row) => `satisfies:${task.id}#AC${row.ordinal}`);
}

async function defaultRecordGates(
  storeRoot: string,
  params: GateVerifyParams,
): Promise<EngineResult<GateVerifyResult>> {
  const { validateGateVerify } = await import('../validation/engine-ops.js');
  return validateGateVerify(storeRoot, params);
}

function defaultCurrentTree(storeRoot: string): string | null {
  return captureTreeIdentity(resolveEvidenceExecutionRoot(storeRoot))?.treeHash ?? null;
}

async function defaultAcRows(storeRoot: string, taskId: string): Promise<readonly AcRow[]> {
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  return (await getTaskAccessor(storeRoot)).getAcRows(taskId);
}

/**
 * Satisfy a task's testsPassed/qaPassed from its merged PR's required CI when
 * they are missing or no longer stand, before `cleo complete` checks gates.
 *
 * Runs only for required CI gates that are unrecorded, or a testsPassed that
 * rests on an affected-only run after merge (T12656) or on a `test-run:`
 * whose tree has moved (T12965). Ordinary completions with standing gates pay
 * nothing. The PR comes from the task's `pr:` implemented atom, else from the
 * change-set derivation `cleo done` uses; a stacked PR is not judged here.
 *
 * @param task - The task being completed (as loaded).
 * @param storeRoot - CLEO store root.
 * @param requiredGates - The project's required verification gates.
 * @param deps - Injectable I/O.
 * @returns What was recorded, a wait-for-CI refusal, or why nothing was.
 * @example
 * ```ts
 * const ci = await satisfyGatesFromMergedCi(task, root, ['implemented', 'testsPassed']);
 * if (ci.kind === 'wait-for-ci') throw new Error(ci.reason);
 * ```
 * @task T12960
 */
export async function satisfyGatesFromMergedCi(
  task: Task,
  storeRoot: string,
  requiredGates: readonly VerificationGate[],
  deps: MergedCiDeps = {},
): Promise<MergedCiOutcome> {
  const ciGates = CI_GATES.filter((g) => requiredGates.includes(g));
  if (ciGates.length === 0) return { kind: 'skipped', testsPassedReason: null };

  let merge: Awaited<ReturnType<typeof taskChangeMergeState>> | undefined;
  const mergeState = async (): Promise<ChangeMergeState> => {
    merge ??= await taskChangeMergeState(task, storeRoot, deps.changeSet);
    return merge.state;
  };

  const testsAtoms = task.verification?.evidence?.testsPassed?.atoms ?? [];
  let testsPassedReason: string | null = null;
  if (task.verification?.gates?.testsPassed === true && ciGates.includes('testsPassed')) {
    if (testsAtoms.some((a) => a.kind === 'test-run' && a.treeHash !== undefined)) {
      testsPassedReason = testRunTreeMismatchReason(
        testsAtoms,
        (deps.currentTree ?? defaultCurrentTree)(storeRoot),
      );
    }
    if (testsPassedReason === null && isAffectedOnly(testsAtoms)) {
      testsPassedReason = affectedScopeSupersededReason(testsAtoms, await mergeState());
    }
  }
  const needs = ciGates.filter(
    (g) =>
      task.verification?.gates?.[g] !== true || (g === 'testsPassed' && testsPassedReason !== null),
  );
  if (needs.length === 0) return { kind: 'skipped', testsPassedReason: null };
  if (!(deps.ciSatisfies ?? readCiSatisfies)(storeRoot)) {
    return { kind: 'skipped', testsPassedReason };
  }

  let pr = prRefFromImplemented(task);
  if (pr === null) {
    const state = await mergeState();
    const cs = merge?.changeSet ?? null;
    if (cs?.source === 'pr' && cs.prNumber !== undefined && cs.stackedOn === undefined) {
      pr =
        cs.componentPrNumber !== undefined
          ? `${cs.componentPrNumber}@${cs.prNumber}`
          : String(cs.prNumber);
    } else if (state === 'merged') {
      // The PR merged, yet the `pr:` check behind the change set refused it —
      // its required checks are red or have not reported.
      const why = [...(cs?.warnings ?? []), ...(cs?.blockers.map((b) => b.message) ?? [])].join(
        ' ',
      );
      return {
        kind: 'wait-for-ci',
        reason: `the change has merged but its PR's required CI does not hold yet${why ? ` (${why})` : ''}`,
      };
    } else {
      return { kind: 'skipped', testsPassedReason };
    }
  }

  const rows = await (deps.acRows ?? defaultAcRows)(storeRoot, task.id);
  const note = `note:recorded by cleo complete from the required CI of merged PR #${pr} (T12960)`;
  const gateEvidence: Partial<Record<VerificationGate, string>> = {};
  for (const gate of needs) {
    const links = criterionLinks(task, gate, rows);
    if (rows.length > 0 && links.length === 0) {
      return {
        kind: 'skipped',
        testsPassedReason,
        ciUnavailable: `merged CI could record ${gate}, but no criterion link is on record to carry over: cleo verify ${task.id} --gate ${gate} --evidence "ci:${pr};satisfies:${task.id}#AC<n>"`,
      };
    }
    gateEvidence[gate] = [`ci:${pr}`, note, ...links].join(';');
  }

  const written = await (deps.recordGates ?? defaultRecordGates)(storeRoot, {
    taskId: task.id,
    gateEvidence,
    agent: 'cleo-complete',
  });
  if (written.success) return { kind: 'recorded', pr, gates: needs };
  const code = written.error?.code ?? 'E_INTERNAL';
  const message = written.error?.message ?? 'unknown error';
  if (code === 'E_EVIDENCE_TESTS_FAILED') {
    return { kind: 'wait-for-ci', reason: `ci:${pr} does not hold: ${message}` };
  }
  return { kind: 'skipped', testsPassedReason, ciUnavailable: `ci:${pr} (${code}): ${message}` };
}
