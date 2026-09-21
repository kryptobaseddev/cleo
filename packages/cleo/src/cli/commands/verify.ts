/**
 * CLI verify command — view or modify verification gates for a task.
 *
 * Routes through the dispatch layer to check.gate.set (mutate),
 * check.gate.status (query, default view), and check.verify.explain
 * (query, when --explain is passed — T1006 / T1013).
 *
 * As of v2026.4.78 (T832 / ADR-051), gate writes MUST be accompanied by
 * structured `--evidence` backing the claim (commit SHAs, files, test runs,
 * tool results). `--all` alone is rejected with E_EVIDENCE_MISSING.
 *
 * The `--explain` flag (T1013) enriches a read-only view with:
 *   - `gates[]`   : per-gate {name, state, timestamp} records
 *   - `evidence[]`: per-gate evidence atoms with re-validation status
 *   - `blockers[]`: human-readable reasons why `cleo complete` cannot yet run
 *
 * Without `--explain` the response shape is identical to prior releases.
 *
 * The `--shared-evidence` flag (T1502 / P0-6) acknowledges that the same
 * evidence atom is being applied to more than 3 distinct tasks in this
 * session. Without the flag such reuse triggers a warning on stderr; in
 * strict mode (`CLEO_STRICT_EVIDENCE=1`) it is a hard reject.
 *
 * The legacy `--acceptance-check` flag and `backfill` subcommand
 * (T9192 / T9218 / ADR-070) were removed per T9337 / Council 20260515T211404Z.
 * The per-task `.mjs` verifier substrate is replaced by the ADR-051
 * evidence-atom Pre-Complete Gate Ritual. Use `cleo verify <id> --evidence`
 * to attest gates and `cleo verify <id> --explain` to re-validate atoms.
 *
 * @task T4454
 * @task T832
 * @task T1006
 * @task T1013
 * @task T1502
 * @task T9337
 * @adr ADR-051
 * @adr ADR-059
 */

import { ExitCode } from '@cleocode/contracts';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliError } from '../renderers/index.js';

/**
 * cleo verify <task-id> — view or modify verification gates.
 *
 * @remarks
 * Read-only view is the default when no write flag is provided. Passing
 * `--explain` enriches the view with the blocker breakdown described in
 * ADR-051 §2.3 (T1013).
 *
 * Pass `--shared-evidence` when knowingly applying the same evidence atom
 * across more than 3 tasks in one session (T1502 / ADR-059).
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
    run: {
      type: 'boolean',
      description:
        "Execute the task's typed acceptance gates and report the results. Read-only: nothing is recorded, so use `--evidence` to attest (T12308).",
    },
    'shared-evidence': {
      type: 'boolean',
      description:
        'Acknowledge that the same evidence atom is applied to >3 distinct tasks in this session (T1502 / ADR-059). Without this flag, such reuse triggers a warning; in strict mode (CLEO_STRICT_EVIDENCE=1) it is a hard reject.',
    },
  },
  async run({ args, cmd }) {
    if (!args.taskId) {
      await showUsage(cmd);
      return;
    }

    const isWrite = !!(args.gate || args.all || args.reset);

    // T12308: `--run` executes typed gates and records nothing. Combining it
    // with a write would blur exactly the line it exists to draw — the gates
    // already run implicitly during an evidence write, and the reader would
    // have no way to tell which results were attested and which were merely
    // observed. Rejected rather than silently ignored.
    if (args.run === true && isWrite) {
      // ADR-086: a rejection is still one LAFS envelope on stdout. A raw
      // stderr write here would hand a machine consumer an exit code with no
      // parseable reason — which is what the JSON-stream-hygiene gate exists
      // to stop, and it caught this line.
      cliError(
        '--run reports typed gate results and records nothing; it cannot be combined with ' +
          '--gate/--all/--reset.',
        ExitCode.VALIDATION_ERROR,
        {
          name: 'E_VALIDATION',
          fix: 'Run `cleo verify <id> --run` first, then attest with `cleo verify <id> --gate <name> --evidence <atoms>`',
        },
        { operation: 'check.gate.run' },
      );
      process.exitCode = ExitCode.VALIDATION_ERROR;
      return;
    }

    // --explain is a read-only enrichment; writes ignore it and keep prior behavior.
    const useExplain = !isWrite && args.explain === true;

    const operation = isWrite
      ? 'gate.set'
      : args.run === true
        ? 'gate.run'
        : useExplain
          ? 'verify.explain'
          : 'gate.status';

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
        sharedEvidence: (args['shared-evidence'] as boolean | undefined) ?? false,
      },
      { command: 'verify' },
    );
  },
});
