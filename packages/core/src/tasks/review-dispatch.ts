/**
 * Reviewer dispatch (T14372, owner decision 2026-11-10): send one reviewer
 * worker to each open PR whose head lacks per-AC verdicts, and keep the PRs
 * the lead reviews itself.
 *
 * - A PR is `lead`-reserved when its diff touches a migration, store or sync
 *   code, a gate (`scripts/lint-*`, `scripts/check-*`, workflows), evidence
 *   code, or deletes a file ({@link classifyReviewRoute}). It is never
 *   dispatched.
 * - A routine PR gets exactly one dispatch per head and mode, recorded as a
 *   `review.dispatch` audit row on each task it names with the PR number and
 *   head sha. A new head dispatches again; the same head does not.
 * - The reviewer runs under its own CLEO session and agent id, reads only
 *   `cleo review packet`, and records `cleo review verdict` per AC. The
 *   non-author refusal in {@link recordReviewVerdict} is what proves
 *   independence; dispatch only refuses to name an author's agent id.
 * - Shadow mode sends the reviewer to record shadow verdicts, which never
 *   count toward a merge; `cleo review check` shows them next to the lead's.
 *
 * Dry run by default: nothing is recorded.
 *
 * @task T14372
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ReviewAuthors,
  ReviewDispatch,
  ReviewDispatchDecision,
  ReviewDispatchResult,
  ReviewRouteReason,
  ReviewRouting,
} from '@cleocode/contracts';
import type { TrainPr } from './merge-train.js';
import type { ReviewDeps } from './review-verdict.js';

/** The audit action a reviewer dispatch is recorded under. */
export const REVIEW_DISPATCH_ACTION = 'review.dispatch';

/** Heartbeat age after which a dispatch run's lock is stale. */
const LOCK_STALE_MS = 10 * 60_000;

/**
 * Changed paths that keep a PR with the lead, by kind. Deletions are judged
 * from the diff, not the path.
 */
const LEAD_RESERVED: ReadonlyArray<[ReviewRouteReason['kind'], RegExp]> = [
  ['migration', /(^|\/)migrations?\/|\.sql$/],
  ['store-sync', /^packages\/[^/]+\/src\/store\/|(^|\/)sync\//],
  ['gate', /^scripts\/(\.?lint-|check-)|^\.github\/workflows\//],
  [
    'evidence',
    /^packages\/[^/]+\/src\/(.*(evidence|verification)|tasks\/(review-verdict|review-dispatch|merge-close|merge-train))/i,
  ],
];

/** One changed file of a diff. */
export interface DiffFile {
  /** The path after the change (the old path for a deletion). */
  path: string;
  /** The diff deletes it. */
  deleted: boolean;
}

/**
 * The files a unified diff changes, and which it deletes.
 *
 * @param diff - A `git diff` / `gh pr diff` unified diff.
 * @returns One entry per file.
 * @task T14372
 */
export function changedFilesOfDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const part of diff.split(/^(?=diff --git )/m)) {
    const head = /^diff --git a\/(\S+) b\/(\S+)/.exec(part);
    if (head === null) continue;
    const deleted = /^deleted file mode /m.test(part);
    files.push({ path: (deleted ? head[1] : head[2]) ?? '', deleted });
  }
  return files;
}

/**
 * Route a PR by what it changes (T14372): `lead` when any path is a
 * migration, store or sync code, a gate, evidence code, or a deletion;
 * otherwise `routine`. Changesets never reserve a PR.
 *
 * @param files - The changed files ({@link changedFilesOfDiff}).
 * @returns The route and every reserving path.
 * @task T14372
 */
export function classifyReviewRoute(files: readonly DiffFile[]): ReviewRouting {
  const reasons: ReviewRouteReason[] = [];
  for (const file of files) {
    if (file.path.startsWith('.changeset/')) continue;
    if (file.deleted) reasons.push({ kind: 'deletion', path: file.path });
    for (const [kind, pattern] of LEAD_RESERVED)
      if (pattern.test(file.path)) reasons.push({ kind, path: file.path });
  }
  return { route: reasons.length > 0 ? 'lead' : 'routine', reasons };
}

