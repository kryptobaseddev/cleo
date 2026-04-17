/**
 * CLI detect command
 * @task T487
 */
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
/** Native citty command for `cleo detect`. */
export const detectCommand = defineCommand({
  meta: { name: 'detect', description: 'Re-detect project type and update project-context.json' },
  async run() {
    await dispatchFromCli(
      'mutate',
      'admin',
      'detect',
      {},
      { command: 'detect', operation: 'admin.detect' },
    );
  },
});
