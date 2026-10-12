/**
 * `cleo docs triage` CLI command — batch-triage docs through the registered
 * `docs.triage` decision site (T13446).
 *
 *   cleo docs triage                      — dry report over drafts, oldest first
 *   cleo docs triage --limit 100          — widen the scan window
 *   cleo docs triage --status proposed    — triage a different lifecycle status
 *   cleo docs triage --record             — also persist each verdict as a
 *                                           proposed D#### decision
 *
 * Proposals only: the command NEVER mutates a doc. Without `--record` nothing
 * is written at all beyond the decision-audit line each asked question gets.
 * An unconfigured decide provider resolves the site to `off`: zero network,
 * every verdict from the rule fallback.
 *
 * @task T13446
 * @saga T13339
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { dispatchFromCli } from '../../../dispatch/adapters/cli.js';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError } from '../../renderers/index.js';

/** Parse a `--limit` string into a positive integer, or fail the command. */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    cliError('--limit must be a positive integer', ExitCode.VALIDATION_ERROR, {
      name: 'E_VALIDATION',
    });
    process.exit(ExitCode.VALIDATION_ERROR);
  }
  return parsed;
}

/** `cleo docs triage` — dry report by default; `--record` persists proposed D#### verdicts. */
export const triageCommand = defineCommand({
  meta: {
    name: 'triage',
    description:
      'Batch-triage docs through the docs.triage decision site: proposed ' +
      'keep/update/supersede/archive verdicts plus staleness scores. Dry report ' +
      'by default (no doc is ever mutated); --record persists each verdict as a ' +
      'proposed D#### decision for owner review (T13446).',
  },
  args: {
    limit: {
      type: 'string',
      description: 'Maximum docs to scan, oldest first (default 25)',
    },
    status: {
      type: 'string',
      description: 'Lifecycle status to scan (default draft)',
    },
    record: {
      type: 'boolean',
      description:
        'Persist every verdict as a typed D#### decision (confirmationState: proposed). ' +
        'Default: dry report, nothing written.',
    },
  } as const,
  async run({ args }) {
    const limit = parseLimit(typeof args.limit === 'string' ? args.limit : undefined);
    await dispatchFromCli(
      'query',
      'docs',
      'triage',
      {
        ...(limit !== undefined ? { limit } : {}),
        ...(typeof args.status === 'string' ? { status: args.status } : {}),
        record: args.record === true,
      },
      { command: 'docs triage' },
    );
  },
});