/**
 * The agent id a dispatched reviewer runs under: one per PR head.
 *
 * @param prNumber - The PR.
 * @param headSha - The head it reviews.
 * @returns `reviewer-pr<n>-<sha7>`.
 */
export function reviewerAgentId(prNumber: number, headSha: string): string {
  return `reviewer-pr${prNumber}-${headSha.slice(0, 7)}`;
}

/**
 * The brief handed to a dispatched reviewer: its own session and agent id,
 * the packet only, one verdict per criterion, a task per serious finding,
 * and never an edit to the PR.
 *
 * @param dispatches - The PR's dispatches, one per task.
 * @returns The brief.
 * @task T14372
 */
export function reviewerBrief(dispatches: readonly ReviewDispatch[]): string {
  const first = dispatches[0];
  if (first === undefined) return '';
  const { prNumber, reviewerAgentId: agent, mode } = first;
  const shadow = mode === 'shadow' ? ' --shadow' : '';
  const lines = [
    `You review PR #${prNumber} at head ${first.headSha}. You are not its author; never edit the PR, push, comment or merge.`,
    `1. Start your own session: cleo session start --scope global --agent ${agent} --name "review #${prNumber}", then set CLEO_SESSION_ID to its id and CLEO_AGENT_ID=${agent} on every cleo call.`,
    '2. Per task, read only the packet (the diff and the criteria), never the PR title, body, comments or commits:',
  ];
  for (const d of dispatches) {
    lines.push(`   cleo review packet ${prNumber} --task ${d.taskId}`);
    lines.push(
      `   then per criterion (${d.acs.join(', ')}): cleo review verdict ${prNumber} --task ${d.taskId} --ac <ACn> --met|--unmet --reason "<what in the diff does or does not implement it>" --packet <packetSha256>${shadow}`,
    );
  }
  lines.push(
    '3. File each serious finding as a task: cleo add --type task --title "..." --acceptance "...".',
    '4. A refusal saying you are an author means this dispatch is wrong: stop and report it; never retry from another session of the same agent.',
  );
  if (mode === 'shadow')
    lines.push(
      'Shadow mode: your verdicts are recorded as shadow verdicts and never count; the lead compares them with its own.',
    );
  return lines.join('\n');
}

/** What a dispatch run reads. Tests inject fixtures. */
export interface ReviewDispatchDeps {
  /** Open PRs. */
  openPrs(): Promise<TrainPr[]>;
  /** PR head and diff. */
  review: ReviewDeps;
  /** Clock (ms). */
  now?(): number;
}

/** Options of {@link runReviewDispatch}. */
export interface ReviewDispatchOptions {
  /** Record the dispatches (default: dry run, which records nothing). */
  execute?: boolean;
  /** Send reviewers to record shadow verdicts, which never count (default: counted). */
  shadow?: boolean;
  /** The dispatcher's environment (session binding). */
  env?: NodeJS.ProcessEnv;
}

/** The criteria of one task a reviewer must judge on `headSha`. */
async function criteriaToReview(
  root: string,
  taskId: string,
  acs: readonly string[],
  prNumber: number,
  headSha: string,
  shadow: boolean,
): Promise<string[]> {
  const { currentAcTexts, judgeReviewVerdicts, reviewVerdictsFor, shadowVerdictsFor } =
    await import('./review-verdict.js');
  if (shadow) {
    const done = new Set(
      (await shadowVerdictsFor(root, taskId, prNumber))
        .filter((v) => v.headSha === headSha)
        .map((v) => v.ac),
    );
    return acs.filter((ac) => !done.has(ac));
  }
  const judged = judgeReviewVerdicts(
    await reviewVerdictsFor(root, taskId, prNumber),
    acs,
    headSha,
    await currentAcTexts(root, taskId),
  );
  // An `unmet` on this head was judged: the author fixes it with a new head.
  return judged.gaps.filter((g) => g.kind !== 'unmet').map((g) => g.ac);
}

