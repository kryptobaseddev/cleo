/**
 * CLI command group: `cleo llm` — multi-credential pool + role-aware resolver.
 *
 * Subcommands:
 *   cleo llm add <provider> --api-key <k> [--label l] [--base-url u]
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
 * Tokens are NEVER surfaced by any subcommand — `list` and `add` redact via
 * `tokenPreview` (last 4 chars), and `test` reports only response id +
 * latency.
 *
 * @task T9258
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

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

/** cleo llm add — upsert credential into the pool */
const addCommand = makeLlmSubcommand({
  name: 'add',
  description:
    'Upsert a credential into the multi-credential pool. Auto-detects authType from token prefix (sk-ant-oat-* → oauth).',
  args: {
    provider: {
      type: 'positional',
      description: 'Provider transport (anthropic | openai | gemini | moonshot)',
      required: true,
    },
    'api-key': {
      type: 'string',
      description: 'API key or OAuth bearer token to persist',
      required: true,
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
  },
  gateway: 'mutate',
  operation: 'add',
  output: { command: 'llm-add', operation: 'llm.add' },
  paramBuilder: (args) => ({
    provider: args['provider'],
    apiKey: args['api-key'],
    ...(args['label'] !== undefined && { label: args['label'] }),
    ...(args['base-url'] !== undefined && { baseUrl: args['base-url'] }),
    ...(args['auth-type'] !== undefined && { authType: args['auth-type'] }),
    ...(args['priority'] !== undefined && { priority: Number(args['priority']) }),
  }),
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
    list: listCommand,
    remove: removeCommand,
    use: useCommand,
    profile: profileCommand,
    test: testCommand,
    whoami: whoamiCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
