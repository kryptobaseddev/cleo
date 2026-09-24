/**
 * `cleo doctor split-brain` — import the rows only one copy of a project store
 * has into another copy, under new ids, without changing any existing row.
 *
 * Dry-run by default: it prints the divergence point, the id map, and per-table
 * counts, including what is skipped and why. `--apply` writes the target in one
 * transaction. `--verify-before <snapshot>` then proves that every row of the
 * pre-import snapshot is still present, byte-identical.
 *
 * Both paths are explicit. The command never guesses a store, and applying
 * to a live store is an owner decision.
 *
 * @task T12329
 */

import { writeFileSync } from 'node:fs';
import {
  importSplitBrain,
  verifyPreexistingRows,
} from '@cleocode/core/store/split-brain-import.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor split-brain` subcommand.
 *
 * Exits 1 when `--verify-before` finds any pre-existing row missing or changed.
 *
 * @task T12329
 */
export const doctorSplitBrainCommand = defineCommand({
  meta: {
    name: 'split-brain',
    description:
      'Import rows that exist only in a diverged copy of a store (--source) into another (--target) ' +
      'under new task ids, with provenance. Dry-run unless --apply; --verify-before <snapshot> proves ' +
      'no pre-existing target row changed.',
  },
  args: {
    source: {
      type: 'string',
      description: 'Store with the extra rows (opened read-only)',
      required: true,
    },
    target: { type: 'string', description: 'Store that receives them', required: true },
    apply: { type: 'boolean', description: 'Write the target (default: dry run)' },
    label: { type: 'string', description: 'Provenance label for the source (default: its path)' },
    'diverged-after': {
      type: 'string',
      description: 'Override the detected divergence point (ISO 8601)',
    },
    receipt: { type: 'string', description: 'Also write the receipt JSON to this file' },
    task: {
      type: 'string',
      description:
        'Task that records provenance of imported non-task rows (required with --apply when there are any)',
    },
    'verify-before': {
      type: 'string',
      description: 'Pre-import snapshot of the target; verify every one of its rows is unchanged',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const report = importSplitBrain({
      sourcePath: String(args.source),
      targetPath: String(args.target),
      dryRun: !args.apply,
      sourceLabel: args.label ? String(args.label) : undefined,
      divergedAfter: args['diverged-after'] ? String(args['diverged-after']) : undefined,
      provenanceTaskId: args.task ? String(args.task) : undefined,
    });
    const verification = args['verify-before']
      ? verifyPreexistingRows(String(args['verify-before']), String(args.target))
      : undefined;
    const changed = verification?.filter((check) => check.missingOrChanged > 0) ?? [];
    const result = {
      ...report,
      ...(verification && {
        verification: {
          tablesChecked: verification.length,
          rowsBefore: verification.reduce((sum, check) => sum + check.before, 0),
          rowsAfter: verification.reduce((sum, check) => sum + check.after, 0),
          missingOrChanged: changed,
        },
      }),
    };
    if (args.receipt) writeFileSync(String(args.receipt), `${JSON.stringify(result, null, 2)}\n`);
    cliOutput(result, { command: 'doctor', operation: 'doctor.split-brain.run' });
    if (changed.length > 0 && (process.exitCode ?? 0) === 0) process.exitCode = 1;
  },
});
