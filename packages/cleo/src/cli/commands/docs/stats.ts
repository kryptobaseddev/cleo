/**
 * `cleo docs stats` CLI command — per-project CleoDocs adoption metrics
 * (T13363).
 *
 *   cleo docs stats           — emit the metrics envelope (add:update ratio,
 *                               loose-markdown count, wikilinks edges,
 *                               decisions linked)
 *   cleo docs stats --output table   — human table rendering of the same
 *
 * Read-only: the command never writes to the store, the filesystem, or the
 * audit log. Output renders through the standard docs envelope path
 * (LAFS envelope by default; `--output table` for humans).
 *
 * @task T13363
 * @saga T13339
 */

import { dispatchFromCli } from '../../../dispatch/adapters/cli.js';
import { defineCommand } from '../../lib/define-cli-command.js';

/** `cleo docs stats` — per-project adoption metrics, read-only. */
export const statsCommand = defineCommand({
  meta: {
    name: 'stats',
    description:
      'Per-project CleoDocs adoption metrics (read-only, T13363): add:update ' +
      'ratio from the docs audit log, loose-markdown count with scanned/excluded ' +
      'dirs, docs_wikilinks edge count, and live decision_adr_links count. ' +
      'Emitted for the Council pilot baseline comparisons.',
  },
  args: {} as const,
  async run() {
    await dispatchFromCli('query', 'docs', 'stats', {}, { command: 'docs stats' });
  },
});
