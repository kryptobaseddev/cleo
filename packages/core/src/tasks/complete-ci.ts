/**
 * `cleo complete` proves testsPassed/qaPassed from merged CI itself (T12960).
 *
 * Once a task's latest implementation has merged, its PR's required CI on the
 * merge commit is the strongest test evidence there is (D11149), and the
 * scoped runs recorded before merge stop counting (D11150, T12656, T12965).
 * Rather than refuse and send the agent off to run the whole suite locally,
 * completion synthesizes the `ci:<pr>` atom, validates it through the one
 * gate-write path (`validateGateVerify`, so nothing here is a second
 * validator), and records it with a note saying who recorded it and why.
 *
 * When CI does not hold, the refusal names the remedy that can work: still
 * pending → wait for CI and retry; a final red, a skipped or missing required
 * job, or a PR the `pr:` check refuses → fix CI, or record a full `tool:test`
 * (plus `tool:lint`/`tool:typecheck`). Never an open-ended wait on CI that has
 * already concluded.
 *
 * Gates recorded here persist even when completion then fails on a later,
 * unrelated check (dependencies, AC coverage, IVTR): they are valid evidence
 * on their own, validated through the same path as `cleo verify`, and the
 * next `cleo complete` reuses them instead of resolving CI again.
 *
 * @task T12960
 * @task T12656
 * @task T12965
 */

import type { AcRow, Task, VerificationGate } from '@cleocode/contracts';
import type { EngineResult } from '../engine-result.js';
import { readCiSatisfies } from '../release/ci-evidence.js';
import type { GateVerifyParams, GateVerifyResult } from '../validation/engine-ops.js';
import {
  type MergeProbeDeps,
  type TaskMergeInfo,
  taskChangeMergeState,
  testsPassedSupersededReason,
} from './affected-scope.js';
import { resolveEvidenceExecutionRoot } from './evidence.js';
import { captureTreeHash } from './tool-cache.js';

/** Gates merged CI can attest (D11149). */
const CI_GATES: readonly VerificationGate[] = ['testsPassed', 'qaPassed'];

