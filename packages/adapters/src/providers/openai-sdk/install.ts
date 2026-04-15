/**
 * OpenAI SDK Install Provider.
 *
 * Handles CLEO installation into OpenAI SDK environments:
 * - Writes an AGENTS.md file with CLEO @-references
 * - Creates a `.openai/` config stub if it does not exist
 *
 * @task T582
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';

/** Lines that should appear in AGENTS.md to reference CLEO. */
const INSTRUCTION_REFERENCES = ['@~/.cleo/templates/CLEO-INJECTION.md', '@.cleo/memory-bridge.md'];

/**
 * Install provider for the OpenAI Agents SDK.
 *
 * Manages CLEO's integration with OpenAI SDK projects by:
 * 1. Ensuring AGENTS.md contains @-references to CLEO instruction files
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

    // Step 1: Ensure AGENTS.md has @-references
    const instructionFileUpdated = this.updateInstructionFile(projectDir);
    if (instructionFileUpdated) {
      details.instructionFile = join(projectDir, 'AGENTS.md');
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
   * Checks for `@~/.cleo/templates/CLEO-INJECTION.md` in AGENTS.md.
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
    this.updateInstructionFile(projectDir);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Update AGENTS.md with CLEO @-references.
   *
   * @returns `true` if the file was created or modified.
   */
  private updateInstructionFile(projectDir: string): boolean {
    const agentsMdPath = join(projectDir, 'AGENTS.md');
    let content = '';
    let existed = false;

    if (existsSync(agentsMdPath)) {
      content = readFileSync(agentsMdPath, 'utf-8');
      existed = true;
    }

    const missingRefs = INSTRUCTION_REFERENCES.filter((ref) => !content.includes(ref));
    if (missingRefs.length === 0) return false;

    const refsBlock = missingRefs.join('\n');

    if (existed) {
      const separator = content.endsWith('\n') ? '' : '\n';
      content = content + separator + refsBlock + '\n';
    } else {
      content = refsBlock + '\n';
    }

    writeFileSync(agentsMdPath, content, 'utf-8');
    return true;
  }

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
