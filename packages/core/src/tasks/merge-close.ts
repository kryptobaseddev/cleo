/**
 * Merge closes tasks (T14101, owner decision D11209).
 *
 * A merged PR whose required checks were green on its exact head closes the
 * tasks its body names, with no agent step. CI never writes to a task store:
 * the GitHub job only posts a receipt ({@link judgeMergedPr}); the store owner's
 * machine applies it here ({@link sweepMergedClosures}), re-deriving everything
 * from `gh` and recording through the same path as `cleo done --pr`
 * (`recordTaskDone`, then `taskComplete`), so the same validators and audit
 * apply. The sweep runs from the daemon loop, lazily (throttled) from the
 * commands agents already run, and before `cleo release` decides what ships.
 *
 * PR body lines, one per task:
 *
 * - `Closes: T#### AC1,AC2` — binds those criteria and completes the task once
 *   the criteria every merged PR bound cover all of its criteria.
 * - `Refs: T#### AC1` — binds those criteria; the task stays open.
 *
 * Every applied line writes one `merge_close` audit row keyed by
 * (PR, merge commit, task), so a rerun records nothing twice.
 *
 * @task T14101
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  GhPrViewPayload,
  MergeDirective,
  MergePrOutcome,
  MergeReceipt,
  MergeSweepOptions,
  MergeSweepResult,
  MergeTaskOutcome,
  TaskAuditLogRow,
} from '@cleocode/contracts';

/** The audit action of an applied `Closes:` / `Refs:` line. */
export const MERGE_CLOSE_AUDIT_ACTION = 'merge_close';

/** The audit action of a refusal already reported on the PR (posted once). */
export const MERGE_CLOSE_REFUSED_ACTION = 'merge_close_refused';

/** The lazy sweep runs at most this often per store. */
export const MERGE_SWEEP_INTERVAL_MS = 5 * 60_000;

/** A first sweep (no high-water mark yet) looks back this far. */
export const MERGE_SWEEP_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/** The most merged PRs one sweep reads. */
const MERGE_SWEEP_PR_LIMIT = 50;

/** The throttle and high-water file, under `.cleo/`. */
const SWEEP_STATE_FILE = 'merge-sweep.json';

/** A merged PR as the sweep reads it from `gh`. */
export interface MergedPrRecord extends Pick<GhPrViewPayload, 'statusCheckRollup'> {
  /** PR number. */
  number: number;
  /** PR body. */
  body: string;
  /** Merge time (ISO); empty for an open PR, which only a dry run reads. */
  mergedAt: string;
  /** Final head. */
  headRefOid: string | null;
  /** Merge commit. */
  mergeCommitSha: string | null;
}

/** The outcome of recording or completing one task. */
type StepResult = { ok: true } | { ok: false; reason: string };

/** Everything the sweep reaches outside the store; injectable for tests. */
export interface MergeCloseDeps {
  /** Merged PRs since an ISO time, oldest first, or null when `gh` failed. */
  listMergedPrs(root: string, since: string): Promise<MergedPrRecord[] | null>;
  /** One PR, or null when `gh` failed or it is not merged. */
  viewPr(root: string, prNumber: number): Promise<MergedPrRecord | null>;
  /** Post a PR comment; false when it could not. */
  comment(root: string, prNumber: number, body: string): Promise<boolean>;
  /** The required check names (`release.prRequiredWorkflows` tiers). */
  requiredChecks(storeRoot: string): Promise<string[]>;
  /** Whether `gh` can run at all. */
  ghAvailable(): Promise<boolean>;
  /** Plan (`dryRun`) or record the task's gates from the PR, as `cleo done --pr`. */
  record(
    storeRoot: string,
    taskId: string,
    prNumber: number,
    acs: string[],
    dryRun: boolean,
  ): Promise<StepResult>;
  /** Complete the task, as `cleo done --pr` does after recording. */
  complete(storeRoot: string, taskId: string, prNumber: number): Promise<StepResult>;
}

const DIRECTIVE_LINE = /^[ \t>*-]*(Closes|Refs)[ \t]*:[ \t]*(.*)$/gim;
const DIRECTIVE_PAYLOAD = /^(T\d+)\s+(AC\d+(?:\s*,\s*AC\d+)*)\s*$/i;

