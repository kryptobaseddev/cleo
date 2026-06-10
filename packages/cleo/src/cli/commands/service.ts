/**
 * CLI command group: `cleo service` — universal service-vault surface (M2-W4).
 *
 * Makes the universal SERVICE-credential vault (github, google, notion, …)
 * USABLE from the CLI. Four verbs, each a THIN delegate that dispatches to a
 * core `service.*` OperationRegistry op via `dispatchFromCli` — the engine lives
 * in CORE (`store/service-connections-accessor.ts` + `store/service-oauth.ts`),
 * driven by the declarative `SERVICE_PROVIDERS` registry in contracts. The CLI
 * only wraps the result into the LAFS envelope.
 *
 *   cleo service connect <provider> --token <t> [--refresh-token r] [--expires-at iso] [--label l]
 *   cleo service connect <provider> --paste-code <code> --code-verifier <v> --redirect-uri <u> [--label l]
 *   cleo service list [provider]
 *   cleo service revoke <provider> <label>
 *   cleo service status [provider]
 *
 * ## Gate-6 (CLI boundary)
 *
 * No standalone named function in this file exceeds 30 LOC: every verb is built
 * by the {@link makeServiceSubcommand} factory (mirrors `makeLlmSubcommand`),
 * which contains the only logic — a `paramBuilder` shapes dispatch params from
 * parsed citty args. All domain logic stays in CORE.
 *
 * ## Gate-1 (defineCommand SSoT)
 *
 * `defineCommand` / `showUsage` are imported from the SSoT wrapper
 * `../lib/define-cli-command.js` — NEVER raw from 'citty'.
 *
 * ## Secrets never on the wire / never printed
 *
 * `--token` / `--refresh-token` are SECRETS forwarded to the engine, which
 * encrypts them at rest and NEVER echoes them. `list` / `status` render
 * NON-SECRET views (`hasCredentials` boolean only — the token is unreachable
 * from any result field).
 *
 * @epic T11765
 * @saga T10409
 * @task T11941
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ArgDef, CommandDef } from '../lib/define-cli-command.js';
import { defineCommand, showUsage } from '../lib/define-cli-command.js';

/**
 * Build a `cleo service <name>` subcommand that dispatches through the
 * `service` domain. Merges the shared `--json` flag automatically. Mirrors
 * `makeLlmSubcommand` in `llm.ts` so every verb stays a thin delegate.
 *
 * @internal
 */
function makeServiceSubcommand(opts: {
  /** Subcommand name (e.g. 'connect', 'list'). */
  name: string;
  /** One-line description surfaced in `--help`. */
  description: string;
  /** citty-shaped args record. A `json` bool flag is merged automatically. */
  args: Record<string, ArgDef>;
  /** 'query' (read-only) or 'mutate' (side-effecting) gateway. */
  gateway: 'query' | 'mutate';
  /** Dispatch operation under the `service` domain. */
  operation: string;
  /** Build the dispatch params from the parsed citty args. */
  paramBuilder: (args: Record<string, unknown>) => Record<string, unknown>;
}): CommandDef {
  const mergedArgs: Record<string, ArgDef> = {
    ...opts.args,
    json: { type: 'boolean', description: 'Output as JSON' },
  };
  return defineCommand({
    meta: { name: opts.name, description: opts.description },
    args: mergedArgs,
    async run({ args }) {
      const params = opts.paramBuilder(args as Record<string, unknown>);
      await dispatchFromCli(opts.gateway, 'service', opts.operation, params, {
        command: `service-${opts.name}`,
        operation: `service.${opts.operation}`,
      });
    },
  });
}

