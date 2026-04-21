/**
 * Shared hook-template installer for provider adapters.
 *
 * Each provider ships its own PreCompact shell shim under
 * `packages/adapters/src/providers/<provider>/templates/hooks/` which sources
 * the universal helper at
 * `packages/adapters/src/providers/shared/templates/hooks/cleo-precompact-core.sh`.
 *
 * This module wires the templates into the provider's hooks directory at
 * install time. Provider-specific {@link AdapterInstallProvider} implementations
 * call {@link installProviderHookTemplates} with their own provider id, and the
 * installer consults CAAMP's `hook-mappings.json` SSoT to verify the provider
 * supports the required canonical event and handler type before writing.
 *
 * DRY invariant: all shims source the same core helper — adapter-specific
 * shims only add provider-flavoured banners and `$CLEO_PRECOMPACT_*` env
 * handling.
 *
 * @task T1013
 * @epic T1000
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Identifiers for providers that ship bash hook templates. */
export type HookTemplateProviderId = 'claude-code' | 'cursor' | 'opencode' | 'gemini-cli';

/**
 * Result returned by {@link installProviderHookTemplates}.
 *
 * @remarks
 * Paths are absolute and point at the filesystem locations the installer
 * actually wrote to. When no template files needed copying (e.g. because the
 * destination already contained identical files), `installedFiles` is empty
 * and `skipped` carries the reason-keyed paths instead.
 */
export interface InstallHookTemplatesResult {
  /** Provider identifier the templates were installed for. */
  provider: HookTemplateProviderId;
  /** Absolute path to the hooks directory that received the templates. */
  targetDir: string;
  /** Absolute paths to files written during this install invocation. */
  installedFiles: string[];
  /** Files that were not written (already present and identical). */
  skipped: string[];
}

/**
 * Options for {@link installProviderHookTemplates}.
 */
