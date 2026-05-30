/**
 * CLI focus command — single-envelope task orientation.
 *
 * Replaces the 8-call pattern (show + list + memory find + docs list +
 * git log + gh pr list + nexus context etc.) with one envelope containing:
 *   - identity + scope
 *   - members (saga only)
 *   - blockers
 *   - ready wave (next parallel-safe tasks from parent epic)
 *   - attached docs
 *   - recent git activity (last 5 commits mentioning the task ID)
 *   - brain context (≤ 3 entries per category, scope-filtered)
 *
 * Token budget: ≤ 1 500 tokens for typical task orientation. As of T11352
 * this is ENFORCED at runtime — not just documented. The `focus.show`
 * response routes through the live MVI budget chokepoint
 * (`dispatch/middleware/budget-enforcement.ts`) which applies the
 * `FOCUS_TOKEN_CEILING` (1500) policy from `dispatch/lib/budget-ceilings.ts`,
 * truncating an over-budget orientation envelope rather than letting it grow
 * unbounded.
 *
 * Usage: cleo focus <id>
 *
 * @task T9973
 * @task T11352 — runtime enforcement of the ≤1500 ceiling
 * @epic T9964 E-ORIENT-V2
 * @epic T11285 EP-MVI-PRIMITIVE
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * `cleo focus <id>` — single-envelope task orientation.
 *
 * Orient on a task, epic, or saga with one call instead of eight.
 * Aggregates identity, scope, members, blockers, ready wave, attached docs,
 * recent git activity, and brain context into a single LAFS envelope.
 *
 * @task T9973
 * @epic T9964
 */
export const focusCommand = defineCommand({
  meta: {
    name: 'focus',
    description:
      'Single-envelope orientation for a task, epic, or saga — replaces 8 separate calls with one',
  },
  args: {
    id: {
      type: 'positional',
      description: 'Task, Epic, or Saga ID to orient on (e.g. T9973, T9831)',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'focus',
      'show',
      { id: args['id'] as string },
      { command: 'focus' },
    );
  },
});