/** Coerce a citty arg to a non-empty string, or undefined. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** cleo service connect — store a service credential (token-direct or paste-code). */
const connectCommand = makeServiceSubcommand({
  name: 'connect',
  description:
    'Connect a service credential. Token-direct: `--token <t>` (browser-free). OAuth paste-code: `--paste-code <code> --code-verifier <v> --redirect-uri <u>`. The secret is encrypted at rest and NEVER printed.',
  args: {
    provider: {
      type: 'positional',
      description: 'Service provider key (e.g. github)',
      required: true,
    },
    label: {
      type: 'string',
      description: "Connection label, unique within provider (default 'default')",
    },
    token: {
      type: 'string',
      description: 'Direct access token to store (token-direct mode). SECRET.',
    },
    'refresh-token': {
      type: 'string',
      description: 'Optional refresh token paired with --token. SECRET.',
    },
    'expires-at': {
      type: 'string',
      description: 'ISO-8601 access-token expiry (token-direct mode).',
    },
    'paste-code': {
      type: 'string',
      description: 'OAuth authorization code from the redirect callback.',
    },
    'code-verifier': {
      type: 'string',
      description: 'PKCE code verifier from `cleo service auth-url`.',
    },
    'redirect-uri': { type: 'string', description: 'Redirect URI used in auth-url; must match.' },
  },
  gateway: 'mutate',
  operation: 'connect',
  paramBuilder: (a) => ({
    provider: a['provider'],
    ...(str(a['label']) !== undefined ? { label: str(a['label']) } : {}),
    ...(str(a['token']) !== undefined ? { token: str(a['token']) } : {}),
    ...(str(a['refresh-token']) !== undefined ? { refreshToken: str(a['refresh-token']) } : {}),
    ...(str(a['expires-at']) !== undefined ? { expiresAt: str(a['expires-at']) } : {}),
    ...(str(a['paste-code']) !== undefined ? { code: str(a['paste-code']) } : {}),
    ...(str(a['code-verifier']) !== undefined ? { codeVerifier: str(a['code-verifier']) } : {}),
    ...(str(a['redirect-uri']) !== undefined ? { redirectUri: str(a['redirect-uri']) } : {}),
  }),
});

/** cleo service list — redacted connection views (never the token). */
const listCommand = makeServiceSubcommand({
  name: 'list',
  description:
    'List service connections as NON-SECRET views (provider/label/status/scopes/expires/hasCredentials). The decrypted token is never shown.',
  args: {
    provider: { type: 'positional', description: 'Optional provider filter', required: false },
  },
  gateway: 'query',
  operation: 'list',
  paramBuilder: (a) => ({
    ...(str(a['provider']) !== undefined ? { provider: str(a['provider']) } : {}),
  }),
});

/** cleo service revoke — hard delete a connection + cascade its agent grants. */
const revokeCommand = makeServiceSubcommand({
  name: 'revoke',
  description: 'Delete a service connection and cascade its agent_service_grants.',
  args: {
    provider: { type: 'positional', description: 'Service provider key', required: true },
    label: { type: 'positional', description: 'Connection label to revoke', required: true },
  },
  gateway: 'mutate',
  operation: 'revoke',
  paramBuilder: (a) => ({ provider: a['provider'], label: a['label'] }),
});

/** cleo service status — connection health (expired? needs refresh?). */
const statusCommand = makeServiceSubcommand({
  name: 'status',
  description:
    'Report connection health — each connection adds `expired` + `needsRefresh` booleans from expires_at. NON-SECRET.',
  args: {
    provider: { type: 'positional', description: 'Optional provider filter', required: false },
  },
  gateway: 'query',
  operation: 'status',
  paramBuilder: (a) => ({
    ...(str(a['provider']) !== undefined ? { provider: str(a['provider']) } : {}),
  }),
});

/**
 * `cleo service` — universal service-vault surface.
 *
 * Dispatches to `service.*` registry operations. Connect/list/revoke/status
 * make the universal vault usable; the OAuth flow (auth-url/exchange/refresh/
 * self-heal) ships under the same `service` domain (T11939).
 *
 * @task T11941
 */
export const serviceCommand = defineCommand({
  meta: {
    name: 'service',
    description: 'Connect, list, revoke, and inspect service-vault credentials (github, google, …)',
  },
  subCommands: {
    connect: connectCommand,
    list: listCommand,
    revoke: revokeCommand,
    status: statusCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
