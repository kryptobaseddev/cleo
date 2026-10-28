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
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type {
  AcRow,
  DataAccessor,
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
  WorktreeIntegrationPlan,
} from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { TERMINAL_TASK_STATUSES } from '@cleocode/contracts/status-registry.js';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { getProjectRoot } from '../paths.js';
import { readProjectInfoAtDirectorySync } from '../project-scope.js';
import { isCiDocumentPath, readCiChecks, readCiSatisfies } from '../release/ci-evidence.js';

import { createOperationExecutionContext } from '../store/background-ops.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import {
  cleoConfigSchemaFor,
  evidenceProjectContext,
  isCleoConfigOnlyChange,
  isNonCodeOnlyChange,
  planScopedTestRun,
  scopedChangedPaths,
  standalonePackage,
} from './affected-packages.js';
import { type TaskMergeInfo, taskChangeMergeState } from './affected-scope.js';
import { type ChangeSetDeps, deriveTaskChangeSet } from './change-set.js';
import {
  checkGateEvidenceMinimumDetailed,
  type classifyEvidenceTask,
  extractTaskAcFilesWithProvenance,
  taskEvidenceKindReport,
} from './evidence.js';
import { PROFILE_WAIVED_GATES } from './gate-notes.js';
import {
  extractTypedGates,
  type TypedResultDrift,
  typedGateAdmissionMs,
  typedResultDrift,
  typedResultStaleReason,
} from './gate-runner.js';
import { gateStaleness } from './gate-staleness.js';
import { changedTestFiles } from './test-run-binding.js';
import { captureTreeHash, computeCacheKey, readCacheEntry } from './tool-cache.js';
import { captureEnvFingerprint, captureResourceEnv } from './tool-cache-env.js';
import { type ResolvedToolCommand, resolveToolCommand } from './tool-resolver.js';
import {
  gateProfileOf,
  loadVerificationGatePolicy,
  requiredGatesFor,
} from './verification-policy.js';

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
  'typed-gate-not-run',
  'test-run-needed',
  'qa-run-needed',
  'ac-mapping-needed',
  'manual-gate',
  'gate-not-derivable',
  'dependency-unresolved',
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
  /**
   * Explicit commit (`--commit <sha>`, T13799): work already on the default
   * branch that no PR or branch cites; verified by the change-set derivation.
   */
  commit?: string;
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
  /**
   * The typed gates run in this `cleo done` (`--run-typed`), so a gate with no
   * current pass is not yet a blocker (T13655).
   */
  runTyped?: boolean;
  /** `--no-integrate`: the plan shows the worktree integration as skipped (T14053). */
  noIntegrate?: boolean;
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
 * - branch: the checked-out HEAD must BE the change-set commit, whatever ref
 *   holds it (T14059: a clean checkout detached at the task branch's tip
 *   measures the same tree; a dirty tree is already a plan blocker);
 * - pr: the merge commit must be an ancestor of the checked-out HEAD.
 */
