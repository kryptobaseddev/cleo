/**
 * `cleo login` — the top-level onboarding front door (T11725 · M3).
 *
 * A single, discoverable entry point that walks a user from a cold start to a
 * usable, validated LLM profile binding WITHOUT needing to know the `llm`
 * sub-namespace. `cleo auth login` and `cleo llm login` are command aliases
 * that resolve to the SAME flow — there is exactly one handler
 * ({@link runLoginFrontDoor}) and exactly one core engine call.
 *
 * ## Thin handler (AC3)
 *
 * The handler does only CLI-shaped work:
 *   1. Parse flags (`--provider`, `--auth`, `--api-key`/stdin, `--model`,
 *      `--role`, `--label`, `--json`).
 *   2. Build a {@link ReadlineWizardIO} for the picker prompts.
 *   3. Build an {@link OAuthTokenAcquirer} that wraps the existing
 *      `cleo llm login` browser flow.
 *   4. Call the shared core orchestrator {@link runFrontDoorLogin}
 *      (`@cleocode/core/llm`), which performs connect → select → bind → validate.
 *   5. Emit a LAFS envelope (`--json` / piped) or a human summary (TTY) per the
 *      interactive-output class (ADR-086 amendment / T11672).
 *
 * It NEVER re-implements provider resolution, auth-method inference, the
 * 5-entity Profile binding, or validation — all of that lives in core.
 *
 * ## Cleo Nexus account (T12712)
 *
 * `nexus` is a reserved target: `cleo login nexus` (and so `cleo auth login
 * nexus` and `cleo llm login nexus`, which share {@link runLoginCommand})
 * signs in to a Cleo Nexus account with the RFC 8628 device-code engine in
 * core, BEFORE any LLM registry lookup. With no target on a terminal, the
 * picker lists "Cleo Nexus account" first, then the LLM providers.
 *
 * ## Guided first run (T13102)
 *
 * After a Cleo Nexus sign-in, login runs the guided first run
 * (`../lib/nexus-first-run-cli.js`): inside an unlinked CLEO project it
 * offers to link the project and take its first encrypted backup (`--yes`
 * does it without asking; a non-interactive run never asks and prints the
 * next command); outside a project it lists the account's projects with the
 * exact `cleo cloud restore <name>` command for each.
 *
 * @module cli/commands/login
 * @task T11725
 * @task T12712
 * @task T13102
 * @epic T11671 (E6-ONBOARDING-FRONT-DOOR)
 */

import type {
  OnboardingAuthMode,
  OnboardingResult,
  ProviderProfile,
  RoleName,
} from '@cleocode/contracts';
import { NEXUS_LOGIN_TARGET, WHOAMI_ROLE_IDS } from '@cleocode/contracts';
import type {
  AcquiredOAuthToken,
  OAuthTokenAcquirer,
} from '@cleocode/core/llm/onboarding/front-door.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { NEXUS_API_URL_ARG } from '../lib/nexus-account-cli.js';
import { runNexusLoginCommand } from '../lib/nexus-first-run-cli.js';
import { ReadlineWizardIO } from '../lib/readline-wizard-io.js';
import { cliError, cliOutput, humanLine, isHumanOutput } from '../renderers/index.js';
import { _tryOpenBrowser, runLlmLogin } from './llm-login.js';

/**
 * Lazily resolve the provider-registry accessors. Kept as a dynamic import so
 * this thin command module does not pull the heavy provider/registry graph at
 * load time (matching `llm.ts`'s lazy `getListProviders`).
 *
 * @internal
 */
async function providerRegistry(): Promise<{
  getProviderProfile: (name: string) => Promise<ProviderProfile | undefined>;
  listProviders: () => Promise<ReadonlyArray<{ name: string }>>;
}> {
  const mod = await import(
    /* webpackIgnore: true */ '@cleocode/core/llm/provider-registry/index.js'
  );
  return {
    getProviderProfile: mod.getProviderProfile as (
      name: string,
    ) => Promise<ProviderProfile | undefined>,
    listProviders: mod.listProviders as () => Promise<ReadonlyArray<{ name: string }>>,
  };
}

