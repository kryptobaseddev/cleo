/**
 * `cleo done <id> --plan` — the read-only evidence planner.
 *
 * {@link deriveTaskEvidence} answers, for one task, "what would `cleo done`
 * record, and what stops it?" without executing a tool or a typed gate and
 * without writing a row, an audit line or a cache entry:
 *
 * - the implemented change set and where it came from ({@link deriveTaskChangeSet});
 * - the gates the verification policy requires and whether each has passed;
 * - the tool runs those gates need, resolved through the ADR-061 resolver,
 *   and whether each already has a fresh cached result for the current tree;
 * - which acceptance criteria map to evidence deterministically — a stored
 *   passing typed gate, or every repo path the criterion names being in the
 *   change set by exact repo-relative path — and which need `--satisfies`;
 * - the ordered blockers, each with one runnable next step;
 * - the exact commands, spelled as today's `cleo verify` / `cleo complete`
 *   verbs, so every one is runnable before `cleo done` records anything.
 *
 * The planned atom strings are the same strings the existing validators
 * receive; the planner adds no validation path of its own.
 *
 * Spec: `verify-streamlined-design` §3.1, §3.2, §7 step 1.
 *
 * @task T12623
 */

import { execFileSync } from 'node:child_process';
import type {
  AcRow,
  DoneNextStep,
  DonePlan,
  DonePlanAcMapping,
  DonePlanBlocker,
  DonePlanBlockerCode,
  DonePlanGate,
  DonePlanToolRun,
  DonePlanTypedGate,
  Task,
  TaskChangeSet,
  VerificationGate,
} from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { getProjectRoot } from '../paths.js';
import { isCiDocumentPath, readCiChecks, readCiSatisfies } from '../release/ci-evidence.js';

import { getTaskAccessor } from '../store/data-accessor.js';
import { planScopedTestRun } from './affected-packages.js';
import {
  type TaskMergeInfo,
  taskChangeMergeState,
  testsPassedSupersededReason,
} from './affected-scope.js';
import { type ChangeSetDeps, deriveTaskChangeSet } from './change-set.js';
import {
  checkGateEvidenceMinimumDetailed,
  classifyEvidenceTask,
  extractTaskAcFilesWithProvenance,
} from './evidence.js';
import { extractTypedGates } from './gate-runner.js';
import { captureTreeHash, computeCacheKey, readCacheEntry } from './tool-cache.js';
import { captureEnvFingerprint, captureResourceEnv } from './tool-cache-env.js';
import { type ResolvedToolCommand, resolveToolCommand } from './tool-resolver.js';
import { loadVerificationGatePolicy } from './verification-policy.js';

/**
 * Whether `ci:<pr>` can attest both tool gates for this change set (T12634):
 * both `evidence.ciChecks` lists are declared, and a change that is not purely
 * documentation also declares its job globs. Otherwise the plan falls back to
 * local tool runs. A PR that edits a pinned workflow is plannable too: main's
 * push CI attests it, never its own runs (T13174), and until that run exists
 * the ci:<pr> refusal says to wait for it — a whole-suite local run is never
 * the answer.
 */
function ciPlannable(storeRoot: string, needsJobs: boolean): boolean {
  const lists = readCiChecks(storeRoot);
  if (!lists.tests?.length || !lists.qa?.length) return false;
  return !(needsJobs && (!lists.jobs?.tests?.length || !lists.jobs?.qa?.length));
}

/** Gates `cleo done` derives evidence for; every other required gate is manual. */
const EVIDENCE_GATES: readonly VerificationGate[] = ['implemented', 'testsPassed', 'qaPassed'];

/** Tools each tool-backed gate runs, in atom order. */
const GATE_TOOLS: Readonly<Partial<Record<VerificationGate, readonly string[]>>> = {
  testsPassed: ['test'],
  qaPassed: ['lint', 'typecheck'],
};

/**
 * Report order for blockers: the first is the one to clear first (spec §3.3:
 * dirty tree → no change set → PR ambiguity → tool failure → typed gate
 * failure → AC mapping → lifecycle).
 */