/**
 * Parse a PR body's `Closes:` / `Refs:` lines (T14101). A line whose payload
 * does not start with a task id (`Closes: #123`, GitHub's own syntax) is not
 * CLEO's and is ignored; a CLEO line that is malformed, or names a task twice,
 * is an error with the fix.
 *
 * @param body - The PR body.
 * @returns The lines, and the errors.
 * @example
 * ```ts
 * parseMergeDirectives('Closes: T14101 AC1,AC2');
 * // { directives: [{ kind: 'closes', taskId: 'T14101', acs: ['AC1', 'AC2'] }], errors: [] }
 * ```
 */
export function parseMergeDirectives(body: string): {
  directives: MergeDirective[];
  errors: string[];
} {
  const directives: MergeDirective[] = [];
  const errors: string[] = [];
  for (const match of body.matchAll(DIRECTIVE_LINE)) {
    const keyword = (match[1] ?? '').toLowerCase() === 'closes' ? 'Closes' : 'Refs';
    const payload = (match[2] ?? '').replace(/`/g, '').trim();
    if (!/^T\d/i.test(payload)) continue;
    const parsed = DIRECTIVE_PAYLOAD.exec(payload);
    if (!parsed) {
      errors.push(
        `"${keyword}: ${payload}" is not "${keyword}: T#### AC1,AC2": name the task, then every criterion this PR delivers (no wildcard).`,
      );
      continue;
    }
    const taskId = (parsed[1] ?? '').toUpperCase();
    if (directives.some((d) => d.taskId === taskId)) {
      errors.push(`${taskId} is named on more than one Closes:/Refs: line; use one line per task.`);
      continue;
    }
    const acs = [...new Set((parsed[2] ?? '').split(',').map((a) => a.trim().toUpperCase()))];
    directives.push({ kind: keyword === 'Closes' ? 'closes' : 'refs', taskId, acs });
  }
  return { directives, errors };
}

/**
 * Judge a merged PR without a task store (T14101): its lines, and whether its
 * required checks were green on its exact head (`statusCheckRollup` is the
 * head's checks). This is the CI job's receipt; the store side judges again.
 *
 * @param pr - The merged PR.
 * @param required - Required check names.
 * @returns The receipt.
 */
export async function judgeMergedPr(
  pr: MergedPrRecord,
  required: readonly string[],
): Promise<MergeReceipt> {
  const { directives, errors } = parseMergeDirectives(pr.body);
  const { evaluateRollup } = await import('../release/pr-evidence.js');
  const ci = evaluateRollup(pr.statusCheckRollup ?? [], required, { prNumber: pr.number });
  const closesNothing =
    errors.length > 0
      ? `its Closes:/Refs: lines are malformed: ${errors.join(' ')}`
      : directives.length === 0
        ? 'its body names no task (add "Closes: T#### AC1,AC2" or "Refs: T#### AC1").'
        : !ci.ok
          ? `its required checks were not green on its head ${pr.headRefOid?.slice(0, 12) ?? '(unknown)'}: ${ci.reason}`
          : undefined;
  return {
    prNumber: pr.number,
    mergeSha: pr.mergeCommitSha,
    headSha: pr.headRefOid,
    directives,
    errors,
    ciGreen: ci.ok,
    ...(ci.ok ? {} : { ciReason: ci.reason }),
    ...(closesNothing !== undefined ? { closesNothing } : {}),
  };
}

/** The persisted throttle and high-water mark. */
interface SweepState {
  lastSweptAt?: string;
  highWater?: string;
}

function sweepStatePath(storeRoot: string): string {
  return join(storeRoot, '.cleo', SWEEP_STATE_FILE);
}

function readSweepState(storeRoot: string): SweepState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(sweepStatePath(storeRoot), 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as SweepState) : {};
  } catch {
    return {};
  }
}

/**
 * Whether the lazy sweep is due for a store (T14101): its last sweep is older
 * than {@link MERGE_SWEEP_INTERVAL_MS}. Cheap: one file read.
 *
 * @param storeRoot - CLEO store root.
 * @param now - Current time (ms).
 * @returns True when a sweep should run.
 */
export function mergeSweepDue(storeRoot: string, now = Date.now()): boolean {
  const last = Date.parse(readSweepState(storeRoot).lastSweptAt ?? '');
  return Number.isNaN(last) || now - last >= MERGE_SWEEP_INTERVAL_MS;
}

/** The criteria every earlier applied line bound for a task, and whether this PR was applied. */
async function priorBindings(
  storeRoot: string,
  taskId: string,
  prNumber: number,
  mergeSha: string | null,
): Promise<{ acs: Set<string>; applied: boolean; reported: Set<string> }> {
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const accessor = await getTaskAccessor(storeRoot);
  const rows: TaskAuditLogRow[] = await accessor.queryAuditLog({
    taskIds: [taskId],
    actions: [MERGE_CLOSE_AUDIT_ACTION, MERGE_CLOSE_REFUSED_ACTION],
  });
  const acs = new Set<string>();
  const reported = new Set<string>();
  let applied = false;
  for (const row of rows) {
    const details = JSON.parse(row.detailsJson ?? '{}') as {
      prNumber?: number;
      mergeSha?: string | null;
      acs?: string[];
      reason?: string;
    };
    const samePr = details.prNumber === prNumber && (details.mergeSha ?? null) === mergeSha;
    if (row.action === MERGE_CLOSE_REFUSED_ACTION) {
      if (samePr && details.reason) reported.add(details.reason);
      continue;
    }
    for (const ac of details.acs ?? []) acs.add(ac);
    if (samePr) applied = true;
  }
  return { acs, applied, reported };
}

async function appendMergeAudit(
  storeRoot: string,
  action: string,
  taskId: string,
  details: Record<string, unknown>,
): Promise<void> {
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const { randomBytes } = await import('node:crypto');
  await (await getTaskAccessor(storeRoot)).appendLog({
    id: `log-${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString('hex')}`,
    timestamp: new Date().toISOString(),
    action,
    taskId,
    actor: 'merge-close',
    details,
  });
}

/** Apply one line of one merged PR to its task. */
async function applyDirective(
  storeRoot: string,
  pr: MergedPrRecord,
  receipt: MergeReceipt,
  directive: MergeDirective,
  deps: MergeCloseDeps,
  dryRun: boolean,
): Promise<MergeTaskOutcome> {
  const { taskId, acs } = directive;
  const base = { taskId, acs };
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const accessor = await getTaskAccessor(storeRoot);
  const task = await accessor.loadSingleTask(taskId);
  if (!task)
    return { ...base, action: 'refused', reason: `${taskId} is not a task in this store.` };
  const prior = await priorBindings(storeRoot, taskId, pr.number, pr.mergeCommitSha);
  if (prior.applied)
    return { ...base, action: 'already', reason: `PR #${pr.number} was already applied.` };
  if (task.status === 'done' || task.status === 'cancelled')
    return { ...base, action: 'already', reason: `${taskId} is already ${task.status}.` };
  const own = (await accessor.getAcRows(taskId))
    .filter((row) => row.kind !== 'child_task')
    .map((row) => `AC${row.ordinal}`);
  const unknown = acs.filter((ac) => !own.includes(ac));
  if (unknown.length > 0)
    return {
      ...base,
      action: 'refused',
      reason: `${taskId} has no ${unknown.join(', ')} (its criteria are ${own.join(', ') || 'none'}).`,
    };
  // A dry run before merge checks the lines against the store; CI and the
  // recorded evidence are judged once the PR has merged.
  const open = pr.mergedAt === '';
  if (!open && !receipt.ciGreen)
    return { ...base, action: 'refused', reason: receipt.closesNothing ?? 'CI was not green.' };
  const audit = { prNumber: pr.number, mergeSha: pr.mergeCommitSha, kind: directive.kind, acs };
  if (directive.kind === 'refs') {
    if (!dryRun) await appendMergeAudit(storeRoot, MERGE_CLOSE_AUDIT_ACTION, taskId, audit);
    return { ...base, action: 'bound' };
  }
  const union = new Set([...prior.acs, ...acs]);
  const missing = own.filter((ac) => !union.has(ac));
  if (missing.length > 0)
    return {
      ...base,
      action: 'refused',
      reason:
        `no merged PR binds ${missing.join(', ')} of ${taskId}: list them on this PR's Closes: line, ` +
        'or bind them first with a Refs: line on the PR that delivers them.',
    };
  if (open)
    return { ...base, action: 'closed', reason: 'would close once it merges with green CI' };
  const recorded = await deps.record(storeRoot, taskId, pr.number, [...union], dryRun);
  if (!recorded.ok) return { ...base, action: 'refused', reason: recorded.reason };
  if (dryRun) return { ...base, action: 'closed' };
  const completed = await deps.complete(storeRoot, taskId, pr.number);
  if (!completed.ok) return { ...base, action: 'refused', reason: completed.reason };
  await appendMergeAudit(storeRoot, MERGE_CLOSE_AUDIT_ACTION, taskId, audit);
  return { ...base, action: 'closed' };
}

/** Post each task refusal on its PR once (an audit row remembers it). */
async function reportRefusals(
  storeRoot: string,
  root: string,
  pr: MergedPrRecord,
  outcomes: MergeTaskOutcome[],
  deps: MergeCloseDeps,
): Promise<void> {
  for (const outcome of outcomes) {
    if (outcome.action !== 'refused' || outcome.reason === undefined) continue;
    const { reported } = await priorBindings(
      storeRoot,
      outcome.taskId,
      pr.number,
      pr.mergeCommitSha,
    ).catch(() => ({ reported: new Set<string>() }));
    if (reported.has(outcome.reason)) continue;
    const body = `CLEO merge-close: ${outcome.taskId} was not closed by this PR: ${outcome.reason}`;
    if (!(await deps.comment(root, pr.number, body))) continue;
    await appendMergeAudit(storeRoot, MERGE_CLOSE_REFUSED_ACTION, outcome.taskId, {
      prNumber: pr.number,
      mergeSha: pr.mergeCommitSha,
      reason: outcome.reason,
    }).catch(() => undefined);
  }
}

/**
 * Close the tasks merged PRs name (T14101): for each merged PR, judge its
 * receipt, then apply each `Closes:` / `Refs:` line to its task. Never throws
 * on `gh` or network trouble: it reports `swept: false` instead. Under
 * `dryRun` it records, completes and comments nothing, and leaves the throttle
 * alone.
 *
 * @param storeRoot - CLEO store root.
 * @param opts - Dry run, force, since, PR numbers.
 * @param deps - Outside access; defaults to `gh` and the done/complete path.
 * @returns What was closed, bound and refused.
 * @example
 * ```ts
 * const r = await sweepMergedClosures(root, { force: true, dryRun: true });
 * console.log(r.closed);
 * ```
 */
export async function sweepMergedClosures(
  storeRoot: string,
  opts: MergeSweepOptions = {},
  deps: MergeCloseDeps = defaultMergeCloseDeps,
): Promise<MergeSweepResult> {
  const dryRun = opts.dryRun === true;
  const empty: MergeSweepResult = {
    swept: false,
    dryRun,
    prs: [],
    closed: [],
    bound: [],
    refused: [],
  };
  const targeted = (opts.prNumbers?.length ?? 0) > 0;
  if (!opts.force && !targeted && !mergeSweepDue(storeRoot))
    return { ...empty, skippedReason: 'throttled: the last sweep was under 5 minutes ago' };
  if (!(await deps.ghAvailable()))
    return { ...empty, skippedReason: 'gh is not available or not authenticated' };
  const { resolveEvidenceExecutionRoot } = await import('./evidence.js');
  const root = resolveEvidenceExecutionRoot(storeRoot);
  const state = readSweepState(storeRoot);
  const startedAt = new Date().toISOString();
  const since =
    opts.since ?? state.highWater ?? new Date(Date.now() - MERGE_SWEEP_LOOKBACK_MS).toISOString();
  let prs: MergedPrRecord[];
  if (targeted) {
    const viewed = await Promise.all((opts.prNumbers ?? []).map((n) => deps.viewPr(root, n)));
    prs = viewed.filter((pr): pr is MergedPrRecord => pr !== null);
  } else {
    const listed = await deps.listMergedPrs(root, since);
    if (listed === null) return { ...empty, skippedReason: 'gh could not list merged PRs' };
    prs = listed;
  }
  const required = await deps.requiredChecks(storeRoot);
  const result: MergeSweepResult = { ...empty, swept: true };
  for (const pr of [...prs].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))) {
    const receipt = await judgeMergedPr(pr, required);
    const entry: MergePrOutcome = {
      prNumber: pr.number,
      mergeSha: pr.mergeCommitSha,
      outcomes: [],
    };
    if (pr.mergedAt === '' && !dryRun) {
      entry.closesNothing = `PR #${pr.number} has not merged; check it with --dry-run.`;
      result.prs.push(entry);
      continue;
    }
    if (receipt.directives.length === 0 || receipt.errors.length > 0) {
      // The CI job comments these; a PR naming no task is not this store's.
      if (receipt.closesNothing) entry.closesNothing = receipt.closesNothing;
      result.prs.push(entry);
      continue;
    }
    for (const directive of receipt.directives) {
      const outcome = await applyDirective(storeRoot, pr, receipt, directive, deps, dryRun).catch(
        (err: Error) => ({
          taskId: directive.taskId,
          acs: directive.acs,
          action: 'refused' as const,
          reason: err.message,
        }),
      );
      entry.outcomes.push(outcome);
      if (outcome.action === 'closed') result.closed.push(outcome.taskId);
      if (outcome.action === 'bound') result.bound.push(outcome.taskId);
      if (outcome.action === 'refused')
        result.refused.push({
          taskId: outcome.taskId,
          prNumber: pr.number,
          reason: outcome.reason ?? 'refused',
        });
    }
    if (!dryRun) await reportRefusals(storeRoot, root, pr, entry.outcomes, deps);
    result.prs.push(entry);
  }
  if (!dryRun && !targeted) {
    const highWater = prs.reduce((max, pr) => (pr.mergedAt > max ? pr.mergedAt : max), since);
    writeFileSync(
      sweepStatePath(storeRoot),
      `${JSON.stringify({ lastSweptAt: startedAt, highWater }, null, 2)}\n`,
    );
  }
  return result;
}

