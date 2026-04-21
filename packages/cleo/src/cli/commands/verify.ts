/**
 * CLI verify command — view or modify verification gates for a task.
 *
 * Routes through the dispatch layer to check.gate.set (mutate),
 * check.gate.status (query, default view), and check.verify.explain
 * (query, when --explain is passed — T1006 / T1013).
 *
 * As of v2026.4.78 (T832 / ADR-051), gate writes MUST be accompanied by
 * structured `--evidence` backing the claim (commit SHAs, files, test runs,
 * tool results).  `--all` alone is rejected with E_EVIDENCE_MISSING.
 *
 * The `--explain` flag (T1013) enriches a read-only view with:
 *   - `gates[]`   : per-gate {name, state, timestamp} records
 *   - `evidence[]`: per-gate evidence atoms with re-validation status
 *   - `blockers[]`: human-readable reasons why `cleo complete` cannot yet run
 *
 * Without `--explain` the response shape is identical to prior releases.
 *
 * @task T4454
 * @task T832
 * @task T1006
 * @task T1013
 * @adr ADR-051
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo verify <task-id> — view or modify verification gates.
 *
 * @remarks
 * Read-only view is the default when no write flag is provided.  Passing
 * `--explain` enriches the view with the blocker breakdown described in
 * ADR-051 §2.3 (T1013).
 */
export const verifyCommand = defineCommand({
  meta: { name: 'verify', description: 'View or modify verification gates for a task' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to inspect or update',
      required: false,
    },
    gate: {
      type: 'string',
      description: 'Set a specific gate by name',
    },
    value: {
      type: 'string',
      description: 'Gate value: true or false',
      default: 'true',
    },
    agent: {
      type: 'string',
      description: 'Agent setting the gate',
    },
    all: {
      type: 'boolean',
      description: 'Mark all required gates as passed',
    },
    reset: {
      type: 'boolean',
      description: 'Reset verification to initial state',
    },
    evidence: {
      type: 'string',
      description:
        "Evidence for the gate (T832/ADR-051). Semicolon-separated atoms: 'commit:<sha>', 'files:<p1,p2>', 'test-run:<json>', 'tool:<name>', 'url:<url>', 'note:<text>'.",
    },
    explain: {
      type: 'boolean',
      description:
        'Enrich read-only view with per-gate evidence breakdown, re-validation status, and blockers[] preventing `cleo complete` (T1013 / ADR-051).',
    },
  },
  async run({ args, cmd }) {
    if (!args.taskId) {
      await showUsage(cmd);
      return;
    }
    const isWrite = !!(args.gate || args.all || args.reset);
    // --explain is a read-only enrichment; writes ignore it and keep prior behavior.
    const useExplain = !isWrite && args.explain === true;

    const operation = isWrite ? 'gate.set' : useExplain ? 'verify.explain' : 'gate.status';

    await dispatchFromCli(
      isWrite ? 'mutate' : 'query',
      'check',
      operation,
      {
        taskId: args.taskId,
        gate: args.gate as string | undefined,
        value: args.value === 'false' ? false : args.gate ? true : undefined,
        agent: args.agent as string | undefined,
        all: args.all as boolean | undefined,
        reset: args.reset as boolean | undefined,
        evidence: args.evidence as string | undefined,
      },
      { command: 'verify' },
    );
  },
});
