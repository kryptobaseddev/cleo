/**
 * Kimi Install Provider
 *
 * Handles CLEO installation into Kimi environments:
 * - Ensures AGENTS.md has CLEO @-references (via CAAMP registry)
 *
 * @task T163
 * @epic T134
 * @task T9018
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureProviderInstructionFile } from '@cleocode/caamp';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';
import { getCleoTemplatesTildePath } from '../shared/paths.js';

/**
 * Install provider for Kimi.
 *
 * Manages CLEO's integration with Kimi by:
 * 1. Ensuring AGENTS.md contains @-references to CLEO instruction files
 *    (via CAAMP registry — single source of truth for instruction file name)
 *
 * @remarks
 * Installation is idempotent -- running install multiple times on the same
 * project produces the same result. Only AGENTS.md is managed; Kimi does
 * not have an MCP or plugin registration mechanism.
 *
 * @task T163
 * @epic T134
 */
export class KimiInstallProvider implements AdapterInstallProvider {
  /**
   * Install CLEO into a Kimi environment.
   *
   * @param options - Installation options including project directory
   * @returns Result describing what was installed
   * @task T163
   */
  async install(options: InstallOptions): Promise<InstallResult> {
    const { projectDir } = options;
    const installedAt = new Date().toISOString();
    const details: Record<string, unknown> = {};

    const result = await ensureProviderInstructionFile('kimi', projectDir, {
      references: [`@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`, '@.cleo/memory-bridge.md'],
      scope: 'project',
    });

    const instructionFileUpdated = result.action !== 'intact';
    if (instructionFileUpdated) {
      details.instructionFile = result.filePath;
    }

    return {
      success: true,
      installedAt,
      instructionFileUpdated,
      details,
    };
  }

  /**
   * Uninstall CLEO from the Kimi environment.
   *
   * Does not remove AGENTS.md references (they are harmless if CLEO is not present).
   * @task T163
   */
  async uninstall(): Promise<void> {
    // No-op: no MCP registration to remove
  }

  /**
   * Check whether CLEO is installed in the Kimi environment.
   *
   * Checks for CLEO references in AGENTS.md.
   * @task T163
   */
  async isInstalled(): Promise<boolean> {
    const instructionRef = `@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`;
    const agentsMdPath = join(process.cwd(), 'AGENTS.md');
    if (existsSync(agentsMdPath)) {
      try {
        const content = readFileSync(agentsMdPath, 'utf-8');
        if (content.includes(instructionRef)) {
          return true;
        }
      } catch {
        // Fall through
      }
    }

    return false;
  }

  /**
   * Ensure AGENTS.md contains @-references to CLEO instruction files.
   *
   * Creates AGENTS.md if it does not exist. Appends any missing references.
   *
   * @param projectDir - Project root directory
   * @task T163
   */
  async ensureInstructionReferences(projectDir: string): Promise<void> {
    await ensureProviderInstructionFile('kimi', projectDir, {
      references: [`@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`, '@.cleo/memory-bridge.md'],
      scope: 'project',
    });
  }
}
