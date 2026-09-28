/**
 * `cleo done` / `cleo verify --auto` — record every required gate in one write.
 *
 * {@link recordTaskDone} turns the read-only plan from
 * {@link deriveTaskEvidence} into recorded gates, in a fixed order that keeps
 * every slow step OUTSIDE the task write transaction:
 *
 *  1. plan — change set, gate evidence, AC links, blockers (git and gh only);
 *  2. tools — `lint` and `typecheck` in parallel, then `test`, each through the
 *     ADR-061 resolver and cache (`runToolCached`, under its global semaphore
 *     and memory caps); a cached result is reused, a failure stops here;
 *  3. typed gates — executed once by `previewTaskGates`, which caches each pass
 *     (T12621); a failure stops here;
 *  4. write — ONE `validateGateVerify` call with per-gate evidence
 *     (`gateEvidence`), which parses and validates every atom through the
 *     existing `parseEvidence` → `validateAtom` → gate minimum →
 *     `checkTaskEvidenceContext` path, serves the typed gates from the cache
 *     (`noRun`), and persists all gates in a single transaction.
 *
 * Tool atoms re-enter `validateAtom` at step 4, where they hit the cache entry
 * step 2 wrote — the same key, because the tools ran in the same execution
 * root the validator resolves. That is why a plan whose change set lives in the
 * task's worktree refuses to run from the main checkout: the validator would
 * measure the wrong tree.
 *
 * There is no override: `CLEO_OWNER_OVERRIDE` is refused by the multi-gate
 * write and stays a single-gate `cleo verify` path. Completion is the caller's
 * next step (`cleo done` dispatches `tasks.complete`, unchanged).
 *
 * Spec: `verify-streamlined-design` §3.2 steps 3-7 and §4.
 *
 * @task T12625
 */

import { execFileSync } from 'node:child_process';
import type {
  DoneBlockedDetails,
  DonePlan,
  DonePlanBlocker,
  DoneRecordResult,
  DoneToolResult,
  VerificationGate,
} from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { getProjectRoot } from '../paths.js';
import { type DeriveTaskEvidenceOptions, deriveTaskEvidence, shellQuote } from './done-plan.js';
import { resolveToolCommand } from './tool-resolver.js';

/** A tool run as `recordTaskDone` needs it; injectable for tests. */
export type DoneToolRunner = (
  tool: string,
  storeRoot: string,
  executionRoot: string,
) => Promise<{
  exitCode: number | null;
  cacheHit: boolean;
  durationMs: number;
  timedOut: boolean;
  tail: string;
}>;

/** Typed-gate execution before the write; injectable for tests. */
export type DoneTypedGateRunner = (
  storeRoot: string,
  taskId: string,
) => Promise<{ gateCount: number; passed: boolean; failing: string[] }>;

/** The single multi-gate write; injectable for tests. */
export type DoneGateWriter = (
  storeRoot: string,
  params: {
    taskId: string;
    gateEvidence: Partial<Record<VerificationGate, string | readonly string[]>>;
    noRun: boolean;
    sessionId?: string;
    agent?: string;
  },
) => Promise<EngineResult<{ passed: boolean }>>;

/** Options for {@link recordTaskDone}. */
export interface RecordTaskDoneOptions extends DeriveTaskEvidenceOptions {
  /** Agent recorded as the gate author. */
  agent?: string;
  /** Session for the audit trail; defaults to the caller's bound session. */
  sessionId?: string;
  /** Injectable slow steps (tests assert their order). */
  steps?: { runTool?: DoneToolRunner; runTypedGates?: DoneTypedGateRunner; write?: DoneGateWriter };
}

/** Default tool runner: resolve through ADR-061 and run through its cache. */
const defaultRunTool: DoneToolRunner = async (tool, storeRoot, executionRoot) => {
  if (tool === 'test-affected') {
    const { resolveAffectedTestCommand } = await import('./affected-packages.js');
    const affected = await resolveAffectedTestCommand(storeRoot, executionRoot);
    if (!affected) {
      return {
        exitCode: null,
        cacheHit: false,
        durationMs: 0,
        timedOut: false,
        tail: 'no affected-scope command',
      };
    }
    const { runToolCached } = await import('./tool-cache.js');
    const r = await runToolCached(affected.command, storeRoot, { executionRoot });
    return {
      exitCode: r.exitCode,
      cacheHit: r.cacheHit,
      durationMs: r.cacheHit ? 0 : r.durationMs,
      timedOut: r.timedOut,
      tail: (r.stderrTail || r.stdoutTail).trim().slice(-400),
    };
  }
  const resolved = resolveToolCommand(tool, storeRoot);
  if (!resolved.ok) {
    return {
      exitCode: null,
      cacheHit: false,
      durationMs: 0,
      timedOut: false,
      tail: resolved.reason,
    };
  }
  const { runToolCached } = await import('./tool-cache.js');
  const r = await runToolCached(resolved.command, storeRoot, { executionRoot });
  return {
    exitCode: r.exitCode,
    cacheHit: r.cacheHit,
    durationMs: r.cacheHit ? 0 : r.durationMs,
    timedOut: r.timedOut,
    tail: (r.stderrTail || r.stdoutTail).trim().slice(-400),
  };
};

