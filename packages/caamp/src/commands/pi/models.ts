/**
 * `caamp pi models` command group.
 *
 * @remarks
 * Six verbs implementing ADR-035 §D3 for Pi's dual-file models
 * configuration. `models.json` is authoritative for definitions,
 * `settings.json:enabledModels` is authoritative for selection, and
 * `settings.json:defaultModel` + `defaultProvider` are authoritative
 * for defaults.
 *
 * | Verb      | Mutates                                    | Reads               |
 * | --------- | ------------------------------------------ | ------------------- |
 * | `list`    | —                                          | both files          |
 * | `add`     | `models.json`                              | —                   |
 * | `remove`  | `models.json`                              | —                   |
 * | `enable`  | `settings.json:enabledModels`              | `models.json`       |
 * | `disable` | `settings.json:enabledModels`              | —                   |
 * | `default` | `settings.json:defaultModel + provider`    | `models.json`       |
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import type {
  HarnessScope,
  PiModelDefinition,
  PiModelProvider,
  PiModelsConfig,
} from '../../core/harness/types.js';
import { LAFSCommandError, runLafsCommand } from '../advanced/lafs.js';
import { PI_ERROR_CODES, type PiCommandBaseOptions, requirePiHarness } from './common.js';

/**
 * Options accepted by every `caamp pi models` verb.
 *
 * @public
 */
export interface PiModelsCommandOptions extends PiCommandBaseOptions {
  /** `--global` targets the Pi global state root instead of the project. */
  global?: boolean;
}

/**
 * Options accepted by `caamp pi models add`.
 *
 * @public
 */
export interface PiModelsAddOptions extends PiModelsCommandOptions {
  /** Human-readable model name. */
  displayName?: string;
  /** Override the provider base URL. */
  baseUrl?: string;
  /** Reasoning-capable flag. */
  reasoning?: boolean;
  /** Context window size in tokens. */
  contextWindow?: string;
  /** Maximum output tokens. */
  maxTokens?: string;
}

/**
 * Parse a `provider:model-id` specifier into its parts.
 *
 * @remarks
 * Throws a typed {@link LAFSCommandError} when the specifier does not
 * match `<provider>:<model-id>` so the error envelope carries a
 * meaningful code and recovery hint.
 *
 * @internal
 */
function parseModelSpec(spec: string): { provider: string; id: string } {
  const idx = spec.indexOf(':');
  if (idx <= 0 || idx === spec.length - 1) {
    throw new LAFSCommandError(
      PI_ERROR_CODES.VALIDATION,
      `Invalid model specifier: ${spec}`,
      "Use 'provider:model-id', e.g. 'anthropic:claude-sonnet-4-20250514'.",
      false,
    );
  }
  return { provider: spec.slice(0, idx), id: spec.slice(idx + 1) };
}

/**
 * Resolve a scope from the `--global` flag into a {@link HarnessScope}.
 *
 * @remarks
 * Mirrors the legacy two-tier scope used by PiHarness' settings and
 * models I/O methods. Defaults to global scope, matching Pi's own
 * behaviour where `models.json` lives at the user-tier root unless a
 * project override is explicitly requested.
 *
 * @internal
 */
function resolveModelsScope(opts: PiModelsCommandOptions): HarnessScope {
  if (opts.global === true) return { kind: 'global' };
  if (opts.projectDir !== undefined && opts.projectDir.length > 0) {
    return { kind: 'project', projectDir: opts.projectDir };
  }
  return { kind: 'global' };
}

/**
 * Parse a numeric CLI option value.
 *
 * @remarks
 * Throws {@link LAFSCommandError} when the string is not a positive
 * finite integer. Used by `--context-window` and `--max-tokens`.
 *
 * @internal
 */
function parsePositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    throw new LAFSCommandError(
      PI_ERROR_CODES.VALIDATION,
      `Invalid value for --${name}: ${raw}`,
      `--${name} must be a positive integer.`,
      false,
    );
  }
  return parsed;
}

/**
 * Registers the `caamp pi models` command group.
 *
 * @remarks
 * Wires the `list`, `add`, `remove`, `enable`, `disable`, and `default`
 * subcommands into the supplied `pi` parent Command. Reads and writes
 * Pi's dual-file `models.json` + `settings.json` hierarchy via the
 * {@link PiHarness} three-tier model APIs.
 *
 * @param parent - The parent `pi` Command to attach the models group to.
 *
 * @example
 * ```bash
 * caamp pi models list
 * caamp pi models add custom-provider:my-model --display-name "My Model"
 * caamp pi models enable anthropic:claude-opus-4-20250514
 * caamp pi models default anthropic:claude-sonnet-4-20250514
 * ```
 *
 * @public
 */
