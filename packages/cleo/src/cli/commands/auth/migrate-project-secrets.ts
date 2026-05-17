/**
 * `cleo auth migrate-project-secrets` — one-shot migration that moves every
 * `llm.providers.*.apiKey` entry out of project-level `.cleo/config.json`
 * and into the unified credential pool (`~/.cleo/llm-credentials.json`).
 *
 * Motivation (E-CONFIG-AUTH-UNIFY §5.2 T-E2-9): T9413 hard-rejected the
 * project-config tier because `.cleo/config.json` is frequently committed
 * to git, leaking API keys. Users who already had keys there need a safe,
 * non-interactive-friendly way to fix the footgun without hand-editing JSON.
 *
 * Flow:
 *   1. Resolve project root (defaults to cwd; `--project-root` override).
 *   2. Read `<projectRoot>/.cleo/config.json`. If missing or contains no
 *      `llm.providers.*.apiKey` entries, exit success (idempotent — running
 *      after a successful migration is a no-op).
 *   3. Enumerate every `(provider, apiKey)` pair. Show the operator a
 *      preview (provider list — keys themselves NEVER printed) and prompt
 *      for confirmation. Skip the prompt when `--yes` is passed (CI mode).
 *   4. Snapshot the original config to `.cleo/config.json.pre-migration-bak`
 *      BEFORE touching anything (atomic safety net).
 *   5. For each entry call `addCredential({ provider, label, authType,
 *      accessToken, source: 'manual' })` with
 *      `label = 'migrated-from-project-config'`.
 *   6. Re-emit `<projectRoot>/.cleo/config.json` with every `apiKey` field
 *      stripped (other LLM config — `default`, `roles`, `daemon`, etc. —
 *      is preserved untouched). Providers whose entry becomes empty after
 *      `apiKey` removal are dropped to avoid littering the file with `{}`.
 *   7. Emit the LAFS envelope summarising the moved providers + backup path.
 *
 * Re-running after a successful migration is a no-op because step 2 finds
 * no `apiKey` entries.
 *
 * @task T9417
 * @epic E-CONFIG-AUTH-UNIFY (E2b §5.2 T-E2-9)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { defineCommand } from 'citty';
import { cliError, cliOutput } from '../../renderers/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-provider migration outcome.
 *
 * @task T9417
 */
export interface MigratedSecret {
  /** Provider id (e.g. `anthropic`). Open string — third-party plugins allowed. */
  provider: string;
  /** Label written to the pool entry (always `migrated-from-project-config`). */
  label: string;
  /** Whether the key was actually moved to the pool (`false` only on dry-run). */
  moved: boolean;
}

/**
 * Result envelope for `cleo auth migrate-project-secrets`.
 *
 * `migrated` is empty when the migration is a no-op (no `apiKey` entries
 * present). `backupPath` is null on no-op runs because no file was written.
 *
 * @task T9417
 */