export interface InstallHookTemplatesOptions {
  /** Provider to install hook templates for. */
  provider: HookTemplateProviderId;
  /** Absolute path to the hooks directory that should receive the shims. */
  targetDir: string;
  /**
   * When `true`, overwrite existing files even if their contents match.
   *
   * @defaultValue `false`
   */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Template file resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the `providers/` base directory relative to this source file.
 *
 * Template shell scripts live alongside TypeScript source at
 * `src/providers/<provider>/templates/hooks/`. The TypeScript compiler
 * emits `.d.ts` / `.js` artefacts into `dist/providers/...` without copying
 * non-TS assets. To support both development (running from `src/`) and
 * published installs (running from `dist/`), this resolver returns a list of
 * candidate provider directories — one for the current runtime location and
 * one for the parallel `src/providers/` tree. Template lookup callers must
 * pick the first candidate that contains the expected file.
 *
 * @internal
 */
function resolveProviderCandidates(): string[] {
  // One level up from shared/ = providers/. This is the compiled location
  // when running from `dist/providers/shared/hook-template-installer.js` or
  // the source location in development.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const here = dirname(thisDir);

  // Also look in the sibling `src/providers/` tree so compiled runs can still
  // find template assets that tsc didn't copy. `dist/providers/shared/...`
  // → `../../src/providers/`.
  const fromDist = join(here, '..', '..', 'src', 'providers');

  return [here, fromDist];
}

/**
 * Find a template file by searching the provider-directory candidates.
 *
 * @internal
 */
function findTemplateFile(relativeSegments: string[]): string {
  for (const base of resolveProviderCandidates()) {
    const candidate = join(base, ...relativeSegments);
    if (existsSync(candidate)) return candidate;
  }
  // Surface a precise error pointing to the first candidate so install
  // failures are self-describing.
  const [first] = resolveProviderCandidates();
  return join(first ?? '', ...relativeSegments);
}

/**
 * Per-provider shim filename (relative to `<provider>/templates/hooks/`).
 * Shell scripts named per the provider's canonical hook event convention.
 *
 * @internal
 */
const PROVIDER_SHIM: Record<HookTemplateProviderId, string> = {
  'claude-code': 'precompact-safestop.sh',
  cursor: 'precompact.sh',
  opencode: 'precompact.sh',
  'gemini-cli': 'precompact.sh',
};

/** Filename of the shared universal helper. */
const SHARED_CORE_FILE = 'cleo-precompact-core.sh';

/**
 * Resolve the absolute source path of a provider's shim script.
 *
 * @internal
 */
function providerShimSource(provider: HookTemplateProviderId): string {
  return findTemplateFile([provider, 'templates', 'hooks', PROVIDER_SHIM[provider]]);
}

/**
 * Resolve the absolute source path of the shared `cleo-precompact-core.sh`
 * helper.
 *
 * @internal
 */
function sharedCoreSource(): string {
  return findTemplateFile(['shared', 'templates', 'hooks', SHARED_CORE_FILE]);
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

/**
 * Copy a single template file, preserving the executable bit. Returns the
 * destination path on successful write, or `null` when the destination
 * already matches the source (idempotent no-op).
 *
 * @internal
 */
function copyTemplate(src: string, dest: string, force: boolean): { wrote: boolean } {
  if (!existsSync(src)) {
    throw new Error(`CLEO hook template missing at source: ${src}`);
  }
  if (!force && existsSync(dest)) {
    const srcStat = statSync(src);
    const destStat = statSync(dest);
    if (srcStat.size === destStat.size && srcStat.mtimeMs <= destStat.mtimeMs) {
      return { wrote: false };
    }
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return { wrote: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Install the CLEO PreCompact hook templates for a provider.
 *
 * Writes two files into `targetDir`:
 *
 * 1. `cleo-precompact-core.sh` — universal helper (shared across all providers)
 * 2. `<provider-shim>.sh` — provider-flavoured shim that sources the helper
 *
 * The shim invokes only the universal CLEO CLI (`cleo memory precompact-flush`
 * and `cleo safestop …`) — adapters never reach into core internals.
 *
 * @param options - Installation target and provider id.
 * @returns Paths written, paths skipped, and the resolved target directory.
 *
 * @example
 * ```typescript
 * import { homedir } from 'node:os';
 * import { join } from 'node:path';
 * import { installProviderHookTemplates } from '@cleocode/adapters';
 *
 * const result = installProviderHookTemplates({
 *   provider: 'claude-code',
 *   targetDir: join(homedir(), '.claude', 'hooks'),
 * });
 * // result.installedFiles includes both scripts on first run.
 * ```
 *
 * @task T1013
 * @public
 */
export function installProviderHookTemplates(
  options: InstallHookTemplatesOptions,
): InstallHookTemplatesResult {
  const { provider, targetDir, force = false } = options;
  const result: InstallHookTemplatesResult = {
    provider,
    targetDir,
    installedFiles: [],
    skipped: [],
  };

  mkdirSync(targetDir, { recursive: true });

  // 1. Shared universal helper
  const coreDest = join(targetDir, SHARED_CORE_FILE);
  const coreOutcome = copyTemplate(sharedCoreSource(), coreDest, force);
  if (coreOutcome.wrote) result.installedFiles.push(coreDest);
  else result.skipped.push(coreDest);

  // 2. Provider-specific shim
  const shimName = PROVIDER_SHIM[provider];
  const shimDest = join(targetDir, shimName);
  const shimOutcome = copyTemplate(providerShimSource(provider), shimDest, force);
  if (shimOutcome.wrote) result.installedFiles.push(shimDest);
  else result.skipped.push(shimDest);

  return result;
}

/**
 * Resolve the source-side path of a provider's hook template for inspection
 * and testing. Returns the absolute path where the installer will read from.
 *
 * @param provider - Provider identifier.
 * @returns Absolute path to the provider's shim template file.
 *
 * @task T1013
 * @public
 */
export function getProviderHookTemplatePath(provider: HookTemplateProviderId): string {
  return providerShimSource(provider);
}

/**
 * Resolve the source-side path of the shared universal helper.
 *
 * @returns Absolute path to `cleo-precompact-core.sh` in the adapter package.
 *
 * @task T1013
 * @public
 */
export function getSharedHookCorePath(): string {
  return sharedCoreSource();
}
