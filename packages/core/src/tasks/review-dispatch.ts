/**
 * Reviewer dispatch (T14372, owner decision 2026-11-10): send one reviewer
 * worker to each open PR whose head lacks per-AC verdicts, and keep the PRs
 * the lead reviews itself. The lead reviews everything until reviewer
 * workers prove themselves in shadow mode.
 *
 * - Shadow by default: a dispatched reviewer records shadow verdicts, which
 *   never count toward a merge; `cleo review check` shows them next to the
 *   lead's. Counted dispatch is refused unless the owner set
 *   {@link REVIEW_WORKERS_COUNTED_KEY}.
 * - A PR is `lead`-reserved when a changed path (either side of a rename) is
 *   a migration, store or sync code, a gate, evidence code, review-integrity
 *   code (review, sessions, claims, agent instructions), a deletion, or when
 *   GitHub's file list cannot be read exactly ({@link classifyReviewRoute}).
 * - A routine PR gets exactly one dispatch per head and mode, recorded as a
 *   `review.dispatch` audit row on each task it names with the PR number,
 *   head sha, and the session created for the reviewer. A new head dispatches
 *   again, up to {@link MAX_REVIEW_DISPATCHES_PER_PR} heads per PR.
 * - {@link recordReviewVerdict} accepts a worker's verdict only from the
 *   dispatch's own session and agent id on that head, never from an author;
 *   the dispatcher may not be an author either.
 *
 * Dry run by default: nothing is recorded.
 *
 * @task T14372
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ReviewDispatch,
  ReviewDispatchDecision,
  ReviewDispatchResult,
  ReviewRouteReason,
  ReviewRouting,
} from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';
import type { TrainPr } from './merge-train.js';
import {
  REVIEW_DISPATCH_ACTION,
  REVIEWER_AGENT_PREFIX,
  type ReviewDeps,
} from './review-verdict.js';

export { REVIEW_DISPATCH_ACTION } from './review-verdict.js';

/** Config key the owner flips to allow counted reviewer workers (default false). */
export const REVIEW_WORKERS_COUNTED_KEY = 'review.workers.counted';

/** Heads per PR and mode a reviewer is dispatched to before the PR is left to the lead. */
export const MAX_REVIEW_DISPATCHES_PER_PR = 3;

/** Heartbeat age after which a dispatch run's lock is stale. */
const LOCK_STALE_MS = 10 * 60_000;

