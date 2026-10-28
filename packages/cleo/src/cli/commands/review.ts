/**
 * `cleo review` — independent per-AC review of a PR (T14122).
 *
 * - `packet <pr> --task <id>`: the PR diff at its head and the task's
 *   criteria, nothing the author wrote about the change (no title, body,
 *   comments, commit messages or changesets). Hand it to a reviewer agent.
 * - `verdict <pr> --task <id> --ac ACn --met|--unmet --reason <text> --packet <sha256>`:
 *   record the reviewer's verdict under its own CLEO session, bound to the
 *   PR head. Refused from an author of the task, or when the packet changed.
 * - `check <pr> --task <ids>`: before merge, each criterion's state on the
 *   current head (met, or missing / unmet / stale with why). Exits 1 on a gap.
 *
 * Thin glue over `@cleocode/core/tasks/review-verdict.js`.
 *
 * @task T14122
 */

import { getProjectRoot } from '@cleocode/core/paths.js';
import {
  buildReviewPacket,
  checkPrReviews,
  recordReviewVerdict,
} from '@cleocode/core/tasks/review-verdict.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

/** A positive PR number, or null. */
function prOf(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Refuse invalid input with E_VALIDATION (exit 6). */
function invalid(message: string): void {
  cliError(message, 6, { name: 'E_VALIDATION' });
  process.exitCode = 6;
}

const prArg = { type: 'positional', description: 'PR number', required: true } as const;
const taskArg = { type: 'string', description: 'Task id', required: true } as const;

const packetCommand = defineCommand({
  meta: {
    name: 'packet',
    description:
      "Print a PR's review packet for one task: the diff at the PR head and the task's criteria, " +
      'with the PR title, body, comments, commit messages and changesets withheld',
  },
  args: { pr: prArg, task: taskArg },
  async run({ args }) {
    const pr = prOf(args.pr);
    if (pr === null) return invalid('PR must be a positive number');
    cliOutput(await buildReviewPacket(getProjectRoot(), pr, String(args.task)), {
      command: 'review',
      operation: 'review.packet',
    });
  },
});

const verdictCommand = defineCommand({
  meta: {
    name: 'verdict',
    description:
      "Record a reviewer's verdict on one criterion, under the reviewer's own CLEO session and " +
      'bound to the PR head; refused from an author of the task or on a changed packet',
  },
  args: {
    pr: prArg,
    task: taskArg,
    ac: { type: 'string', description: 'Criterion alias (AC1, AC2, …)', required: true },
    met: { type: 'boolean', description: 'The diff implements the criterion' },
    unmet: { type: 'boolean', description: 'The diff does not implement the criterion' },
    reason: {
      type: 'string',
      description: 'What in the diff does or does not implement it',
      required: true,
    },
    packet: { type: 'string', description: 'packetSha256 of the packet reviewed', required: true },
  },
  async run({ args }) {
    const pr = prOf(args.pr);
    if (pr === null) return invalid('PR must be a positive number');
    if ((args.met === true) === (args.unmet === true)) {
      return invalid('Give exactly one of --met or --unmet');
    }
    const verdict = await recordReviewVerdict(getProjectRoot(), {
      prNumber: pr,
      taskId: String(args.task),
      ac: String(args.ac),
      verdict: args.met === true ? 'met' : 'unmet',
      reason: String(args.reason),
      packetSha256: String(args.packet),
    });
    cliOutput(verdict, { command: 'review', operation: 'review.verdict' });
  },
});

const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description:
      "Before merge: each task criterion's review state on the PR's current head (met, or " +
      'missing / unmet / stale with why); exits 1 when any criterion lacks a met verdict',
  },
  args: {
    pr: prArg,
    task: { type: 'string', description: 'Task ids, comma-separated', required: true },
    ac: { type: 'string', description: 'Only these criteria, comma-separated (default: all)' },
  },
  async run({ args }) {
    const pr = prOf(args.pr);
    if (pr === null) return invalid('PR must be a positive number');
    const list = (raw: unknown): string[] =>
      String(raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
    const acs = typeof args.ac === 'string' ? list(args.ac) : undefined;
    const checks = await checkPrReviews(getProjectRoot(), pr, list(args.task), {
      ...(acs !== undefined ? { acs } : {}),
    });
    const ready = checks.every((c) => c.gaps.length === 0);
    cliOutput({ prNumber: pr, ready, checks }, { command: 'review', operation: 'review.check' });
    if (!ready) process.exitCode = 1;
  },
});

/** `cleo review` root command. */
export const reviewCommand = defineCommand({
  meta: {
    name: 'review',
    description:
      'Independent per-criterion PR review by a non-author, bound to the PR head (packet | verdict | check)',
  },
  subCommands: { packet: packetCommand, verdict: verdictCommand, check: checkCommand },
});
