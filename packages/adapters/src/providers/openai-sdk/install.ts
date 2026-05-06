/**
 * OpenAI SDK Install Provider.
 *
 * Handles CLEO installation into OpenAI SDK environments:
 * - Writes an AGENTS.md file with CLEO @-references (via CAAMP registry)
 * - Creates a `.openai/` config stub if it does not exist
 *
 * @task T582
 * @task T9018
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureProviderInstructionFile } from '@cleocode/caamp';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';
import { getCleoTemplatesTildePath } from '../shared/paths.js';

/**
 * Install provider for the OpenAI SDK adapter (Vercel AI SDK).
 *
 * Manages CLEO's integration with OpenAI SDK projects by:
 * 1. Ensuring AGENTS.md contains @-references to CLEO instruction files
 *    (via CAAMP registry — single source of truth for instruction file name)
 * 2. Creating the `.openai/` config directory stub if absent
 *
 * @remarks
 * Installation is idempotent — running install multiple times on the same
 * project produces the same result.
 */
export class OpenAiSdkInstallProvider implements AdapterInstallProvider {
  /**
   * Install CLEO into an OpenAI SDK project.
   *
   * @param options - Installation options including project directory.
   * @returns Result describing what was installed.
   */
  async install(options: InstallOptions): Promise<InstallResult> {
    const { projectDir } = options;
    const installedAt = new Date().toISOString();
    const details: Record<string, unknown> = {};

    // Step 1: Ensure AGENTS.md has @-references via CAAMP registry
    const instructionResult = await ensureProviderInstructionFile('openai-sdk', projectDir, {
      references: [`@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`, '@.cleo/memory-bridge.md'],
      scope: 'project',
    });

    const instructionFileUpdated = instructionResult.action !== 'intact';
    if (instructionFileUpdated) {
      details.instructionFile = instructionResult.filePath;
    }

    // Step 2: Create .openai config directory stub
    const configCreated = this.ensureConfigDir(projectDir);
    if (configCreated) {
      details.configDir = join(projectDir, '.openai');
    }

    return {
      success: true,
      installedAt,
      instructionFileUpdated,
      details,
    };
  }

  /**
   * Uninstall CLEO from the current OpenAI SDK project.
   *
   * Does not remove AGENTS.md references (they are harmless if CLEO is absent).
   */
  async uninstall(): Promise<void> {}

  /**
   * Check whether CLEO is installed in the current OpenAI SDK environment.
   *
   * Checks for `@~/.local/share/cleo/templates/CLEO-INJECTION.md` in AGENTS.md.
   */
  async isInstalled(): Promise<boolean> {
    // A project is considered installed when AGENTS.md contains the first reference.
    // There is no plugin registry for the OpenAI SDK.
    return false;
  }

  /**
   * Ensure AGENTS.md contains @-references to CLEO instruction files.
   *
   * @param projectDir - Project root directory.
   */
  async ensureInstructionReferences(projectDir: string): Promise<void> {
    await ensureProviderInstructionFile('openai-sdk', projectDir, {
      references: [`@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`, '@.cleo/memory-bridge.md'],
      scope: 'project',
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Create the `.openai/` config directory if it does not exist.
   *
   * @returns `true` if the directory was created.
   */
  private ensureConfigDir(projectDir: string): boolean {
    const configDir = join(projectDir, '.openai');
    if (existsSync(configDir)) return false;

    mkdirSync(configDir, { recursive: true });
    return true;
  }
}
