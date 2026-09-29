/**
 * CLI command group: `cleo decide` — configure and probe the typed-decision
 * ("System One") provider.
 *
 * The user picks a provider (`layahost`, the default, needs only an API key;
 * `jev` also needs a URL) and supplies the key, plus an optional default
 * model. Logic lives in `@cleocode/core/decide/`; these handlers only parse
 * flags and render (arch gate 6). No output ever carries the key — at most a
 * masked last-4 preview.
 *
 * Subcommands:
 *   cleo decide config                                       — TTY: setup wizard (hidden key input); else show settings
 *   cleo decide config --provider layahost --key-stdin       — store settings (recommended scripted form)
 *   cleo decide config --provider jev --url <u> --key-stdin [--model <m>] — custom Jev endpoint
 *   cleo decide config --url <u> --key <k>                   — same; the key lands in shell history
 *   cleo decide config ... --profile <name> [--activate]     — add/update a named profile (T12733)
 *   cleo decide config --remove <name> [--use <other>]       — remove a profile
 *   cleo decide config --clear                               — remove every profile
 *   cleo decide use <profile>                                — switch the active profile
 *   cleo decide profiles [--probe]                           — list profiles (active marked, keys masked)
 *   cleo decide status                                       — probe GET {url}/v1/models
 *   cleo decide ask --state <text> --noul <question>         — one debug decision
 *   cleo decide sites [--rung r] [--mode m] [--id s] [--evidence] — list decision sites
 *   cleo decide budget reset [--force]                       — repair a corrupt spend ledger
 *
 * @task T12491
 * @task T12713
 * @task T12733
 * @epic T12486
 */

import {
  DECISION_PROVIDER_KINDS,
  DECISION_RUNGS,
  DECISION_SITE_MODES,
  type DecisionRung,
  type DecisionSiteModeValue,
  ExitCode,
} from '@cleocode/contracts';
import {
  askDecideDebug,
  clearDecideConfig,
  configureDecide,
  DecideCredentialsError,
  describeDecideCredentials,
  listDecideProfilesReport,
  listDecisionSites,
  parseDecisionProviderKind,
  probeDecideProvider,
  removeDecideProfile,
  resetDecideBudget,
  runDecideWizard,
  SpendResetRefusedError,
  useDecideProfile,
} from '@cleocode/core/decide/index.js';
import { WizardInterruptError } from '@cleocode/core/setup';
import { defineCommand, showUsage } from '../lib/define-cli-command.js';
import { ReadlineWizardIO } from '../lib/readline-wizard-io.js';
import { cliError, cliOutput } from '../renderers/index.js';

/** Read piped stdin (trimmed). Returns `''` for a TTY. */
async function readSecretFromStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  process.stdin.setEncoding('utf-8');
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf.trim();
}

/** Emit a validation error envelope and set exit code 6. */
function failValidation(message: string, operation: string, fix: string): void {
  cliError(message, ExitCode.VALIDATION_ERROR, { name: 'E_VALIDATION', fix }, { operation });
  process.exitCode = ExitCode.VALIDATION_ERROR;
}

const CONFIG_FIX = 'printf %s "$KEY" | cleo decide config --provider layahost --key-stdin';

const PROFILES_FIX = 'cleo decide profiles';

/** Run the interactive setup wizard on the terminal (stderr prompts, hidden key). */
async function runConfigWizard(op: string): Promise<void> {
  const io = new ReadlineWizardIO(process.stdin, process.stderr);
  try {
    cliOutput(await runDecideWizard(io), { command: 'decide', operation: op });
  } catch (err) {
    // Ctrl-C is a cancel, not a validation failure: exit 130 (SIGINT convention).
    if (err instanceof WizardInterruptError) {
      process.stderr.write('System One setup cancelled.\n'); // json-stream-hygiene-allowed: interactive wizard cancel notice on a TTY
      process.exitCode = 130;
      return;
    }
    failValidation(err instanceof Error ? err.message : 'setup failed', op, CONFIG_FIX);
  } finally {
    io.close();
  }
}

