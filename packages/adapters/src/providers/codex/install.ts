/**
 * Codex CLI Install Provider
 *
 * Handles CLEO installation into Codex CLI environments:
 * - Ensures AGENTS.md has CLEO @-references via CAAMP
 *
 * @task T162
 * @task T9019
 * @epic T134
 */

import { join } from 'node:path';
import { ensureProviderInstructionFile } from '@cleocode/caamp';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';
import { getCleoTemplatesTildePath } from '../shared/paths.js';

/**
 * Install provider for Codex CLI.
 *
 * Manages CLEO's integration with Codex CLI by:
 * 1. Ensuring AGENTS.md contains @-references to CLEO instruction files
 *    (delegated to CAAMP's canonical {@link ensureProviderInstructionFile}).
 *
 * @remarks
 * Installation is idempotent — running install multiple times on the same
 * project produces the same result. Only AGENTS.md is managed; Codex CLI
 * does not have an MCP or plugin registration mechanism.
 *
 * @task T162
 * @epic T134
 */
export class CodexInstallProvider implements AdapterInstallProvider {
  /**
   * Install CLEO into a Codex CLI environment.
   *
   * @param options - Installation options including project directory
   * @returns Result describing what was installed
   * @task T162
   */
  async install(options: InstallOptions): Promise<InstallResult> {
    const { projectDir } = options;
    const installedAt = new Date().toISOString();
    const details: Record<string, unknown> = {};

    // Ensure AGENTS.md has CLEO @-references via CAAMP canonical API.
    const result = await ensureProviderInstructionFile('codex', projectDir, {
      scope: 'project',
      references: [`@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`, '@.cleo/memory-bridge.md'],
    });

    const instructionFileUpdated = result.action !== 'intact';
    if (instructionFileUpdated) {
      details.instructionFile = join(projectDir, result.instructFile);
    }

    return {
      success: true,
      installedAt,
      instructionFileUpdated,
      details,
    };
  }

  /**
   * Uninstall CLEO from the Codex CLI environment.
   *
   * Does not remove AGENTS.md references (they are harmless if CLEO is not present).
   * @task T162
   */
  async uninstall(): Promise<void> {
    // No-op: no MCP registration to remove
  }

  /**
   * Check whether CLEO is installed in the Codex CLI environment.
   *
   * Delegates to CAAMP's instruction-file check.
   * @task T162
   */
  async isInstalled(): Promise<boolean> {
    try {
      const result = await ensureProviderInstructionFile('codex', process.cwd(), {
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
   * @task T162
   */
  async ensureInstructionReferences(projectDir: string): Promise<void> {
    await ensureProviderInstructionFile('codex', projectDir, {
      scope: 'project',
      references: [`@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`, '@.cleo/memory-bridge.md'],
    });
  }
}
