/**
 * CLI command: cleo hook heavy-command [--provider <p>]
 *
 * Hooks CLEO installs into agent harnesses. Each subcommand reads the
 * harness's hook payload on stdin and answers in the harness's own protocol on
 * stdout (not a LAFS envelope). `bin/cleo.js` short-circuits `cleo hook …` to
 * the same runtime without the CLI bootstrap, because the heavy-command hook
 * runs before every shell command an agent issues. The runtime lives in
 * `../hook-entry.ts`.
 *
 * @task T12983
 * @epic T12978
 */

import { defineCommand, showUsage } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

const heavyCommandSubcommand = defineCommand({
  meta: {
    name: 'heavy-command',
    description:
      'PreToolUse hook: route heavy shell commands (tests, builds, typechecks, installs) through cleo run. Reads the hook JSON on stdin; prints the harness answer.',
  },
  args: {
    provider: {
      type: 'string',
      description: 'Harness protocol to answer in: claude-code (default), codex, kimi, opencode',
    },
  },
  async run({ args }) {
    const { runHookCli } = await import('../hook-entry.js');
    const provider = typeof args.provider === 'string' ? args.provider : 'claude-code';
    process.exitCode = await runHookCli(['heavy-command', '--provider', provider]);
  },
});

const syncSubcommand = defineCommand({
  meta: {
    name: 'sync',
    description:
      'Preview or explicitly activate hash-bound project hooks; never grants native trust',
  },
  args: {
    'dry-run': { type: 'boolean', description: 'Validate and preview without writing files' },
    activate: {
      type: 'boolean',
      description: 'Explicitly activate current definition and handler hashes',
    },
    disable: {
      type: 'boolean',
      description: 'Disable execution and remove only unmodified receipt-owned entries',
    },
    providers: {
      type: 'string',
      description: 'Comma-separated harness IDs; otherwise detect project providers',
    },
  },
  async run({ args }) {
    if ([args.activate, args.disable, args['dry-run']].filter(Boolean).length > 1) {
      cliError('Choose one of --dry-run, --activate or --disable', 'E_VALIDATION');
      process.exitCode = 1;
      return;
    }
    const state = await import('@cleocode/core/hooks/project-state');
    if (args.activate === true) await state.activateProjectHooks(process.cwd());
    if (args.disable === true) await state.disableProjectHooks(process.cwd());
    const inspection = await state.inspectProjectHooks(process.cwd());
    const { syncProjectHookProviders } = await import('@cleocode/adapters/project-hook-delivery');
    const providers = await syncProjectHookProviders({
      ...inspection.context,
      events: inspection.manifest.hooks.flatMap((hook) =>
        hook.bindings
          .filter((binding) => binding.source === 'agent')
          .map((binding) => binding.event),
      ),
      enabled:
        args.activate === true || args['dry-run'] === true || inspection.activation === 'active',
      dryRun: args.activate !== true && args.disable !== true,
      rollback: args.disable === true,
      providers: typeof args.providers === 'string' ? args.providers.split(',') : undefined,
    });
    const { installCleoHooks } = await import('@cleocode/core/git/hooks-install');
    const git = await installCleoHooks(inspection.context.projectRoot, {
      dryRun: args.activate !== true,
    });
    const conflict =
      providers.some((provider) => provider.state === 'conflict') ||
      Object.keys(git.skipReasons).length > 0;
    cliOutput(
      {
        inspection,
        providers,
        git,
        deliveryStatus: conflict
          ? 'conflict'
          : providers.some((provider) => provider.state === 'unsupported')
            ? 'unsupported'
            : 'complete',
      },
      { command: 'hook', operation: 'hook.sync' },
    );
    if (conflict) process.exitCode = 1;
  },
});

const runSubcommand = defineCommand({
  meta: {
    name: 'run',
    description: 'Native project hook adapter: advisory agents, authoritative Git verdicts',
  },
  args: {
    source: { type: 'string', description: 'agent or git' },
    provider: { type: 'string', description: 'Harness protocol identifier' },
    event: { type: 'string', description: 'Canonical manifest event' },
    'remote-name': { type: 'string', description: 'Git remote name' },
    'remote-location': { type: 'string', description: 'Git remote location' },
    probe: {
      type: 'boolean',
      description: 'Print lightweight runner capability token without stdin',
    },
  },
  async run({ rawArgs }) {
    const { runProjectHookCli } = await import('../project-hook-entry.js');
    process.exitCode = await runProjectHookCli(rawArgs ?? []);
  },
});

const checkSubcommand = defineCommand({
  meta: {
    name: 'check',
    description:
      'Run one activated project check with a LAFS result; --ci fails unavailable checks',
  },
  args: {
    id: { type: 'positional', required: true, description: 'Manifest hook ID' },
    ci: { type: 'boolean', description: 'Require verifiable CI outcomes' },
    input: { type: 'string', description: 'Bounded JSON request file passed as toolInput' },
    candidate: {
      type: 'string',
      description: 'Explicit committed candidate SHA (toolInput.candidate)',
    },
  },
  async run({ args }) {
    const { checkProjectHookCli } = await import('../project-hook-entry.js');
    await checkProjectHookCli(
      String(args.id),
      args.ci === true ? 'ci' : 'direct',
      process.cwd(),
      args.input,
      args.candidate,
    );
  },
});

/** cleo hook — agent-harness hooks (stdout is the harness protocol). */
export const hookCommand = defineCommand({
  meta: {
    name: 'hook',
    description:
      'Agent-harness hooks installed by cleo init/upgrade; stdout is the harness hook protocol, not LAFS: cleo hook heavy-command --provider claude-code|codex|kimi|opencode',
  },
  subCommands: {
    'heavy-command': heavyCommandSubcommand,
    sync: syncSubcommand,
    run: runSubcommand,
    check: checkSubcommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