/** `cleo decide config` */
const decideConfigCommand = defineCommand({
  meta: {
    name: 'config',
    description:
      'Store a named System One profile: provider, API key and model (0600 file in the CLEO home), then probe it and detect its capabilities. --provider layahost (default) needs only the key; --provider jev needs --url. --profile names it (default: the provider name); other profiles are kept, and exactly one is active. Prefer --key-stdin so the key stays out of shell history. No flags on a terminal runs the setup wizard (the key is typed hidden); no flags without a terminal shows the active settings (key masked).',
  },
  args: {
    provider: {
      type: 'string',
      description: `Provider: ${DECISION_PROVIDER_KINDS.join('|')} (layahost: fixed URL, model laya-auto; jev: custom URL, required)`,
    },
    url: {
      type: 'string',
      description: 'Provider API base URL: overrides the layahost default; required for jev',
    },
    key: {
      type: 'string',
      description:
        'API key. Visible in the process list (ps) and shell history; prefer --key-stdin',
    },
    'key-stdin': { type: 'boolean', description: 'Read the API key from stdin (recommended)' },
    model: {
      type: 'string',
      description:
        'Default model; omitted → the stored model, the preset (layahost: laya-auto) or the first listed (jev)',
    },
    profile: {
      type: 'string',
      description:
        'Profile to add or update (lowercase a-z, 0-9, -; default: the provider name, or the active profile)',
    },
    activate: {
      type: 'boolean',
      description:
        'Make the profile active (default: only for the first profile or one already active)',
    },
    remove: {
      type: 'string',
      description: 'Remove this profile; the active one needs --use <other>',
    },
    use: { type: 'string', description: 'With --remove: the profile to activate instead' },
    clear: { type: 'boolean', description: 'Remove every profile (URLs, keys and models)' },
  },
  async run({ args }) {
    const op = 'decide.config';
    if (args.clear === true)
      return cliOutput(await clearDecideConfig(), { command: 'decide', operation: op });
    if (args.remove !== undefined) {
      try {
        const result = await removeDecideProfile(args.remove, args.use);
        return cliOutput(result, { command: 'decide', operation: 'decide.config.remove' });
      } catch (err) {
        if (!(err instanceof DecideCredentialsError)) throw err;
        return failValidation(err.message, op, PROFILES_FIX);
      }
    }
    const provider = parseDecisionProviderKind(args.provider);
    if (args.provider !== undefined && provider === undefined) {
      return failValidation(`unknown provider '${args.provider}'`, op, CONFIG_FIX);
    }
    const apiKey = args['key-stdin'] === true ? await readSecretFromStdin() : args.key;
    if (args['key-stdin'] === true && !apiKey)
      return failValidation('--key-stdin set but stdin is empty or a TTY', op, CONFIG_FIX);
    const noSettings =
      provider === undefined &&
      args.url === undefined &&
      apiKey === undefined &&
      args.model === undefined &&
      args.profile === undefined &&
      args.activate === undefined;
    if (noSettings && process.stdin.isTTY && process.stderr.isTTY) return runConfigWizard(op);
    if (noSettings) {
      return cliOutput(describeDecideCredentials(), { command: 'decide', operation: op });
    }
    try {
      const result = await configureDecide({
        provider,
        baseUrl: args.url,
        apiKey,
        model: args.model,
        profile: args.profile,
        ...(args.activate === true ? { activate: true } : {}),
      });
      cliOutput(result, { command: 'decide', operation: op });
    } catch (err) {
      failValidation(err instanceof Error ? err.message : 'invalid settings', op, CONFIG_FIX);
    }
  },
});

/** `cleo decide use` */
const decideUseCommand = defineCommand({
  meta: {
    name: 'use',
    description:
      'Switch the active System One profile: everyday decisions use it from now on. Other profiles stay stored and can still be addressed by name.',
  },
  args: {
    profile: { type: 'positional', description: 'Profile to activate', required: true },
  },
  async run({ args }) {
    const op = 'decide.use';
    try {
      cliOutput(await useDecideProfile(args.profile), { command: 'decide', operation: op });
    } catch (err) {
      if (!(err instanceof DecideCredentialsError)) throw err;
      failValidation(err.message, op, PROFILES_FIX);
    }
  },
});

/** `cleo decide profiles` */
const decideProfilesCommand = defineCommand({
  meta: {
    name: 'profiles',
    description:
      'List the stored System One profiles: the active one marked, keys masked. --probe also checks each profile (GET {url}/v1/models, in parallel).',
  },
  args: {
    probe: { type: 'boolean', description: "Probe each profile's reachability" },
    'timeout-ms': { type: 'string', description: 'Probe timeout in ms (default 3000)' },
  },
  async run({ args }) {
    const timeoutMs = args['timeout-ms'] ? Number(args['timeout-ms']) : undefined;
    const result = await listDecideProfilesReport({ probe: args.probe === true, timeoutMs });
    cliOutput(result, { command: 'decide', operation: 'decide.profiles' });
  },
});

/** `cleo decide status` */
const decideStatusCommand = defineCommand({
  meta: {
    name: 'status',
    description:
      'Probe the decision provider (GET {url}/v1/models, short timeout): reachable, unauthorized, key_limit_reached (the key monthly limit), unconfigured or unreachable. Also reports the registered sites count, the provider capabilities and balance (GET /v1/usage, refreshed at most every 10 minutes) and month-to-date spend against decide.budget.monthlyMicros. Exits 1 unless reachable.',
  },
  args: {
    'timeout-ms': { type: 'string', description: 'Probe timeout in ms (default 3000)' },
  },
  async run({ args }) {
    const timeoutMs = args['timeout-ms'] ? Number(args['timeout-ms']) : undefined;
    const result = await probeDecideProvider({ timeoutMs });
    cliOutput(result, { command: 'decide', operation: 'decide.status' });
    if (result.state !== 'reachable' && (process.exitCode ?? 0) === 0) process.exitCode = 1;
  },
});