/** Default typed-gate runner: `previewTaskGates`, which caches each pass (T12621). */
const defaultRunTypedGates: DoneTypedGateRunner = async (storeRoot, taskId) => {
  const { previewTaskGates } = await import('./gate-preview.js');
  const preview = await previewTaskGates(storeRoot, { taskId });
  return {
    gateCount: preview.gateCount,
    passed: preview.passed,
    failing: preview.results
      .filter((r) => r.result === 'fail' || r.result === 'error')
      .map((r) => `${r.req ?? `#${r.index}`} (${r.kind}): ${r.errorMessage ?? r.result}`),
  };
};

/** Default writer: the existing gate write, with per-gate evidence. */
const defaultWrite: DoneGateWriter = async (storeRoot, params) => {
  const { validateGateVerify } = await import('../validation/engine-ops.js');
  const result = await validateGateVerify(storeRoot, params);
  return result.success ? engineSuccess({ passed: result.data.passed }) : result;
};

function blocked(
  plan: DonePlan,
  blocker: DonePlanBlocker,
  recordedGates: VerificationGate[] = [],
): EngineResult<DoneRecordResult> {
  const details: DoneBlockedDetails = {
    blocker: blocker.code,
    ...(blocker.cause ? { cause: blocker.cause } : {}),
    next: blocker.next,
    recordedGates,
    plan,
  };
  return engineError('E_DONE_BLOCKED', blocker.message, { details, fix: blocker.next.command });
}

/** `git` read in `cwd`, trimmed; `null` on failure (a non-zero exit included). */
function gitRead(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The tools and typed gates run on whatever `executionRoot` has checked out.
 * `implemented` cites the change set's commit; unless that tree CONTAINS the
 * change, `testsPassed`/`qaPassed` would attest a different tree — the T12625
 * review reproduced a failing test recording testsPassed from the main
 * checkout while `implemented` cited the unchecked-out task branch.
 *
 * - branch: the change-set commit must be the checked-out HEAD (a dirty tree
 *   is already a plan blocker);
 * - pr: the merge commit must be an ancestor of the checked-out HEAD.
 */
function checkoutBlocker(plan: DonePlan): DonePlanBlocker | null {
  const cs = plan.changeSet;
  const root = cs.executionRoot;
  const head = gitRead(root, ['rev-parse', 'HEAD']);
  const short = (sha: string | null | undefined): string => (sha ?? 'nothing').slice(0, 12);
  if (cs.source === 'branch') {
    if (cs.headRef === 'HEAD' && head !== null && head === cs.commitSha) return null;
    const branch = cs.headRef && cs.headRef !== 'HEAD' ? cs.headRef : `task/${plan.taskId}`;
    return {
      code: 'checkout-required',
      message: `${plan.taskId}'s change is ${short(cs.commitSha)} on ${branch}, but ${root} has ${short(head)} checked out; the tools would measure a different tree than implemented cites.`,
      next: {
        command: `git -C ${shellQuote(root)} switch ${branch} && cleo done ${plan.taskId}`,
        why: 'Tests, lint, typecheck and typed gates must run on the commit implemented records.',
      },
    };
  }
  if (cs.source === 'pr' && cs.mergeCommitSha) {
    // D11151: every PR the task shipped in must be in the tested tree.
    const merges = [
      ...(cs.additionalPrs ?? []).flatMap((p) =>
        p.mergeCommitSha ? [{ pr: p.prNumber, sha: p.mergeCommitSha }] : [],
      ),
      { pr: cs.prNumber, sha: cs.mergeCommitSha },
    ];
    const missing = merges.find(
      (m) =>
        head === null || gitRead(root, ['merge-base', '--is-ancestor', m.sha, 'HEAD']) === null,
    );
    if (!missing) return null;
    return {
      code: 'checkout-required',
      message: `${root} has ${short(head)} checked out, which does not contain PR #${missing.pr}'s merge commit ${short(missing.sha)}.`,
      next: {
        command: `git -C ${shellQuote(root)} switch --detach ${cs.mergeCommitSha} && cleo done ${plan.taskId}`,
        why: 'Tests, lint, typecheck and typed gates must run on a tree containing the merged change.',
      },
    };
  }
  return null;
}

/** Step 2: lint + typecheck in parallel, then test; stop at the first failure. */
async function runPlannedTools(
  plan: DonePlan,
  storeRoot: string,
  runTool: DoneToolRunner,
): Promise<{ results: DoneToolResult[]; blocker?: DonePlanBlocker }> {
  const root = plan.changeSet.executionRoot;
  const runnable = plan.toolRuns.filter((r) => r.cache !== 'not-applicable');
  const results: DoneToolResult[] = [];
  const waves = [
    runnable.filter((r) => r.tool !== 'test'),
    runnable.filter((r) => r.tool === 'test'),
  ];
  for (const wave of waves) {
    const outcomes = await Promise.all(
      wave.map(async (r) => ({ run: r, out: await runTool(r.tool, storeRoot, root) })),
    );
    for (const { run, out } of outcomes) {
      results.push({
        tool: run.tool,
        gate: run.gate,
        exitCode: out.exitCode,
        cacheHit: out.cacheHit,
        durationMs: out.durationMs,
      });
    }
    const failed = outcomes.find(({ out }) => out.exitCode !== 0);
    if (failed) {
      const { run, out } = failed;
      return {
        results,
        blocker: {
          code: 'tool-failed',
          message: out.timedOut
            ? `tool:${run.tool} exceeded its deadline in ${root}.`
            : `tool:${run.tool} failed (exit ${out.exitCode}) in ${root}: ${out.tail}`,
          next: {
            command: `cd ${shellQuote(root)} && ${run.command ?? `cleo done ${plan.taskId}`}`,
            why: `${run.gate} needs a passing ${run.tool} run on the recorded tree.`,
          },
          cause: out.timedOut ? 'E_EVIDENCE_TOOL_TIMEOUT' : 'E_EVIDENCE_TOOL_FAILED',
        },
      };
    }
  }
  return { results };
}

/**
 * Record every required gate a task lacks, in one write, from derived
 * evidence. Does not complete the task.
 *
 * @param taskId - Task to record.
 * @param opts - Planner options (`satisfies`, `prNumber`, roots) plus author,
 *   session and injectable steps.
 * @returns The recorded gates, or `E_DONE_BLOCKED` with one next step and
 *   the original cause in `details.cause`.
 * @example
 * ```ts
 * const r = await recordTaskDone('T123', { satisfies: 'all' });
 * if (!r.success) console.error(r.error.fix);
 * ```
 * @task T12625
 */
export async function recordTaskDone(
  taskId: string,
  opts: RecordTaskDoneOptions = {},
): Promise<EngineResult<DoneRecordResult>> {
  const storeRoot = opts.projectRoot ?? getProjectRoot();
  let plan: DonePlan;
  try {
    plan = await deriveTaskEvidence(taskId, { ...opts, projectRoot: storeRoot });
  } catch (err) {
    return cleoErrorToEngineResult<DoneRecordResult>(err, 'E_DONE_FAILED', 'cleo done failed');
  }
  if (plan.changeSet.rootSource === 'task-worktree') {
    return blocked(plan, {
      code: 'run-from-worktree',
      message: `${taskId}'s work is in its worktree ${plan.runFrom}; tools must run in that tree.`,
      next: {
        command: `cd ${shellQuote(plan.runFrom)} && cleo done ${taskId}`,
        why: 'Evidence tools measure the invocation tree; run cleo done from the task worktree.',
      },
    });
  }
  const first = plan.blockers[0];
  if (first) return blocked(plan, first);
  if (plan.toolRuns.length > 0 || plan.typedGates.length > 0) {
    const checkout = checkoutBlocker(plan);
    if (checkout) return blocked(plan, checkout);
  }

  const steps = opts.steps ?? {};
  const tools = await runPlannedTools(plan, storeRoot, steps.runTool ?? defaultRunTool);
  if (tools.blocker) return blocked(plan, tools.blocker);

  const typed = plan.typedGates.length
    ? await (steps.runTypedGates ?? defaultRunTypedGates)(storeRoot, taskId)
    : { gateCount: 0, passed: true, failing: [] };
  if (!typed.passed) {
    return blocked(plan, {
      code: 'typed-gate-failed',
      message: `Typed gate(s) failed: ${typed.failing.join('; ')}`,
      next: {
        command: `cleo verify ${taskId} --run`,
        why: 'Fix the failing typed gate and re-run.',
      },
    });
  }

  const pending = plan.gates.filter((g) => !g.passed && g.evidence !== null);
  const gateEvidence: Partial<Record<VerificationGate, string | string[]>> = Object.fromEntries(
    pending.map((g) => [g.gate, g.evidence as string]),
  );
  let verificationPassed = plan.gates.every((g) => g.passed);
  if (pending.length > 0) {
    let sessionId = opts.sessionId;
    if (sessionId === undefined) {
      const { resolveBoundSessionId } = await import('../store/session-store.js');
      sessionId = (await resolveBoundSessionId(storeRoot).catch(() => null)) ?? undefined;
    }
    const { readAllowCachedGates } = await import('./gate-result-cache.js');
    // D11151: every earlier own-branch PR is an ordered implemented attempt in
    // the SAME write as the primary, so all are recorded or none (review HIGH).
    if (plan.additionalImplemented?.length && gateEvidence.implemented) {
      gateEvidence.implemented = [
        ...plan.additionalImplemented,
        gateEvidence.implemented as string,
      ];
    }
    const written = await (steps.write ?? defaultWrite)(storeRoot, {
      taskId,
      gateEvidence,
      noRun: typed.gateCount > 0 && readAllowCachedGates(storeRoot),
      ...(sessionId ? { sessionId } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
    });
    if (!written.success) {
      return blocked(plan, {
        code: 'evidence-refused',
        message: written.error.message,
        next: {
          command: `cleo done ${taskId} --plan`,
          why: 'The validators refused the derived evidence; the plan shows what changed.',
        },
        cause: written.error.code,
      });
    }
    verificationPassed = written.data.passed;
  }

  return engineSuccess({
    taskId,
    recordedGates: pending.map((g) => g.gate),
    alreadyPassed: plan.gates.filter((g) => g.passed).map((g) => g.gate),
    toolResults: tools.results,
    typedGateCount: typed.gateCount,
    verificationPassed,
    plan,
  });
}

/**
 * A tool runner shared by a batch: each (tool, execution root) pair runs once
 * and every later caller gets the same outcome. Keyed on the root as well as
 * the tool — two tasks whose work lives in different trees must each be
 * measured in their own tree.
 *
 * @param base - The runner that actually executes.
 * @returns A memoising runner.
 * @task T12628
 */
export function sharedToolRunner(base: DoneToolRunner): DoneToolRunner {
  const runs = new Map<string, ReturnType<DoneToolRunner>>();
  return (tool, storeRoot, executionRoot) => {
    const key = `${tool}\u0000${executionRoot}`;
    let run = runs.get(key);
    if (!run) {
      run = base(tool, storeRoot, executionRoot);
      runs.set(key, run);
    }
    return run;
  };
}

/** One task's outcome in a batch close. */
export interface BatchDoneEntry {
  /** Task the entry is for. */
  taskId: string;
  /** Its record result, or its `E_DONE_BLOCKED`. */
  result: EngineResult<DoneRecordResult>;
}

/**
 * Close several tasks shipped by one PR (T12628): each task is planned and
 * recorded on its own, and one task's blocker never stops the others. The
 * tools run once per execution root for the whole batch — every task shares
 * one memoised runner — and each task still gets its own validated write.
 * Shared evidence is NOT pre-acknowledged: the ADR-059 warning fires as for
 * any other reuse.
 *
 * @param taskIds - Tasks to record, in order.
 * @param opts - Shared options (`prNumber`, `satisfies`, roots, author, steps).
 * @returns One entry per task, in the given order.
 * @example
 * ```ts
 * const entries = await recordTasksDone(['T1', 'T2', 'T3'], { prNumber: 42 });
 * ```
 * @task T12628
 */
export async function recordTasksDone(
  taskIds: readonly string[],
  opts: RecordTaskDoneOptions = {},
): Promise<BatchDoneEntry[]> {
  const runTool = sharedToolRunner(opts.steps?.runTool ?? defaultRunTool);
  const entries: BatchDoneEntry[] = [];
  for (const taskId of taskIds) {
    entries.push({
      taskId,
      result: await recordTaskDone(taskId, { ...opts, steps: { ...opts.steps, runTool } }),
    });
  }
  return entries;
}