// ---------------------------------------------------------------------------
// Shared handler — the ONE place all three entry points dispatch through (AC2)
// ---------------------------------------------------------------------------

/**
 * The auth methods the front-door picker offers.
 *
 * @internal
 */
const AUTH_METHODS = ['oauth', 'api_key'] as const;

/**
 * Read all of stdin into a trimmed string. Returns `''` when stdin is a TTY
 * (no piped input). Used by the `--api-key-stdin` secure-entry path.
 *
 * @internal
 */
async function readApiKeyFromStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  process.stdin.setEncoding('utf-8');
  let buf = '';
  for await (const chunk of process.stdin) {
    buf += chunk;
  }
  return buf.replace(/\r?\n$/, '').trim();
}

/**
 * Build the default OAuth token acquirer — wraps the existing
 * `cleo llm login` browser / device-code flow (which stores the credential in
 * the pool) and returns the stored label + expiry so the front-door engine can
 * bind to it (skipping a second write).
 *
 * Exported so the `llm login` / `auth login` aliases reuse the identical
 * acquirer, and so tests can substitute a stub.
 *
 * @param label - Optional credential label override.
 * @returns An {@link OAuthTokenAcquirer}.
 * @task T11725
 */
export function makeOAuthAcquirer(label?: string): OAuthTokenAcquirer {
  return async (provider: string): Promise<AcquiredOAuthToken> => {
    const result = await runLlmLogin(provider, label ? { label } : {});
    if (!result.success || !result.data) {
      const message = result.error?.message ?? `OAuth login failed for '${provider}'.`;
      throw new Error(message);
    }
    return {
      label: result.data.label,
      ...(result.data.expiresIn != null ? { expiresIn: result.data.expiresIn } : {}),
    };
  };
}

/**
 * Parsed, validated front-door flags.
 *
 * @internal
 */
interface ParsedLoginFlags {
  provider?: string;
  authMode?: OnboardingAuthMode;
  token?: string;
  model?: string;
  role?: RoleName;
  label?: string;
}

/**
 * Validate `--role` against the canonical role vocabulary.
 *
 * @internal
 */
function parseRole(raw: unknown): RoleName | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  if ((WHOAMI_ROLE_IDS as readonly string[]).includes(raw)) return raw as RoleName;
  throw new Error(`Invalid --role '${raw}'. Valid roles: ${WHOAMI_ROLE_IDS.join(', ')}.`);
}

/**
 * Run the onboarding front-door flow from parsed CLI args.
 *
 * This is the single shared handler for `cleo login`, `cleo auth login`, and
 * `cleo llm login` (AC2 — no duplicated handler logic). It resolves the
 * provider + auth method (prompting on a TTY when not supplied), acquires the
 * credential, then dispatches to {@link runFrontDoorLogin}.
 *
 * @param args - The citty-parsed arg bag.
 * @returns The engine's {@link OnboardingResult} envelope.
 * @task T11725
 */
export async function runLoginFrontDoor(args: Record<string, unknown>): Promise<OnboardingResult> {
  // Lazy: front-door.ts statically imports the provider-registry + login-engine
  // graph; a static import here would defeat providerRegistry()'s lazy-loading
  // and pull the heavy graph into every command that mounts login (init, auth,
  // llm) at module-load time.
  const { runFrontDoorLogin } = await import(
    /* webpackIgnore: true */ '@cleocode/core/llm/onboarding/front-door.js'
  );
  const flags = await resolveFlags(args);

  // The OAuth acquirer is only invoked when the resolved auth method is oauth.
  const acquirer = makeOAuthAcquirer(flags.label);

  return runFrontDoorLogin(
    flags.provider as string,
    {
      ...(flags.authMode !== undefined ? { authMode: flags.authMode } : {}),
      ...(flags.token !== undefined ? { token: flags.token } : {}),
      ...(flags.model !== undefined ? { model: flags.model } : {}),
      ...(flags.role !== undefined ? { role: flags.role } : {}),
      ...(flags.label !== undefined ? { label: flags.label } : {}),
    },
    acquirer,
  );
}

