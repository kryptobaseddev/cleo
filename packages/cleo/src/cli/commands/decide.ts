/**
 * CLI command group: `cleo decide` — configure and probe the typed-decision
 * ("System One") provider.
 *
 * The user supplies two settings, an API base URL and an API key, plus an
 * optional default model. Logic lives in `@cleocode/core/decide/operations`;
 * these handlers only parse flags and render (arch gate 6). No output ever
 * carries the key — at most a masked last-4 preview.
 *
 * Subcommands:
 *   cleo decide config --url <u> --key-stdin [--model <m>]   — store settings (recommended form)
 *   cleo decide config --url <u> --key <k>                   — same; the key lands in shell history
 *   cleo decide config --clear                               — remove settings
 *   cleo decide status                                       — probe GET {url}/v1/models
 *   cleo decide ask --state <text> --noul <question>         — one debug decision
 *   cleo decide sites [--rung r] [--mode m] [--id s] [--evidence] — list decision sites
 *
 * @task T12491
 * @epic T12486
 */

import {
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
  probeDecideProvider,
} from '@cleocode/core/decide/index.js';
import { defineCommand, showUsage } from '../lib/define-cli-command.js';
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

const CONFIG_FIX =
  'printf %s "$KEY" | cleo decide config --url https://provider.example --key-stdin';

/** `cleo decide config` */
const decideConfigCommand = defineCommand({
  meta: {
    name: 'config',
    description:
      'Store the decision provider API URL and key (0600 file in the CLEO home). Prefer --key-stdin so the key stays out of shell history. No flags shows the current settings (key masked).',
  },
  args: {
    url: { type: 'string', description: 'Provider API base URL, e.g. https://layahost.com' },
    key: {
      type: 'string',
      description:
        'API key. Visible in the process list (ps) and shell history; prefer --key-stdin',
    },
    'key-stdin': { type: 'boolean', description: 'Read the API key from stdin (recommended)' },
    model: { type: 'string', description: 'Optional default model; omitted → provider listing' },
    clear: { type: 'boolean', description: 'Remove the stored URL, key and model' },
  },
  async run({ args }) {
    const op = 'decide.config';
    if (args.clear === true)
      return cliOutput(await clearDecideConfig(), { command: 'decide', operation: op });
    const apiKey = args['key-stdin'] === true ? await readSecretFromStdin() : args.key;
    if (args['key-stdin'] === true && !apiKey)
      return failValidation('--key-stdin set but stdin is empty or a TTY', op, CONFIG_FIX);
    if (args.url === undefined && apiKey === undefined && args.model === undefined) {
      return cliOutput(describeDecideCredentials(), { command: 'decide', operation: op });
    }
    try {
      const result = await configureDecide({ baseUrl: args.url, apiKey, model: args.model });
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
      'Probe the decision provider (GET {url}/v1/models, short timeout): reachable, unauthorized, unconfigured or unreachable. Exits 1 unless reachable.',
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

/**
 * `cleo decide` — typed-decision provider setup and debugging.
 *
 * @task T12491
 */
export const decideCommand = defineCommand({
  meta: {
    name: 'decide',
    description:
      'System One integration (typed decisions): decide config (API URL + key), decide status (reachability probe), decide ask (one debug question), decide sites (the registered decision sites). Unconfigured means heuristics answer.',
  },
  subCommands: {
    config: decideConfigCommand,
    status: decideStatusCommand,
    ask: decideAskCommand,
    sites: decideSitesCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
