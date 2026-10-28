/**
 * Independent per-AC review of a PR (T14122, council run
 * 20261028T155822Z-293ed9f0, blocking amendment 2 of D11211).
 *
 * The author of a task cannot be the one who decides its criteria are met.
 * A reviewer under its own CLEO session gets a {@link ReviewPacket}: the PR
 * diff at its head and the task's criteria, never the PR title, body,
 * comments, commit messages or changesets, so the author's `Closes:` lines
 * and summary cannot steer it. It records one {@link ReviewVerdict} per
 * criterion, bound to that head and to the packet it was given.
 *
 * Authorship is the task's work claim (T12502): the current claim holder,
 * every holder a hand-off or take-over replaced, and the session that
 * created the task. Git identity cannot serve, since every agent pushes under
 * one GitHub account. A reviewer whose session or agent id is among them is
 * refused, and a task with no recorded author refuses every verdict.
 *
 * Verdicts are task audit rows (`review.verdict`), written only by
 * {@link recordReviewVerdict}; nothing parses PR text. The merge sweep
 * (T14101) and `cleo review check` read them through
 * {@link reviewVerdictsFor} and {@link judgeReviewVerdicts}.
 *
 * @task T14122
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type {
  ReviewAuthors,
  ReviewGap,
  ReviewJudgement,
  ReviewPacket,
  ReviewVerdict,
  Task,
  TaskAuditLogRow,
} from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';

/** The audit action a verdict is recorded under. */
export const REVIEW_VERDICT_ACTION = 'review.verdict';

/** Claim audit actions whose `before` names a replaced holder (T12502). */
const CLAIM_REPLACED_ACTIONS = ['task_claim_handoff', 'task_claim_force', 'task_claim_takeover'];

/** Changed paths withheld from a packet: the author's own account of the change. */
const WITHHELD_PATH = /^\.changeset\//;

/** How a packet reads a PR from GitHub. Injected by tests. */
export interface ReviewDeps {
  /** The PR's current head sha, or null when `gh` cannot read it. */
  prHead(cwd: string, prNumber: number): Promise<string | null>;
  /** The PR's diff at its current head, or null when `gh` cannot read it. */
  prDiff(cwd: string, prNumber: number): Promise<string | null>;
}

function gh(args: string[], cwd: string): string | null {
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
}

/** The default {@link ReviewDeps}: `gh pr view` and `gh pr diff`. */
export const defaultReviewDeps: ReviewDeps = {
  async prHead(cwd, prNumber) {
    const out = gh(
      ['pr', 'view', String(prNumber), '--json', 'headRefOid', '-q', '.headRefOid'],
      cwd,
    );
    const sha = out?.trim() ?? '';
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  },
  async prDiff(cwd, prNumber) {
    return gh(['pr', 'diff', String(prNumber)], cwd);
  },
};

/**
 * A unified diff without the files whose path matches `withheld`, and the
 * paths it left out.
 *
 * @param diff - A `git diff` / `gh pr diff` unified diff.
 * @param withheld - Paths to leave out.
 */
export function withholdDiffPaths(
  diff: string,
  withheld: RegExp = WITHHELD_PATH,
): { diff: string; withheldPaths: string[] } {
  const parts = diff.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  const withheldPaths: string[] = [];
  for (const part of parts) {
    const path = /^diff --git a\/(\S+) b\/(\S+)/.exec(part)?.[2];
    if (path !== undefined && withheld.test(path)) withheldPaths.push(path);
    else kept.push(part);
  }
  return { diff: kept.join(''), withheldPaths };
}

function packetHash(
  headSha: string,
  taskId: string,
  acs: ReviewPacket['acs'],
  diff: string,
): string {
  return createHash('sha256').update(JSON.stringify({ headSha, taskId, acs, diff })).digest('hex');
}

/**
 * Build the review packet for one PR and task: the diff at the PR head and
 * the task's criteria, nothing the author wrote about the change.
 *
 * @param projectRoot - Project root (task store and `gh` working directory).
 * @param prNumber - The PR.
 * @param taskId - The task under review.
 * @param deps - GitHub access.
 * @throws CleoError when the task or the PR cannot be read, or the head moved while reading.
 */
