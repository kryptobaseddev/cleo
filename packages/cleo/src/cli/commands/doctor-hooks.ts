/** Read-only project hook ownership, activation and capability diagnostics (T13344). */
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/** Inspect shared hooks; --fix only refreshes already activated managed delivery. */
export const doctorHooksCommand = defineCommand({
  meta: {
    name: 'hooks',
    description:
      'Inspect hook attribution, activation, drift and provider trust; --fix repairs eligible managed entries',
  },
  args: {
    fix: { type: 'boolean', description: 'Repair delivery only when current hashes are activated' },
    providers: { type: 'string', description: 'Comma-separated harness IDs to inspect' },
  },
  async run({ args }) {
    const { inspectProjectHooks } = await import('@cleocode/core/hooks/project-state');
    const { readLastProjectHookExecution } = await import('@cleocode/core/hooks/project-runner');
    const inspection = await inspectProjectHooks(process.cwd());
    const { syncProjectHookProviders, hasUnsupportedProjectHookDelivery } = await import(
      '@cleocode/adapters/project-hook-delivery'
    );
    const providers = await syncProjectHookProviders({
      ...inspection.context,
      enabled: inspection.activation === 'active',
      events: inspection.manifest.hooks.flatMap((hook) =>
        hook.bindings
          .filter((binding) => binding.source === 'agent')
          .map((binding) => binding.event),
      ),
      dryRun: args.fix !== true || inspection.activation !== 'active',
      providers: typeof args.providers === 'string' ? args.providers.split(',') : undefined,
    });
    const { installCleoHooks } = await import('@cleocode/core/git/hooks-install');
    const git = await installCleoHooks(inspection.context.projectRoot, {
      dryRun: args.fix !== true || inspection.activation !== 'active',
    });
    const conflict =
      providers.some((provider) => provider.state === 'conflict') ||
      Object.keys(git.skipReasons).length > 0;
    cliOutput(
      {
        ...inspection,
        lastExecution: await readLastProjectHookExecution(process.cwd()),
        providers,
        git,
        deliveryStatus: conflict
          ? 'conflict'
          : hasUnsupportedProjectHookDelivery(providers)
            ? 'unsupported'
            : 'complete',
        fixApplied: args.fix === true && inspection.activation === 'active',
      },
      { command: 'doctor', operation: 'doctor.hooks' },
    );
    if (inspection.activation === 'drifted' || conflict) process.exitCode = 1;
  },
});