/** Decide (and with `execute`, record) the dispatch for one open PR. */
async function judgePr(
  root: string,
  pr: TrainPr,
  ctx: {
    deps: ReviewDispatchDeps;
    mode: ReviewDispatch['mode'];
    execute: boolean;
    dispatcherSessionId: string | null;
    now: () => number;
  },
): Promise<ReviewDispatchDecision> {
  const base = { prNumber: pr.number, headSha: pr.headSha };
  const skip = (reason: string): ReviewDispatchDecision => ({ ...base, action: 'skip', reason });
  if (pr.isDraft) return skip('draft');
  const { parseMergeDirectives } = await import('./merge-close.js');
  const { directives, errors } = parseMergeDirectives(pr.body);
  if (errors.length > 0) return skip(`malformed Closes:/Refs: lines: ${errors.join(' ')}`);
  if (directives.length === 0) return skip('the body names no task to review');

  const diff = await ctx.deps.review.prDiff(root, pr.number);
  const head = await ctx.deps.review.prHead(root, pr.number);
  if (diff === null || head === null) return skip('the PR could not be read with gh');
  if (head !== pr.headSha)
    return skip(`head moved to ${head.slice(0, 9)} while it was read; judged again next run`);
  const routing = classifyReviewRoute(changedFilesOfDiff(diff));
  if (routing.route === 'lead')
    return {
      ...base,
      action: 'lead',
      reason: `lead-reserved: ${routing.reasons.map((r) => `${r.kind} ${r.path}`).join('; ')}`,
      routing,
    };

  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const { CLAIM_AUTHOR_ACTIONS, reviewAuthors } = await import('./review-verdict.js');
  const accessor = await getTaskAccessor(root);
  const agent = reviewerAgentId(pr.number, pr.headSha);
  const dispatches: ReviewDispatch[] = [];
  let already = false;
  for (const line of directives) {
    const task = await accessor.loadSingleTask(line.taskId);
    if (task === null) return skip(`${line.taskId} is not in this project's task store`);
    const authors: ReviewAuthors = reviewAuthors(
      task,
      await accessor.queryAuditLog({ taskIds: [line.taskId], actions: CLAIM_AUTHOR_ACTIONS }),
    );
    if (authors.agentIds.includes(agent))
      return skip(`the reviewer agent id ${agent} is an author of ${line.taskId}`);
    const prior = await accessor.queryAuditLog({
      taskIds: [line.taskId],
      actions: [REVIEW_DISPATCH_ACTION],
    });
    if (prior.some((row) => isDispatchOf(row.detailsJson, pr.number, pr.headSha, ctx.mode)))
      already = true;
    const acs = await criteriaToReview(
      root,
      line.taskId,
      line.acs,
      pr.number,
      pr.headSha,
      ctx.mode === 'shadow',
    );
    if (acs.length === 0) continue;
    dispatches.push({
      prNumber: pr.number,
      headSha: pr.headSha,
      taskId: line.taskId,
      acs,
      mode: ctx.mode,
      reviewerAgentId: agent,
      dispatcherSessionId: ctx.dispatcherSessionId,
      dispatchedAt: new Date(ctx.now()).toISOString(),
    });
  }
  if (already)
    return {
      ...base,
      action: 'dispatched-already',
      reason: `a ${ctx.mode} reviewer was already dispatched to head ${pr.headSha.slice(0, 9)}`,
      routing,
    };
  if (dispatches.length === 0)
    return {
      ...skip(
        `every criterion has a ${ctx.mode === 'shadow' ? 'shadow ' : ''}verdict on head ${pr.headSha.slice(0, 9)}`,
      ),
      routing,
    };
  if (ctx.execute)
    for (const d of dispatches)
      await accessor.appendLog({
        action: REVIEW_DISPATCH_ACTION,
        taskId: d.taskId,
        actor: ctx.dispatcherSessionId ?? 'review-dispatch',
        sessionId: ctx.dispatcherSessionId,
        timestamp: d.dispatchedAt,
        details: d,
      });
  return {
    ...base,
    action: 'dispatch',
    reason: `routine; ${dispatches.map((d) => `${d.taskId} ${d.acs.join(',')}`).join('; ')} lack a verdict on this head`,
    routing,
    dispatches,
    brief: reviewerBrief(dispatches),
  };
}