export async function buildReviewPacket(
  projectRoot: string,
  prNumber: number,
  taskId: string,
  deps: ReviewDeps = defaultReviewDeps,
): Promise<ReviewPacket> {
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const accessor = await getTaskAccessor(projectRoot);
  const task = await accessor.loadSingleTask(taskId);
  // @sync-invariant none:input-shape an unknown task is refused before anything is read or written
  if (task === null) throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`);
  const acs = [...(await accessor.getAcRows(taskId))]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((r) => ({ alias: `AC${r.ordinal}`, text: r.text }));
  const unreadable = (): CleoError =>
    // @sync-invariant none:input-shape a PR gh cannot read is refused before anything is written
    new CleoError(ExitCode.NOT_FOUND, `PR #${prNumber} could not be read with gh`, {
      fix: 'Check `gh auth status` and that the PR number belongs to this repository.',
    });
  const before = await deps.prHead(projectRoot, prNumber);
  const raw = before === null ? null : await deps.prDiff(projectRoot, prNumber);
  const after = raw === null ? null : await deps.prHead(projectRoot, prNumber);
  // @sync-invariant none:input-shape a PR gh cannot read is refused before anything is written
  if (before === null || raw === null || after === null) throw unreadable();
  if (before !== after) {
    // @sync-invariant none:input-shape a PR head that moved mid-read is refused before anything is written
    throw new CleoError(
      ExitCode.CONTEXT_STALE,
      `PR #${prNumber} moved from ${before.slice(0, 7)} to ${after.slice(0, 7)} while its diff was read`,
      { fix: `Run \`cleo review packet ${prNumber} --task ${taskId}\` again.` },
    );
  }
  const { diff, withheldPaths } = withholdDiffPaths(raw);
  return {
    prNumber,
    headSha: after,
    taskId,
    acs,
    diff,
    withheldPaths,
    packetSha256: packetHash(after, taskId, acs, diff),
  };
}

/**
 * The identities that authored a task (T14122): its current claim holder,
 * every holder a claim hand-off or take-over replaced, and the session that
 * created it.
 *
 * @param task - The task.
 * @param claimRows - Its claim audit rows (`task_claim_handoff` / `_force` / `_takeover`).
 */
export function reviewAuthors(
  task: Pick<Task, 'claim' | 'provenance'>,
  claimRows: readonly Pick<TaskAuditLogRow, 'beforeJson' | 'afterJson' | 'sessionId'>[],
): ReviewAuthors {
  const sessions = new Set<string>();
  const agents = new Set<string>();
  const add = (holder: { sessionId?: unknown; agentId?: unknown } | null | undefined): void => {
    if (typeof holder?.sessionId === 'string' && holder.sessionId !== '') {
      sessions.add(holder.sessionId);
    }
    if (typeof holder?.agentId === 'string' && holder.agentId !== '') agents.add(holder.agentId);
  };
  add(task.claim);
  add({ sessionId: task.provenance?.sessionId });
  for (const row of claimRows) {
    for (const json of [row.beforeJson, row.afterJson]) {
      if (json === null) continue;
      try {
        add(JSON.parse(json) as { sessionId?: unknown; agentId?: unknown });
      } catch {
        // A malformed row names nobody.
      }
    }
    add({ sessionId: row.sessionId });
  }
  return { sessionIds: [...sessions].sort(), agentIds: [...agents].sort() };
}

/** What {@link recordReviewVerdict} records. */
export interface ReviewVerdictInput {
  /** The PR. */
  prNumber: number;
  /** The task. */
  taskId: string;
  /** The criterion alias (`AC2`). */
  ac: string;
  /** Whether the diff implements it. */
  verdict: 'met' | 'unmet';
  /** Why. */
  reason: string;
  /** The {@link ReviewPacket.packetSha256} the reviewer judged. */
  packetSha256: string;
  /** For a `met`: the id of the earlier non-author `unmet` verdict on this head it answers (T14128). */
  answers?: string;
}