/**
 * The PR comment for a receipt (T14101): what the store owner's sweep will
 * close or bind, or why the PR closes nothing, plus the receipt as JSON.
 *
 * @param receipt - The receipt.
 * @returns Markdown for `gh pr comment`.
 */
export function formatMergeReceipt(receipt: MergeReceipt): string {
  const lines = receipt.closesNothing
    ? [`CLEO merge-close: this PR closes nothing, because ${receipt.closesNothing}`]
    : [
        "CLEO merge-close receipt: the store owner's sweep (`cleo done --from-merge`) will record this PR's evidence for:",
        ...receipt.directives.map(
          (d) => `- ${d.kind === 'closes' ? 'close' : 'bind'} ${d.taskId} (${d.acs.join(', ')})`,
        ),
      ];
  return [...lines, '', '```json', JSON.stringify(receipt, null, 2), '```'].join('\n');
}

/**
 * Judge one merged PR without a task store and optionally comment the
 * receipt on it (T14101): the GitHub job's half. Reads only `gh` and the
 * tracked `.cleo/project-context.json` (for the required checks).
 *
 * @param storeRoot - Checkout root (the project context is read from it).
 * @param prNumber - The merged PR.
 * @param opts - `comment: true` posts the receipt on the PR.
 * @param deps - Outside access.
 * @returns The receipt, or null when `gh` could not read a merged PR.
 */