/** Injectable I/O for {@link satisfyGatesFromMergedCi}. */
export interface MergedCiDeps {
  /** Merge-state probes (change-set `gh` lookup, git ancestry). */
  merge?: MergeProbeDeps;
  /** Whether the project accepts `ci:<pr>` evidence; defaults to `evidence.ciSatisfies`. */
  ciSatisfies?: (storeRoot: string) => boolean;
  /** Current tree hash of the execution root; defaults to the tool cache's `captureTreeHash`. */
  currentTree?: (storeRoot: string) => Promise<string | null> | string | null;
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
      /** The change merged and its required CI is still running: wait and retry. */
      kind: 'wait-for-ci';
      /** Why the CI does not hold yet. */
      reason: string;
    }
  | {
      /**
       * The change merged and its required CI concluded without proving the
       * gates (red, skipped or missing required jobs, or the PR is refused):
       * fix CI, or record a full local run.
       */
      kind: 'ci-red';
      /** Why the CI does not hold. */
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

/**
 * Whether a CI refusal describes checks that have not concluded yet, as
 * opposed to a final failure. Pending only when the reason names a pending
 * run and no concluded failure (`startup_failure` and every other
 * `*_failure` conclusion included), skip or missing check.
 *
 * @param reason - The refusal text from the `ci:`/`pr:` validators.
 * @returns True when waiting for CI can resolve it.
 * @task T12960
 */
export function isPendingCiReason(reason: string): boolean {
  return (
    /\bpending\b|\bin_progress\b|\bqueued\b/i.test(reason) &&
    // `\w*_failure` covers startup_failure and any other *_failure conclusion.
    !/\b(\w*_failure|failure|failed|cancelled|timed_out|action_required|missing|skipped|not found|no SUCCESS)\b/i.test(
      reason,
    )
  );
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

function defaultCurrentTree(storeRoot: string): Promise<string | null> {
  return captureTreeHash(resolveEvidenceExecutionRoot(storeRoot));
}

async function defaultAcRows(storeRoot: string, taskId: string): Promise<readonly AcRow[]> {
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  return (await getTaskAccessor(storeRoot)).getAcRows(taskId);
}

/** Classify a CI refusal as pending (wait) or concluded (fix or run locally). */
function ciRefusal(reason: string): MergedCiOutcome {
  return isPendingCiReason(reason) ? { kind: 'wait-for-ci', reason } : { kind: 'ci-red', reason };
}

/**
 * Satisfy a task's testsPassed/qaPassed from its merged PR's required CI when
 * they are missing or no longer stand, before `cleo complete` checks gates.
 *
 * Runs only for required CI gates that are unrecorded, or a testsPassed that
 * {@link testsPassedSupersededReason} no longer accepts (a scoped run after
 * merge, or a test-run whose tree moved). Ordinary completions with standing
 * gates pay nothing. The PR is the merged PR that carries the task's latest
 * implementation ({@link taskChangeMergeState}) — never one that merely cites
 * the task; a stacked PR is not judged.
 *
 * @param task - The task being completed (as loaded).
 * @param storeRoot - CLEO store root.
 * @param requiredGates - The project's required verification gates.
 * @param deps - Injectable I/O.
 * @returns What was recorded, a CI refusal, or why nothing was.
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

  let merge: TaskMergeInfo | undefined;
  const mergeInfo = async (): Promise<TaskMergeInfo> => {
    merge ??= await taskChangeMergeState(task, storeRoot, deps.merge);
    return merge;
  };

  const testsPassedReason =
    task.verification?.gates?.testsPassed === true && ciGates.includes('testsPassed')
      ? await testsPassedSupersededReason(task.verification?.evidence?.testsPassed?.atoms ?? [], {
          mergeState: async () => (await mergeInfo()).state,
          currentTree: () => (deps.currentTree ?? defaultCurrentTree)(storeRoot),
        })
      : null;
  const needs = ciGates.filter(
    (g) =>
      task.verification?.gates?.[g] !== true || (g === 'testsPassed' && testsPassedReason !== null),
  );
  if (needs.length === 0) return { kind: 'skipped', testsPassedReason: null };
  if (!(deps.ciSatisfies ?? readCiSatisfies)(storeRoot)) {
    return { kind: 'skipped', testsPassedReason };
  }

  const { state, prRef, changeSet, unproven } = await mergeInfo();
  if (state !== 'merged') return { kind: 'skipped', testsPassedReason };
  if (prRef === null) {
    // The change landed, yet no merged PR that carries the implementation
    // passed the `pr:` check — its required checks did not hold, the PR is
    // refused outright, or the commits reached the default branch some other
    // way (a PR that cites the task but never ran them proves nothing).
    const why = [
      ...(unproven ? [unproven] : []),
      ...(changeSet?.warnings ?? []),
      ...(changeSet?.blockers.map((b) => b.message) ?? []),
    ].join(' ');
    return ciRefusal(
      `the change has merged but no merged PR's required CI proves it${why ? ` (${why})` : ''}`,
    );
  }

  const rows = await (deps.acRows ?? defaultAcRows)(storeRoot, task.id);
  const note = `note:recorded by cleo complete from the required CI of merged PR #${prRef} (T12960)`;
  const gateEvidence: Partial<Record<VerificationGate, string>> = {};
  for (const gate of needs) {
    const links = criterionLinks(task, gate, rows);
    if (rows.length > 0 && links.length === 0) {
      return {
        kind: 'skipped',
        testsPassedReason,
        ciUnavailable: `merged CI could record ${gate}, but no criterion link is on record to carry over: cleo verify ${task.id} --gate ${gate} --evidence "ci:${prRef};satisfies:${task.id}#AC<n>"`,
      };
    }
    gateEvidence[gate] = [`ci:${prRef}`, note, ...links].join(';');
  }

  const written = await (deps.recordGates ?? defaultRecordGates)(storeRoot, {
    taskId: task.id,
    gateEvidence,
    agent: 'cleo-complete',
  });
  if (written.success) return { kind: 'recorded', pr: prRef, gates: needs };
  const code = written.error?.code ?? 'E_INTERNAL';
  const message = written.error?.message ?? 'unknown error';
  if (code === 'E_EVIDENCE_TESTS_FAILED') return ciRefusal(`ci:${prRef} does not hold: ${message}`);
  return { kind: 'skipped', testsPassedReason, ciUnavailable: `ci:${prRef} (${code}): ${message}` };
}
