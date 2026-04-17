/**
 * CLI validate command - check file integrity, schema compliance, checksum.
 * Delegates to dispatch layer: check.schema.
 * @task T4454
 * @task T4659
 * @task T4795
 * @epic T4654
 * @task T4904
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Native citty command for `cleo validate` — deprecated alias for
 * `cleo check schema todo`. Validates task data against schema and
 * business rules.
 *
 * @deprecated Use `cleo check schema todo` instead.
 * @epic T487
 */
export const validateCommand = defineCommand({
  meta: {
    name: 'validate',
    description:
      'DEPRECATED: Use `cleo check schema todo` instead. Validate task data against schema and business rules',
  },
  args: {
    strict: {
      type: 'boolean',
      description: 'Treat warnings as errors',
    },
  },
  async run({ args }) {
    console.error('[DEPRECATED] cleo validate is deprecated. Use: cleo check schema todo');
    await dispatchFromCli(
      'query',
      'check',
      'schema',
      {
        type: 'todo',
        strict: args.strict,
      },
      { command: 'validate', operation: 'check.schema' },
    );
  },
});