export async function mergeReceiptFor(
  storeRoot: string,
  prNumber: number,
  opts: { comment?: boolean } = {},
  deps: MergeCloseDeps = defaultMergeCloseDeps,
): Promise<{ receipt: MergeReceipt; commented: boolean } | null> {
  const pr = await deps.viewPr(storeRoot, prNumber);
  if (pr === null) return null;
  const receipt = await judgeMergedPr(pr, await deps.requiredChecks(storeRoot));
  const commented =
    opts.comment === true && (await deps.comment(storeRoot, prNumber, formatMergeReceipt(receipt)));
  return { receipt, commented };
}

const PR_FIELDS = 'number,body,mergedAt,headRefOid,mergeCommit,statusCheckRollup';

/** Normalise one `gh pr list/view --json PR_FIELDS` row (an open PR has `mergedAt: ''`). */
function toMergedPr(row: unknown): MergedPrRecord | null {
  if (row === null || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.number !== 'number') return null;
  const merge = r.mergeCommit as { oid?: unknown } | null | undefined;
  return {
    number: r.number,
    body: typeof r.body === 'string' ? r.body : '',
    mergedAt: typeof r.mergedAt === 'string' ? r.mergedAt : '',
    headRefOid: typeof r.headRefOid === 'string' ? r.headRefOid : null,
    mergeCommitSha: typeof merge?.oid === 'string' ? merge.oid : null,
    statusCheckRollup: Array.isArray(r.statusCheckRollup)
      ? (r.statusCheckRollup as GhPrViewPayload['statusCheckRollup'])
      : [],
  };
}

