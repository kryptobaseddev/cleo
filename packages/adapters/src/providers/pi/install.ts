/**
 * Pi Install Provider
 *
 * Handles CLEO installation into Pi coding agent environments:
 * - Ensures AGENTS.md has CLEO @-references (project and global scope)
 * - Manages Pi settings.json to register CLEO extension path
 *
 * Pi uses AGENTS.md (not CLAUDE.md) as its instruction file. The global
 * instruction file lives at `~/.pi/agent/AGENTS.md`; the project-level
 * file lives at `<projectDir>/AGENTS.md`.
 *
 * Detection: Pi is detected by the `PI_CODING_AGENT_DIR` or `PI_HOME`
 * environment variables, or by presence of `~/.pi/agent/` directory.
 *
 * @task T553
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';

/** Lines that should appear in AGENTS.md to reference CLEO. */
const INSTRUCTION_REFERENCES = ['@~/.cleo/templates/CLEO-INJECTION.md', '@.cleo/memory-bridge.md'];

/**
 * Resolve the Pi global state root directory.
 *
 * Honours `PI_CODING_AGENT_DIR` env var when set (with `~` expansion),
 * then `PI_HOME`, then falls back to `~/.pi/agent`.
 */
function getPiAgentDir(): string {
  const env = process.env['PI_CODING_AGENT_DIR'];
  if (env !== undefined && env.length > 0) {
    if (env === '~') return homedir();
    if (env.startsWith('~/')) return join(homedir(), env.slice(2));
    return env;
  }
  const piHome = process.env['PI_HOME'];
  if (piHome !== undefined && piHome.length > 0) {
    return join(piHome, 'agent');
  }
  return join(homedir(), '.pi', 'agent');
}

/**
 * Install provider for Pi coding agent.
 *
 * Manages CLEO's integration with Pi by:
 * 1. Ensuring project AGENTS.md contains @-references to CLEO instruction files
 * 2. Ensuring global AGENTS.md (~/.pi/agent/AGENTS.md) contains @-references
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

    // Step 1: Ensure project AGENTS.md has @-references
    const projectUpdated = this.updateInstructionFile(projectDir, 'AGENTS.md');
    if (projectUpdated) {
      details.instructionFile = join(projectDir, 'AGENTS.md');
    }

    // Step 2: Ensure global AGENTS.md has @-references (best-effort)
    let globalUpdated = false;
    try {
      const globalDir = getPiAgentDir();
      globalUpdated = this.updateInstructionFile(globalDir, 'AGENTS.md');
      if (globalUpdated) {
        details.globalInstructionFile = join(globalDir, 'AGENTS.md');
      }
    } catch {
      // Global install is best-effort — never block project install
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
   * Checks for CLEO references in the project AGENTS.md.
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

    // Also check global AGENTS.md
    try {
      const globalPath = join(getPiAgentDir(), 'AGENTS.md');
      if (existsSync(globalPath)) {
        const content = readFileSync(globalPath, 'utf-8');
        if (INSTRUCTION_REFERENCES.some((ref) => content.includes(ref))) {
          return true;
        }
      }
    } catch {
      // Fall through
    }

    return false;
  }

  /**
   * Ensure AGENTS.md contains @-references to CLEO instruction files.
   *
   * Creates AGENTS.md if it does not exist. Appends any missing references.
   *
   * @param projectDir - Project root directory
   */
  async ensureInstructionReferences(projectDir: string): Promise<void> {
    this.updateInstructionFile(projectDir, 'AGENTS.md');
  }

  /**
   * Update an instruction file with CLEO @-references.
   *
   * @param dir - Directory containing the instruction file
   * @param filename - Name of the instruction file (e.g. "AGENTS.md")
   * @returns true if the file was created or modified
   */
  private updateInstructionFile(dir: string, filename: string): boolean {
    const filePath = join(dir, filename);
    let content = '';
    let existed = false;

    if (existsSync(filePath)) {
      content = readFileSync(filePath, 'utf-8');
      existed = true;
    }

    const missingRefs = INSTRUCTION_REFERENCES.filter((ref) => !content.includes(ref));

    if (missingRefs.length === 0) {
      return false;
    }

    const refsBlock = missingRefs.join('\n');

    if (existed) {
      // Append missing references
      const separator = content.endsWith('\n') ? '' : '\n';
      content = content + separator + refsBlock + '\n';
    } else {
      // Create new file with references — ensure parent dir exists
      mkdirSync(dir, { recursive: true });
      content = refsBlock + '\n';
    }

    writeFileSync(filePath, content, 'utf-8');
    return true;
  }
}
