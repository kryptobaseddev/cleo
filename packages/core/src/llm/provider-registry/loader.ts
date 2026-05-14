/**
 * Plugin discovery and dynamic import for the CLEO provider registry.
 *
 * Scans `${CLEO_HOME}/plugins/model-providers/` for `*.{ts,mjs,js,cjs}` files,
 * imports each one via `pathToFileURL(absPath).href`, and calls the module's
 * `register` export (named or default) with the plugin API surface.
 *
 * - Non-existent plugin directory → silently no-ops (not an error).
 * - Import errors → logged via `process.stderr` and skipped (never throws).
 * - Idempotent: the discovery promise is module-level singleton; repeated
 *   calls await the same promise.
 *
 * @task T9262
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProviderPlugin, ProviderPluginApi, ProviderProfile } from '@cleocode/contracts';
import { getCleoHome } from '../../paths.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Minimal shape we expect from a dynamically-imported plugin module. */
interface RawPluginModule {
  register?: (api: ProviderPluginApi) => void;
  default?: { register?: (api: ProviderPluginApi) => void } | ((api: ProviderPluginApi) => void);
}

// ---------------------------------------------------------------------------
// Plugin file extensions we recognise
// ---------------------------------------------------------------------------

/** Extensions tried for user plugin files, in priority order. */
const PLUGIN_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts'] as const;

/**
 * Returns `true` when `filename` ends with a recognised plugin extension.
 */
function isPluginFile(filename: string): boolean {
  return PLUGIN_EXTENSIONS.some((ext) => filename.endsWith(ext));
}

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------

/**
 * Return the user plugin directory path — `${CLEO_HOME}/plugins/model-providers`.
 *
 * Does NOT check whether the directory exists; callers must handle that.
 */
export function getPluginDir(): string {
  return join(getCleoHome(), 'plugins', 'model-providers');
}

// ---------------------------------------------------------------------------
// Single-plugin loader
// ---------------------------------------------------------------------------

/**
 * Dynamically import one plugin file and invoke its `register` hook.
 *
 * Tolerates import errors: logs to `process.stderr` and returns without
 * throwing so other plugins in the directory still load.
 *
 * @param absPath - Absolute path to the plugin file.
 * @param api     - The plugin API surface passed to the `register` hook.
 */
async function loadOnePlugin(absPath: string, api: ProviderPluginApi): Promise<void> {
  let mod: RawPluginModule;
  try {
    // ESM dynamic import requires a file URL on all platforms.
    mod = (await import(pathToFileURL(absPath).href)) as RawPluginModule;
  } catch (err) {
    process.stderr.write(
      `[cleo/provider-registry] Failed to import plugin ${absPath}: ${String(err)}\n`,
    );
    return;
  }

  // Resolve the register function: named export takes priority over default.
  let registerFn: ((api: ProviderPluginApi) => void) | undefined;

  if (typeof mod.register === 'function') {
    registerFn = mod.register;
  } else if (mod.default !== undefined) {
    if (typeof mod.default === 'function') {
      // Default export is itself a function — treat as register.
      registerFn = mod.default as (api: ProviderPluginApi) => void;
    } else if (typeof (mod.default as ProviderPlugin).register === 'function') {
      registerFn = (mod.default as ProviderPlugin).register;
    }
  }

  if (registerFn === undefined) {
    process.stderr.write(
      `[cleo/provider-registry] Plugin ${absPath} has no exported 'register' function — skipping.\n`,
    );
    return;
  }

  try {
    registerFn(api);
  } catch (err) {
    process.stderr.write(
      `[cleo/provider-registry] Plugin ${absPath} threw during register(): ${String(err)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Directory scanner
// ---------------------------------------------------------------------------

/**
 * Scan `pluginDir` for files matching {@link PLUGIN_EXTENSIONS}, sorted
 * lexicographically for deterministic load order, and load each one.
 *
 * Non-existent directories are silently ignored (returns without error).
 *
 * @param pluginDir - Absolute path to the plugins directory.
 * @param api       - Plugin API surface passed to each plugin.
 */
export async function scanAndLoadPlugins(pluginDir: string, api: ProviderPluginApi): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(pluginDir);
  } catch {
    // Directory does not exist or is not readable — silently no-op.
    return;
  }

  // Filter to only recognised plugin files (skip dirs, dotfiles, etc.)
  const pluginFiles = entries
    .filter((name) => !name.startsWith('.') && isPluginFile(name))
    .filter((name) => {
      try {
        return statSync(join(pluginDir, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort(); // Lexicographic order for deterministic loading

  for (const filename of pluginFiles) {
    await loadOnePlugin(join(pluginDir, filename), api);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the {@link ProviderPluginApi} surface backed by the given
 * `registerProvider` function and run full plugin discovery.
 *
 * This is the entry-point called by the registry's `ensureDiscovered()`
 * singleton. It:
 *   1. Registers all builtin profiles via the provided `builtins` array.
 *   2. Scans `${CLEO_HOME}/plugins/model-providers/` for user plugins.
 *
 * @param registerProvider - The registry's registration function.
 * @param builtins         - Builtin profiles to pre-register before plugins.
 */
export async function runDiscovery(
  registerProvider: (profile: ProviderProfile) => void,
  builtins: ReadonlyArray<ProviderProfile>,
): Promise<void> {
  const api: ProviderPluginApi = { registerProvider };

  // 1. Register builtins first so user plugins can override them.
  for (const profile of builtins) {
    registerProvider(profile);
  }

  // 2. Load user plugins — they may override builtins (last-writer-wins).
  await scanAndLoadPlugins(getPluginDir(), api);
}