/**
 * Resolve the provider + auth method from flags, prompting interactively on a
 * TTY when either is missing. For the `api_key` path, the secret is read from
 * `--api-key` / `--api-key-stdin` / an interactive prompt.
 *
 * @internal
 */
async function resolveFlags(args: Record<string, unknown>): Promise<ParsedLoginFlags> {
  const out: ParsedLoginFlags = {};

  const labelArg = typeof args['label'] === 'string' && args['label'] ? args['label'] : undefined;
  if (labelArg) out.label = labelArg;
  out.model = typeof args['model'] === 'string' && args['model'] ? args['model'] : undefined;
  out.role = parseRole(args['role']);

  const registry = await providerRegistry();
  // Prompts MUST go to stderr: stdout carries exactly one LAFS envelope when
  // piped / --json (ADR-086), and the command meta promises stderr prompts.
  const io = new ReadlineWizardIO(process.stdin, process.stderr);
  try {
    out.provider = await resolveProvider(args, registry, io);
    out.authMode = await resolveAuthMethod(args, out.provider, registry, io);
    if (out.authMode === 'api_key') {
      out.token = await resolveRequiredApiKey(args, io);
    }
  } finally {
    io.close();
  }
  return out;
}

/**
 * Resolve the provider id from `--provider`, else (on a TTY) prompt with the
 * registry's provider list.
 *
 * @internal
 */
async function resolveProvider(
  args: Record<string, unknown>,
  registry: Awaited<ReturnType<typeof providerRegistry>>,
  io: ReadlineWizardIO,
): Promise<string> {
  const provider = typeof args['provider'] === 'string' ? (args['provider'] as string) : '';
  if (provider) return provider;
  if (!process.stdin.isTTY) {
    throw new Error(
      'No --provider supplied and stdin is not a TTY. Pass `--provider <name>` ' +
        '(e.g. anthropic, openai, gemini).',
    );
  }
  const profiles = await registry.listProviders();
  const names = profiles.map((p) => p.name).sort();
  return io.select('Which provider do you want to log in to?', names);
}

/**
 * Resolve the auth method: explicit `--auth`, else inferred from the provider
 * profile (oauth when supported), prompting on a TTY.
 *
 * @internal
 */
async function resolveAuthMethod(
  args: Record<string, unknown>,
  provider: string,
  registry: Awaited<ReturnType<typeof providerRegistry>>,
  io: ReadlineWizardIO,
): Promise<OnboardingAuthMode> {
  const authArg = typeof args['auth'] === 'string' ? (args['auth'] as string) : '';
  if (authArg === 'oauth' || authArg === 'api_key') return authArg;
  if (authArg !== '') throw new Error(`Invalid --auth '${authArg}'. Valid: oauth | api_key.`);

  const supportsOAuth = Boolean((await registry.getProviderProfile(provider))?.oauth);
  if (!process.stdin.isTTY) {
    // Non-interactive: an api-key flag → api_key; else the provider's native scheme.
    return hasApiKeyFlag(args) ? 'api_key' : supportsOAuth ? 'oauth' : 'api_key';
  }
  if (supportsOAuth) return io.select('How do you want to authenticate?', AUTH_METHODS);
  return 'api_key';
}

/**
 * Resolve the api-key secret and reject when absent.
 *
 * @internal
 */
async function resolveRequiredApiKey(
  args: Record<string, unknown>,
  io: ReadlineWizardIO,
): Promise<string> {
  const token = await resolveApiKey(args, io);
  if (!token) {
    throw new Error(
      'No API key supplied. Pass `--api-key-stdin` (recommended), `--api-key <value>`, ' +
        'or run interactively to be prompted.',
    );
  }
  return token;
}

/**
 * Resolve the api-key secret in priority order: stdin → flag → interactive
 * prompt.
 *
 * @internal
 */
async function resolveApiKey(args: Record<string, unknown>, io: ReadlineWizardIO): Promise<string> {
  if (args['api-key-stdin'] === true) {
    return readApiKeyFromStdin();
  }
  if (typeof args['api-key'] === 'string' && args['api-key']) {
    return args['api-key'] as string;
  }
  if (process.stdin.isTTY) {
    return (await io.secret('API key (input hidden):')).trim();
  }
  return '';
}