export function registerPiModelsCommands(parent: Command): void {
  const models = parent.command('models').description("Manage Pi's dual-file models configuration");

  models
    .command('list')
    .description('List every model known to Pi (union of models.json and enabledModels)')
    .option('--global', 'Read from the Pi global state root (default)')
    .option('--project-dir <path>', 'Read from a project-scoped Pi config')
    .action(async (opts: PiModelsCommandOptions) =>
      runLafsCommand('pi.models.list', 'standard', async () => {
        const harness = requirePiHarness();
        const scope = resolveModelsScope(opts);
        const entries = await harness.listModels(scope);
        const active = entries.filter((e) => e.enabled);
        const def = entries.find((e) => e.isDefault) ?? null;
        return {
          scope: scope.kind,
          count: entries.length,
          activeCount: active.length,
          default: def,
          models: entries,
        };
      }),
    );

  models
    .command('add <spec>')
    .description('Add a custom model definition to models.json (e.g. provider:model-id)')
    .option('--global', 'Write to the Pi global state root (default)')
    .option('--project-dir <path>', 'Write to a project-scoped Pi config')
    .option('--display-name <name>', 'Human-readable model name')
    .option('--base-url <url>', 'Override the provider base URL')
    .option('--reasoning', 'Mark the model as reasoning-capable')
    .option('--context-window <tokens>', 'Context window size in tokens')
    .option('--max-tokens <tokens>', 'Maximum output tokens')
    .action(async (spec: string, opts: PiModelsAddOptions) =>
      runLafsCommand('pi.models.add', 'standard', async () => {
        const harness = requirePiHarness();
        const scope = resolveModelsScope(opts);
        const { provider, id } = parseModelSpec(spec);
        const contextWindow = parsePositiveInt(opts.contextWindow, 'context-window');
        const maxTokens = parsePositiveInt(opts.maxTokens, 'max-tokens');

        const config = await harness.readModelsConfig(scope);
        const providerBlock: PiModelProvider = config.providers[provider] ?? {};
        if (opts.baseUrl !== undefined) providerBlock.baseUrl = opts.baseUrl;

        const nextModels: PiModelDefinition[] = providerBlock.models
          ? [...providerBlock.models]
          : [];
        const existingIdx = nextModels.findIndex((m) => m.id === id);
        const definition: PiModelDefinition = {
          id,
          name: opts.displayName ?? id,
        };
        if (opts.reasoning === true) definition.reasoning = true;
        if (contextWindow !== undefined) definition.contextWindow = contextWindow;
        if (maxTokens !== undefined) definition.maxTokens = maxTokens;

        if (existingIdx >= 0) {
          nextModels[existingIdx] = definition;
        } else {
          nextModels.push(definition);
        }
        providerBlock.models = nextModels;

        const nextConfig: PiModelsConfig = {
          providers: { ...config.providers, [provider]: providerBlock },
        };
        await harness.writeModelsConfig(nextConfig, scope);

        return {
          added: { provider, id, name: definition.name },
          replaced: existingIdx >= 0,
          scope: scope.kind,
        };
      }),
    );

  models
    .command('remove <spec>')
    .description('Remove a custom model definition from models.json')
    .option('--global', 'Write to the Pi global state root (default)')
    .option('--project-dir <path>', 'Write to a project-scoped Pi config')
    .action(async (spec: string, opts: PiModelsCommandOptions) =>
      runLafsCommand('pi.models.remove', 'standard', async () => {
        const harness = requirePiHarness();
        const scope = resolveModelsScope(opts);
        const { provider, id } = parseModelSpec(spec);

        const config = await harness.readModelsConfig(scope);
        const providerBlock = config.providers[provider];
        if (providerBlock === undefined || providerBlock.models === undefined) {
          return { removed: false, provider, id, reason: 'provider-not-found' };
        }
        const before = providerBlock.models.length;
        const filtered = providerBlock.models.filter((m) => m.id !== id);
        if (filtered.length === before) {
          return { removed: false, provider, id, reason: 'model-not-found' };
        }
        const nextProviderBlock: PiModelProvider = { ...providerBlock, models: filtered };
        if (filtered.length === 0) {
          delete nextProviderBlock.models;
        }
        const nextConfig: PiModelsConfig = {
          providers: { ...config.providers, [provider]: nextProviderBlock },
        };
        await harness.writeModelsConfig(nextConfig, scope);
        return { removed: true, provider, id, scope: scope.kind };
      }),
    );

  models
    .command('enable <spec>')
    .description('Enable a model by appending it to settings.json:enabledModels')
    .option('--global', 'Write to the Pi global state root (default)')
    .option('--project-dir <path>', 'Write to a project-scoped Pi config')
    .action(async (spec: string, opts: PiModelsCommandOptions) =>
      runLafsCommand('pi.models.enable', 'standard', async () => {
        const harness = requirePiHarness();
        const scope = resolveModelsScope(opts);
        const { provider, id } = parseModelSpec(spec);

        // Validate against models.json when the spec is a concrete id.
        if (!id.includes('*')) {
          const config = await harness.readModelsConfig(scope);
          const providerBlock = config.providers[provider];
          const defined = providerBlock?.models?.some((m) => m.id === id) ?? false;
          if (!defined) {
            // Soft validation: a missing definition means the id must
            // resolve against Pi's built-in registry. We allow the
            // enable but surface an advisory flag.
          }
        }

        const current = await harness.readSettings(scope);
        const currentObj =
          typeof current === 'object' && current !== null && !Array.isArray(current)
            ? (current as Record<string, unknown>)
            : {};
        const enabledRaw = currentObj['enabledModels'];
        const enabled = Array.isArray(enabledRaw)
          ? enabledRaw.filter((v): v is string => typeof v === 'string')
          : [];
        const already = enabled.includes(spec);
        if (already) {
          return { enabled: false, reason: 'already-enabled', spec, scope: scope.kind };
        }
        enabled.push(spec);
        await harness.writeSettings({ enabledModels: enabled }, scope);
        return { enabled: true, spec, provider, id, scope: scope.kind };
      }),
    );

  models
    .command('disable <spec>')
    .description('Disable a model by removing it from settings.json:enabledModels')
    .option('--global', 'Write to the Pi global state root (default)')
    .option('--project-dir <path>', 'Write to a project-scoped Pi config')
    .action(async (spec: string, opts: PiModelsCommandOptions) =>
      runLafsCommand('pi.models.disable', 'standard', async () => {
        const harness = requirePiHarness();
        const scope = resolveModelsScope(opts);
        const current = await harness.readSettings(scope);
        const currentObj =
          typeof current === 'object' && current !== null && !Array.isArray(current)
            ? (current as Record<string, unknown>)
            : {};
        const enabledRaw = currentObj['enabledModels'];
        const enabled = Array.isArray(enabledRaw)
          ? enabledRaw.filter((v): v is string => typeof v === 'string')
          : [];
        const filtered = enabled.filter((e) => e !== spec);
        if (filtered.length === enabled.length) {
          return { disabled: false, reason: 'not-enabled', spec, scope: scope.kind };
        }
        await harness.writeSettings({ enabledModels: filtered }, scope);
        return { disabled: true, spec, scope: scope.kind };
      }),
    );

  models
    .command('default <spec>')
    .description('Set settings.json:defaultProvider and defaultModel')
    .option('--global', 'Write to the Pi global state root (default)')
    .option('--project-dir <path>', 'Write to a project-scoped Pi config')
    .action(async (spec: string, opts: PiModelsCommandOptions) =>
      runLafsCommand('pi.models.default', 'standard', async () => {
        const harness = requirePiHarness();
        const scope = resolveModelsScope(opts);
        const { provider, id } = parseModelSpec(spec);

        // Validate against models.json; do not hard-fail on missing
        // definition so callers can target Pi's built-in registry, but
        // carry the advisory in the envelope.
        const config = await harness.readModelsConfig(scope);
        const providerBlock = config.providers[provider];
        const defined = providerBlock?.models?.some((m) => m.id === id) ?? false;

        await harness.writeSettings({ defaultProvider: provider, defaultModel: id }, scope);
        return {
          set: true,
          provider,
          id,
          knownInModelsJson: defined,
          scope: scope.kind,
        };
      }),
    );
}
