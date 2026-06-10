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
 * @module cli/commands/login
 * @task T11725
 * @epic T11671 (E6-ONBOARDING-FRONT-DOOR)
 */

import type {
  OnboardingAuthMode,
  OnboardingResult,
  ProviderProfile,
  RoleName,
} from '@cleocode/contracts';
import { WHOAMI_ROLE_IDS } from '@cleocode/contracts';
import type {
  AcquiredOAuthToken,
  OAuthTokenAcquirer,
} from '@cleocode/core/llm/onboarding/front-door.js';
import { runFrontDoorLogin } from '@cleocode/core/llm/onboarding/front-door.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { ReadlineWizardIO } from '../lib/readline-wizard-io.js';
import { cliError, cliOutput, humanLine, isHumanOutput } from '../renderers/index.js';
import { runLlmLogin } from './llm-login.js';

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
  const io = new ReadlineWizardIO();
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
    return (await io.prompt('API key:')).trim();
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
    description: 'Provider to log in to (anthropic | openai | codex | gemini | kimi-code | …).',
    required: false,
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
    description:
      'Log in to an LLM provider and bind a usable profile in one step — the discoverable ' +
      'front door over `cleo llm login`. Picks a provider + auth method (browser OAuth or API key), ' +
      'selects a model, binds it, and validates the binding. `cleo auth login` and `cleo llm login` ' +
      'resolve to this same flow. Prompts/URLs go to stderr; the result is a human line on a terminal ' +
      'or a JSON envelope when piped / --json.',
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
        { operation: 'login.run' },
      );
      process.exit(1);
    }
    emitLoginResult(result, 'login.run');
  },
});