/**
 * `true` when any api-key flag is present (used to infer auth method
 * non-interactively).
 *
 * @internal
 */
function hasApiKeyFlag(args: Record<string, unknown>): boolean {
  return (
    args['api-key-stdin'] === true ||
    (typeof args['api-key'] === 'string' && (args['api-key'] as string) !== '')
  );
}

// ---------------------------------------------------------------------------
// Login target: Cleo Nexus account or an LLM provider (T12712)
// ---------------------------------------------------------------------------

/**
 * The picker's label for the Cleo Nexus account. Listed first.
 *
 * @task T12712
 */
export const NEXUS_PICKER_LABEL = 'Cleo Nexus account';

/**
 * The front-door picker's options: the Cleo Nexus account first, then the
 * LLM providers in name order.
 *
 * @param providerNames - LLM provider names from the registry.
 * @returns Picker options.
 * @task T12712
 */
export function loginPickerOptions(providerNames: readonly string[]): string[] {
  return [NEXUS_PICKER_LABEL, ...[...providerNames].sort()];
}

/**
 * Resolve the login target: the positional/`--provider` value, else (on a
 * terminal) the picker. Returns `undefined` when non-interactive with no
 * target, so the LLM front door reports its usual error.
 *
 * @internal
 */
async function resolveLoginTarget(args: Record<string, unknown>): Promise<string | undefined> {
  const given = typeof args['provider'] === 'string' ? args['provider'] : '';
  if (given || !process.stdin.isTTY) return given || undefined;
  const names = (await (await providerRegistry()).listProviders()).map((p) => p.name);
  const io = new ReadlineWizardIO(process.stdin, process.stderr);
  try {
    const choice = await io.select('What do you want to log in to?', loginPickerOptions(names));
    return choice === NEXUS_PICKER_LABEL ? NEXUS_LOGIN_TARGET : choice;
  } finally {
    io.close();
  }
}

/**
 * The ONE handler behind `cleo login`, `cleo auth login` and `cleo llm login`:
 * the reserved `nexus` target runs the Cleo Nexus device-code login before any
 * LLM registry lookup; every other target runs {@link runLoginFrontDoor}.
 *
 * @param args - The citty-parsed arg bag.
 * @param operation - LAFS operation id (`login.run`, `auth.login`, `llm.login`).
 * @task T12712
 */
export async function runLoginCommand(
  args: Record<string, unknown>,
  operation: string,
): Promise<void> {
  let target: string | undefined;
  try {
    target = await resolveLoginTarget(args);
  } catch (err) {
    failLogin(err, operation);
  }
  if (target === NEXUS_LOGIN_TARGET) {
    // Sign in, then the guided first run (T13102): link and back up, or list projects.
    await runNexusLoginCommand(args, operation, _tryOpenBrowser);
    return;
  }
  let result: OnboardingResult;
  try {
    result = await runLoginFrontDoor(target ? { ...args, provider: target } : args);
  } catch (err) {
    failLogin(err, operation);
  }
  emitLoginResult(result, operation);
}

/**
 * Emit a front-door failure as `E_LOGIN_FAILED` and exit 1.
 *
 * @internal
 */
