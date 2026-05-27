/**
 * OpenCode Install Provider
 *
 * Handles CLEO installation into OpenCode environments:
 * - Ensures AGENTS.md has CLEO @-references via CAAMP
 * - Installs PreCompact hook shell shims + a JS plugin wrapper (T1013)
 *
 * @task T5240
 * @task T1013
 * @task T9019
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureProviderInstructionFile } from '@cleocode/caamp';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';
import {
  type InstallHookTemplatesResult,
  installProviderHookTemplates,
} from '../shared/hook-template-installer.js';
import { getCleoTemplatesTildePath } from '../shared/paths.js';

/**
 * Install provider for OpenCode.
 *
 * Manages CLEO's integration with OpenCode by:
 * 1. Ensuring AGENTS.md contains @-references to CLEO instruction files
 *    (delegated to CAAMP's canonical {@link ensureProviderInstructionFile}).
 * 2. Installing PreCompact hook shell templates + generating the JS plugin
 *    wrapper that spawns the shim on `experimental.session.compacting` (T1013).
 *
 * @remarks
 * Installation is idempotent — running install multiple times on the same
 * project produces the same result. OpenCode's plugin system is the native
 * hook surface (OpenCode has no config-file hook registry like Claude Code or
 * Cursor), so the installer writes a JS plugin that subscribes to the native
 * event and spawns the shell shim as a child process. This keeps the DRY
 * contract: all providers funnel through the shared `cleo-precompact-core.sh`
 * helper and end up in the `cleo` CLI.
 */
export class OpenCodeInstallProvider implements AdapterInstallProvider {
  /**
   * Install CLEO into an OpenCode project.
   *
   * @param options - Installation options including project directory
   * @returns Result describing what was installed
   */
  async install(options: InstallOptions): Promise<InstallResult> {
    const { projectDir } = options;
    const installedAt = new Date().toISOString();
    const details: Record<string, unknown> = {};

    // Step 1: Ensure AGENTS.md has @-references via CAAMP canonical API.
    const instructResult = await ensureProviderInstructionFile('opencode', projectDir, {
      scope: 'project',
      references: [`@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`, '@.cleo/memory-bridge.md'],
    });

    const instructionFileUpdated = instructResult.action !== 'intact';
    if (instructionFileUpdated) {
      details.instructionFile = join(projectDir, instructResult.instructFile);
    }

    // Step 2 (T1013): Install PreCompact hook templates + generate the JS
    // plugin wrapper that spawns the bash shim on
    // `experimental.session.compacting`.
    const hookResult = this.installHookTemplates(projectDir);
    if (hookResult) {
      details.hookTemplates = hookResult;
    }

    return {
      success: true,
      installedAt,
      instructionFileUpdated,
      details,
    };
  }

  /**
   * Uninstall CLEO from the current OpenCode project.
   *
   * Does not remove AGENTS.md references (they are harmless if CLEO is not present).
   */
  async uninstall(): Promise<void> {}

  /**
   * Check whether CLEO is installed in the current environment.
   *
   * Delegates to CAAMP's instruction-file check.
   */
  async isInstalled(): Promise<boolean> {
    try {
      const result = await ensureProviderInstructionFile('opencode', process.cwd(), {
        scope: 'project',
        references: [
          `@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`,
          '@.cleo/memory-bridge.md',
        ],
      });
      return result.action === 'intact';
    } catch {
      return false;
    }
  }

  /**
   * Ensure AGENTS.md contains @-references to CLEO instruction files.
   *
   * Delegates to CAAMP's canonical {@link ensureProviderInstructionFile}.
   *
   * @param projectDir - Project root directory
   */
  async ensureInstructionReferences(projectDir: string): Promise<void> {
    await ensureProviderInstructionFile('opencode', projectDir, {
      scope: 'project',
      references: [`@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`, '@.cleo/memory-bridge.md'],
    });
  }

  /**
   * Install the CLEO PreCompact hook templates for OpenCode (T1013).
   *
   * OpenCode uses a JavaScript plugin system, not config-based hooks. The
   * installer:
   *
   * 1. Writes the shared bash helper and OpenCode-flavoured `precompact.sh`
   *    to `<projectDir>/.opencode/plugins/hooks/` so the shim can be spawned
   *    as a child process.
   * 2. Generates an OpenCode plugin `.opencode/plugins/cleo-precompact.js`
   *    that subscribes to `experimental.session.compacting` (CAAMP native
   *    event for the canonical `PreCompact`) and spawns the shim.
   *
   * Idempotent.
   *
   * @param projectDir - Project root directory.
   * @returns Install summary, or `null` when no change was required.
   *
   * @task T1013
   */
  private installHookTemplates(projectDir: string): {
    templates: InstallHookTemplatesResult;
    pluginWritten: boolean;
  } | null {
    const pluginsDir = join(projectDir, '.opencode', 'plugins');
    const hooksDir = join(pluginsDir, 'hooks');

    // Template copy is best-effort so missing/locked filesystems (CI sandboxes,
    // mocked `node:fs` in unit tests) don't fail the whole install.
    let templates: InstallHookTemplatesResult;
    try {
      templates = installProviderHookTemplates({
        provider: 'opencode',
        targetDir: hooksDir,
      });
    } catch {
      return null;
    }

    let pluginWritten = false;
    try {
      pluginWritten = this.writePrecompactPlugin(pluginsDir, join(hooksDir, 'precompact.sh'));
    } catch {
      // Best-effort: never block install on hook wiring failures.
    }

    if (templates.installedFiles.length === 0 && !pluginWritten) {
      return null;
    }

    return { templates, pluginWritten };
  }

  /**
   * Write an OpenCode JavaScript plugin that spawns `precompact.sh` when the
   * canonical `PreCompact` event fires. OpenCode exposes the event natively as
   * `experimental.session.compacting` (see CAAMP `hook-mappings.json`).
   *
   * The generated file is idempotent — overwritten only when its content
   * differs from the target on disk. Uses `child_process.spawn` so the bash
   * shim runs in a separate process and does not block the compaction path.
   *
   * @param pluginsDir - Absolute path to `.opencode/plugins/`.
   * @param shimPath - Absolute path to the installed `precompact.sh`.
   * @returns `true` when the plugin file was written, `false` when unchanged.
   *
   * @task T1013
   */
  private writePrecompactPlugin(pluginsDir: string, shimPath: string): boolean {
    const pluginPath = join(pluginsDir, 'cleo-precompact.js');
    const generated = [
      '// CLEO PreCompact plugin for OpenCode (generated by @cleocode/adapters).',
      '// Bridges the canonical CAAMP `PreCompact` event',
      '// (`experimental.session.compacting`) to the shell shim at:',
      `//   ${shimPath}`,
      '// The shim invokes only the `cleo` CLI — no core internals.',
      '',
      "import { spawn } from 'node:child_process';",
      '',
      'export default function register(plugin) {',
      "  plugin.on('experimental.session.compacting', () => {",
      '    try {',
      `      const child = spawn(${JSON.stringify(shimPath)}, [], {`,
      '        detached: true,',
      "        stdio: 'ignore',",
      '      });',
      '      child.unref();',
      '    } catch (err) {',
      '      // Hook errors must never block compaction.',
      "      console.error('[CLEO] precompact hook failed:', err);",
      '    }',
      '  });',
      '}',
      '',
    ].join('\n');

    if (existsSync(pluginPath)) {
      try {
        if (readFileSync(pluginPath, 'utf-8') === generated) {
          return false;
        }
      } catch {
        // Fall through and overwrite.
      }
    }

    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(pluginPath, generated, 'utf-8');
    return true;
  }
}
