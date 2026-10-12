/**
 * `cleo docs link-decision <adrSlug> <D####>` and
 * `cleo docs unlink-decision <adrSlug> <D####>` — the writer verbs of
 * `decision_adr_links` (T13598), so an ADR traces to the decisions it ratifies
 * (`cleo docs fetch` shows them as `linkedDecisions`).
 *
 * Thin CLI boundary over the `docs.link-decision` / `docs.unlink-decision`
 * dispatch ops; the store rules live in `core/store/decision-adr-links.ts`.
 * Unlinking is a permanent tombstone: a revoked pair is never re-linked.
 *
 * @task T13598
 */

import { dispatchFromCli } from '../../../dispatch/adapters/cli.js';
import { defineCommand } from '../../lib/define-cli-command.js';

const decisionLinkArgs = {
  adrSlug: {
    type: 'positional',
    description: 'Slug of the ADR doc (e.g. adr-091-sync-journal)',
    required: true,
  },
  decisionId: {
    type: 'positional',
    description: 'The D#### brain ledger decision id',
    required: true,
  },
} as const;

/** Build one of the two verbs over its dispatch op. */
function makeDecisionLinkCommand(name: 'link-decision' | 'unlink-decision', description: string) {
  return defineCommand({
    meta: { name, description },
    args: decisionLinkArgs,
    async run({ args }) {
      await dispatchFromCli(
        'mutate',
        'docs',
        name,
        { adrSlug: String(args.adrSlug), decisionId: String(args.decisionId) },
        { command: `docs ${name}` },
      );
    },
  });
}

/** `cleo docs link-decision` (T13598). */
export const linkDecisionCommand = makeDecisionLinkCommand(
  'link-decision',
  'Link a stored D#### decision to an existing ADR doc that ratifies it; repeating is a no-op, and a revoked pair is refused.',
);

/** `cleo docs unlink-decision` (T13598). */
export const unlinkDecisionCommand = makeDecisionLinkCommand(
  'unlink-decision',
  'Revoke a decision-to-ADR link. This cannot be undone: the revoke is a permanent tombstone and the pair can never be re-linked.',
);