function failLogin(err: unknown, operation: string): never {
  cliError(
    err instanceof Error ? err.message : String(err),
    1,
    { name: 'E_LOGIN_FAILED' },
    { operation },
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Emit the onboarding result per the interactive-output class: a human summary
 * on a TTY, the canonical LAFS envelope when piped / under `--json` (AC4).
 *
 * Exits the process with code 1 when the flow did not validate.
 *
 * @param result - The engine result envelope.
 * @param operation - The LAFS operation id for the envelope meta.
 * @task T11725
 */
export function emitLoginResult(result: OnboardingResult, operation: string): void {
  if (!result.validated) {
    emitLoginFailure(result, operation);
    return;
  }
  if (isHumanOutput()) {
    humanLine(
      `Logged in to ${result.provider} as '${result.accountLabel}' — ` +
        `bound ${result.profileName ?? 'default'} → ${result.provider}/${result.modelId}.`,
    );
  } else {
    cliOutput(result, { command: 'login', operation });
  }
}

/**
 * Render a non-validated onboarding result as a structured error (LAFS or human
 * line) and exit non-zero. The partial step trace is surfaced so agents can
 * branch on the stable `E_*` code.
 *
 * @internal
 */
function emitLoginFailure(result: OnboardingResult, operation: string): never {
  const failed = result.steps.find((s) => s.status === 'failed');
  cliError(
    failed?.detail ?? 'Onboarding login did not complete.',
    failed?.code ?? 1,
    { name: failed?.code ?? 'E_ONBOARDING_INCOMPLETE', details: { steps: result.steps } },
    { operation },
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

/**
 * Shared citty arg schema for the front-door command + its aliases.
 *
 * Exported so `cleo llm login` and `cleo auth login` mount the IDENTICAL flag
 * surface (AC2 — no duplicated handler logic).
 *
 * @task T11725
 */
export const LOGIN_ARGS = {
  provider: {
    type: 'positional',
    description:
      "What to log in to: 'nexus' (Cleo Nexus account) or an LLM provider (anthropic | openai | codex | gemini | kimi-code | …).",
    required: false,
  },
  'api-url': NEXUS_API_URL_ARG,
  browser: {
    type: 'boolean',
    description:
      'Open the verification URL in a browser (nexus). --no-browser only prints it (SSH, containers).',
    default: true,
  },
  'read-only': {
    type: 'boolean',
    description:
      'nexus: enrol this machine with the read-only device profile (account, devices and project reads only). Refused with CLEO_NEXUS_DEVICE=0.',
  },
  name: {
    type: 'string',
    description:
      'nexus: device name shown on cleocode.dev (default: OS, arch and a short id; never the hostname). Ignored with CLEO_NEXUS_DEVICE=0.',
  },
  yes: {
    type: 'boolean',
    description:
      'nexus: inside a CLEO project this machine has not linked, link it and take the first encrypted backup without asking. Without it a terminal is asked, and a non-interactive run only prints the next command.',
  },
  auth: {
    type: 'string',
    description:
      "Auth method: 'oauth' (browser) or 'api_key'. Inferred from the provider when omitted.",
  },
  'api-key': {
    type: 'string',
    description:
      '(DEPRECATED — visible to `ps`/shell history) API key for the api_key path. Prefer --api-key-stdin.',
  },
  'api-key-stdin': {
    type: 'boolean',
    description: '(recommended) Read the API key from piped stdin instead of a flag.',
  },
  model: {
    type: 'string',
    description: 'Model id to bind (default: the latest catalog model for the provider).',
  },
  role: {
    type: 'string',
    description: `Bind the model to a specific role instead of the global default. Valid: ${WHOAMI_ROLE_IDS.join(' | ')}.`,
  },
  label: {
    type: 'string',
    description: "Credential label (default: 'oauth-login').",
  },
  json: {
    type: 'boolean',
    description: 'Output the result as a JSON LAFS envelope.',
  },
} as const;

/**
 * `cleo login` — top-level onboarding front door.
 *
 * @task T11725
 */
export const loginCommand = defineCommand({
  meta: {
    name: 'login',
    // ONE quoted literal, no backticks: the manifest generator's DESC_RE
    // captures only the first plain string literal (concatenations + backticks
    // truncate the `cleo --help` text mid-sentence).
    description:
      'Log in to a Cleo Nexus account (cleo login nexus: device code, --api-url, --no-browser) or to an LLM provider, binding a usable profile in one step. The picker lists the Cleo Nexus account first, then the providers. After a Cleo Nexus sign-in inside an unlinked CLEO project it offers to link the project and back it up (--yes does it; a non-interactive run prints the next command); outside a project it lists your projects with the cleo cloud restore command for each. For a provider it picks an auth method (browser OAuth or API key), selects a model, binds it, and validates the binding. cleo auth login and cleo llm login resolve to this same flow. Prompts/URLs go to stderr; the result is a human line on a terminal or a JSON envelope when piped / --json.',
  },
  args: LOGIN_ARGS,
  async run({ args }) {
    await runLoginCommand(args as Record<string, unknown>, 'login.run');
  },
});