/**
 * Record one reviewer's verdict on one criterion, bound to the PR head
 * (T14122). The packet is rebuilt and must hash to `packetSha256`, so the
 * verdict is about exactly the diff and criterion text the reviewer saw on
 * the current head.
 *
 * @param projectRoot - Project root.
 * @param input - The verdict.
 * @param opts - The reviewer's environment (session binding, `CLEO_AGENT_ID`) and GitHub access.
 * @returns The recorded verdict.
 * @throws CleoError when the reviewer is unbound or an author, the task has no recorded author,
 *   the criterion is unknown, the reason is empty, or the packet no longer matches.
 */
export async function recordReviewVerdict(
  projectRoot: string,
  input: ReviewVerdictInput,
  opts: { env?: NodeJS.ProcessEnv; deps?: ReviewDeps } = {},
): Promise<ReviewVerdict> {
  const env = opts.env ?? process.env;
  const reason = input.reason.trim();
  if (reason === '') {
    // @sync-invariant none:input-shape an empty verdict reason is refused before anything is written
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'A review verdict needs a --reason', {
      fix: 'Say what in the diff does or does not implement the criterion.',
    });
  }
  const { resolveBoundSession } = await import('../store/session-store.js');
  const bound = await resolveBoundSession(projectRoot, env);
  if (bound === null) {
    // @sync-invariant none:local-only the reviewer's own session binding is local; nothing is written without it
    throw new CleoError(
      ExitCode.SESSION_UNBOUND,
      'A review verdict is recorded under the reviewer’s own CLEO session, and this caller has none',
      {
        fix: 'Start a reviewer session (`cleo session start --scope global --name "review #<pr>"`) and run the verdict with CLEO_SESSION_ID set to it.',
      },
    );
  }
  const reviewer = { sessionId: bound.session.id, agentId: env['CLEO_AGENT_ID'] || null };

  const packet = await buildReviewPacket(projectRoot, input.prNumber, input.taskId, opts.deps);
  const criterion = packet.acs.find((a) => a.alias === input.ac);
  if (criterion === undefined) {
    // @sync-invariant none:input-shape an unknown criterion alias is refused before anything is written
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `${input.taskId} has no criterion ${input.ac} (it has ${packet.acs.map((a) => a.alias).join(', ') || 'none'})`,
    );
  }
  if (packet.packetSha256 !== input.packetSha256) {
    // @sync-invariant none:input-shape a packet that no longer matches the PR head is refused before anything is written
    throw new CleoError(
      ExitCode.CONTEXT_STALE,
      `The packet for PR #${input.prNumber} and ${input.taskId} changed since it was reviewed (now head ${packet.headSha.slice(0, 7)})`,
      {
        fix: `Run \`cleo review packet ${input.prNumber} --task ${input.taskId}\`, review the new packet, and record the verdict with its packetSha256.`,
      },
    );
  }

  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const accessor = await getTaskAccessor(projectRoot);
  const task = await accessor.loadSingleTask(input.taskId);
  // @sync-invariant none:input-shape an unknown task is refused before anything is written
  if (task === null) throw new CleoError(ExitCode.NOT_FOUND, `Task ${input.taskId} not found`);
  const claimRows = await accessor.queryAuditLog({
    taskIds: [input.taskId],
    actions: CLAIM_REPLACED_ACTIONS,
  });
  const authors = reviewAuthors(task, claimRows);
  if (authors.sessionIds.length === 0 && authors.agentIds.length === 0) {
    // @sync-invariant none:input-shape a task with no recorded author is refused before the verdict row is written
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `${input.taskId} has no recorded author, so an independent review cannot be proven`,
      { fix: `The author claims the task first: \`cleo start ${input.taskId}\`.` },
    );
  }
  if (
    authors.sessionIds.includes(reviewer.sessionId) ||
    (reviewer.agentId !== null && authors.agentIds.includes(reviewer.agentId))
  ) {
    // @sync-invariant none:input-shape a reviewer who is an author is refused before the verdict row is written
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `The reviewer (session ${reviewer.sessionId}${reviewer.agentId ? `, agent ${reviewer.agentId}` : ''}) is an author of ${input.taskId}; a verdict must come from someone else`,
      {
        fix: 'Hand the packet to a reviewer agent that runs under its own CLEO session and agent id.',
      },
    );
  }

  if (input.answers !== undefined) {
    const answered = (await reviewVerdictsFor(projectRoot, input.taskId, input.prNumber)).find(
      (v) => v.id === input.answers,
    );
    if (
      input.verdict !== 'met' ||
      answered === undefined ||
      answered.verdict !== 'unmet' ||
      answered.ac !== input.ac ||
      answered.headSha !== packet.headSha
    ) {
      // @sync-invariant none:input-shape an answer naming no unmet verdict on this criterion and head is refused before the verdict row is written
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `--answers ${input.answers} names no unmet verdict on ${input.ac} of ${input.taskId} at head ${packet.headSha.slice(0, 7)}, or the new verdict is not met`,
        {
          fix: `List the verdicts with \`cleo review check ${input.prNumber} --task ${input.taskId}\`; only a met verdict answers an unmet one.`,
        },
      );
    }
  }
  const acRow = (await accessor.getAcRows(input.taskId)).find((r) => `AC${r.ordinal}` === input.ac);
  const verdict: ReviewVerdict = {
    id: randomUUID(),
    taskId: input.taskId,
    ac: input.ac,
    acId: acRow?.id ?? '',
    prNumber: input.prNumber,
    headSha: packet.headSha,
    verdict: input.verdict,
    reason,
    reviewer,
    authors,
    packetSha256: packet.packetSha256,
    ...(input.answers !== undefined ? { answers: input.answers } : {}),
    createdAt: new Date().toISOString(),
  };
  await accessor.appendLog({
    action: REVIEW_VERDICT_ACTION,
    taskId: input.taskId,
    actor: reviewer.agentId ?? reviewer.sessionId,
    sessionId: reviewer.sessionId,
    timestamp: verdict.createdAt,
    details: verdict,
  });
  return verdict;
}