/** Changed paths that keep a PR with the lead, by kind. Deletions are judged from the status. */
const LEAD_RESERVED: ReadonlyArray<[ReviewRouteReason['kind'], RegExp]> = [
  ['migration', /(^|\/)migrations?\/|\.sql$/],
  ['store-sync', /^packages\/[^/]+\/src\/store\/|(^|\/)sync\//],
  ['gate', /^scripts\/(\.?lint-|check-)|^\.github\/workflows\//],
  [
    'evidence',
    /^packages\/[^/]+\/src\/(.*(evidence|verification)|tasks\/(review-verdict|review-dispatch|merge-close|merge-train))/i,
  ],
  [
    'review-integrity',
    /^packages\/contracts\/src\/review-verdict\.ts$|^packages\/cleo\/src\/cli\/commands\/review\.ts$|^packages\/core\/src\/sessions\/|claim|^packages\/core\/templates\/CLEO-INJECTION\.md$|(^|\/)AGENTS\.md$|(^|\/)CLAUDE\.md$|^\.cleo\/project-context\.json$/i,
  ],
];

/** GitHub file statuses the router reads; any other makes the PR lead-reserved. */
const KNOWN_STATUSES = new Set(['added', 'modified', 'removed', 'renamed', 'copied', 'changed']);

/** One changed file as GitHub's `pulls/<n>/files` reports it. */
export interface PrFile {
  /** The path after the change. */
  path: string;
  /** `added`, `modified`, `removed`, `renamed`, `copied`, `changed` (anything else is unrecognised). */
  status: string;
  /** The path before a rename or copy. */
  previousPath?: string;
}

/** A PR's changed files and the count GitHub reports, so a truncated list is caught. */
export interface PrFileList {
  /** The files. */
  files: PrFile[];
  /** `changedFiles` from the PR itself. */
  changedFiles: number;
}

/**
 * Route a PR by what it changes (T14372). Fails closed: `lead` when any path
 * (either side of a rename or copy) is reserved, a file is deleted, an entry
 * has an unknown status, an empty or control-character path, or the list's
 * length differs from the PR's changed-file count. Changesets never reserve.
 *
 * @param list - The PR's files ({@link ReviewDispatchDeps.prFiles}).
 * @returns The route and every reserving path.
 * @task T14372
 */
export function classifyReviewRoute(list: PrFileList): ReviewRouting {
  const reasons: ReviewRouteReason[] = [];
  // A control character in a path is refused: it is not read exactly.
  const readable = (p: unknown): p is string =>
    typeof p === 'string' && p !== '' && !/[\u0000-\u001f\u007f]/.test(p);
  if (list.files.length !== list.changedFiles)
    reasons.push({
      kind: 'unrecognised',
      path: `file list has ${list.files.length} entries, the PR reports ${list.changedFiles}`,
    });
  for (const file of list.files) {
    const paths = [file.path, ...(file.previousPath !== undefined ? [file.previousPath] : [])];
    const renamed = file.status === 'renamed' || file.status === 'copied';
    if (
      !KNOWN_STATUSES.has(file.status) ||
      !paths.every(readable) ||
      renamed !== (file.previousPath !== undefined)
    ) {
      reasons.push({ kind: 'unrecognised', path: JSON.stringify(file) });
      continue;
    }
    if (paths.every((p) => p.startsWith('.changeset/'))) continue;
    if (file.status === 'removed') reasons.push({ kind: 'deletion', path: file.path });
    for (const path of paths)
      for (const [kind, pattern] of LEAD_RESERVED)
        if (pattern.test(path)) reasons.push({ kind, path });
  }
  return { route: reasons.length > 0 ? 'lead' : 'routine', reasons };
}

/**
 * The agent id a dispatched reviewer runs under: one per mode and PR head.
 *
 * @param mode - The dispatch mode.
 * @param prNumber - The PR.
 * @param headSha - The head it reviews.
 * @returns `reviewer-<mode>-pr<n>-<sha7>`.
 */
export function reviewerAgentId(
  mode: ReviewDispatch['mode'],
  prNumber: number,
  headSha: string,
): string {
  return `${REVIEWER_AGENT_PREFIX}${mode}-pr${prNumber}-${headSha.slice(0, 7)}`;
}

/**
 * The brief handed to a dispatched reviewer: the session and agent id its
 * dispatch created, the packet only, one verdict per criterion, a task per
 * serious finding listed in its report, and never an edit to the PR.
 *
 * @param dispatches - The PR's dispatches, one per task.
 * @returns The brief.
 * @task T14372
 */
export function reviewerBrief(dispatches: readonly ReviewDispatch[]): string {
  const first = dispatches[0];
  if (first === undefined) return '';
  const { prNumber, reviewerAgentId: agent, reviewerSessionId, mode } = first;
  const shadow = mode === 'shadow' ? ' --shadow' : '';
  const session = reviewerSessionId === '' ? '<created on --execute>' : reviewerSessionId;
  const lines = [
    `You review PR #${prNumber} at head ${first.headSha}. You are not its author; never edit the PR, push, comment or merge.`,
    `1. Run every cleo call with CLEO_SESSION_ID=${session} CLEO_AGENT_ID=${agent} (the session this dispatch created; never start or reuse another).`,
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
    '4. A refusal (author, or no matching dispatch) means this dispatch is wrong: stop and report it; never retry under another identity.',
    '5. End your report with one line: "findings: T####,T####" naming every task you filed, or "findings: none".',
    `6. When done, end the session: cleo session end --note "review #${prNumber} done".`,
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
  /** A PR's changed files (GitHub's list), or null when it cannot be read. */
  prFiles(prNumber: number): Promise<PrFileList | null>;
  /** PR head (and diff, unused here). */
  review: ReviewDeps;
  /** Whether the owner enabled counted reviewer workers ({@link REVIEW_WORKERS_COUNTED_KEY}). */
  countedEnabled(): Promise<boolean>;
  /** Clock (ms). */
  now?(): number;
}

/** Options of {@link runReviewDispatch}. */
export interface ReviewDispatchOptions {
  /** Record the dispatches (default: dry run, which records nothing). */
  execute?: boolean;
  /** Send reviewers whose verdicts count; refused unless {@link REVIEW_WORKERS_COUNTED_KEY} is true. */
  counted?: boolean;
  /** The dispatcher's environment (session binding, `CLEO_AGENT_ID`). */
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

/** Create the reviewer's own session, bound to its agent id. */
async function createReviewerSession(root: string, agent: string, name: string): Promise<string> {
  const { generateSessionId } = await import('../sessions/session-id.js');
  const { createSession, updateSession } = await import('../store/session-store.js');
  const id = generateSessionId();
  await createSession(
    {
      id,
      name,
      status: 'active',
      scope: { type: 'global' },
      taskWork: { taskId: null, setAt: null },
      startedAt: new Date().toISOString(),
      agent,
      parentSessionId: null,
    },
    root,
  );
  // A session naming its agent is owned, so it never blocks another `cleo session start`.
  await updateSession(id, { agentIdentifier: agent, agentHandle: agent }, root);
  return id;
}

/** Decide (and with `execute`, record) the dispatch for one open PR. */
async function judgePr(
  root: string,
  pr: TrainPr,
  ctx: {
    deps: ReviewDispatchDeps;
    mode: ReviewDispatch['mode'];
    execute: boolean;
    dispatcher: { sessionId: string | null; agentId: string | null };
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

  const before = await ctx.deps.review.prHead(root, pr.number);
  const files = before === null ? null : await ctx.deps.prFiles(pr.number);
  const after = files === null ? null : await ctx.deps.review.prHead(root, pr.number);
  if (files === null || after === null) return skip('the PR could not be read with gh');
  if (before !== pr.headSha || after !== pr.headSha)
    return skip(`head moved to ${after.slice(0, 9)} while it was read; judged again next run`);
  const routing = classifyReviewRoute(files);
  if (routing.route === 'lead')
    return {
      ...base,
      action: 'lead',
      reason: `lead-reserved: ${routing.reasons.map((r) => `${r.kind} ${r.path}`).join('; ')}`,
      routing,
    };

  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const { CLAIM_AUTHOR_ACTIONS, reviewAuthors, reviewDispatchesFor } = await import(
    './review-verdict.js'
  );
  const accessor = await getTaskAccessor(root);
  const agent = reviewerAgentId(ctx.mode, pr.number, pr.headSha);
  const heads = new Set<string>();
  const dispatches: ReviewDispatch[] = [];
  for (const line of directives) {
    const task = await accessor.loadSingleTask(line.taskId);
    if (task === null) return skip(`${line.taskId} is not in this project's task store`);
    const authors = reviewAuthors(
      task,
      await accessor.queryAuditLog({ taskIds: [line.taskId], actions: CLAIM_AUTHOR_ACTIONS }),
    );
    const { sessionId, agentId } = ctx.dispatcher;
    if (
      (sessionId !== null && authors.sessionIds.includes(sessionId)) ||
      (agentId !== null && authors.agentIds.includes(agentId))
    )
      return skip(
        `the dispatcher is an author of ${line.taskId}; the dispatch must come from someone else`,
      );
    if (authors.agentIds.includes(agent))
      return skip(`the reviewer agent id ${agent} is an author of ${line.taskId}`);
    for (const d of await reviewDispatchesFor(root, line.taskId, pr.number))
      if (d.mode === ctx.mode) heads.add(d.headSha);
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
      reviewerSessionId: '',
      dispatcherSessionId: sessionId,
      dispatchedAt: new Date(ctx.now()).toISOString(),
    });
  }
  if (heads.has(pr.headSha))
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
  if (heads.size >= MAX_REVIEW_DISPATCHES_PER_PR)
    return {
      ...skip(
        `${heads.size} heads of this PR already had a ${ctx.mode} reviewer (cap ${MAX_REVIEW_DISPATCHES_PER_PR}); the lead reviews it`,
      ),
      routing,
    };
  if (ctx.execute) {
    const reviewerSessionId = await createReviewerSession(
      root,
      agent,
      `review #${pr.number} ${pr.headSha.slice(0, 7)} (${ctx.mode})`,
    );
    for (const d of dispatches) {
      d.reviewerSessionId = reviewerSessionId;
      await accessor.appendLog({
        action: REVIEW_DISPATCH_ACTION,
        taskId: d.taskId,
        actor: ctx.dispatcher.agentId ?? ctx.dispatcher.sessionId ?? 'review-dispatch',
        sessionId: ctx.dispatcher.sessionId,
        timestamp: d.dispatchedAt,
        details: d,
      });
    }
  }
  return {
    ...base,
    action: 'dispatch',
    reason: `routine; ${dispatches.map((d) => `${d.taskId} ${d.acs.join(',')}`).join('; ')} lack a verdict on this head`,
    routing,
    dispatches,
    brief: reviewerBrief(dispatches),
  };
}

/**
 * Run a reviewer dispatch once (T14372): judge every open PR and, with
 * `execute`, record one dispatch per task for each routine PR whose head
 * lacks verdicts, create the reviewer's session, and return the brief to hand
 * each reviewer agent. Shadow unless `counted`, which the owner must enable.
 * Idempotent per head: safe on a schedule.
 *
 * @param root - Project root.
 * @param opts - `execute` records; `counted` sends reviewers whose verdicts count.
 * @param deps - Outside access; defaults to `gh` and the project config.
 * @returns One decision per open PR.
 * @throws CleoError when counted mode is asked for and {@link REVIEW_WORKERS_COUNTED_KEY} is not true.
 * @task T14372
 */
export async function runReviewDispatch(
  root: string,
  opts: ReviewDispatchOptions = {},
  deps?: ReviewDispatchDeps,
): Promise<ReviewDispatchResult> {
  const execute = opts.execute === true;
  const mode: ReviewDispatch['mode'] = opts.counted === true ? 'counted' : 'shadow';
  const d = deps ?? (await defaultReviewDispatchDeps(root));
  if (mode === 'counted' && !(await d.countedEnabled()))
    // @sync-invariant none:input-shape counted dispatch while the owner has not enabled it is refused before anything is written
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Counted reviewer workers are off (${REVIEW_WORKERS_COUNTED_KEY} is not true); the lead reviews every PR until shadow verdicts agree`,
      {
        fix: `Dispatch in shadow mode (drop --counted). Only the owner turns ${REVIEW_WORKERS_COUNTED_KEY} on.`,
      },
    );
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
    const env = opts.env ?? process.env;
    const { resolveBoundSession } = await import('../store/session-store.js');
    const bound = await resolveBoundSession(root, env);
    const dispatcher = {
      sessionId: bound?.session.id ?? null,
      agentId: env['CLEO_AGENT_ID'] || null,
    };
    const ctx = { deps: d, mode, execute, dispatcher, now };
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
 * The default {@link ReviewDispatchDeps}: open PRs, heads and GitHub's file
 * list (`pulls/<n>/files`, JSON, so no path is parsed from patch text) from
 * `gh`, and {@link REVIEW_WORKERS_COUNTED_KEY} from the config cascade.
 *
 * @param root - Project root.
 * @returns The deps.
 */
export async function defaultReviewDispatchDeps(root: string): Promise<ReviewDispatchDeps> {
  const { execFileSync } = await import('node:child_process');
  const { resolveEvidenceExecutionRoot } = await import('./evidence.js');
  const { ghMergeTrainGitHub } = await import('./merge-train.js');
  const { defaultReviewDeps } = await import('./review-verdict.js');
  const cwd = resolveEvidenceExecutionRoot(root);
  const github = ghMergeTrainGitHub(cwd);
  const gh = (args: string[]): string | null => {
    try {
      return execFileSync('gh', args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
      });
    } catch {
      return null;
    }
  };
  return {
    openPrs: () => github.openPrs(),
    review: defaultReviewDeps,
    async prFiles(prNumber) {
      const count = gh([
        'pr',
        'view',
        String(prNumber),
        '--json',
        'changedFiles',
        '-q',
        '.changedFiles',
      ]);
      const out = gh([
        'api',
        '--paginate',
        `repos/{owner}/{repo}/pulls/${prNumber}/files?per_page=100`,
        '--jq',
        '.[] | {filename, status, previous_filename}',
      ]);
      if (count === null || out === null) return null;
      const files: PrFile[] = [];
      for (const line of out.split('\n')) {
        if (line.trim() === '') continue;
        const r = JSON.parse(line) as {
          filename?: unknown;
          status?: unknown;
          previous_filename?: unknown;
        };
        files.push({
          path: typeof r.filename === 'string' ? r.filename : '',
          status: typeof r.status === 'string' ? r.status : '',
          ...(typeof r.previous_filename === 'string' ? { previousPath: r.previous_filename } : {}),
        });
      }
      return { files, changedFiles: Number(count.trim()) };
    },
    async countedEnabled() {
      const { getConfigValue } = await import('../config/registry.js');
      return (
        (await getConfigValue<boolean>(REVIEW_WORKERS_COUNTED_KEY, { projectRoot: root })) === true
      );
    },
  };
}
