/**
 * `cleo doctor skill-fixtures` — caamp unit-test fixtures left in the real
 * skills root.
 *
 * Before the test sandbox covered the skills root, caamp tests wrote
 * `<prefix>-<uuid>` skill dirs plus `real-skill` / `skill-alpha` /
 * `skill-beta` into `<cleoHome>/skills`. An entry counts as a fixture only
 * when its name AND its content match what those tests write; a name match
 * with other content is reported `unclassified` and never touched. Manifest
 * skills, bundled skill names and hidden entries are never candidates.
 *
 * Read-only by default. `--repair` moves every fixture into
 * `<cleoHome>/audit/skill-fixture-quarantine/<receiptId>/` (nothing is
 * deleted) and appends intent/completed receipts to
 * `<cleoHome>/audit/skill-fixtures.jsonl`. `--restore <receiptId>` moves
 * that run's entries back. `--dry-run` shows the receipt without touching
 * disk.
 *
 * @task T12645
 */

import {
  auditSkillFixtures,
  repairSkillFixtures,
  restoreSkillFixtures,
} from '@cleocode/core/system/skill-fixtures.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor skill-fixtures` subcommand. Exits non-zero while fixtures remain.
 *
 * @task T12645
 */
export const doctorSkillFixturesCommand = defineCommand({
  meta: {
    name: 'skill-fixtures',
    description:
      'Find caamp test fixtures left in the real skills root (UUID-named and known fixture ' +
      'dirs whose content matches the tests). Read-only; --repair quarantines them with a ' +
      'receipt (--dry-run to preview).',
  },
  args: {
    repair: {
      type: 'boolean',
      description:
        'Move every fixture into <cleoHome>/audit/skill-fixture-quarantine/<receiptId>/ and ' +
        'append a receipt. Unclassified entries are reported, never moved.',
    },
    restore: {
      type: 'string',
      description:
        'Move the entries quarantined by this repair receipt id back to their original paths ' +
        '(never over an occupied path). Appends a restored receipt.',
    },
    'dry-run': {
      type: 'boolean',
      description: 'With --repair or --restore: report the receipt without touching disk',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const dryRun = args['dry-run'] === true;
    if (typeof args.restore === 'string' && args.restore.length > 0) {
      try {
        const receipt = restoreSkillFixtures(args.restore, { dryRun });
        cliOutput(
          { restore: receipt, audit: auditSkillFixtures() },
          { command: 'doctor', operation: 'doctor.skill-fixtures.run' },
        );
        if (receipt.skipped.length > 0 && !dryRun) process.exitCode = 1;
      } catch (err) {
        cliError(
          err instanceof Error ? err.message : String(err),
          1,
          {
            name: 'E_SKILL_FIXTURE_RESTORE_FAILED',
            fix:
              'Pass a receipt id from <cleoHome>/audit/skill-fixtures.jsonl whose repair ' +
              'finished and has not been restored. Entries restored before a failure are listed ' +
              'in that file; the rest stay in quarantine.',
          },
          { operation: 'doctor.skill-fixtures.run' },
        );
        process.exitCode = 1;
      }
      return;
    }
    let result: ReturnType<typeof repairSkillFixtures> | null = null;
    if (args.repair === true) {
      try {
        result = repairSkillFixtures({ dryRun });
      } catch (err) {
        cliError(
          err instanceof Error ? err.message : String(err),
          1,
          {
            name: 'E_SKILL_FIXTURE_REPAIR_FAILED',
            fix:
              'Entries moved before the failure are in the quarantine dir named by the intent ' +
              'receipt in <cleoHome>/audit/skill-fixtures.jsonl; the rest are untouched. ' +
              'Re-run `cleo doctor skill-fixtures --repair`.',
          },
          { operation: 'doctor.skill-fixtures.run' },
        );
        process.exitCode = 1;
        return;
      }
    }
    const audit = result?.audit ?? auditSkillFixtures();

    cliOutput(
      { ...audit, receipt: result?.receipt ?? null },
      { command: 'doctor', operation: 'doctor.skill-fixtures.run' },
    );

    if (!audit.healthy && !dryRun && (process.exitCode ?? 0) === 0) {
      process.exitCode = 1;
    }
  },
});