/** `cleo decide ask` */
const decideAskCommand = defineCommand({
  meta: {
    name: 'ask',
    description:
      'Debug: ask one yes/no question about a state through the configured provider. Shows the typed answer, source (provider or fallback), latency and cost.',
  },
  args: {
    state: { type: 'string', description: 'The state (text) to judge', required: true },
    noul: { type: 'string', description: 'The yes/no question', required: true },
    'timeout-ms': { type: 'string', description: 'Deadline in ms (default 10000)' },
    profile: { type: 'string', description: 'Ask through this profile (default: the active one)' },
  },
  async run({ args }) {
    const timeoutMs = args['timeout-ms'] ? Number(args['timeout-ms']) : undefined;
    const result = await askDecideDebug({
      state: args.state,
      question: args.noul,
      timeoutMs,
      ...(args.profile ? { profile: args.profile } : {}),
    });
    cliOutput(result, { command: 'decide', operation: 'decide.ask' });
  },
});

/** Narrow a flag value to one of `allowed`. */
function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((a) => a === value);
}

/** `cleo decide sites` */
const decideSitesCommand = defineCommand({
  meta: {
    name: 'sites',
    description:
      'List the System One integration decision sites: rung, ladder, fallback, owner escalation, configured and effective mode, go-live evidence and last-7-day activity. A site that uses System One is effectively off while no provider is configured.',
  },
  args: {
    rung: {
      type: 'string',
      description: `Only sites with this primary rung (${DECISION_RUNGS.join('|')})`,
    },
    mode: {
      type: 'string',
      description: `Only sites with this effective mode (${DECISION_SITE_MODES.join('|')})`,
    },
    id: { type: 'string', description: 'Only the site with this id' },
    evidence: { type: 'boolean', description: 'Only sites with recorded go-live evidence' },
  },
  async run({ args }) {
    const op = 'decide.sites';
    const rung: DecisionRung | undefined = oneOf(args.rung, DECISION_RUNGS);
    if (args.rung !== undefined && rung === undefined) {
      return failValidation(
        `unknown rung '${args.rung}'`,
        op,
        `--rung ${DECISION_RUNGS.join('|')}`,
      );
    }
    const mode: DecisionSiteModeValue | undefined = oneOf(args.mode, DECISION_SITE_MODES);
    if (args.mode !== undefined && mode === undefined) {
      return failValidation(
        `unknown mode '${args.mode}'`,
        op,
        `--mode ${DECISION_SITE_MODES.join('|')}`,
      );
    }
    const result = await listDecisionSites({
      rung,
      mode,
      id: args.id,
      evidenceOnly: args.evidence === true,
    });
    cliOutput(result, { command: 'decide', operation: op });
  },
});

/** `cleo decide budget reset` */
const decideBudgetResetCommand = defineCommand({
  meta: {
    name: 'reset',
    description:
      'Repair a corrupt System One spend ledger (<cleoHome>/decide/spend.json): start a fresh one for this month, moving the old file aside as a receipt. Refuses a readable ledger unless --force; month-to-date spend is always kept when readable, so a reset never lifts a reached cap.',
  },
  args: {
    force: {
      type: 'boolean',
      description:
        'Reset a ledger that is not corrupt (keeps month-to-date spend; clears in-flight reservations and the key-limit stop)',
    },
  },
  async run({ args }) {
    const op = 'decide.budget.reset';
    try {
      const receipt = await resetDecideBudget(undefined, { force: args.force === true });
      cliOutput(receipt, { command: 'decide', operation: op });
    } catch (err) {
      if (!(err instanceof SpendResetRefusedError)) throw err;
      failValidation(err.message, op, 'cleo decide status');
    }
  },
});

/** `cleo decide budget` */
const decideBudgetCommand = defineCommand({
  meta: {
    name: 'budget',
    description: 'System One monthly spend cap (decide.budget.monthlyMicros): budget reset',
  },
  subCommands: { reset: decideBudgetResetCommand },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});

/**
 * `cleo decide` — typed-decision provider setup and debugging.
 *
 * @task T12491
 */
export const decideCommand = defineCommand({
  meta: {
    name: 'decide',
    description:
      'System One integration (typed decisions): decide config (named provider profile + API key; wizard on a terminal), decide use (switch the active profile), decide profiles (list them), decide status (reachability probe), decide ask (one debug question), decide sites (the registered decision sites). Unconfigured means heuristics answer.',
  },
  subCommands: {
    config: decideConfigCommand,
    use: decideUseCommand,
    profiles: decideProfilesCommand,
    status: decideStatusCommand,
    ask: decideAskCommand,
    sites: decideSitesCommand,
    budget: decideBudgetCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
