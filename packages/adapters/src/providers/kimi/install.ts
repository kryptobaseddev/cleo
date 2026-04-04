/**
 * Kimi Install Provider
 *
 * Handles CLEO installation into Kimi environments:
 * - Ensures AGENTS.md has CLEO @-references
 *
 * @task T163
 * @epic T134
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';

/** Lines that should appear in AGENTS.md to reference CLEO. */
const INSTRUCTION_REFERENCES = ['@~/.cleo/templates/CLEO-INJECTION.md', '@.cleo/memory-bridge.md'];

/**
 * Install provider for Kimi.
 *
 * Manages CLEO's integration with Kimi by:
 * 1. Ensuring AGENTS.md contains @-references to CLEO instruction files
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
    let instructionFileUpdated = false;
    const details: Record<string, unknown> = {};

    // Step 1: Ensure AGENTS.md has @-references
    instructionFileUpdated = this.updateInstructionFile(projectDir);
    if (instructionFileUpdated) {
      details.instructionFile = join(projectDir, 'AGENTS.md');
    }

    return {
      success: true,
      installedAt,
      instructionFileUpdated,
      mcpRegistered: false,
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
    const agentsMdPath = join(process.cwd(), 'AGENTS.md');
    if (existsSync(agentsMdPath)) {
      try {
        const content = readFileSync(agentsMdPath, 'utf-8');
        if (INSTRUCTION_REFERENCES.some((ref) => content.includes(ref))) {
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
    this.updateInstructionFile(projectDir);
  }

  /**
   * Update AGENTS.md with CLEO @-references.
   *
   * @param projectDir - Project root directory
   * @returns true if the file was created or modified
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

    if (missingRefs.length === 0) {
      return false;
    }

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
}
