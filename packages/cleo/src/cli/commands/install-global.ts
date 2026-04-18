/**
 * CLI `cleo install-global` command — manually trigger the global bootstrap flow.
 *
 * This is the manual entry point for the same flow that runs during
 * `npm install -g @cleocode/cleo` (postinstall). It installs:
 *   - Templates to the canonical XDG data dir and the ~/.cleo symlink
 *   - CAAMP injection block into ~/.agents/AGENTS.md
 *   - Core skills globally
 *   - Agent definition (cleo-subagent symlink)
 *   - Seed CANT agent personas
 *   - Provider adapters
 *
 * Useful when:
 *   - The postinstall hook was skipped or failed
 *   - A new AI provider was installed and injection needs to be (re-)applied
 *   - The ~/.cleo symlink migration needs to be triggered manually
 *
 * @task T929
 */

import { type BootstrapContext, bootstrapGlobalCleo } from '@cleocode/core/internal';
import { defineCommand } from 'citty';
import { cliOutput } from '../renderers/index.js';

/**
 * Render a BootstrapContext result in human-readable form.
 *
 * @param ctx - Bootstrap context produced by bootstrapGlobalCleo()
 * @param dryRun - Whether this was a dry-run pass
 */
function renderBootstrapHuman(ctx: BootstrapContext, dryRun: boolean): void {
  if (dryRun) {
    process.stdout.write('Dry-run mode — no changes will be made.\n\n');
  }

  if (ctx.created.length > 0) {
    process.stdout.write(`${dryRun ? 'Would create/update' : 'Created/updated'}:\n`);
    for (const item of ctx.created) {
      process.stdout.write(`  + ${item}\n`);
    }
    process.stdout.write('\n');
  } else {
    process.stdout.write('No changes needed — everything is already up to date.\n\n');
  }

  if (ctx.warnings.length > 0) {
    process.stdout.write('Warnings:\n');
    for (const w of ctx.warnings) {
      process.stdout.write(`  ! ${w}\n`);
    }
    process.stdout.write('\n');
  }
}

/**
 * Native citty command for `cleo install-global`.
 *
 * Runs the global bootstrap manually (install templates, ~/.cleo symlink,
 * agents, skills). Same operations as the npm postinstall hook.
 *
 * Global output flags (--json, --human, --quiet) are declared in args so
 * citty parses them directly. This replaces the Commander.js optsWithGlobals()
 * pattern that is unavailable in native citty commands.
 */
export const installGlobalCommand = defineCommand({
  meta: {
    name: 'install-global',
    description:
      'Run the global bootstrap manually (install templates, ~/.cleo symlink, agents, skills). Same as npm postinstall.',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Preview changes without applying them',
    },
    // Global output format flags — read directly from args (no optsWithGlobals in citty)
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
    human: {
      type: 'boolean',
      description: 'Force human-readable output',
    },
    quiet: {
      type: 'boolean',
      description: 'Suppress non-essential output',
    },
  },
  async run({ args }) {
    const dryRun = args['dry-run'] === true;
    const isHuman = args.human === true || (!!process.stdout.isTTY && args.json !== true);

    const ctx: BootstrapContext = await bootstrapGlobalCleo({ dryRun });

    if (isHuman && args.quiet !== true) {
      renderBootstrapHuman(ctx, dryRun);
    }

    cliOutput(
      {
        dryRun,
        created: ctx.created,
        warnings: ctx.warnings,
      },
      {
        command: 'install-global',
        message: dryRun
          ? `Dry-run complete — ${ctx.created.length} action(s) would be applied`
          : `Bootstrap complete — ${ctx.created.length} action(s) applied, ${ctx.warnings.length} warning(s)`,
      },
    );
  },
});
