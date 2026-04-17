/**
 * CLI bug command — shorthand for creating bug-report tasks with severity mapping.
 *
 * Maps P0–P3 severity levels to task priority and labels, then dispatches
 * to `tasks.add` via the CLI adapter.
 *
 *   cleo bug <title> --severity P1 [--epic <id>] [--description <desc>] [--dry-run]
 *
 * @task T4913
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Severity mapping configuration.
 * Maps P0–P3 severity levels to task priority and label arrays.
 */
const SEVERITY_MAP: Record<string, { priority: string; labels: string[] }> = {
  P0: { priority: 'critical', labels: ['bug', 'p0'] },
  P1: { priority: 'high', labels: ['bug', 'p1'] },
  P2: { priority: 'medium', labels: ['bug', 'p2'] },
  P3: { priority: 'low', labels: ['bug', 'p3'] },
};

/**
 * Valid severity level keys for validation error messages.
 */
const VALID_SEVERITIES = Object.keys(SEVERITY_MAP);

/**
 * `cleo bug` — create a bug-report task with automatic severity mapping.
 *
 * Dispatches to `tasks.add` with priority and labels derived from the
 * --severity flag (P0 = critical … P3 = low).
 */
export const bugCommand = defineCommand({
  meta: {
    name: 'bug',
    description: 'Create a bug report task with severity mapping (requires active session)',
  },
  args: {
    title: {
      type: 'positional',
      description: 'Bug report title',
      required: true,
    },
    severity: {
      type: 'string',
      description: 'Severity level (P0, P1, P2, P3)',
      alias: 's',
      default: 'P2',
    },
    epic: {
      type: 'string',
      description: 'Epic ID to link as parent (optional)',
      alias: 'e',
    },
    description: {
      type: 'string',
      description: 'Bug description',
      alias: 'd',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Show what would be created without making changes',
      default: false,
    },
  },
  async run({ args }) {
    const severity = args.severity ?? 'P2';

    if (!VALID_SEVERITIES.includes(severity)) {
      console.error(
        `Error: Invalid severity "${severity}". Must be one of: ${VALID_SEVERITIES.join(', ')}`,
      );
      process.exit(1);
    }

    const mapping = SEVERITY_MAP[severity];

    const params: Record<string, unknown> = {
      title: args.title,
      type: 'task',
      priority: mapping.priority,
      labels: mapping.labels,
      origin: 'bug-report',
      description: args.description ?? args.title,
    };

    if (args.epic !== undefined) {
      params['parent'] = args.epic;
    }

    if (args['dry-run']) {
      params['dryRun'] = true;
    }

    await dispatchFromCli('mutate', 'tasks', 'add', params, { command: 'bug' });
  },
});