function checkoutBlocker(
  taskId: string,
  cs: TaskChangeSet,
  ciSatisfies: boolean,
): DonePlanBlocker | null {
  const root = cs.executionRoot;
  const head = gitRead(root, ['rev-parse', 'HEAD']);
  const short = (sha: string | null | undefined): string => (sha ?? 'nothing').slice(0, 12);
  if (cs.source === 'branch') {
    if (head !== null && head === cs.commitSha) return null;
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
  if (cs.source === 'commit' && cs.commitSha) {
    // T13799: a landed commit, like a merge, must be in the tested tree.
    if (
      head !== null &&
      gitRead(root, ['merge-base', '--is-ancestor', cs.commitSha, 'HEAD']) !== null
    )
      return null;
    return {
      code: 'checkout-required',
      message: `${root} has ${short(head)} checked out, which does not contain ${taskId}'s commit ${short(cs.commitSha)}; the tools would measure a tree without the change.`,
      next: {
        command: `git -C ${shellQuote(root)} switch --detach ${cs.baseRef ?? cs.commitSha} && cleo done ${taskId} --commit ${cs.commitSha}`,
        why: 'Tests, lint, typecheck and typed gates must run on a tree that holds the commit implemented records.',
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
    // T13429: intended, not a bug — the tools must measure the MERGED tree
    // (the default branch with the change). A squash- or rebase-merged task
    // branch never contains the merge commit even when its diff is the same,
    // and a checkout that has not fetched since the merge does not have it at
    // all; the remedy says which, so `switch` never fails on a missing commit.
    const local = gitRead(root, ['cat-file', '-e', `${cs.mergeCommitSha}^{commit}`]) !== null;
    const fetch = local ? '' : `git -C ${shellQuote(root)} fetch origin && `;
    // T13463: the command switches to the LATEST merge, which holds every
    // earlier one; name it when the missing commit is an earlier PR's.
    const target =
      missing.sha === cs.mergeCommitSha
        ? ''
        : ` The command switches to PR #${cs.prNumber}'s merge commit ${short(cs.mergeCommitSha)}, which contains it.`;
    return {
      code: 'checkout-required',
      message:
        `${root} has ${short(head)} checked out, which does not contain PR #${missing.pr}'s merge commit ${short(missing.sha)}` +
        `${local ? '' : ' (not fetched into this checkout yet)'}.${target} A squash- or rebase-merged branch never ` +
        'contains its merge commit, so the tools must run on the merged tree' +
        (ciSatisfies
          ? '; evidence.ciSatisfies is set, so ci:<pr> needs no local run.'
          : '. (Setting evidence.ciSatisfies would let ci:<pr>, the merged CI, stand in.)'),
      next: {
        command: `${fetch}git -C ${shellQuote(root)} switch --detach ${cs.mergeCommitSha} && cleo done ${taskId}`,
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
    const checkout = checkoutBlocker(taskId, cs, readCiSatisfies(input.storeRoot));
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
    : resolveToolCommand(tool, storeRoot, {
        executionRoot: root,
        projectContext: evidenceProjectContext(storeRoot, root),
      });
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

/**
 * Stored typed-gate results, aligned with criteria by acceptance index.
 *
 * T14063: a stored pass is checked the way `cleo complete` checks it, inputs
 * and environment included ({@link typedResultDrift}), from the tree the plan
 * tells the caller to complete in. A pass completion would refuse is
 * `not-run`, with completion's reason and the re-bind command.
 */
async function planTypedGates(
  task: Task,
  rows: readonly AcRow[],
  storeRoot: string,
  runFrom: string,
): Promise<DonePlanTypedGate[]> {
  const results = task.verification?.gateResults ?? [];
  const projectRoot = resolve(storeRoot);
  const projectId = readProjectInfoAtDirectorySync(
    projectRoot,
    join(projectRoot, '.cleo'),
  ).projectId;
  const owner = projectId ? { projectId, projectRoot } : undefined;
  const typed = extractTypedGates(task.acceptance ?? []);
  const planned = typed.map(({ gate, originalIndex }) => {
    const stored = results.find((r) => r.index === originalIndex);
    const row = rows[originalIndex];
    // A pass `cleo complete` would refuse as stale (an older criterion or gate
    // definition, another task, owner or criterion id) is not a pass in the
    // plan: the one predicate completion's revalidation uses (T13502).
    const stale =
      stored?.result === 'pass' &&
      (row === undefined || typedResultStaleReason(stored, task, gate, row, owner) !== null);
    // T13752: an `error` is no verdict (a cache-only write found no cached
    // pass, or the run did not finish), so it never reads as "last failed".
    const status: DonePlanTypedGate['status'] =
      stored === undefined || stored.result === 'skipped' || stored.result === 'error' || stale
        ? 'not-run'
        : stored.result === 'pass'
          ? 'pass'
          : 'fail';
    const entry: DonePlanTypedGate = {
      alias: `AC${row?.ordinal ?? originalIndex + 1}`,
      kind: gate.kind,
      ...(gate.req ? { req: gate.req } : {}),
      status,
    };
    return { entry, originalIndex };
  });
  if (!planned.some(({ entry }) => entry.status === 'pass')) return planned.map((p) => p.entry);
  const drift = await planTypedDrift(task, rows, projectRoot, projectId, runFrom);
  return planned.map(({ entry, originalIndex }): DonePlanTypedGate => {
    const refused = entry.status === 'pass' ? drift.get(originalIndex) : undefined;
    return refused ? { ...entry, status: 'not-run', ...refused } : entry;
  });
}

/**
 * Completion's typed input revalidation, run for the plan under its own
 * budget (T14063). A refusal that is not per gate (no project identity,
 * criteria out of step) applies to every stored pass, as it would at completion.
 */
async function planTypedDrift(
  task: Task,
  rows: readonly AcRow[],
  projectRoot: string,
  projectId: string | undefined,
  runFrom: string,
): Promise<Map<number, TypedResultDrift>> {
  const everyPass = (reason: string): Map<number, TypedResultDrift> =>
    new Map(
      (task.verification?.gateResults ?? [])
        .filter((r) => r.result === 'pass')
        .map((r) => [r.index, { reason }]),
    );
  if (!projectId) return everyPass('cannot be revalidated: the project has no stable identity');
  const gates = extractTypedGates(task.acceptance ?? []).map(({ gate }) => gate);
  const execution = createOperationExecutionContext(
    {
      projectId,
      projectRoot,
      actor: process.env.CLEO_AGENT_ID ?? 'cleo',
      operation: 'tasks.done.plan',
      idempotencyKey: `${task.id}:${randomUUID()}`,
    },
    { budgetMs: typedGateAdmissionMs(gates) },
  );
  try {
    return await typedResultDrift(task, rows, { projectRoot, execution }, runFrom);
  } catch (error) {
    return everyPass(
      `cannot be revalidated: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    execution.close();
  }
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
  runTyped = false,
): DonePlanAcMapping[] {
  const recorded = recordedCriteria(task);
  const changed = new Set(changeSet.files.map(normaliseRepoPath));
  const writable = (gates: VerificationGate[]): VerificationGate[] =>
    gates.filter((g) => pending.includes(g));
  const typedAliases = new Set(typedGates.map((g) => g.alias));
  // T13799: when every criterion is a typed gate (a REQ-only task), those gates
  // are the task's whole definition, so the change and its QA serve them too.
  const onlyTyped = rows.length > 0 && rows.every((r) => typedAliases.has(`AC${r.ordinal}`));
  return rows.map((row) => {
    const alias = `AC${row.ordinal}`;
    const base = { alias, id: row.id, text: row.text };
    if (satisfies === 'all' || satisfies?.includes(alias)) {
      const gates = writable([...EVIDENCE_GATES]);
      return { ...base, mapped: true, gates, basis: 'agent' };
    }
    // T13799: with --run-typed, cleo done runs a not-yet-run typed gate before
    // the write and refuses on failure, so its criterion links to that run.
    if (
      typedGates.some(
        (g) => g.alias === alias && (g.status === 'pass' || (runTyped && g.status === 'not-run')),
      )
    ) {
      const gates = writable(onlyTyped ? [...EVIDENCE_GATES] : ['testsPassed']);
      return { ...base, mapped: true, gates, basis: 'typed-gate' };
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
  nonCode: boolean,
  cleoConfig: boolean,
  configSuffix = '',
): string | null {
  if (decisionOnly) return 'note:decision-only implementation, no code changed';
  if (ciPr !== null) return `ci:${ciPr}`;
  // T13758: CLEO validates the changed CLEO config against its schema at verify.
  if (cleoConfig) return 'tool:config-schema';
  // T13745: validates as not applicable (no test reads the change); runs nothing.
  if (nonCode && gate === 'testsPassed') return 'tool:test';
  const atoms = runs
    .filter((r) => r.gate === gate && r.cache !== 'unresolved')
    .map((r) => `tool:${r.tool}`);
  return atoms.length > 0 ? `${atoms.join(';')}${configSuffix}` : null;
}

/** Blockers from tool runs and typed gates, before any AC question. */
function toolAndTypedGateBlockers(
  taskId: string,
  code: boolean,
  runs: readonly DonePlanToolRun[],
  typedGates: readonly DonePlanTypedGate[],
  root: string,
  runTyped: boolean,
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
        gate: run.gate,
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
        gate: run.gate,
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
        gate,
      });
    }
  }
  for (const typed of typedGates) {
    const label = `Typed gate ${typed.alias} (${typed.kind}${typed.req ? ` ${typed.req}` : ''})`;
    if (typed.status === 'fail') {
      out.push({
        code: 'typed-gate-failed',
        message: `${label} last failed.`,
        next: step(
          `cleo verify ${taskId} --run`,
          'Re-run the typed gates and fix the failing one.',
        ),
      });
    } else if (typed.status === 'not-run' && !runTyped) {
      // T13655: completion refuses a typed gate with no current bound pass
      // (never run, or stale), so the plan must not call the task ready.
      // T14063: a stored pass completion would refuse names completion's
      // reason and the command that re-binds it.
      out.push({
        code: 'typed-gate-not-run',
        message: typed.reason
          ? `${label}'s stored pass would be refused by cleo complete: ${typed.reason}.`
          : `${label} has no current passing result; cleo complete refuses it until it passes.`,
        next: typed.fix
          ? step(
              typed.fix,
              'Re-binds the typed result in this tree and environment; only typed gates with no current pass run again.',
            )
          : step(
              `cleo verify ${taskId} --run && cleo done ${taskId}`,
              'cleo done executes no typed gate: run them with cleo verify --run (it caches each pass), or pass --run-typed.',
            ),
      });
    }
  }
  return out;
}

/**
 * The changed test files of a standalone (non-workspace) project, or none in
 * a workspace, outside git, or with no test file changed (T13403). Read from
 * the task's change set only, never the working tree (T13917: a shared dirty
 * checkout handed a record-only task 18 unrelated tests).
 */
function standaloneChangedTests(root: string, files: readonly string[]): string[] {
  if (standalonePackage(root) === null) return [];
  return changedTestFiles(root, files);
}

/**
 * The blocker for a task with no change set (T13917). A non-code task
 * (research, documentation) is closed by its document or decision, never by
 * a new branch; a code task may still be record-only, so both routes are
 * named.
 */
function noChangeSetBlocker(
  task: Task,
  kind: ReturnType<typeof classifyEvidenceTask>,
): DonePlanBlocker {
  const id = task.id;
  const record =
    `cleo docs add ${id} <file> --type ${kind === 'research' ? 'research' : 'note'} --slug <kebab>` +
    ` (or: cleo memory decision-store --decision "<what>" --rationale "<why>" --linked-task ${id})`;
  if (kind !== 'code') {
    return {
      code: 'no-change-set',
      message:
        `${id} is a ${kind} task with no attached document or linked decision, and its evidence ` +
        'is that document or decision: no test, lint or typecheck applies.',
      next: step(
        record,
        kind === 'research'
          ? 'implemented then binds as files:<doc> or decision:<id>, the only gate a research task needs (verification.requiredGatesByKind).'
          : 'implemented and documented then bind as files:<doc>, the gates a documentation task needs (verification.requiredGatesByKind).',
      ),
    };
  }
  return {
    code: 'no-change-set',
    message:
      `No merged PR, task branch or attached document references ${id}. If ${id} changed code, ` +
      `commit it on task/${id} (or pass --pr <n>); if it changed none, attach its record or link a decision.`,
    next: step(
      `git switch -c task/${id}`,
      `Or, for a task with no code change: ${record}; a documentation task declares its documents ` +
        `(cleo update ${id} --files <doc paths>). cleo done never plans tests or lint from the working tree.`,
    ),
  };
}

/** The step that binds a targeted run of a standalone project's changed tests (T13403). */
function testRunNeededBlocker(
  taskId: string,
  gate: VerificationGate,
  files: readonly string[],
  configSuffix = '',
): DonePlanBlocker {
  const named = `${files.slice(0, 5).join(' ')}${files.length > 5 ? ` … (${files.length} files)` : ''}`;
  return {
    code: 'test-run-needed',
    gate,
    message:
      `${gate}: this single-package project's tool:test would run the whole suite. Run the ` +
      `changed test file(s) ${named} with a JSON reporter and record the report as test-run:.`,
    next: step(
      `cleo verify ${taskId} --gate ${gate} --evidence 'test-run:<vitest-json-report>${configSuffix}'`,
      'Write the report to a gitignored path (vitest run <files> --reporter=json ' +
        '--outputFile=<path>; jest <files> --json --outputFile=<path>); it must pass every ' +
        'changed test file. tool:test (the whole suite) also satisfies the gate.',
    ),
  };
}

/**
 * The refusal that replaces a whole-suite `tool:test` (T13641, T13647 owner
 * decision 2026-10-12): `cleo done` never launches an unscoped suite on its own. Names why the affected scope
 * does not apply, why the recorded scoped run no longer stands (with the
 * differing files, T13642), and the scoped evidence to record instead.
 */
function wholeSuiteRefusedBlocker(
  taskId: string,
  gate: VerificationGate,
  scopeReason: string | null,
  supersededReason: string | null,
  ciUsable: boolean,
  configSuffix = '',
): DonePlanBlocker {
  return {
    code: 'test-run-needed',
    gate,
    message:
      `${gate}: the only test run cleo done could plan is the whole suite ` +
      `(${scopeReason ?? 'the affected scope does not apply'}), and cleo done never runs a whole suite on its own.` +
      (supersededReason ? ` ${supersededReason}` : ''),
    next: step(
      `cleo verify ${taskId} --gate ${gate} --evidence 'test-run:<vitest-json-report>${configSuffix}'`,
      'Run the tests that cover the change with a JSON reporter (vitest run <files> --reporter=json ' +
        '--outputFile=<path>) and record the report' +
        (ciUsable
          ? ", or ci:<pr> once the merged PR's CI is green"
          : // T13745: a change outside every package (root config) has no targeted
            // run; merged CI with covering rules is its honest route.
            ', or ci:<pr> once the PR merges if you set evidence.ciSatisfies and evidence.ciChecks ' +
            '(evidence.ciChecks.covering maps root config paths to the CI jobs that check them)') +
        ', or declare testing.affectedCommand in .cleo/project-context.json so cleo done can plan a ' +
        'scoped tool:test-affected. A full run is your explicit choice: cleo verify --gate testsPassed --evidence tool:test.',
    ),
  };
}

/**
 * The step that binds qa-run receipts of a standalone project's changed roots
 * instead of a fresh whole-project lint/typecheck (T13427).
 */
function qaRunNeededBlocker(
  taskId: string,
  files: readonly string[],
  checks: readonly string[],
  subject = 'this single-package project',
  configSuffix = '',
): DonePlanBlocker {
  const dirs = [
    ...new Set(
      // T13917: the task's change set, never the whole working tree.
      files
        .filter((p) => !isCiDocumentPath(p))
        .map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.')),
    ),
  ].sort();
  const roots = `${dirs.slice(0, 5).join(' ')}${dirs.length > 5 ? ` … (${dirs.length} dirs)` : ''}`;
  const atoms = `${checks.map((c) => `qa-run:<${c}-receipt.json>`).join(';')}${configSuffix}`;
  return {
    code: 'qa-run-needed',
    gate: 'qaPassed',
    message:
      `qaPassed: ${subject} has no recorded ${checks.join(' or ')} result for ` +
      `the current tree, and tool:${checks[0]} would check the whole project. Run ` +
      `${checks.join(' and ')} over the changed roots (${roots || 'none'}) and record a qa-run receipt for each.`,
    next: step(
      `cleo verify ${taskId} --gate qaPassed --evidence '${atoms}'`,
      'Each receipt is JSON: {"kind":"typecheck"|"lint","command":[…],"exitCode":0,' +
        '"diagnostics":{"errors":0},"roots":[…],"startTime":<epoch ms>}; its roots must hold every ' +
        'changed code file. A check with a fresh cached result binds as tool:<check> alongside. ' +
        'tool:lint;tool:typecheck (the whole project) also satisfies the gate.',
    ),
  };
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

/**
 * A required evidence gate that is neither passed nor planned (T14036): no
 * evidence derives for it and no other blocker names it, so `cleo complete`
 * would refuse while the plan said ready. A gate whose recorded pass no longer
 * stands (T14037) says why.
 */
function gateNotDerivableBlockers(
  taskId: string,
  gates: readonly DonePlanGate[],
  planned: readonly DonePlanBlocker[],
  changeSet: TaskChangeSet,
  staleReason: (gate: VerificationGate) => string | null,
): DonePlanBlocker[] {
  return gates
    .filter(
      (g) =>
        g.required &&
        !g.passed &&
        g.evidence === null &&
        EVIDENCE_GATES.includes(g.gate) &&
        !planned.some((b) => b.gate === g.gate) &&
        // A change-set blocker already says why implemented, or anything with
        // no change set at all, does not derive.
        !(g.gate === 'implemented' && changeSet.blockers.length > 0) &&
        changeSet.source !== 'none',
    )
    .map((g) => {
      const stale = staleReason(g.gate);
      return {
        code: 'gate-not-derivable' as const,
        gate: g.gate,
        message:
          `${g.gate} is required and ${stale ? `its recorded evidence no longer stands (${stale})` : 'not passed'}, ` +
          'and cleo done cannot derive evidence for it here, so cleo complete would refuse.',
        next: step(
          `cleo verify ${taskId} --gate ${g.gate} --evidence '<atoms>'`,
          checkGateEvidenceMinimumDetailed(g.gate, [])?.message ?? `Record ${g.gate} evidence.`,
        ),
      };
    });
}

/**
 * A `depends` edge to a task that is not terminal (T14036): `cleo complete`
 * refuses it with the same rule ({@link TERMINAL_TASK_STATUSES}); a dependency
 * that no longer exists never blocks.
 */
async function dependencyBlockers(
  task: Task,
  accessor: Pick<DataAccessor, 'loadTasks'>,
): Promise<DonePlanBlocker[]> {
  if (!task.depends?.length) return [];
  return (await accessor.loadTasks(task.depends))
    .filter((d) => !TERMINAL_TASK_STATUSES.has(d.status))
    .map((d) => ({
      code: 'dependency-unresolved' as const,
      message: `${task.id} depends on ${d.id} (${d.status}), which is not done; cleo complete refuses until it is.`,
      next: step(
        `cleo complete ${d.id}`,
        `Or, when the edge is stale, drop it (cleo update ${task.id} --remove-depends ${d.id}) or ` +
          `record an audited override (cleo complete ${task.id} --waive-depends "<reason>").`,
      ),
    }));
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

/**
 * An epic's plan (T14073): it completes through `cleo complete`, never through
 * derived evidence. Its "Complete child" criteria are covered by the done
 * children ({@link computeAcCoverage}); the plan names what `cleo complete`
 * would still refuse: an unfinished child, or a criterion with no evidence and
 * the `cleo verify` write that binds it.
 */
async function epicPlan(
  task: Task,
  storeRoot: string,
  accessor: Pick<DataAccessor, 'getAcRows' | 'getAcBindings' | 'getChildren'>,
): Promise<DonePlan> {
  const { computeAcCoverage } = await import('./ac-coverage-gate.js');
  const coverage = await computeAcCoverage(task.id, accessor);
  const unbound = coverage.ok ? [] : coverage.unsatisfied;
  const children = unbound.flatMap((u) => (u.childTaskId ? [u.childTaskId] : []));
  const criteria = unbound.filter((u) => u.childTaskId === undefined);
  const bind = criteria.map(
    (u) =>
      `cleo verify ${task.id} --gate implemented --evidence 'pr:<n>;files:<changed paths>;satisfies:${task.id}#${u.alias}'`,
  );
  const blocker: DonePlanBlocker =
    unbound.length === 0
      ? {
          code: 'epic-rollup',
          message: `${task.id} is an epic; its children are done and every criterion is covered.`,
          next: step(`cleo complete ${task.id}`, 'Epic completion uses the existing child rollup.'),
        }
      : children.length > 0
        ? {
            code: 'epic-rollup',
            message: `${task.id} is an epic; it completes through its children, and ${children.join(', ')} ${children.length === 1 ? 'is' : 'are'} not done.`,
            next: step(`cleo show ${children[0]}`, 'Finish every child before the epic.'),
          }
        : {
            code: 'epic-rollup',
            message: `${task.id} is an epic; its children cover their own criteria, but cleo complete needs evidence for ${criteria.map((u) => u.alias).join(', ')}.`,
            next: step(
              bind[0] ?? `cleo complete ${task.id}`,
              'Bind each criterion to the merged work that proves it, then cleo complete.',
            ),
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
    commands: unbound.length === 0 ? [`cleo complete ${task.id}`] : bind,
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
    // @sync-invariant task.ac.integrity a --satisfies alias must name one of the task's criteria; an unknown one is refused before any binding is written
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
    // @sync-invariant none:input-shape planning an unknown task is refused before anything is written
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`, {
      fix: `cleo find "${taskId}"`,
    });
  }
  // T14053: what completion will do with the worktree branch, from local refs.
  const integration = await planCompletionIntegration(taskId, storeRoot, opts.noIntegrate);
  if (task.type === 'epic') return { ...(await epicPlan(task, storeRoot, accessor)), integration };
  const rows = [...(await accessor.getAcRows(taskId))].sort((a, b) => a.ordinal - b.ordinal);
  const satisfies = normaliseSatisfies(taskId, opts.satisfies, rows);
  const policy = await loadVerificationGatePolicy(storeRoot);

  // T13785: a parent whose work was split across its children closes on the
  // PRs its done children shipped, never on one picked PR.
  const doneChildIds = (await accessor.getChildren(taskId))
    .filter((c) => c.status === 'done')
    .map((c) => c.id);
  const changeSet = await deriveTaskChangeSet(
    {
      task,
      storeRoot,
      cwd: opts.cwd,
      prNumber: opts.prNumber,
      doneChildIds,
      ...(opts.commit !== undefined ? { commit: opts.commit } : {}),
    },
    opts.deps,
  );
  const root = changeSet.executionRoot;
  // T14001: the gates fit the task's kind (research: its doc or decision),
  // unless its change set or implemented evidence touches code (#2413 review).
  const evidenceKind = await taskEvidenceKindReport(
    task,
    storeRoot,
    [...changeSet.files, ...changeSet.deletedFiles],
    opts.cwd,
    opts.deps,
  );
  if (evidenceKind.reason) {
    changeSet.warnings.push(`${task.id} owes the code gates: ${evidenceKind.reason}.`);
  }
  const kind = evidenceKind.kind;
  const requiredGates = requiredGatesFor(policy, kind);
  // T13474: name the gate profile and what it waives, so a reviewer sees it.
  const profile = gateProfileOf(task);
  if (profile !== null && kind !== 'code') {
    changeSet.warnings.push(
      `${task.id} declares profile:${profile}: ${PROFILE_WAIVED_GATES.join(' and ')} are not applicable; it owes ${requiredGates.join(', ')}.`,
    );
  }
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
  // same rule `cleo complete` enforces (one shared function). T13427, T13644:
  // likewise for qa-run receipts. T14037: with complete's re-validation of
  // every recorded gate's atoms, through the one read-only gateStaleness.
  const staleness = await gateStaleness(task, storeRoot, {
    mergeState: mergeInfo,
    // T12965 review M2: the change-set root, as `cleo complete` and the
    // `test-run:` binding compute it.
    currentTree: () => captureTreeHash(root),
    root: () => root,
  });
  const staleReason = (gate: VerificationGate): string | null =>
    staleness.find((s) => s.gate === gate)?.reason ?? null;
  const supersededReason = staleReason('testsPassed');
  for (const s of staleness) changeSet.warnings.push(`${s.gate} no longer stands: ${s.reason}`);
  const passed = (gate: VerificationGate): boolean =>
    task.verification?.gates?.[gate] === true && staleReason(gate) === null;
  const pending = requiredGates.filter((g) => !passed(g));
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
  const testRunBlockers: DonePlanBlocker[] = [];
  const qaRunChecks: string[] = [];
  const standalone = standalonePackage(root) !== null;
  // T13428: a docs change set (a research or documentation deliverable) has
  // no code to test or typecheck, decision recorded yet or not: never plan a
  // whole suite or a typecheck for it.
  // T13745: a non-code-only change (docs, editor settings) has no test to run and
  // no TypeScript to typecheck: tool:test records that by absence, and a lint
  // (or structural) qa-run receipt holding the files stands for qaPassed.
  const nonCode =
    changeSet.source !== 'docs' &&
    isNonCodeOnlyChange([...changeSet.files, ...changeSet.deletedFiles]);
  // T13758: a change to CLEO-owned config alone is tested by CLEO's own schema
  // check of each file (tool:config-schema), for testsPassed and qaPassed.
  const cleoConfig =
    changeSet.source !== 'docs' &&
    changeSet.deletedFiles.length === 0 &&
    isCleoConfigOnlyChange(changeSet.files);
  // T13778: a change that also edits CLEO config composes tool:config-schema
  // (those files) with the run that covers the rest.
  const configSuffix =
    !cleoConfig && changeSet.files.some((p) => cleoConfigSchemaFor(p) !== null)
      ? ';tool:config-schema'
      : '';
  // T13917: with no change set there is nothing of the task's to test, lint
  // or typecheck; the working tree may hold anyone's work.
  const noChangeSet = changeSet.source === 'none';
  if (
    !noChangeSet &&
    !decisionOnly &&
    changeSet.source !== 'docs' &&
    ciPr === null &&
    !nonCode &&
    !cleoConfig
  ) {
    for (const gate of pending) {
      for (const tool of GATE_TOOLS[gate] ?? []) {
        // T13403: a standalone project is one package, the whole project, so
        // tool:test and tool:test-affected both run its whole suite. When the
        // change adds or edits test files, plan the targeted test-run the
        // binding accepts (it must run every one of them) instead.
        const targeted = tool === 'test' ? standaloneChangedTests(root, changeSet.files) : [];
        if (targeted.length > 0) {
          testRunBlockers.push(testRunNeededBlocker(taskId, gate, targeted, configSuffix));
          continue;
        }
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
        const run: DonePlanToolRun =
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
              : await planToolRun(tool, gate, storeRoot, root);
        // T13647 (owner decision 2026-10-12, "never run whole suites"): cleo
        // done never plans a whole-suite tool:test it would have to execute (a
        // cache miss). A result already cached for this tree runs nothing and
        // keeps its usual handling; otherwise the plan refuses and names the
        // scoped evidence to record, with the differing files when a carry was
        // refused (T13641, T13642).
        if (scoped?.scope === 'full' && run.cache === 'miss') {
          testRunBlockers.push(
            wholeSuiteRefusedBlocker(
              taskId,
              gate,
              scoped.reason,
              supersededReason,
              ciUsable,
              configSuffix,
            ),
          );
          continue;
        }
        // T13427: in a standalone project a missing lint/typecheck result
        // would be a fresh whole-project run; plan a qa-run receipt of the
        // changed roots instead. A cached result still binds as tool:.
        if (standalone && gate === 'qaPassed' && run.cache === 'miss') {
          qaRunChecks.push(tool);
          continue;
        }
        toolRuns.push(run);
      }
    }
  }
  if (qaRunChecks.length > 0) {
    testRunBlockers.push(
      qaRunNeededBlocker(taskId, changeSet.files, qaRunChecks, undefined, configSuffix),
    );
  }
  if (!noChangeSet && nonCode && ciPr === null && pending.includes('qaPassed')) {
    testRunBlockers.push(
      qaRunNeededBlocker(taskId, changeSet.files, ['lint'], 'this non-code change'),
    );
  }
  const typedGates = await planTypedGates(task, rows, storeRoot, root);
  const acMapping = mapCriteria(
    task,
    rows,
    typedGates,
    changeSet,
    pending,
    satisfies,
    opts.runTyped === true,
  );

  const gates: DonePlanGate[] = requiredGates.map((gate) => {
    const raw =
      gate === 'implemented'
        ? changeSet.implementedEvidence
        : GATE_TOOLS[gate]
          ? toolGateEvidence(gate, toolRuns, decisionOnly, ciPr, nonCode, cleoConfig, configSuffix)
          : null;
    return {
      gate,
      required: true,
      passed: passed(gate),
      evidence: passed(gate) ? null : withSatisfies(taskId, gate, raw, acMapping),
    };
  });

  const isCode = kind === 'code';
  const acBlocker = acMappingBlocker(taskId, acMapping, pending);
  // T14036: with every required gate already standing, complete re-judges the
  // recorded evidence and needs no change set, so its derivation blockers go.
  const allPassed = requiredGates.every(passed);
  const planned = [
    ...(allPassed
      ? []
      : changeSet.blockers.map((b) =>
          b.code === 'no-change-set' ? noChangeSetBlocker(task, kind) : b,
        )),
    ...toolAndTypedGateBlockers(taskId, isCode, toolRuns, typedGates, root, opts.runTyped === true),
    ...testRunBlockers,
    ...(acBlocker ? [acBlocker] : []),
    ...manualGateBlockers(taskId, gates),
  ];
  const derivedBlockers = orderBlockers([
    ...planned,
    ...gateNotDerivableBlockers(taskId, gates, planned, changeSet, staleReason),
    ...(task.status === 'done' ? [] : await dependencyBlockers(task, accessor)),
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
    // T13648: `cleo complete` has no --pr, so a plan judged through an
    // explicit PR finishes with `cleo done --pr`, which keeps that carrier.
    commands.push(
      opts.prNumber === undefined
        ? `${cd}cleo complete ${taskId}`
        : `${cd}cleo done ${taskId} --pr ${opts.prNumber}`,
    );
  }
  const next =
    blockers[0]?.next ??
    (commands[0] ? step(commands[0], 'Every gate is derivable; record them in order.') : null);
  const ready = blockers.length === 0 && commands.length > 0;
  const readyReason = notReadyReason(taskId, task.status, ready, blockers);
  // T14125: evidence never counts an untracked file; name the ones left out.
  const untrackedSetAside =
    task.status === 'done' ? [] : (scopedChangedPaths(root)?.untrackedSetAside ?? []);
  if (untrackedSetAside.length > 0) {
    const named = `${untrackedSetAside.slice(0, 5).join(', ')}${untrackedSetAside.length > 5 ? ', …' : ''}`;
    changeSet.warnings.push(
      `${untrackedSetAside.length} untracked file(s) are not part of this change and no evidence ` +
        `judges them (${named}). Stage a file this task created (git add, or git add -N) so it counts.`,
    );
  }

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
    ready,
    ...(readyReason !== null ? { readyReason } : {}),
    ...(untrackedSetAside.length > 0 ? { untrackedSetAside } : {}),
    next,
    integration,
  };
}

/**
 * Why a plan is not ready when no blocker says so (T14095): a plan that is not
 * ready always names why, by a blocker or by this reason. A done task has
 * nothing left to record or complete; any other plan with no blocker and no
 * command has no derivable step at all.
 *
 * @param taskId - The task.
 * @param status - Its status.
 * @param ready - Whether the plan is ready.
 * @param blockers - The plan's blockers.
 * @returns The reason, or `null` when the plan is ready or a blocker explains it.
 */
export function notReadyReason(
  taskId: string,
  status: string,
  ready: boolean,
  blockers: readonly DonePlanBlocker[],
): string | null {
  if (status === 'done')
    return `${taskId} is already done: there is nothing left to record or complete.`;
  if (ready || blockers.length > 0) return null;
  return (
    `${taskId} has no command to run: no gate has evidence left to record and implemented ` +
    `is neither recorded nor derivable. Record it with cleo verify ${taskId} --gate implemented ` +
    '--evidence <atoms>.'
  );
}

/**
 * The worktree integration `cleo complete` would run for `taskId`, decided by
 * the same function, without changing git (T14053).
 */
async function planCompletionIntegration(
  taskId: string,
  storeRoot: string,
  noIntegrate: boolean | undefined,
): Promise<WorktreeIntegrationPlan> {
  const { planWorktreeIntegration } = await import('../spawn/branch-integration.js');
  const { integrationDisabledReason } = await import('../orchestrate/worktree-complete.js');
  const disabledReason = integrationDisabledReason(noIntegrate);
  return planWorktreeIntegration(taskId, storeRoot, disabledReason ? { disabledReason } : {});
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
    // @sync-invariant none:input-shape the read-only plan writes nothing; its failure is reported as is
    return cleoErrorToEngineResult<DonePlan>(err, 'E_DONE_PLAN_FAILED', 'cleo done --plan failed');
  }
}

/**
 * Parse the `--satisfies` / `--pr` / `--commit` CLI flags shared by
 * `cleo done` and `cleo verify --auto` into planner options.
 *
 * @param satisfies - Raw `--satisfies` value (`AC1,AC3` or `all`), if given.
 * @param pr - Raw `--pr` value, if given.
 * @param commit - Raw `--commit` value, if given (T13799).
 * @returns The options, or the refusal text for an invalid PR number or commit.
 * @example
 * ```ts
 * parseDoneOptions('AC1,AC3', '42'); // { ok: true, options: { satisfies: ['AC1','AC3'], prNumber: 42 } }
 * ```
 * @task T12625
 */
export function parseDoneOptions(
  satisfies: unknown,
  pr: unknown,
  commit?: unknown,
):
  | { ok: true; options: Pick<DeriveTaskEvidenceOptions, 'satisfies' | 'prNumber' | 'commit'> }
  | { ok: false; message: string } {
  const raw = typeof satisfies === 'string' ? satisfies.trim() : '';
  const prNumber = typeof pr === 'string' ? Number(pr) : undefined;
  if (prNumber !== undefined && !(Number.isInteger(prNumber) && prNumber > 0)) {
    return { ok: false, message: `--pr must be a positive PR number, got "${String(pr)}"` };
  }
  const sha = typeof commit === 'string' ? commit.trim() : undefined;
  if (sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(sha)) {
    return { ok: false, message: `--commit must be a commit SHA (7-40 hex), got "${sha}"` };
  }
  if (sha !== undefined && prNumber !== undefined) {
    return { ok: false, message: '--pr and --commit name two different change sets; pass one' };
  }
  return {
    ok: true,
    options: {
      ...(raw === '' ? {} : { satisfies: raw.toLowerCase() === 'all' ? 'all' : raw.split(',') }),
      ...(prNumber !== undefined ? { prNumber } : {}),
      ...(sha !== undefined ? { commit: sha } : {}),
    },
  };
}