const DONE_PLAN_BLOCKER_ORDER: readonly DonePlanBlockerCode[] = [
  'git-root',
  'run-from-worktree',
  'dirty-tree',
  'checkout-required',
  'no-change-set',
  'pr-ambiguous',
  'pr-unverified',
  'merge-commit-missing',
  'decision-missing',
  'tool-unresolved',
  'tool-failed',
  'typed-gate-failed',
  'ac-mapping-needed',
  'manual-gate',
  'epic-rollup',
  'evidence-refused',
  'completion-refused',
];

/** Options for {@link deriveTaskEvidence}. */
export interface DeriveTaskEvidenceOptions {
  /** CLEO store root. Defaults to the resolved project root. */
  projectRoot?: string;
  /** Invocation directory; locates the caller's worktree. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Criteria the agent asserts (`--satisfies AC1,AC3`), or `'all'`. */
  satisfies?: readonly string[] | 'all';
  /** Explicit PR (`--pr <n>`). */
  prNumber?: number;
  /** Injectable change-set I/O (tests). */
  deps?: ChangeSetDeps;
  /** Evidence preview (tests inject; defaults to the write's own validators). */
  previewEvidence?: DoneEvidencePreview;
  /**
   * Queue for the `test` slot while resolving the affected scope. `cleo done`
   * does (it runs the tests next); `--plan` never waits and reports
   * `scope pending: …` instead (T12656 review; T13133: the machine budget in
   * use, or memory pressure).
   */
  waitForTestSlot?: boolean;
}

/**
 * Validate a derived multi-gate write without writing it: the same validators
 * `cleo done` records through (T12672).
 */
export type DoneEvidencePreview = (
  storeRoot: string,
  taskId: string,
  gateEvidence: Partial<Record<VerificationGate, string | string[]>>,
) => Promise<{ ok: true } | { ok: false; code: string; message: string; fix?: string }>;

/** Default preview: `validateGateVerify` in preview mode (no tool runs, no write). */
const defaultPreviewEvidence: DoneEvidencePreview = async (storeRoot, taskId, gateEvidence) => {
  const { validateGateVerify } = await import('../validation/engine-ops.js');
  const r = await validateGateVerify(storeRoot, { taskId, gateEvidence, preview: true });
  return r.success
    ? { ok: true }
    : {
        ok: false,
        code: r.error.code,
        message: r.error.message,
        ...(r.error.fix ? { fix: r.error.fix } : {}),
      };
};

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
function checkoutBlocker(taskId: string, cs: TaskChangeSet): DonePlanBlocker | null {
  const root = cs.executionRoot;
  const head = gitRead(root, ['rev-parse', 'HEAD']);
  const short = (sha: string | null | undefined): string => (sha ?? 'nothing').slice(0, 12);
  if (cs.source === 'branch') {
    if (cs.headRef === 'HEAD' && head !== null && head === cs.commitSha) return null;
    const branch = cs.headRef && cs.headRef !== 'HEAD' ? cs.headRef : `task/${taskId}`;
    return {
      code: 'checkout-required',
      message: `${taskId}'s change is ${short(cs.commitSha)} on ${branch}, but ${root} has ${short(head)} checked out; the tools would measure a different tree than implemented cites.`,
      next: {
        command: `git -C ${shellQuote(root)} switch ${branch} && cleo done ${taskId}`,
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
        command: `git -C ${shellQuote(root)} switch --detach ${cs.mergeCommitSha} && cleo done ${taskId}`,
        why: 'Tests, lint, typecheck and typed gates must run on a tree containing the merged change.',
      },
    };
  }
  return null;
}

/**
 * The refusals `cleo done` would raise from what the plan already knows —
 * the ONE readiness check both `--plan` and `done` use (T12672), so
 * `ready: true` never meets a plan-visible refusal:
 *
 * - tools or typed gates run on a tree: from the task worktree
 *   (`run-from-worktree`), with the change checked out (`checkout-required`).
 *   A close with no tool run needs no tree (T12671);
 * - the derived evidence goes through the write's own validators in preview
 *   mode (`evidence-refused`), when nothing else blocks.
 */
