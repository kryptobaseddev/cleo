/**
 * CLI command group: `cleo llm` — multi-credential pool + role-aware resolver.
 *
 * Subcommands:
 *   cleo llm add <provider> (--api-key-stdin | --api-key-env=NAME | --api-key=<v>) [--label l] [--base-url u]
 *   cleo llm list [provider]
 *   cleo llm remove <provider> --label <l>
 *   cleo llm use <provider> [--model m]
 *   cleo llm profile <role> <provider> [--model m] [--credential-label l]
 *   cleo llm test <provider> [--label l] [--model m]
 *   cleo llm whoami [--role r]
 *
 * All subcommands dispatch via `dispatchFromCli('mutate'|'query', 'llm', ...)`
 * — the engine lives in `@cleocode/core/llm/cli-ops.ts` and the dispatch
 * domain at `packages/cleo/src/dispatch/domains/llm/`.
 *
 * ## Security (S-11) — secret-on-argv mitigation
 *
 * `cleo llm add` accepts the credential through three input modes, in
 * priority order:
 *
 *   1. `--api-key-stdin`  — read from stdin (recommended; not visible to
 *                           `ps`, shell history, or process inspection).
 *   2. `--api-key-env=NAME` — read from the env var named `NAME`.
 *   3. `--api-key=<value>` — DEPRECATED. Accepted for backward compat
 *                            with CI scripts, but emits a stderr warning
 *                            because the value is visible to anyone who
 *                            can list processes (`ps aux`) and is logged
 *                            verbatim by most shell history mechanisms.
 *
 * Tokens are NEVER surfaced in result envelopes — every credential view
 * carries `tokenPreview` (last 4 chars, prefixed by the auth-type marker
 * `…` for api_key or `oat-…` for OAuth). `test` reports only response id
 * + latency.
 *
 * @task T9258
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import type { OnboardingResult } from '@cleocode/contracts';
import { pushWarning } from '@cleocode/core';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliError, cliOutput, humanLine, isHumanOutput } from '../renderers/index.js';
import { costCommand } from './llm-cost.js';
import { runLlmRefreshCatalog } from './llm-refresh-catalog.js';
import { streamCommand } from './llm-stream.js';
import { emitLoginResult, LOGIN_ARGS, runLoginFrontDoor } from './login.js';

// Lazy import — avoids circular deps and keeps startup fast.
// Resolved on first call to `cleo llm list-providers`.
async function getListProviders(): Promise<
  () => Promise<
    ReadonlyArray<{
      name: string;
      displayName: string;
      authTypes: ReadonlyArray<string>;
      defaultModel: string;
      baseUrl: string;
    }>
  >
> {
  const { listProviders } = await import(
    /* webpackIgnore: true */ '@cleocode/core/llm/provider-registry'
  );
  return listProviders as () => Promise<
    ReadonlyArray<{
      name: string;
      displayName: string;
      authTypes: ReadonlyArray<string>;
      defaultModel: string;
      baseUrl: string;
    }>
  >;
}

// ---------------------------------------------------------------------------
// Secret-on-argv mitigation (S-11) — stdin reader
// ---------------------------------------------------------------------------

/**
 * Read all of stdin into a string and trim trailing whitespace.
 *
 * Used by `cleo llm add --api-key-stdin` so credentials never appear on
 * the process argv list or in shell history. Returns the empty string
 * when stdin is a TTY (no piped input) — the caller MUST treat that as
 * an `E_INVALID_INPUT`.
 *
 * @task T9258 (S-11)
 */
async function readApiKeyFromStdin(): Promise<string> {
  // process.stdin.isTTY is true when stdin is a terminal (no pipe). In that
  // case there is no input to read — bail with empty so the caller can fail.
  if (process.stdin.isTTY) return '';
  process.stdin.setEncoding('utf-8');
  let buf = '';
  for await (const chunk of process.stdin) {
    buf += chunk;
  }
  // Strip trailing newline only — preserve internal whitespace because
  // some OAuth tokens are JWTs that allow base64url padding `=`.
  return buf.replace(/\r?\n$/, '').trim();
}

