/**
 * `cleo doctor cleo-link` — does `~/.cleo` deliver the global protocol?
 *
 * The global hub `~/.agents/AGENTS.md` references
 * `@~/.cleo/templates/CLEO-INJECTION.md`. A dangling or foreign `~/.cleo`
 * (e.g. a Linux target carried to macOS by dotfiles) makes that reference
 * resolve to nothing, and every harness loading the hub gets no protocol.
 *
 * Read-only by default. `--repair` relinks `~/.cleo` to the OS data directory,
 * preserving a live foreign link or directory beside it, and appends a receipt
 * to `<cleoHome>/audit/cleo-link-repairs.jsonl`. `--dry-run` shows the receipt
 * the repair would write.
 *
 * @task T12596
 */

import { auditCleoLink, repairCleoLink } from '@cleocode/core/system/cleo-link.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor cleo-link` subcommand.
 *
 * Exits non-zero while the hub reference does not resolve, so it can gate a
 * setup script.
 *
 * @task T12596
 */
export const doctorCleoLinkCommand = defineCommand({
  meta: {
    name: 'cleo-link',
    description:
      'Check that ~/.cleo links to the OS CLEO data dir so the global hub reference ' +
      '@~/.cleo/templates/CLEO-INJECTION.md resolves. Read-only; --repair relinks it with a receipt.',
  },
  args: {
    repair: {
      type: 'boolean',
      description:
        'Relink ~/.cleo to the OS data dir. A dangling link is replaced; a live foreign link ' +
        'or directory is moved to ~/.cleo.preserved-<ts> first. Appends a receipt.',
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
    const before = auditCleoLink();
    const repaired =
      args.repair === true ? await repairCleoLink({ dryRun: args['dry-run'] === true }) : null;
    const audit = repaired?.audit ?? before;

    cliOutput(
      { ...audit, before, receipt: repaired?.receipt ?? null },
      { command: 'doctor', operation: 'doctor.cleo-link.run' },
    );

    const healthy = audit.state === 'canonical' && audit.hubReferenceResolves;
    const refused = repaired?.receipt.action === 'refused';
    const dryRun = args['dry-run'] === true;
    if ((refused || (!healthy && !dryRun)) && (process.exitCode ?? 0) === 0) {
      process.exitCode = 1;
    }
  },
});
