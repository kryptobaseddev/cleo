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
 *   cleo decide config --clear                               — remove settings
 *   cleo decide status                                       — probe GET {url}/v1/models
 *   cleo decide ask --state <text> --noul <question>         — one debug decision
 *   cleo decide sites [--rung r] [--mode m] [--id s] [--evidence] — list decision sites
 *   cleo decide budget reset [--force]                       — repair a corrupt spend ledger
 *   cleo decide bench [--profiles a,b] [--sites …] [--sample-only] [--corrections f] [--max-usd N] [--runs N] [--out dir]
 *                                                            — System One accuracy benchmark (T12495)
 *
 * @task T12491
 * @task T12713
 * @task T12495
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
  describeDecideCredentials,
  listDecisionSites,
  parseDecisionProviderKind,
  probeDecideProvider,
  resetDecideBudget,
  runDecideWizard,
  SpendResetRefusedError,
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
      'Store the decision provider, API key and model (0600 file in the CLEO home), then probe it and detect its capabilities. --provider layahost (default) needs only the key; --provider jev needs --url. Prefer --key-stdin so the key stays out of shell history. No flags on a terminal runs the setup wizard (the key is typed hidden); no flags without a terminal shows the current settings (key masked).',
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
    clear: { type: 'boolean', description: 'Remove the stored URL, key and model' },
  },
  async run({ args }) {
    const op = 'decide.config';
    if (args.clear === true)
      return cliOutput(await clearDecideConfig(), { command: 'decide', operation: op });
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
      args.model === undefined;
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
      });
      cliOutput(result, { command: 'decide', operation: op });
    } catch (err) {
      failValidation(err instanceof Error ? err.message : 'invalid settings', op, CONFIG_FIX);
    }
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
  },
  async run({ args }) {
    const timeoutMs = args['timeout-ms'] ? Number(args['timeout-ms']) : undefined;
    const result = await askDecideDebug({ state: args.state, question: args.noul, timeoutMs });
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

/** Split a comma list flag. */
function commaList(value: string | undefined): string[] | undefined {
  return value === undefined
    ? undefined
    : value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
}

/** A numeric flag, or `undefined` when absent. */
function numberFlag(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

/** `cleo decide bench` */
const decideBenchCommand = defineCommand({
  meta: {
    name: 'bench',
    description:
      "System One accuracy benchmark (T12495): build a labelled dataset from this project's own history (duplicate task pairs, explicitly typed observations, superseding decisions; redacted), write a stratified spot-check sample for the owner, then compare providers against each site's heuristic with batched calls (provider cache off, 30s or longer deadline): accuracy, precision, recall, F1, false-positive rate, p50/p95 latency, cost and fallbacks, mean and spread over --runs. A hard total cap (--max-usd, default 5) is checked before every batch; the run stops cleanly at it. Profiles resolve from CLEO_DECIDE_PROFILE_<NAME>_KEY/_URL/_MODEL or the stored provider kind. --sample-only never contacts a provider.",
  },
  args: {
    profiles: {
      type: 'string',
      description: 'Comma list of provider profiles to compare, e.g. layahost,jev',
    },
    sites: {
      type: 'string',
      description:
        'Comma list: duplicateDetection,observationType,decisionContradiction (default all)',
    },
    'sample-only': {
      type: 'boolean',
      description: 'Build the dataset and the spot-check sample only (offline, no spend)',
    },
    corrections: {
      type: 'string',
      description:
        'Owner corrections file ({"corrections":[{"id","label"}|{"id","drop":true}]}) to apply',
    },
    'max-usd': { type: 'string', description: 'Hard total spend cap in USD (default 5)' },
    runs: { type: 'string', description: 'Repeated runs for mean and spread (default 1)' },
    out: { type: 'string', description: 'Output directory (default .cleo/decide-bench)' },
    'batch-size': { type: 'string', description: 'Rows per batch call, 1-64 (default 16)' },
    rebuild: {
      type: 'boolean',
      description: 'Rebuild the dataset from the stores (drops corrections)',
    },
    seed: { type: 'string', description: 'Seed for negatives and the sample (default 12495)' },
  },
  async run({ args }) {
    const op = 'decide.bench';
    const { DecideBenchInputError, runDecideBenchOperation } = await import(
      '@cleocode/core/decide/bench/index.js'
    );
    try {
      const result = await runDecideBenchOperation({
        profiles: commaList(args.profiles),
        sites: commaList(args.sites),
        sampleOnly: args['sample-only'] === true,
        correctionsPath: args.corrections,
        maxUsd: numberFlag(args['max-usd']),
        runs: numberFlag(args.runs),
        outDir: args.out,
        batchSize: numberFlag(args['batch-size']),
        rebuild: args.rebuild === true,
        seed: numberFlag(args.seed),
      });
      cliOutput(result, { command: 'decide', operation: op });
    } catch (err) {
      if (!(err instanceof DecideBenchInputError)) throw err;
      failValidation(err.message, op, err.fix);
    }
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
      'System One integration (typed decisions): decide config (provider + API key; wizard on a terminal), decide status (reachability probe), decide ask (one debug question), decide sites (the registered decision sites), decide bench (accuracy benchmark). Unconfigured means heuristics answer.',
  },
  subCommands: {
    config: decideConfigCommand,
    status: decideStatusCommand,
    ask: decideAskCommand,
    sites: decideSitesCommand,
    budget: decideBudgetCommand,
    bench: decideBenchCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