// ---------------------------------------------------------------------------
// Shared subcommand factory — mirrors `makeMemorySubcommand` in memory.ts
// ---------------------------------------------------------------------------

/**
 * Build a `cleo llm <name>` subcommand that dispatches through the
 * `llm` domain. Merges the shared `--json` flag automatically.
 *
 * @internal
 */
function makeLlmSubcommand(opts: {
  /** Subcommand name (e.g. 'add', 'list'). */
  name: string;
  /** One-line description surfaced in `--help`. */
  description: string;
  /** citty-shaped args record (positional + flags). A `json` bool flag is merged automatically. */
  args: Record<string, import('citty').ArgDef>;
  /** 'query' (read-only) or 'mutate' (side-effecting) gateway. */
  gateway: 'query' | 'mutate';
  /** Dispatch operation under the `llm` domain. */
  operation: string;
  /** Output render options. */
  output: { command: string; operation: string };
  /** Build the dispatch params from the parsed citty args. */
  paramBuilder: (args: Record<string, unknown>) => Record<string, unknown>;
}): import('citty').CommandDef {
  const mergedArgs: Record<string, import('citty').ArgDef> = {
    ...opts.args,
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  };

  return defineCommand({
    meta: { name: opts.name, description: opts.description },
    args: mergedArgs,
    async run({ args }) {
      const params = opts.paramBuilder(args as Record<string, unknown>);
      await dispatchFromCli(opts.gateway, 'llm', opts.operation, params, opts.output);
    },
  });
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/**
 * Verbatim stderr warning printed when the deprecated `--api-key=<value>`
 * mode is used. Tested literally by the CLI test suite — do not edit the
 * wording without updating `llm-command.test.ts`.
 *
 * @task T9258 (S-11)
 */
const API_KEY_FLAG_DEPRECATION =
  "[warning] --api-key exposes the secret to 'ps' listings and shell history. Prefer --api-key-stdin or --api-key-env=NAME for production use.";

/**
 * cleo llm add — upsert credential into the pool.
 *
 * S-11 mitigation: three input modes for the secret, in priority order
 *   1. `--api-key-stdin`   — recommended; reads from piped stdin.
 *   2. `--api-key-env=NAME` — reads from `process.env[NAME]`.
 *   3. `--api-key=<value>` — DEPRECATED; emits a stderr warning but still
 *                            accepts the value for CI backward compat.
 *
 * This subcommand is intentionally NOT built via `makeLlmSubcommand` —
 * the secret-resolution flow needs to run BEFORE dispatch and may abort
 * with a synchronous error envelope, which the generic factory cannot
 * express cleanly.
 *
 * @task T9258 (S-11)
 */
const addCommand = defineCommand({
  meta: {
    name: 'add',
    // Help text lists --api-key-stdin first (recommended path) and
    // --api-key last (deprecated). See S-11 in T9258 for the rationale.
    description:
      'Upsert a credential into the multi-credential pool. Reads the secret from stdin (--api-key-stdin, recommended), from an env var (--api-key-env=NAME), or as a literal flag value (--api-key, DEPRECATED — visible to ps + shell history). Auto-detects authType from token prefix (sk-ant-oat-* → oauth).',
  },
  args: {
    provider: {
      type: 'positional',
      description: 'Provider transport (anthropic | openai | gemini | moonshot)',
      required: true,
    },
    // Recommended path — listed first to surface it in --help output.
    'api-key-stdin': {
      type: 'boolean',
      description:
        '(recommended) Read the API key from stdin. Example: `echo "$KEY" | cleo llm add anthropic --api-key-stdin`. Not visible to `ps` listings or shell history.',
    },
    // Named-env mode — second-priority. Lets users put the key in a
    // .envrc / secret manager and reference it by name.
    'api-key-env': {
      type: 'string',
      description:
        'Read the API key from the env var named here. Example: `cleo llm add anthropic --api-key-env=ANTHROPIC_API_KEY`.',
    },
    // Deprecated literal-value mode — last in the help order. Backward
    // compat for CI scripts; emits a stderr warning when used.
    'api-key': {
      type: 'string',
      description:
        '(DEPRECATED) API key or OAuth bearer token as a literal flag value. Exposes the secret to `ps` and shell history. Prefer --api-key-stdin or --api-key-env=NAME.',
    },
    label: {
      type: 'string',
      description: "Human-readable label, unique within provider (default: 'default')",
    },
    'base-url': {
      type: 'string',
      description: 'Optional override for the provider base URL',
    },
    'auth-type': {
      type: 'string',
      description: "Explicit auth type override ('api_key' | 'oauth' | 'aws_sdk')",
    },
    priority: {
      type: 'string',
      description: 'Optional priority override (lower wins)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const a = args as Record<string, unknown>;

    // --- Resolve the secret in priority order: stdin > env > literal. ---
    let apiKey = '';
    let source: 'stdin' | 'env' | 'flag' | 'none' = 'none';

    if (a['api-key-stdin'] === true) {
      apiKey = await readApiKeyFromStdin();
      source = 'stdin';
      if (!apiKey) {
        // T9772: validation error → LAFS envelope (no raw stderr).
        cliError(
          '--api-key-stdin set but stdin is empty or a TTY. Pipe the secret in, e.g. `echo "$KEY" | cleo llm add ...`.',
          2,
          { name: 'E_VALIDATION', fix: 'Pipe the secret to stdin or use --api-key-env=NAME.' },
          { operation: 'llm.add' },
        );
        process.exit(2);
      }
    } else if (typeof a['api-key-env'] === 'string' && a['api-key-env']) {
      const envName = a['api-key-env'] as string;
      const envValue = process.env[envName];
      if (!envValue) {
        // T9772: validation error → LAFS envelope (no raw stderr).
        cliError(
          `--api-key-env=${envName} is not set in the environment.`,
          2,
          {
            name: 'E_VALIDATION',
            fix: `Export ${envName} before running, or use --api-key-stdin.`,
          },
          { operation: 'llm.add' },
        );
        process.exit(2);
      }
      apiKey = envValue;
      source = 'env';
    } else if (typeof a['api-key'] === 'string' && a['api-key']) {
      // Deprecated path — accept but surface deprecation warning through the
      // LAFS envelope (`meta.warnings[]`) instead of polluting stderr. T9772.
      pushWarning({
        code: 'W_DEPRECATED_FLAG',
        message: API_KEY_FLAG_DEPRECATION,
        deprecated: '--api-key=<value>',
        replacement: '--api-key-stdin or --api-key-env=NAME',
      });
      apiKey = a['api-key'] as string;
      source = 'flag';
    } else {
      // T9772: validation error → LAFS envelope (no raw stderr).
      cliError(
        'cleo llm add requires one of --api-key-stdin (recommended), --api-key-env=NAME, or --api-key=<value> (deprecated).',
        2,
        {
          name: 'E_VALIDATION',
          fix: 'Provide the credential via --api-key-stdin, --api-key-env=NAME, or --api-key=<value>.',
        },
        { operation: 'llm.add' },
      );
      process.exit(2);
    }

    // --- Build dispatch params. The secret is forwarded to the engine
    //     via the apiKey field; the engine NEVER logs or echoes it. ---
    const params: Record<string, unknown> = {
      provider: a['provider'],
      apiKey,
      _source: source, // surfaces in audit logs for incident response
    };
    if (a['label'] !== undefined) params['label'] = a['label'];
    if (a['base-url'] !== undefined) params['baseUrl'] = a['base-url'];
    if (a['auth-type'] !== undefined) params['authType'] = a['auth-type'];
    if (a['priority'] !== undefined) params['priority'] = Number(a['priority']);

    await dispatchFromCli('mutate', 'llm', 'add', params, {
      command: 'llm-add',
      operation: 'llm.add',
    });
  },
});

/** cleo llm list — show redacted credential pool */
const listCommand = makeLlmSubcommand({
  name: 'list',
  description:
    'List redacted credentials from the multi-credential pool (tokens shown as last 4 chars only).',
  args: {
    provider: {
      type: 'positional',
      description: 'Optional provider filter',
      required: false,
    },
  },
  gateway: 'query',
  operation: 'list',
  output: { command: 'llm-list', operation: 'llm.list' },
  paramBuilder: (args) => ({
    ...(args['provider'] !== undefined && args['provider'] !== ''
      ? { provider: args['provider'] }
      : {}),
  }),
});

/** cleo llm remove — delete (provider, label) pair */
const removeCommand = makeLlmSubcommand({
  name: 'remove',
  description: 'Delete a (provider, label) credential pair from the pool.',
  args: {
    provider: {
      type: 'positional',
      description: 'Provider transport',
      required: true,
    },
    label: {
      type: 'string',
      description: 'Label of the credential to remove',
      required: true,
    },
  },
  gateway: 'mutate',
  operation: 'remove',
  output: { command: 'llm-remove', operation: 'llm.remove' },
  paramBuilder: (args) => ({
    provider: args['provider'],
    label: args['label'],
  }),
});

/** cleo llm use — set llm.default.{provider,model} */
const useCommand = makeLlmSubcommand({
  name: 'use',
  description: 'Set llm.default.{provider,model} in the global config.',
  args: {
    provider: {
      type: 'positional',
      description: 'Provider transport to mark as default',
      required: true,
    },
    model: {
      type: 'string',
      description: 'Optional default model identifier',
    },
  },
  gateway: 'mutate',
  operation: 'use',
  output: { command: 'llm-use', operation: 'llm.use' },
  paramBuilder: (args) => ({
    provider: args['provider'],
    ...(args['model'] !== undefined && { model: args['model'] }),
  }),
});

/** cleo llm profile — set llm.roles[role] */
const profileCommand = makeLlmSubcommand({
  name: 'profile',
  description:
    'Pin a logical role (extraction | consolidation | derivation | hygiene | judgement) to a specific provider / model / credential label.',
  args: {
    role: {
      type: 'positional',
      description: 'Role name',
      required: true,
    },
    provider: {
      type: 'positional',
      description: 'Provider transport for this role',
      required: true,
    },
    model: {
      type: 'string',
      description: 'Optional model identifier for this role',
    },
    'credential-label': {
      type: 'string',
      description: 'Optional credential label to pin this role to a specific store entry',
    },
  },
  gateway: 'mutate',
  operation: 'profile',
  output: { command: 'llm-profile', operation: 'llm.profile' },
  paramBuilder: (args) => ({
    role: args['role'],
    provider: args['provider'],
    ...(args['model'] !== undefined && { model: args['model'] }),
    ...(args['credential-label'] !== undefined && { credentialLabel: args['credential-label'] }),
  }),
});

/** cleo llm test — round-trip provider ping */
const testCommand = makeLlmSubcommand({
  name: 'test',
  description:
    'Round-trip ping against the resolved provider (1-token prompt). Returns latency + response id; tokens never surfaced.',
  args: {
    provider: {
      type: 'positional',
      description: 'Provider transport to probe',
      required: true,
    },
    label: {
      type: 'string',
      description: 'Credential label to pin the test to a specific store entry',
    },
    model: {
      type: 'string',
      description: "Model override (defaults to the provider's implicit fallback)",
    },
  },
  gateway: 'query',
  operation: 'test',
  output: { command: 'llm-test', operation: 'llm.test' },
  paramBuilder: (args) => ({
    provider: args['provider'],
    ...(args['label'] !== undefined && { label: args['label'] }),
    ...(args['model'] !== undefined && { model: args['model'] }),
  }),
});

/** cleo llm whoami — role-by-role resolver dump */
const whoamiCommand = makeLlmSubcommand({
  name: 'whoami',
  description:
    'For each role, resolve and report which provider / model / credential would be picked today.',
  args: {
    role: {
      type: 'string',
      description: 'Optional role filter',
    },
  },
  gateway: 'query',
  operation: 'whoami',
  output: { command: 'llm-whoami', operation: 'llm.whoami' },
  paramBuilder: (args) => ({
    ...(args['role'] !== undefined && args['role'] !== '' ? { role: args['role'] } : {}),
  }),
});

// ---------------------------------------------------------------------------
// cleo llm list-providers
// ---------------------------------------------------------------------------

/**
 * `ProviderProfileSummary` — JSON-safe view of a {@link ProviderProfile}.
 *
 * The `fetchModels` function is omitted so the output is safe for JSON
 * serialisation. Sorted by `name` ascending.
 *
 * @task T9262
 */
interface ProviderProfileSummary {
  /** Canonical provider name. */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Supported auth schemes. */
  authTypes: ReadonlyArray<string>;
  /** Recommended default model identifier. */
  defaultModel: string;
  /** Provider base URL (no trailing slash). */
  baseUrl: string;
}

/**
 * cleo llm list-providers — enumerate all registered provider profiles.
 *
 * Triggers plugin discovery on the first call (scans
 * `${CLEO_HOME}/plugins/model-providers/`). Profiles are sorted ascending
 * by canonical name for stable output.
 *
 * Output shape: `{ providers: ProviderProfileSummary[] }`
 *
 * @task T9262
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */
const listProvidersCommand = defineCommand({
  meta: {
    name: 'list-providers',
    description:
      'List all registered LLM provider profiles (builtins + user plugins from $CLEO_HOME/plugins/model-providers/).',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run() {
    const listProviders = await getListProviders();
    const profiles = await listProviders();

    const providers: ProviderProfileSummary[] = profiles.map((p) => ({
      name: p.name,
      displayName: p.displayName,
      authTypes: p.authTypes,
      defaultModel: p.defaultModel,
      baseUrl: p.baseUrl,
    }));

    cliOutput(
      { providers },
      {
        command: 'llm-list-providers',
        operation: 'llm.listProviders',
      },
    );
  },
});

// ---------------------------------------------------------------------------
// cleo llm context-engines list
// ---------------------------------------------------------------------------

/**
 * `cleo llm context-engines list` — enumerate all registered ContextEngine names.
 *
 * Lists every engine registered in the plugin registry (both builtins and
 * user-registered engines). Output is sorted ascending by name.
 *
 * Output shape: `{ engines: string[] }`
 *
 * @task T9312
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */
const contextEnginesListCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List all registered ContextEngine names (builtins + user plugins).',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run() {
    const { listContextEngines } = await import(
      /* webpackIgnore: true */ '@cleocode/core/llm/executor-factory'
    );
    const engines = listContextEngines();
    cliOutput(
      { engines: [...engines] },
      {
        command: 'llm-context-engines-list',
        operation: 'llm.contextEngines.list',
      },
    );
  },
});