async function readinessBlockers(input: {
  taskId: string;
  storeRoot: string;
  changeSet: TaskChangeSet;
  needsTree: boolean;
  gates: readonly DonePlanGate[];
  additionalImplemented: readonly string[];
  blocked: boolean;
  preview: DoneEvidencePreview;
}): Promise<DonePlanBlocker[]> {
  const { taskId, changeSet: cs } = input;
  if (input.needsTree) {
    if (cs.rootSource === 'task-worktree') {
      return [
        {
          code: 'run-from-worktree',
          message: `${taskId}'s work is in its worktree ${cs.executionRoot}; tools must run in that tree.`,
          next: {
            command: `cd ${shellQuote(cs.executionRoot)} && cleo done ${taskId}`,
            why: 'Evidence tools measure the invocation tree; run cleo done from the task worktree.',
          },
        },
      ];
    }
    const checkout = checkoutBlocker(taskId, cs);
    if (checkout) return [checkout];
  }
  const pending = input.gates.filter((g) => !g.passed && g.evidence !== null);
  if (input.blocked || pending.length === 0) return [];
  const gateEvidence: Partial<Record<VerificationGate, string | string[]>> = Object.fromEntries(
    pending.map((g) => [g.gate, g.evidence as string]),
  );
  if (input.additionalImplemented.length > 0 && gateEvidence.implemented) {
    gateEvidence.implemented = [...input.additionalImplemented, gateEvidence.implemented as string];
  }
  const checked = await input.preview(input.storeRoot, taskId, gateEvidence);
  if (checked.ok) return [];
  return [
    {
      code: 'evidence-refused',
      message: checked.message,
      next: {
        command: checked.fix ?? `cleo show ${taskId} --full`,
        why: 'The validators cleo done records through refuse this evidence.',
      },
      cause: checked.code,
    },
  ];
}

/**
 * POSIX single-quote a shell word (bare when it is already safe).
 *
 * @param word - Word to quote.
 * @returns A string the shell reads back as exactly `word`.
 */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function step(command: string, why: string): DoneNextStep {
  return { command, why };
}

function orderBlockers(blockers: DonePlanBlocker[]): DonePlanBlocker[] {
  return blockers
    .map((b, i) => ({ b, i }))
    .sort(
      (x, y) =>
        DONE_PLAN_BLOCKER_ORDER.indexOf(x.b.code) - DONE_PLAN_BLOCKER_ORDER.indexOf(y.b.code) ||
        x.i - y.i,
    )
    .map(({ b }) => b);
}

/** Resolve one tool and read — never write — its ADR-061 cache entry for `root`. */
async function planToolRun(
  tool: string,
  gate: VerificationGate,
  storeRoot: string,
  root: string,
  override?: ResolvedToolCommand,
): Promise<DonePlanToolRun> {
  const resolution = override
    ? { ok: true as const, command: override }
    : resolveToolCommand(tool, storeRoot);
  if (!resolution.ok) {
    return {
      tool,
      gate,
      command: null,
      source: null,
      cache: resolution.codeName === 'E_TOOL_NOT_APPLICABLE' ? 'not-applicable' : 'unresolved',
      reason: resolution.reason,
    };
  }
  const { command } = resolution;
  const key = computeCacheKey(
    command,
    await captureTreeHash(root),
    captureEnvFingerprint(root, command.canonical),
    // T12989: the heap and worker limits a run here would be spawned with.
    captureResourceEnv(command.canonical),
  );
  const entry = readCacheEntry(storeRoot, key);
  const run: DonePlanToolRun = {
    tool,
    gate,
    command: [command.cmd, ...command.args].join(' '),
    source: command.source,
    cache: entry === null ? 'miss' : entry.exitCode === 0 ? 'fresh-pass' : 'fresh-fail',
  };
  if (entry !== null && entry.exitCode !== null) {
    run.exitCode = entry.exitCode;
    run.capturedAt = entry.capturedAt;
  }
  return run;
}

/**
 * Repo-relative path in the one spelling exact matching compares: no leading
 * `./`, no trailing `/`. Deliberately NOT {@link diffIntersectsAc}, whose
 * suffix rule would let `src/index.ts` match `packages/lafs/src/index.ts` —
 * acceptable for an advisory intersect, not for claiming a criterion.
 */
