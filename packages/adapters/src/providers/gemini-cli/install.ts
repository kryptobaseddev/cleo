/**
 * Gemini CLI Install Provider
 *
 * Handles CLEO installation into Gemini CLI environments:
 * - Ensures GEMINI.md has CLEO @-references (via CAAMP registry)
 *
 * @task T161
 * @epic T134
 * @task T9018
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureProviderInstructionFile } from '@cleocode/caamp';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';
import { getCleoTemplatesTildePath } from '../shared/paths.js';

/**
 * Install provider for Gemini CLI.
 *
 * Manages CLEO's integration with Gemini CLI by:
 * 1. Ensuring GEMINI.md contains @-references to CLEO instruction files
 *    (via CAAMP registry — single source of truth for instruction file name)
 *
 * @remarks
 * Installation is idempotent -- running install multiple times on the same
 * project produces the same result. Only GEMINI.md is managed; Gemini CLI
 * does not have an MCP or plugin registration mechanism.
 *
 * @task T161
 * @epic T134
 */
export class GeminiCliInstallProvider implements AdapterInstallProvider {
  /**
   * Install CLEO into a Gemini CLI environment.
   *
   * @param options - Installation options including project directory
   * @returns Result describing what was installed
   * @task T161
   */
  async install(options: InstallOptions): Promise<InstallResult> {
    const { projectDir } = options;
    const installedAt = new Date().toISOString();
    const details: Record<string, unknown> = {};

    const result = await ensureProviderInstructionFile('gemini-cli', projectDir, {
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
   * Uninstall CLEO from the Gemini CLI environment.
   *
   * Does not remove GEMINI.md references (they are harmless if CLEO is not present).
   * @task T161
   */
  async uninstall(): Promise<void> {
    // No-op: no MCP registration to remove
  }

  /**
   * Check whether CLEO is installed in the Gemini CLI environment.
   *
   * Checks for CLEO references in GEMINI.md.
   * @task T161
   */
  async isInstalled(): Promise<boolean> {
    const instructionRef = `@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`;
    const geminiMdPath = join(process.cwd(), 'GEMINI.md');
    if (existsSync(geminiMdPath)) {
      try {
        const content = readFileSync(geminiMdPath, 'utf-8');
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
   * Ensure GEMINI.md contains @-references to CLEO instruction files.
   *
   * Creates GEMINI.md if it does not exist. Appends any missing references.
   *
   * @param projectDir - Project root directory
   * @task T161
   */
  async ensureInstructionReferences(projectDir: string): Promise<void> {
    await ensureProviderInstructionFile('gemini-cli', projectDir, {
      references: [`@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`, '@.cleo/memory-bridge.md'],
      scope: 'project',
    });
  }
}