export interface AuthMigrateProjectSecretsResult {
  /** Absolute path to the project config file that was inspected. */
  configPath: string;
  /** Absolute path to the pre-migration backup (`null` on no-op). */
  backupPath: string | null;
  /** Per-provider migration outcomes. */
  migrated: MigratedSecret[];
  /** `true` when the operator declined the prompt (no changes written). */
  cancelled: boolean;
  /** `true` when `--dry-run` was passed; no filesystem writes occurred. */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the project root: explicit `--project-root` wins, else cwd.
 *
 * `cleo` is always invoked from inside a project tree, so cwd is the
 * pragmatic default. We deliberately do NOT walk upward looking for
 * `.cleo/` because the migration command is operator-facing and should
 * fail loud if the user runs it from the wrong directory.
 *
 * @internal
 */
function resolveProjectRootArg(arg: unknown): string {
  if (typeof arg === 'string' && arg.length > 0) return arg;
  return process.cwd();
}

/**
 * Resolve the path of the project config file inside the given project root.
 *
 * Honours `CLEO_DIR` so non-default layouts (e.g. test fixtures pointing at
 * a custom dotdir) resolve correctly.
 *
 * @internal
 */
function projectConfigPath(projectRoot: string): string {
  const cleoDir = process.env['CLEO_DIR'] ?? '.cleo';
  return join(projectRoot, cleoDir, 'config.json');
}

/**
 * Extract every `(provider, apiKey)` pair from a parsed project config.
 *
 * Returns an empty array when:
 *   - `llm` is missing or not an object,
 *   - `llm.providers` is missing or not an object,
 *   - no entry has a non-empty string `apiKey` field.
 *
 * Provider names are open strings (third-party plugin providers are valid).
 *
 * @internal
 */
function extractApiKeyEntries(config: unknown): Array<{ provider: string; apiKey: string }> {
  if (!config || typeof config !== 'object') return [];
  const llm = (config as Record<string, unknown>)['llm'];
  if (!llm || typeof llm !== 'object') return [];
  const providers = (llm as Record<string, unknown>)['providers'];
  if (!providers || typeof providers !== 'object') return [];
  const out: Array<{ provider: string; apiKey: string }> = [];
  for (const [provider, raw] of Object.entries(providers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const apiKey = (raw as Record<string, unknown>)['apiKey'];
    if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
      out.push({ provider, apiKey: apiKey.trim() });
    }
  }
  return out;
}

/**
 * Return a deep-cloned config with every `llm.providers.*.apiKey` field
 * removed. Providers whose entry becomes empty (no remaining fields) are
 * dropped entirely so the resulting file doesn't accumulate `{}` stubs.
 *
 * All other `llm` keys (`default`, `roles`, `daemon`, …) and top-level
 * keys are preserved verbatim.
 *
 * @internal
 */
function stripApiKeysFromConfig(config: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(config);
  const llm = clone['llm'];
  if (!llm || typeof llm !== 'object') return clone;
  const providers = (llm as Record<string, unknown>)['providers'];
  if (!providers || typeof providers !== 'object') return clone;
  const cleanedProviders: Record<string, unknown> = {};
  for (const [provider, raw] of Object.entries(providers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') {
      cleanedProviders[provider] = raw;
      continue;
    }
    const entry = { ...(raw as Record<string, unknown>) };
    delete entry['apiKey'];
    if (Object.keys(entry).length > 0) {
      cleanedProviders[provider] = entry;
    }
    // else: drop the provider entirely — nothing left to persist.
  }
  (llm as Record<string, unknown>)['providers'] = cleanedProviders;
  return clone;
}

/**
 * Detect the auth type from an API key prefix.
 *
 * Anthropic OAuth tokens (`sk-ant-oat-*` / `sk-ant-ort-*`) MUST be stored
 * with `authType: 'oauth'`; everything else uses `'api_key'`. Mirrors the
 * detection in `packages/core/src/llm/credentials.ts`.
 *
 * @internal
 */
function detectAuthType(provider: string, token: string): 'api_key' | 'oauth' {
  if (provider !== 'anthropic') return 'api_key';
  if (token.startsWith('sk-ant-oat-') || token.startsWith('sk-ant-ort-')) return 'oauth';
  return 'api_key';
}

/**
 * Synchronously read a yes/no answer from stdin.
 *
 * Returns `true` when the operator answers with `y` / `yes` (case-insensitive);
 * any other input — including the empty string — returns `false`. The prompt
 * defaults to no because the migration mutates user data; explicit consent
 * is required.
 *
 * @internal
 */
async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, (a: string) => resolve(a));
    });
    const clean = answer.trim().toLowerCase();
    return clean === 'y' || clean === 'yes';
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Core (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Options consumed by {@link runMigrateProjectSecrets}.
 *
 * @task T9417
 */
export interface RunMigrateOptions {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** When true, skip the interactive prompt (CI / scripted usage). */
  yes: boolean;
  /** When true, do not write anything to disk — print what would happen. */
  dryRun: boolean;
}

/**
 * Internal entry point — separated from the command so tests can drive the
 * migration without going through citty argument parsing.
 *
 * @task T9417
 */
export async function runMigrateProjectSecrets(
  opts: RunMigrateOptions,
): Promise<AuthMigrateProjectSecretsResult> {
  const configPath = projectConfigPath(opts.projectRoot);

  // No project config → nothing to migrate. Idempotent no-op.
  if (!existsSync(configPath)) {
    return {
      configPath,
      backupPath: null,
      migrated: [],
      cancelled: false,
      dryRun: opts.dryRun,
    };
  }

  const raw = readFileSync(configPath, 'utf-8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Fix the JSON syntax error before running migrate-project-secrets.`,
    );
  }

  const entries = extractApiKeyEntries(parsed);
  if (entries.length === 0) {
    // Nothing to migrate — emit a clean no-op result.
    return {
      configPath,
      backupPath: null,
      migrated: [],
      cancelled: false,
      dryRun: opts.dryRun,
    };
  }

  // Prompt for confirmation (unless --yes). Routes through stderr so JSON
  // consumers still get clean stdout and the prompt is visible interactively.
  if (!opts.yes) {
    process.stderr.write(
      `Found ${entries.length} project-config secret(s) to migrate:\n` +
        entries.map((e) => `  - ${e.provider}\n`).join('') +
        `\nThis will:\n` +
        `  1. Back up ${configPath} -> ${configPath}.pre-migration-bak\n` +
        `  2. Move each apiKey into the unified credential pool with label 'migrated-from-project-config'\n` +
        `  3. Remove the apiKey fields from the project config\n\n`,
    );
    const confirmed = await promptYesNo('Proceed? [y/N] ');
    if (!confirmed) {
      return {
        configPath,
        backupPath: null,
        migrated: [],
        cancelled: true,
        dryRun: opts.dryRun,
      };
    }
  }

  if (opts.dryRun) {
    return {
      configPath,
      backupPath: null,
      migrated: entries.map((e) => ({
        provider: e.provider,
        label: 'migrated-from-project-config',
        moved: false,
      })),
      cancelled: false,
      dryRun: true,
    };
  }

  // Atomic backup BEFORE any mutation — writes a sibling file so the original
  // is recoverable even if the addCredential calls fail midway. We use the
  // raw bytes (not the parsed-then-reserialised form) so the backup is a
  // byte-perfect restore target.
  const backupPath = `${configPath}.pre-migration-bak`;
  writeFileSync(backupPath, raw, { mode: 0o600 });

  // Lazy import — keeps `cleo --help` fast and avoids pulling the credential
  // store + its lockfile machinery into the cold-start surface for users who
  // never call this command.
  const { addCredential } = await import(
    /* webpackIgnore: true */ '@cleocode/core/llm/credentials-store.js'
  );

  const migrated: MigratedSecret[] = [];
  for (const { provider, apiKey } of entries) {
    // `addCredential` is upsert-by-(provider, label) — running twice is safe.
    // The unified pool only honours `BuiltinProviderId` plus open plugin
    // strings; both are valid `ModelTransport` widenings, so we cast at the
    // boundary without adding a new public type.
    await addCredential({
      provider: provider as Parameters<typeof addCredential>[0]['provider'],
      label: 'migrated-from-project-config',
      authType: detectAuthType(provider, apiKey),
      accessToken: apiKey,
      source: 'manual',
    });
    migrated.push({ provider, label: 'migrated-from-project-config', moved: true });
  }

  // Re-emit the config with every apiKey stripped. We pretty-print with 2-space
  // indent to match the convention every other CLEO config writer uses.
  const stripped = stripApiKeysFromConfig(parsed);
  writeFileSync(configPath, `${JSON.stringify(stripped, null, 2)}\n`, 'utf-8');

  return {
    configPath,
    backupPath,
    migrated,
    cancelled: false,
    dryRun: false,
  };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * `cleo auth migrate-project-secrets` — see file-level docstring.
 *
 * @task T9417
 */
export const authMigrateProjectSecretsCommand = defineCommand({
  meta: {
    name: 'migrate-project-secrets',
    description:
      'Move every llm.providers.*.apiKey out of .cleo/config.json (project-scoped, ' +
      'often committed to git) and into the unified credential pool. Atomic: ' +
      'backs up the original config to .cleo/config.json.pre-migration-bak first.',
  },
  args: {
    'project-root': {
      type: 'string',
      description: 'Override the project root (default: cwd)',
    },
    yes: {
      type: 'boolean',
      description: 'Skip the interactive confirmation prompt',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Show what would be migrated without writing anything',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON envelope',
    },
  },
  async run({ args }) {
    const a = args as Record<string, unknown>;
    const projectRoot = resolveProjectRootArg(a['project-root']);
    const yes = Boolean(a['yes']);
    const dryRun = Boolean(a['dry-run']);

    let result: AuthMigrateProjectSecretsResult;
    try {
      result = await runMigrateProjectSecrets({ projectRoot, yes, dryRun });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(message, 6, { name: 'E_VALIDATION' });
      process.exit(6);
    }

    cliOutput(result, {
      command: 'auth-migrate-project-secrets',
      operation: 'auth.migrate-project-secrets',
    });
  },
});