function normaliseRepoPath(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Stored typed-gate results, aligned with criteria by acceptance index. */
function planTypedGates(task: Task, rows: readonly AcRow[]): DonePlanTypedGate[] {
  const results = task.verification?.gateResults ?? [];
  return extractTypedGates(task.acceptance ?? []).map(({ gate, originalIndex }) => {
    const stored = results.find((r) => r.index === originalIndex);
    const status: DonePlanTypedGate['status'] =
      stored === undefined || stored.result === 'skipped'
        ? 'not-run'
        : stored.result === 'pass'
          ? 'pass'
          : 'fail';
    const row = rows[originalIndex];
    return {
      alias: `AC${row?.ordinal ?? originalIndex + 1}`,
      kind: gate.kind,
      ...(gate.req ? { req: gate.req } : {}),
      status,
    };
  });
}

/** Criterion IDs already linked by recorded gate evidence. */
function recordedCriteria(task: Task): Set<string> {
  const ids = new Set<string>();
  for (const evidence of Object.values(task.verification?.evidence ?? {})) {
    for (const link of evidence?.scope?.criteria ?? []) ids.add(link.criterionId);
  }
  return ids;
}

/**
 * Map each criterion conservatively. Keyword matching is deliberately absent:
 * a criterion is linked only by a stored passing typed gate, by every path it
 * names being in the change set, by prior recorded evidence, or by the agent.
 */
function mapCriteria(
  task: Task,
  rows: readonly AcRow[],
  typedGates: readonly DonePlanTypedGate[],
  changeSet: TaskChangeSet,
  pending: readonly VerificationGate[],
  satisfies: readonly string[] | 'all' | undefined,
): DonePlanAcMapping[] {
  const recorded = recordedCriteria(task);
  const changed = new Set(changeSet.files.map(normaliseRepoPath));
  const writable = (gates: VerificationGate[]): VerificationGate[] =>
    gates.filter((g) => pending.includes(g));
  return rows.map((row) => {
    const alias = `AC${row.ordinal}`;
    const base = { alias, id: row.id, text: row.text };
    if (satisfies === 'all' || satisfies?.includes(alias)) {
      const gates = writable([...EVIDENCE_GATES]);
      return { ...base, mapped: true, gates, basis: 'agent' };
    }
    if (typedGates.some((g) => g.alias === alias && g.status === 'pass')) {
      return { ...base, mapped: true, gates: writable(['testsPassed']), basis: 'typed-gate' };
    }
    const named = extractTaskAcFilesWithProvenance({ acceptance: [row.text] }).files ?? [];
    if (named.length > 0 && named.every((path) => changed.has(normaliseRepoPath(path)))) {
      return {
        ...base,
        mapped: true,
        gates: writable(['implemented']),
        basis: 'files-in-diff',
        files: named,
      };
    }
    if (recorded.has(row.id)) return { ...base, mapped: true, gates: [], basis: 'recorded' };
    return {
      ...base,
      mapped: false,
      gates: [],
      basis: 'none',
      ...(named.length ? { files: named } : {}),
    };
  });
}

/** Planned atoms for a tool-backed gate, or a decision-only note. */
function toolGateEvidence(
  gate: VerificationGate,
  runs: readonly DonePlanToolRun[],
  decisionOnly: boolean,
  ciPr: string | null,
): string | null {
  if (decisionOnly) return 'note:decision-only implementation, no code changed';
  if (ciPr !== null) return `ci:${ciPr}`;
  const atoms = runs
    .filter((r) => r.gate === gate && r.cache !== 'unresolved')
    .map((r) => `tool:${r.tool}`);
  return atoms.length > 0 ? atoms.join(';') : null;
}

/** Blockers from tool runs and typed gates, before any AC question. */
function toolAndTypedGateBlockers(
  taskId: string,
  code: boolean,
  runs: readonly DonePlanToolRun[],
  typedGates: readonly DonePlanTypedGate[],
  root: string,
): DonePlanBlocker[] {
  const out: DonePlanBlocker[] = [];
  for (const run of runs) {
    if (run.cache === 'unresolved') {
      out.push({
        code: 'tool-unresolved',
        message: `No command resolves for tool:${run.tool} (${run.gate}): ${run.reason ?? 'unknown'}`,
        next: step(
          'cleo detect',
          `Re-detect the toolchain, or declare the ${run.tool} command in .cleo/project-context.json, so ${run.gate} has a real result.`,
        ),
        cause: 'E_EVIDENCE_TOOL_UNAVAILABLE',
      });
    } else if (run.cache === 'fresh-fail') {
      out.push({
        code: 'tool-failed',
        message: `tool:${run.tool} failed (exit ${run.exitCode}) on the current tree; ${run.gate} cannot pass until it does.`,
        next: step(
          `cd ${shellQuote(root)} && ${run.command}`,
          `Fix the failures ${run.tool} reports.`,
        ),
        cause: 'E_EVIDENCE_TOOL_FAILED',
      });
    }
  }
  for (const gate of new Set(runs.map((r) => r.gate))) {
    const gateRuns = runs.filter((r) => r.gate === gate);
    if (code && gateRuns.every((r) => r.cache === 'not-applicable')) {
      out.push({
        code: 'tool-unresolved',
        message: `Every tool for ${gate} is not applicable here; a code task needs an actual result.`,
        next: step(
          `cleo verify ${taskId} --gate ${gate} --evidence 'test-run:<vitest-json-report>'`,
          'A code task cannot pass on the absence of a toolchain.',
        ),
      });
    }
  }
  for (const typed of typedGates) {
    if (typed.status !== 'fail') continue;
    out.push({
      code: 'typed-gate-failed',
      message: `Typed gate ${typed.alias} (${typed.kind}${typed.req ? ` ${typed.req}` : ''}) last failed.`,
      next: step(`cleo verify ${taskId} --run`, 'Re-run the typed gates and fix the failing one.'),
    });
  }
  return out;
}

/** The AC blocker: criteria nobody linked, or a gate left with no linkage at all. */
function acMappingBlocker(
  taskId: string,
  mapping: readonly DonePlanAcMapping[],
  pending: readonly VerificationGate[],
): DonePlanBlocker | null {
  if (mapping.length === 0) return null;
  const unmapped = mapping.filter((m) => !m.mapped).map((m) => m.alias);
  const bare = pending.filter(
    (gate) => EVIDENCE_GATES.includes(gate) && !mapping.some((m) => m.gates.includes(gate)),
  );
  if (unmapped.length === 0 && bare.length === 0) return null;
  const ask = unmapped.length > 0 ? unmapped : mapping.map((m) => m.alias);
  const parts = [
    unmapped.length > 0 ? `${unmapped.join(', ')} have no deterministic evidence link` : '',
    bare.length > 0 ? `${bare.join(', ')} would carry no criterion link` : '',
  ].filter(Boolean);
  return {
    code: 'ac-mapping-needed',
    message: `${parts.join('; ')}. Name the criteria this work satisfies; the claim is still bound to the validated artifacts.`,
    next: step(
      `cleo done ${taskId} --plan --satisfies ${ask.join(',')}`,
      'Answer once; the criteria fan out to every gate whose evidence covers them.',
    ),
    cause: 'E_EVIDENCE_CONTENT_MISMATCH',
  };
}

/** Required gates `cleo done` cannot derive (documented, securityPassed, …). */
function manualGateBlockers(taskId: string, gates: readonly DonePlanGate[]): DonePlanBlocker[] {
  return gates
    .filter((g) => g.required && !g.passed && !EVIDENCE_GATES.includes(g.gate))
    .map((g) => ({
      code: 'manual-gate' as const,
      message: `${g.gate} is required and is not derived by cleo done.`,
      next: step(
        `cleo verify ${taskId} --gate ${g.gate} --evidence '<atoms>'`,
        checkGateEvidenceMinimumDetailed(g.gate, [])?.message ?? `Record ${g.gate} evidence.`,
      ),
    }));
}

function withSatisfies(
  taskId: string,
  gate: VerificationGate,
  evidence: string | null,
  mapping: readonly DonePlanAcMapping[],
): string | null {
  if (evidence === null) return null;
  const links = mapping
    .filter((m) => m.gates.includes(gate))
    .map((m) => `satisfies:${taskId}#${m.alias}`);
  return [evidence, ...links].join(';');
}

function epicPlan(task: Task, storeRoot: string): DonePlan {
  const blocker: DonePlanBlocker = {
    code: 'epic-rollup',
    message: `${task.id} is an epic; it completes through its children, not through derived evidence.`,
    next: step(`cleo complete ${task.id}`, 'Epic completion uses the existing child rollup.'),
  };
  return {
    taskId: task.id,
    runFrom: storeRoot,
    changeSet: {
      source: 'none',
      executionRoot: storeRoot,
      rootSource: 'store',
      files: [],
      deletedFiles: [],
      docs: [],
      decisions: [],
      candidates: [],
      implementedEvidence: null,
      blockers: [],
      warnings: [],
    },
    gates: [],
    toolRuns: [],
    typedGates: [],
    acMapping: [],
    needsSatisfies: [],
    blockers: [blocker],
    commands: [],
    ready: false,
    next: blocker.next,
  };
}

/** Normalise `--satisfies` and reject aliases the task does not have. */
function normaliseSatisfies(
  taskId: string,
  satisfies: readonly string[] | 'all' | undefined,
  rows: readonly AcRow[],
): readonly string[] | 'all' | undefined {
  if (satisfies === undefined || satisfies === 'all') return satisfies;
  const aliases = satisfies.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const known = new Set(rows.map((r) => `AC${r.ordinal}`));
  const unknown = aliases.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `--satisfies names criteria ${taskId} does not have: ${unknown.join(', ')}`,
      { fix: `cleo show ${taskId} --full  # criteria: ${[...known].join(', ') || 'none'}` },
    );
  }
  return aliases;
}

