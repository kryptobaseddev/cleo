/**
 * Pi Install Provider
 *
 * Handles CLEO installation into Pi coding agent environments:
 * - Ensures AGENTS.md has CLEO @-references via CAAMP (project and global scope)
 *
 * Pi uses AGENTS.md (not CLAUDE.md) as its instruction file. The global
 * instruction file lives at `~/.pi/agent/AGENTS.md`; the project-level
 * file lives at `<projectDir>/AGENTS.md`.
 *
 * Detection: Pi is detected by the `PI_CODING_AGENT_DIR` or `PI_HOME`
 * environment variables, or by presence of `~/.pi/agent/` directory.
 *
 * @task T553
 * @task T9019
 */

import { join } from 'node:path';
import { ensureProviderInstructionFile } from '@cleocode/caamp';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';
import { getCleoTemplatesTildePath } from '../shared/paths.js';

/**
 * CLEO @-references injected into Pi instruction files.
 * Resolved dynamically to support non-default XDG / OS installation locations (T916).
 */
function getCleoReferences(): string[] {
  return [`@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`, '@.cleo/memory-bridge.md'];
}

/**
 * Install provider for Pi coding agent.
 *
 * Manages CLEO's integration with Pi by:
 * 1. Ensuring project AGENTS.md contains @-references to CLEO instruction files
 *    (delegated to CAAMP's canonical {@link ensureProviderInstructionFile}).
 * 2. Ensuring global AGENTS.md (~/.pi/agent/AGENTS.md) contains @-references.
 *
 * @remarks
 * Installation is idempotent — running install multiple times on the same
 * project produces the same result. Pi's AGENTS.md is auto-discovered from
 * the working directory upwards, so project-level injection is the primary
 * mechanism. Global injection ensures fresh sessions always load CLEO context.
 */
export class PiInstallProvider implements AdapterInstallProvider {
  /**
   * Install CLEO into a Pi coding agent project.
   *
   * @param options - Installation options including project directory
   * @returns Result describing what was installed
   */
  async install(options: InstallOptions): Promise<InstallResult> {
    const { projectDir } = options;
    const installedAt = new Date().toISOString();
    const details: Record<string, unknown> = {};

    // Step 1: Ensure project AGENTS.md has @-references via CAAMP canonical API.
    const projectResult = await ensureProviderInstructionFile('pi', projectDir, {
      scope: 'project',
      references: getCleoReferences(),
    });

    const projectUpdated = projectResult.action !== 'intact';
    if (projectUpdated) {
      details.instructionFile = join(projectDir, projectResult.instructFile);
    }

    // Step 2: Ensure global AGENTS.md has @-references (best-effort).
    // CAAMP resolves pathGlobal from the registry ($HOME/.pi/agent).
    let globalUpdated = false;
    try {
      const globalResult = await ensureProviderInstructionFile('pi', projectDir, {
        scope: 'global',
        references: getCleoReferences(),
      });
      globalUpdated = globalResult.action !== 'intact';
      if (globalUpdated) {
        details.globalInstructionFile = globalResult.filePath;
      }
    } catch {
      // Global install is best-effort — never block project install.
    }

    const instructionFileUpdated = projectUpdated || globalUpdated;

    return {
      success: true,
      installedAt,
      instructionFileUpdated,
      details,
    };
  }

  /**
   * Uninstall CLEO from the current Pi project.
   *
   * Does not remove AGENTS.md references (they are harmless if CLEO is not present).
   */
  async uninstall(): Promise<void> {}

  /**
   * Check whether CLEO is installed in the current environment.
   *
   * Delegates to CAAMP's instruction-file check for project and global scopes.
   */
  async isInstalled(): Promise<boolean> {
    // Check project-level AGENTS.md.
    try {
      const result = await ensureProviderInstructionFile('pi', process.cwd(), {
        scope: 'project',
        references: getCleoReferences(),
      });
      if (result.action === 'intact') return true;
    } catch {
      // Fall through
    }

    // Also check global AGENTS.md.
    try {
      const result = await ensureProviderInstructionFile('pi', process.cwd(), {
        scope: 'global',
        references: getCleoReferences(),
      });
      if (result.action === 'intact') return true;
    } catch {
      // Fall through
    }

    return false;
  }

  /**
   * Ensure AGENTS.md contains @-references to CLEO instruction files.
   *
   * Delegates to CAAMP's canonical {@link ensureProviderInstructionFile}.
   *
   * @param projectDir - Project root directory
   */
  async ensureInstructionReferences(projectDir: string): Promise<void> {
    await ensureProviderInstructionFile('pi', projectDir, {
      scope: 'project',
      references: getCleoReferences(),
    });
  }
}
