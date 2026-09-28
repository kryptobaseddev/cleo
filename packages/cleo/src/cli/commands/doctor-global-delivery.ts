/**
 * `cleo doctor global-delivery` — does every harness on this machine load CLEO?
 *
 * One surface for the three things that silently break global delivery:
 * `~/.cleo` (must link to the platform data dir), the hub
 * `~/.agents/AGENTS.md` (its `@~/.cleo/templates/CLEO-INJECTION.md` reference
 * must resolve), and CLEO skill installs in every harness skills dir (each
 * must resolve; links routed through `~/.cleo` break all at once when it
 * dangles).
 *
 * Read-only by default. `--repair` relinks `~/.cleo` (preserving a live
 * foreign link or directory beside it) and relinks every dangling or
 * `~/.cleo`-routed skill entry to the physical skills dir, as a verified
 * symlink or, where links are unsupported, a copy. One receipt per run is
 * appended to `<cleoHome>/audit/global-delivery.jsonl`. `--dry-run` shows the
 * receipt without writing.
 *
 * @task T12596
 * @task T12598
 */

import {
  auditGlobalDelivery,
  repairGlobalDelivery,
} from '@cleocode/core/system/global-delivery.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor global-delivery` subcommand. Exits non-zero while unhealthy.
 *
 * @task T12598
 */
export const doctorGlobalDeliveryCommand = defineCommand({
  meta: {
    name: 'global-delivery',
    description:
      'Check that ~/.cleo, the global hub reference and every harness CLEO skill install ' +
      'resolve. Read-only; --repair relinks them with a receipt (--dry-run to preview).',
  },
  args: {
    repair: {
      type: 'boolean',
      description:
        'Relink ~/.cleo to the OS data dir and every dangling or ~/.cleo-routed skill entry ' +
        'to the physical skills dir (verified symlink, else copy). Appends a receipt.',
    },
    'dry-run': {
      type: 'boolean',
      description: 'With --repair: report the receipt without touching disk',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const dryRun = args['dry-run'] === true;
    let result: Awaited<ReturnType<typeof repairGlobalDelivery>> | null = null;
    if (args.repair === true) {
      try {
        result = await repairGlobalDelivery({ dryRun });
      } catch (err) {
        // A symlink/junction failure (e.g. Windows without Developer Mode or
        // admin). The repair rolled the previous entry back before throwing.
        const message = err instanceof Error ? err.message : String(err);
        cliError(
          message,
          1,
          {
            name: 'E_CLEO_LINK_REPAIR_FAILED',
            fix:
              'The previous ~/.cleo entry was restored. On Windows enable Developer Mode or run ' +
              'as administrator, then re-run `cleo doctor global-delivery --repair`. The receipt ' +
              'log under <cleoHome>/audit records the attempt.',
          },
          { operation: 'doctor.global-delivery.run' },
        );
        process.exitCode = 1;
        return;
      }
    }
    const audit = result?.audit ?? (await auditGlobalDelivery());

    cliOutput(
      { ...audit, receipt: result?.receipt ?? null },
      { command: 'doctor', operation: 'doctor.global-delivery.run' },
    );

    const refused = result?.receipt.link.action === 'refused';
    if ((refused || (!audit.healthy && !dryRun)) && (process.exitCode ?? 0) === 0) {
      process.exitCode = 1;
    }
  },
});