async function gh(args: string[], cwd: string): Promise<string | null> {
  const { ghQueryTimeoutMs } = await import('../release/github-pr.js');
  try {
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: ghQueryTimeoutMs(),
    });
  } catch {
    return null;
  }
}

/** A step's engine result as a {@link StepResult}. */
function stepOf(r: { success: boolean; error?: { message?: string } | null }): StepResult {
  return r.success ? { ok: true } : { ok: false, reason: r.error?.message ?? 'refused' };
}

/** The default {@link MergeCloseDeps}: `gh`, and the `cleo done --pr` record and complete path. */
export const defaultMergeCloseDeps: MergeCloseDeps = {
  async listMergedPrs(root, since) {
    const day = since.slice(0, 10);
    const out = await gh(
      [
        'pr',
        'list',
        '--state',
        'merged',
        '--search',
        `merged:>=${day}`,
        '--limit',
        String(MERGE_SWEEP_PR_LIMIT),
        '--json',
        PR_FIELDS,
      ],
      root,
    );
    if (out === null) return null;
    const rows: unknown = JSON.parse(out);
    if (!Array.isArray(rows)) return null;
    return rows.flatMap((row) => {
      const pr = toMergedPr(row);
      return pr && pr.mergedAt !== '' && pr.mergedAt >= since ? [pr] : [];
    });
  },
  async viewPr(root, prNumber) {
    const out = await gh(['pr', 'view', String(prNumber), '--json', PR_FIELDS], root);
    return out === null ? null : toMergedPr(JSON.parse(out));
  },
  async comment(root, prNumber, body) {
    return (await gh(['pr', 'comment', String(prNumber), '--body', body], root)) !== null;
  },
  async requiredChecks(storeRoot) {
    const { loadProjectContext } = await import('../agents/variable-substitution.js');
    const { resolveRequiredWorkflows } = await import('../release/pr-evidence.js');
    const ctx = loadProjectContext(storeRoot);
    return resolveRequiredWorkflows(process.env, ctx.loaded ? ctx.context : null);
  },
  async ghAvailable() {
    const { isGhCliAvailable } = await import('../release/github-pr.js');
    return isGhCliAvailable();
  },
  async record(storeRoot, taskId, prNumber, acs, dryRun) {
    const satisfies = acs;
    if (dryRun) {
      const { planTaskDone } = await import('./done-plan.js');
      const plan = await planTaskDone(taskId, { projectRoot: storeRoot, prNumber, satisfies });
      if (!plan.success) return stepOf(plan);
      const blocker = plan.data.blockers[0];
      return blocker ? { ok: false, reason: blocker.message } : { ok: true };
    }
    const { recordTaskDone } = await import('./done-record.js');
    const recorded = await recordTaskDone(taskId, {
      projectRoot: storeRoot,
      prNumber,
      satisfies,
      agent: 'merge-close',
      // The sweep runs no tool: a gate it cannot take from merged CI stays an
      // agent's (evidence.ciSatisfies makes testsPassed/qaPassed ci:<pr>).
      steps: {
        runTool: async (tool) => ({
          exitCode: null,
          cacheHit: false,
          durationMs: 0,
          timedOut: false,
          tail: '',
          killed: `merge-close runs no tool (${tool}); set evidence.ciSatisfies so merged CI records testsPassed and qaPassed`,
        }),
      },
    });
    return stepOf(recorded);
  },
  async complete(storeRoot, taskId, prNumber) {
    const { taskComplete } = await import('./complete.js');
    return stepOf(await taskComplete(storeRoot, taskId, { prNumber }));
  },
};
