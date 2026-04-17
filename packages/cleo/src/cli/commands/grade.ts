/**
 * Grade command
 * @task T4916
 * @task T487
 */
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
/** Native citty command for `cleo grade [sessionId]`. */
export const gradeCommand = defineCommand({
  meta: {
    name: 'grade',
    description: 'Grade agent behavior for a session (requires --grade flag on session start)',
  },
  args: {
    sessionId: { type: 'positional', description: 'Session ID to grade', required: false },
    list: { type: 'boolean', description: 'List all past grade results' },
  },
  async run({ args }) {
    if (args.list || !args.sessionId) {
      await dispatchFromCli('query', 'check', 'grade.list', {}, { command: 'grade' });
    } else {
      await dispatchFromCli(
        'query',
        'check',
        'grade',
        { sessionId: args.sessionId },
        { command: 'grade' },
      );
    }
  },
});