/** Whether a `review.dispatch` row names this PR, head and mode. */
function isDispatchOf(
  json: string | null,
  prNumber: number,
  headSha: string,
  mode: ReviewDispatch['mode'],
): boolean {
  try {
    const d = JSON.parse(json ?? 'null') as Partial<ReviewDispatch> | null;
    return d?.prNumber === prNumber && d.headSha === headSha && d.mode === mode;
  } catch {
    return false;
  }
}

/**
 * Run a reviewer dispatch once (T14372): judge every open PR and, with
 * `execute`, record one dispatch per task for each routine PR whose head
 * lacks verdicts, returning the brief to hand each reviewer agent.
 * Idempotent per head: safe on a schedule.
 *
 * @param root - Project root.
 * @param opts - `execute` records; `shadow` sends reviewers to record shadow verdicts.
 * @param deps - Outside access; defaults to `gh`.
 * @returns One decision per open PR.
 * @task T14372
 */
export async function runReviewDispatch(
  root: string,
  opts: ReviewDispatchOptions = {},
  deps?: ReviewDispatchDeps,
): Promise<ReviewDispatchResult> {
  const execute = opts.execute === true;
  const mode: ReviewDispatch['mode'] = opts.shadow === true ? 'shadow' : 'counted';
  const d = deps ?? (await defaultReviewDispatchDeps(root));
  const now = d.now ?? Date.now;
  const result: ReviewDispatchResult = { dryRun: !execute, mode, ran: false, decisions: [] };
  let release: () => void = () => undefined;
  if (execute) {
    const { acquireHeartbeatLock } = await import('./merge-close.js');
    mkdirSync(join(root, '.cleo'), { recursive: true });
    const taken = acquireHeartbeatLock(join(root, '.cleo', 'review-dispatch.lock'), LOCK_STALE_MS);
    if (taken === null)
      return { ...result, skippedReason: 'another review dispatch is running in this repository' };
    release = taken;
  }
  try {
    const { resolveBoundSession } = await import('../store/session-store.js');
    const bound = await resolveBoundSession(root, opts.env ?? process.env);
    const ctx = { deps: d, mode, execute, dispatcherSessionId: bound?.session.id ?? null, now };
    const prs = [...(await d.openPrs())].sort((a, b) => a.number - b.number);
    result.ran = true;
    for (const pr of prs)
      result.decisions.push(
        await judgePr(root, pr, ctx).catch(
          (err: Error): ReviewDispatchDecision => ({
            prNumber: pr.number,
            headSha: pr.headSha,
            action: 'skip',
            reason: `GitHub or store error, judged again next run: ${err.message}`,
          }),
        ),
      );
  } finally {
    release();
  }
  return result;
}

/**
 * The default {@link ReviewDispatchDeps}: open PRs and diffs from `gh` in the
 * evidence work tree.
 *
 * @param root - Project root.
 * @returns The deps.
 */
export async function defaultReviewDispatchDeps(root: string): Promise<ReviewDispatchDeps> {
  const { resolveEvidenceExecutionRoot } = await import('./evidence.js');
  const { ghMergeTrainGitHub } = await import('./merge-train.js');
  const { defaultReviewDeps } = await import('./review-verdict.js');
  const github = ghMergeTrainGitHub(resolveEvidenceExecutionRoot(root));
  return { openPrs: () => github.openPrs(), review: defaultReviewDeps };
}
