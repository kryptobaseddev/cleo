/**
 * `cleo docs rot` CLI command — stale, duplicate and orphaned docs (T14111).
 *
 *   cleo docs rot                          — the full report (read-only, git only)
 *   cleo docs rot --changed <base>..<head> — also list docs a merged change left stale
 *   cleo docs rot --strict                 — exit 2 when the report finds anything
 *
 * @task T14111
 * @epic T14106
 */

import type { DocsRotResult } from '@cleocode/contracts/operations/docs.js';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../../dispatch/adapters/cli.js';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliOutput } from '../../renderers/index.js';

/** `cleo docs rot` — docs-rot report; `--strict` fails on any finding. */
export const rotCommand = defineCommand({
  meta: {
    name: 'rot',
    description:
      'Docs-rot report from git alone (T14111): docs whose covers: code changed after ' +
      'them (stale), duplicate docs, and orphaned docs (dead covers globs, unreferenced ' +
      'docs/ files). --changed <base>..<head> also lists the docs a merged change left ' +
      'stale; --strict exits 2 on any finding.',
  },
  args: {
    changed: {
      type: 'string',
      description: 'Git range <base>..<head> of a merged change to flag docs for',
    },
    strict: {
      type: 'boolean',
      description: 'Exit 2 when the report finds stale, duplicate, orphaned or flagged docs',
    },
  } as const,
  async run({ args }) {
    const params = typeof args.changed === 'string' ? { changed: args.changed } : {};
    if (args.strict !== true) {
      await dispatchFromCli('query', 'docs', 'rot', params, { command: 'docs rot' });
      return;
    }
    const response = await dispatchRaw('query', 'docs', 'rot', params);
    handleRawError(response, { command: 'docs rot', operation: 'docs.rot' });
    const report = response.data as DocsRotResult;
    cliOutput(report, { command: 'docs rot', message: report.summary });
    const findings =
      report.stale.length +
      report.duplicates.length +
      report.orphans.length +
      report.flagged.length;
    if (findings > 0) process.exit(2);
  },
});