/**
 * Plan the evidence `cleo done` would record for a task. Read-only: executes
 * no tool or typed gate and writes nothing.
 *
 * @param taskId - Task to plan.
 * @param opts - Store root, invocation directory, `--satisfies`, `--pr`.
 * @returns The plan: change set, gates, tool runs, AC mapping, ordered
 *   blockers and the runnable commands.
 * @throws CleoError(NOT_FOUND) for an unknown task; CleoError(VALIDATION_ERROR)
 *   for a `--satisfies` alias the task does not have.
 * @example
 * ```ts
 * const plan = await deriveTaskEvidence('T123', { satisfies: ['AC2'] });
 * for (const cmd of plan.commands) console.log(cmd);
 * ```
 * @task T12623
 */
export async function deriveTaskEvidence(
  taskId: string,
  opts: DeriveTaskEvidenceOptions = {},
): Promise<DonePlan> {
  const storeRoot = opts.projectRoot ?? getProjectRoot();
  const accessor = await getTaskAccessor(storeRoot);
  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`, {
      fix: `cleo find "${taskId}"`,
    });
  }
  if (task.type === 'epic') return epicPlan(task, storeRoot);
  const rows = [...(await accessor.getAcRows(taskId))].sort((a, b) => a.ordinal - b.ordinal);
  const satisfies = normaliseSatisfies(taskId, opts.satisfies, rows);
  const policy = await loadVerificationGatePolicy(storeRoot);

  const changeSet = await deriveTaskChangeSet(
    { task, storeRoot, cwd: opts.cwd, prNumber: opts.prNumber },
    opts.deps,
  );
  const root = changeSet.executionRoot;
  // T12656 AC2: whether the LATEST implementation merged, and through which
  // PR, is judged by the one function `cleo complete` and `tool:test` use —
  // on the change set derived above, resolved only when needed.
  let merge: Promise<TaskMergeInfo> | undefined;
  const mergeInfo = (): Promise<TaskMergeInfo> => {
    merge ??= taskChangeMergeState(task, storeRoot, {
      derived: changeSet,
      executionRoot: root,
      ...(opts.deps ? { changeSet: opts.deps } : {}),
    });
    return merge;
  };
  // T12635 (D11150): a scoped testsPassed only stands before merge. Once the
  // change has merged, merged CI or a full run supersedes it; a tree-bound
  // test-run also stops standing once its tree moves (T12965). T12656: the
  // same rule `cleo complete` enforces (one shared function).
  const supersededReason = await testsPassedSupersededReason(
    task.verification?.evidence?.testsPassed?.atoms ?? [],
    {
      mergeState: mergeInfo,
      // T12965 review M2: the change-set root, as `cleo complete` and the
      // `test-run:` binding compute it.
      currentTree: () => captureTreeHash(root),
    },
  );
  const superseded = supersededReason !== null;
  if (supersededReason) changeSet.warnings.push(supersededReason);
  const passed = (gate: VerificationGate): boolean =>
    task.verification?.gates?.[gate] === true && !(gate === 'testsPassed' && superseded);
  const pending = policy.requiredGates.filter((g) => !passed(g));
  const decisionOnly =
    changeSet.source === 'docs' && (changeSet.implementedEvidence ?? '').startsWith('decision:');

  // T12634 (D11149): a merged PR (not stacked) proves testsPassed/qaPassed by
  // its merge-commit CI when the project opts in, so no local tool run is
  // planned for them. T12959 review: only the PR that carries the latest
  // implementation (as `cleo complete` records it), never one that merely
  // cites the task. T12671: a component landed by an integration PR is judged
  // on the integration PR's CI, linked through the component (`<c>@<n>`).
  const ciUsable =
    readCiSatisfies(storeRoot) &&
    ciPlannable(
      storeRoot,
      ![...changeSet.files, ...changeSet.deletedFiles].every(isCiDocumentPath),
    );
  const ciPr = ciUsable
    ? await mergeInfo().then((info) => (info.state === 'merged' ? info.prRef : null))
    : null;
  const toolRuns: DonePlanToolRun[] = [];
  if (!decisionOnly && ciPr === null) {
    for (const gate of pending) {
      for (const tool of GATE_TOOLS[gate] ?? []) {
        // T12635: before merge, test only the affected packages when declared.
        // T12959 review: the plan asks the one planner a scope-aware tool:test
        // asks (`testing.preferAffected`, the merge state — an unknown one
        // plans the full run complete accepts — and untested dependents), so
        // the run `cleo done` makes is the run validation repeats, never a
        // second one with another scope.
        const scoped =
          tool === 'test'
            ? await planScopedTestRun(storeRoot, root, {
                wait: opts.waitForTestSlot === true,
                mergeState: mergeInfo,
              })
            : null;
        // T13125: a whole-suite local run where merged-PR CI would carry the
        // gate is named as such, with ci:<pr> as the preferred evidence.
        if (scoped?.scope === 'full' && ciUsable) {
          const why = scoped.reason ?? 'the affected scope does not apply';
          changeSet.warnings.push(
            `${gate}: this plans a whole-suite local tool:test (${why})` +
              (why.includes('ci:<pr>')
                ? ''
                : '; evidence.ciSatisfies is set, so ci:<pr> once the PR merges is the preferred evidence and needs no local run'),
          );
        }
        toolRuns.push(
          scoped?.scope === 'affected'
            ? await planToolRun('test-affected', gate, storeRoot, root, scoped.run.command)
            : scoped?.scope === 'pending'
              ? {
                  tool: 'test-affected',
                  gate,
                  command: null,
                  source: 'project-context',
                  cache: 'miss',
                  reason: scoped.reason,
                }
              : await planToolRun(tool, gate, storeRoot, root),
        );
      }
    }
  }
  const typedGates = planTypedGates(task, rows);
  const acMapping = mapCriteria(task, rows, typedGates, changeSet, pending, satisfies);

  const gates: DonePlanGate[] = policy.requiredGates.map((gate) => {
    const raw =
      gate === 'implemented'
        ? changeSet.implementedEvidence
        : GATE_TOOLS[gate]
          ? toolGateEvidence(gate, toolRuns, decisionOnly, ciPr)
          : null;
    return {
      gate,
      required: true,
      passed: passed(gate),
      evidence: passed(gate) ? null : withSatisfies(taskId, gate, raw, acMapping),
    };
  });

  const isCode = classifyEvidenceTask({ task }) === 'code';
  const acBlocker = acMappingBlocker(taskId, acMapping, pending);
  const derivedBlockers = orderBlockers([
    ...changeSet.blockers,
    ...toolAndTypedGateBlockers(taskId, isCode, toolRuns, typedGates, root),
    ...(acBlocker ? [acBlocker] : []),
    ...manualGateBlockers(taskId, gates),
  ]);

  const cd = changeSet.rootSource === 'task-worktree' ? `cd ${shellQuote(root)} && ` : '';
  // D11151: each earlier own-branch PR is its own implemented attempt, recorded
  // first so the stored implemented evidence ends on the primary (latest) PR.
  const additionalImplemented = passed('implemented')
    ? []
    : (changeSet.additionalPrs ?? []).flatMap((extra) => {
        const ev = withSatisfies(taskId, 'implemented', extra.implementedEvidence, acMapping);
        return ev === null ? [] : [ev];
      });
  const blockers = orderBlockers([
    ...derivedBlockers,
    ...(task.status === 'done'
      ? []
      : await readinessBlockers({
          taskId,
          storeRoot,
          changeSet,
          needsTree: toolRuns.length > 0 || typedGates.length > 0,
          gates,
          additionalImplemented,
          blocked: derivedBlockers.length > 0,
          preview: opts.previewEvidence ?? defaultPreviewEvidence,
        })),
  ]);
  const commands = additionalImplemented.map(
    (ev) => `${cd}cleo verify ${taskId} --gate implemented --evidence ${shellQuote(ev)}`,
  );
  commands.push(
    ...gates
      .filter((g) => !g.passed && g.evidence !== null)
      .map(
        (g) =>
          `${cd}cleo verify ${taskId} --gate ${g.gate} --evidence ${shellQuote(g.evidence ?? '')}`,
      ),
  );
  if (task.status === 'done') {
    changeSet.warnings.push(`${taskId} is already done; nothing is left to record.`);
  } else if (changeSet.implementedEvidence !== null || passed('implemented')) {
    commands.push(`${cd}cleo complete ${taskId}`);
  }
  const next =
    blockers[0]?.next ??
    (commands[0] ? step(commands[0], 'Every gate is derivable; record them in order.') : null);

  return {
    taskId,
    runFrom: root,
    changeSet,
    gates,
    ...(additionalImplemented.length > 0 ? { additionalImplemented } : {}),
    toolRuns,
    typedGates,
    acMapping,
    needsSatisfies: acMapping.filter((m) => !m.mapped).map((m) => m.alias),
    blockers,
    commands,
    ready: blockers.length === 0 && commands.length > 0,
    next,
  };
}

/**
 * {@link deriveTaskEvidence} as an {@link EngineResult}, for the CLI handler:
 * a `CleoError` (unknown task, bad `--satisfies`) becomes a typed failure
 * instead of a throw, so the handler stays a thin renderer.
 *
 * @param taskId - Task to plan.
 * @param opts - Same options as {@link deriveTaskEvidence}.
 * @returns The plan, or the refusal with its exit code and fix.
 * @example
 * ```ts
 * const result = await planTaskDone('T123', { satisfies: 'all' });
 * if (result.success) console.log(result.data.commands);
 * ```
 * @task T12623
 */
export async function planTaskDone(
  taskId: string,
  opts: DeriveTaskEvidenceOptions = {},
): Promise<EngineResult<DonePlan>> {
  try {
    return engineSuccess(await deriveTaskEvidence(taskId, opts));
  } catch (err) {
    return cleoErrorToEngineResult<DonePlan>(err, 'E_DONE_PLAN_FAILED', 'cleo done --plan failed');
  }
}

/**
 * Parse the `--satisfies` / `--pr` CLI flags shared by `cleo done` and
 * `cleo verify --auto` into planner options.
 *
 * @param satisfies - Raw `--satisfies` value (`AC1,AC3` or `all`), if given.
 * @param pr - Raw `--pr` value, if given.
 * @returns The options, or the refusal text for an invalid PR number.
 * @example
 * ```ts
 * parseDoneOptions('AC1,AC3', '42'); // { ok: true, options: { satisfies: ['AC1','AC3'], prNumber: 42 } }
 * ```
 * @task T12625
 */
export function parseDoneOptions(
  satisfies: unknown,
  pr: unknown,
):
  | { ok: true; options: Pick<DeriveTaskEvidenceOptions, 'satisfies' | 'prNumber'> }
  | { ok: false; message: string } {
  const raw = typeof satisfies === 'string' ? satisfies.trim() : '';
  const prNumber = typeof pr === 'string' ? Number(pr) : undefined;
  if (prNumber !== undefined && !(Number.isInteger(prNumber) && prNumber > 0)) {
    return { ok: false, message: `--pr must be a positive PR number, got "${String(pr)}"` };
  }
  return {
    ok: true,
    options: {
      ...(raw === '' ? {} : { satisfies: raw.toLowerCase() === 'all' ? 'all' : raw.split(',') }),
      ...(prNumber !== undefined ? { prNumber } : {}),
    },
  };
}