function isVerdict(v: unknown): v is ReviewVerdict {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['taskId'] === 'string' &&
    typeof r['ac'] === 'string' &&
    typeof r['prNumber'] === 'number' &&
    typeof r['headSha'] === 'string' &&
    (r['verdict'] === 'met' || r['verdict'] === 'unmet') &&
    typeof r['createdAt'] === 'string'
  );
}

/**
 * The verdicts recorded for one task on one PR (T14122), oldest first. All of
 * them, not only the latest: an earlier `unmet` a later `met` did not answer
 * still counts (T14128).
 *
 * @param projectRoot - Project root.
 * @param taskId - The task.
 * @param prNumber - The PR.
 */
export async function reviewVerdictsFor(
  projectRoot: string,
  taskId: string,
  prNumber: number,
): Promise<ReviewVerdict[]> {
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const rows = await (await getTaskAccessor(projectRoot)).queryAuditLog({
    taskIds: [taskId],
    actions: [REVIEW_VERDICT_ACTION],
  });
  const byId = new Map<string, ReviewVerdict>();
  for (const row of rows) {
    let v: unknown;
    try {
      v = JSON.parse(row.detailsJson ?? 'null');
    } catch {
      continue;
    }
    if (!isVerdict(v) || v.prNumber !== prNumber || v.taskId !== taskId) continue;
    byId.set(v.id, v);
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Which criteria a task's verdicts prove met on a PR head, and why the rest
 * are not (T14122). Only the latest verdict on `headSha` counts; a verdict on
 * an older head is stale, and one whose reviewer is among its recorded
 * authors counts for nothing. A `met` does not clear an earlier non-author
 * `unmet` on the same head unless it answers it by id (T14128), so shopping
 * for a friendlier reviewer leaves the criterion unmet and names the verdict
 * that was not answered. The merge sweep and `cleo review check` share it,
 * so both report the same reasons.
 *
 * @param verdicts - The task's verdicts on the PR ({@link reviewVerdictsFor}).
 * @param acs - The criteria to judge (`AC1`, …).
 * @param headSha - The PR head (`headRefOid`).
 */
export function judgeReviewVerdicts(
  verdicts: readonly ReviewVerdict[],
  acs: readonly string[],
  headSha: string,
): ReviewJudgement {
  const short = (sha: string): string => sha.slice(0, 7);
  const byAuthor = (v: ReviewVerdict): boolean =>
    v.authors.sessionIds.includes(v.reviewer.sessionId) ||
    (v.reviewer.agentId !== null && v.authors.agentIds.includes(v.reviewer.agentId));
  const met: string[] = [];
  const gaps: ReviewGap[] = [];
  for (const ac of acs) {
    const mine = verdicts.filter((v) => v.ac === ac);
    const head = mine
      .filter((v) => v.headSha === headSha)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const onHead = head.at(-1);
    const unanswered =
      onHead?.verdict === 'met' && !byAuthor(onHead)
        ? head.find(
            (u) =>
              u.verdict === 'unmet' &&
              !byAuthor(u) &&
              !head.some(
                (m) =>
                  m.verdict === 'met' &&
                  !byAuthor(m) &&
                  m.answers === u.id &&
                  m.createdAt >= u.createdAt,
              ),
          )
        : undefined;
    if (onHead !== undefined && byAuthor(onHead)) {
      gaps.push({
        ac,
        kind: 'author',
        reason: `${ac}: reviewed by the task's own author on head ${short(headSha)}; review independently`,
      });
    } else if (unanswered !== undefined) {
      gaps.push({
        ac,
        kind: 'unmet',
        reason: `${ac}: a later met on head ${short(headSha)} does not answer unmet verdict ${unanswered.id}: ${unanswered.reason}`,
      });
    } else if (onHead?.verdict === 'met') {
      met.push(ac);
    } else if (onHead !== undefined) {
      gaps.push({
        ac,
        kind: 'unmet',
        reason: `${ac}: reviewed unmet on head ${short(headSha)} (verdict ${onHead.id}): ${onHead.reason}`,
      });
    } else {
      const latest = [...mine].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
      gaps.push(
        latest === undefined
          ? { ac, kind: 'missing', reason: `${ac}: no verdict on head ${short(headSha)}` }
          : {
              ac,
              kind: 'stale',
              reason: `${ac}: no verdict on head ${short(headSha)} (latest is for ${short(latest.headSha)})`,
            },
      );
    }
  }
  return { headSha, met, gaps };
}

/** One task's review state on a PR head ({@link checkPrReviews}). */
export interface PrReviewCheck extends ReviewJudgement {
  /** The task. */
  taskId: string;
}

/**
 * The pre-merge review check for an open PR (T14122): for each task, which
 * criteria a non-author verdict proves met on the PR's current head, and why
 * the rest are not (missing, unmet, or reviewed on an older head). A push
 * after review makes every verdict stale here, while the author can still
 * fix it in the same PR.
 *
 * @param projectRoot - Project root.
 * @param prNumber - The PR.
 * @param taskIds - The tasks the PR delivers.
 * @param opts - Narrow to these criteria (default: all of each task's), and GitHub access.
 * @throws CleoError when the PR head cannot be read.
 */
export async function checkPrReviews(
  projectRoot: string,
  prNumber: number,
  taskIds: readonly string[],
  opts: { acs?: readonly string[]; deps?: ReviewDeps } = {},
): Promise<PrReviewCheck[]> {
  const deps = opts.deps ?? defaultReviewDeps;
  const headSha = await deps.prHead(projectRoot, prNumber);
  if (headSha === null) {
    // @sync-invariant none:input-shape a PR gh cannot read is refused by a read-only check; nothing is written
    throw new CleoError(ExitCode.NOT_FOUND, `PR #${prNumber} could not be read with gh`, {
      fix: 'Check `gh auth status` and that the PR number belongs to this repository.',
    });
  }
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const accessor = await getTaskAccessor(projectRoot);
  const checks: PrReviewCheck[] = [];
  for (const taskId of taskIds) {
    const all = [...(await accessor.getAcRows(taskId))]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((r) => `AC${r.ordinal}`);
    const acs = opts.acs === undefined ? all : all.filter((a) => opts.acs?.includes(a));
    const verdicts = await reviewVerdictsFor(projectRoot, taskId, prNumber);
    checks.push({ taskId, ...judgeReviewVerdicts(verdicts, acs, headSha) });
  }
  return checks;
}
