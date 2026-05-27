/**
 * `cleo docs audit` CLI command — query the immutable docs audit trail.
 *
 *   cleo docs audit --slug <slug>  — show audit history for a specific slug
 *   cleo docs audit --verify       — verify checkpoint chain integrity
 *
 * @task T11182
 * @saga T10516
 */

import { ExitCode } from '@cleocode/contracts';
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../../dispatch/adapters/cli.js';
import { cliError } from '../../renderers/index.js';

export const auditCommand = defineCommand({
  meta: {
    name: 'audit',
    description:
      'Query the immutable docs audit trail (--slug <slug> or --verify for integrity check)',
  },
  args: {
    slug: {
      type: 'string',
      description: 'Show audit history for a specific document slug',
    },
    verify: {
      type: 'boolean',
      description: 'Verify checkpoint chain integrity across the full audit log',
    },
  } as const,
  async run({ args }) {
    if (!args.slug && !args.verify) {
      cliError(
        'Pass --slug <slug> to view history or --verify to check integrity.',
        ExitCode.GENERAL_ERROR,
      );
      return;
    }
    await dispatchFromCli(
      'query',
      'docs',
      'audit',
      {
        ...(typeof args.slug === 'string' ? { slug: args.slug } : {}),
        ...(args.verify === true ? { verify: true } : {}),
      },
      { command: 'docs audit' },
    );
  },
});