/**
 * `cleo llm context-engines` — ContextEngine plugin registry subgroup.
 *
 * @task T9312
 */
const contextEnginesCommand = defineCommand({
  meta: {
    name: 'context-engines',
    description: 'Manage registered ContextEngine plugins.',
  },
  subCommands: {
    list: contextEnginesListCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});

// ---------------------------------------------------------------------------
// cleo llm login (device-code OAuth)
// ---------------------------------------------------------------------------

/**
 * cleo llm login <provider> — onboarding front door (alias of `cleo login`).
 *
 * Dispatches to the SAME shared handler ({@link runLoginFrontDoor}) and the
 * SAME core engine as `cleo login` / `cleo auth login` (T11725 · AC2). The
 * front-door orchestrator picks a provider + auth method (browser OAuth or API
 * key), runs the OAuth dance when needed, then connect → select → bind →
 * validate so the result is a usable, validated Profile binding — not just a
 * stored credential.
 *
 * Prior to T11725 this command only stored an OAuth credential. The flow is now
 * unified; `cleo llm add <provider> --api-key-stdin` remains the bare
 * credential-only path for non-OAuth providers.
 *
 * @task T9266
 * @task T11669
 * @task T11725
 */
const loginCommand = defineCommand({
  meta: {
    name: 'login',
    description:
      'Log in to an LLM provider and bind a usable profile (alias of `cleo login`). ' +
      'Picks a provider + auth method (browser OAuth: anthropic, openai/codex; device-code: kimi-code; ' +
      'or API key), selects a model, binds it, and validates the binding. ' +
      'Prompts/URLs go to stderr; the result is a human line on a terminal or a JSON envelope when piped/--json.',
  },
  args: LOGIN_ARGS,
  async run({ args }) {
    let result: OnboardingResult;
    try {
      result = await runLoginFrontDoor(args as Record<string, unknown>);
    } catch (err) {
      cliError(
        err instanceof Error ? err.message : String(err),
        1,
        { name: 'E_LOGIN_FAILED' },
        { operation: 'llm.login' },
      );
      process.exit(1);
    }
    emitLoginResult(result, 'llm.login');
  },
});

// ---------------------------------------------------------------------------
// cleo llm refresh-catalog
// ---------------------------------------------------------------------------

/**
 * cleo llm refresh-catalog — fetch and cache the live model catalog.
 *
 * Pulls https://models.dev/api.json and persists it under
 * `<CLEO_DATA_DIR>/llm-catalog/<unix-timestamp>-models.json`, then
 * updates the `latest.json` symlink. Falls back to the most-recent disk
 * snapshot when the network is unavailable.
 *
 * On success prints the number of providers and models written. On network
 * failure falls back gracefully and exits with code 0 (stale cache used).
 *
 * @task T9314
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 5)
 */
const refreshCatalogCommand = defineCommand({
  meta: {
    name: 'refresh-catalog',
    description:
      'Fetch the live model catalog from models.dev and persist it to disk. ' +
      'Falls back to the most-recent cached snapshot on network failure.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run() {
    const result = await runLlmRefreshCatalog();
    if (result.success && result.data) {
      const d = result.data;
      // T11672 interactive-output class: human summary on a terminal, JSON
      // envelope when piped / under --json (global format context decides).
      if (isHumanOutput()) {
        humanLine(
          `Catalog refreshed: ${d.providers} providers, ${d.models} models written to ${d.filePath}`,
        );
      } else {
        cliOutput(result.data, { command: 'llm-refresh-catalog', operation: 'llm.refreshCatalog' });
      }
      return;
    }
    if (!result.success) {
      // T9772: surface refresh failure through LAFS envelope (no raw stderr).
      cliError(
        result.error?.message ?? 'refresh failed',
        result.error?.code ?? 1,
        { name: 'E_REFRESH_FAILED' },
        { operation: 'llm.refreshCatalog' },
      );
      process.exit(1);
    }
  },
});

// ---------------------------------------------------------------------------
// Parent command
// ---------------------------------------------------------------------------

/**
 * `cleo llm` — multi-credential pool + role-aware resolver.
 *
 * Dispatches to `llm.*` registry operations.
 *
 * @task T9258
 */
export const llmCommand = defineCommand({
  meta: {
    name: 'llm',
    description: 'Manage LLM credentials, role profiles, and resolver diagnostics',
  },
  subCommands: {
    add: addCommand,
    'context-engines': contextEnginesCommand,
    cost: costCommand,
    list: listCommand,
    login: loginCommand,
    remove: removeCommand,
    stream: streamCommand,
    use: useCommand,
    profile: profileCommand,
    'refresh-catalog': refreshCatalogCommand,
    test: testCommand,
    whoami: whoamiCommand,
    'list-providers': listProvidersCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
