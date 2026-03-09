/**
 * Install the CLEO Claude Code plugin (brain hooks) for the current user.
 *
 * This copies the bundled .claude-plugin/ directory into Claude Code's plugin
 * cache and registers it in ~/.claude/settings.json, enabling:
 *   - Brain observation hooks (PostToolUse → brain.db)
 *   - Session context injection (UserPromptSubmit → brain context)
 *   - Session summary on Stop
 *
 * @task T5671
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_CACHE_NAME = 'cleocode';
const PLUGIN_PACKAGE_NAME = 'cleo';

export interface PluginInstallResult {
  created: string[];
  warnings: string[];
}

export async function installClaudePlugin(opts: {
  dryRun?: boolean;
}): Promise<PluginInstallResult> {
  const { dryRun = false } = opts;
  const created: string[] = [];
  const warnings: string[] = [];

  const home = homedir();
  const claudeHome = join(home, '.claude');
  const settingsPath = join(claudeHome, 'settings.json');

  // Locate bundled plugin source (works from npm package or source tree)
  const thisFile = fileURLToPath(import.meta.url);
  const packageRoot = resolve(dirname(thisFile), '..', '..', '..');
  const pluginSrc = join(packageRoot, '.claude-plugin');

  if (!existsSync(pluginSrc)) {
    warnings.push('CLEO Claude plugin source not found — skipping plugin install');
    return { created, warnings };
  }

  // Determine version from plugin.json
  let pluginVersion = '0.0.0';
  try {
    const pluginJson = JSON.parse(readFileSync(join(pluginSrc, 'plugin.json'), 'utf-8'));
    pluginVersion = pluginJson.version ?? '0.0.0';
  } catch {
    // use default
  }

  // Install plugin into Claude Code plugin cache
  const cacheDir = join(claudeHome, 'plugins', 'cache', PLUGIN_CACHE_NAME, PLUGIN_PACKAGE_NAME, pluginVersion);
  const cacheDirDisplay = cacheDir.replace(home, '~');

  if (!dryRun) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      cpSync(pluginSrc, cacheDir, { recursive: true });
      created.push(`${cacheDirDisplay} (CLEO Claude plugin installed)`);
    } catch (err) {
      warnings.push(`Plugin cache copy failed: ${err instanceof Error ? err.message : String(err)}`);
      return { created, warnings };
    }
  } else {
    created.push(`${cacheDirDisplay} (would install CLEO Claude plugin)`);
  }

  // Register in ~/.claude/settings.json enabledPlugins
  if (!dryRun) {
    try {
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        } catch {
          // malformed settings — start fresh
        }
      }

      const enabledPlugins = (settings['enabledPlugins'] as Record<string, boolean>) ?? {};

      // Disable old claude-mem if present
      if (enabledPlugins['claude-mem@thedotmack'] === true) {
        enabledPlugins['claude-mem@thedotmack'] = false;
        created.push('~/.claude/settings.json (disabled claude-mem@thedotmack)');
      }

      // Enable the CLEO plugin
      const pluginKey = `${PLUGIN_PACKAGE_NAME}@${PLUGIN_CACHE_NAME}`;
      if (!enabledPlugins[pluginKey]) {
        enabledPlugins[pluginKey] = true;
        created.push(`~/.claude/settings.json (enabled ${pluginKey})`);
      }

      settings['enabledPlugins'] = enabledPlugins;

      mkdirSync(claudeHome, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    } catch (err) {
      warnings.push(
        `settings.json update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    created.push(`~/.claude/settings.json (would enable ${PLUGIN_PACKAGE_NAME}@${PLUGIN_CACHE_NAME})`);
  }

  return { created, warnings };
}
