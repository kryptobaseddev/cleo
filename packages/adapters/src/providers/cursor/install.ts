/**
 * Cursor Install Provider
 *
 * Handles CLEO installation into Cursor environments:
 * - Ensures .cursorrules has CLEO @-references (legacy format)
 * - Creates .cursor/rules/cleo.mdc with CLEO references (modern format)
 *
 * Cursor supports two instruction file formats:
 * 1. Legacy: .cursorrules (flat file, project root)
 * 2. Modern: .cursor/rules/*.mdc (MDC format, per-rule files)
 *
 * This provider writes to both for maximum compatibility.
 *
 * @task T5240
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';

/** Lines that should appear in instruction files to reference CLEO. */
const INSTRUCTION_REFERENCES = ['@~/.cleo/templates/CLEO-INJECTION.md', '@.cleo/memory-bridge.md'];

/**
 * Install provider for Cursor.
 *
 * Manages CLEO's integration with Cursor by:
 * 1. Creating/updating .cursorrules with @-references (legacy)
 * 2. Creating .cursor/rules/cleo.mdc with @-references (modern)
 */
export class CursorInstallProvider implements AdapterInstallProvider {
  /**
   * Install CLEO into a Cursor project.
   *
   * @param options - Installation options including project directory
   * @returns Result describing what was installed
   */
  async install(options: InstallOptions): Promise<InstallResult> {
    const { projectDir } = options;
    const installedAt = new Date().toISOString();
    let instructionFileUpdated = false;
    const details: Record<string, unknown> = {};

    // Step 1: Ensure instruction files have @-references
    instructionFileUpdated = this.updateInstructionFiles(projectDir);
    if (instructionFileUpdated) {
      details.instructionFiles = this.getUpdatedFileList(projectDir);
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
   * Uninstall CLEO from the current Cursor project.
   *
   * Does not remove instruction file references (they are harmless if CLEO is not present).
   */
  async uninstall(): Promise<void> {}

  /**
   * Check whether CLEO is installed in the current environment.
   *
   * Checks for .cursor/rules/cleo.mdc or .cursorrules with CLEO references.
   */
  async isInstalled(): Promise<boolean> {
    const mdcPath = join(process.cwd(), '.cursor', 'rules', 'cleo.mdc');
    if (existsSync(mdcPath)) {
      return true;
    }

    const rulesPath = join(process.cwd(), '.cursorrules');
    if (existsSync(rulesPath)) {
      try {
        const content = readFileSync(rulesPath, 'utf-8');
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
   * Ensure instruction files contain @-references to CLEO.
   *
   * Updates .cursorrules (legacy) and creates .cursor/rules/cleo.mdc (modern).
   *
   * @param projectDir - Project root directory
   */
  async ensureInstructionReferences(projectDir: string): Promise<void> {
    this.updateInstructionFiles(projectDir);
  }

  /**
   * Update instruction files with CLEO @-references.
   *
   * Handles both legacy (.cursorrules) and modern (.cursor/rules/cleo.mdc) formats.
   *
   * @returns true if any file was created or modified
   */
  private updateInstructionFiles(projectDir: string): boolean {
    let updated = false;

    // Update legacy .cursorrules if it exists
    if (this.updateLegacyRules(projectDir)) {
      updated = true;
    }

    // Create/update modern .cursor/rules/cleo.mdc
    if (this.updateModernRules(projectDir)) {
      updated = true;
    }

    return updated;
  }

  /**
   * Update legacy .cursorrules file with @-references.
   * Only modifies the file if it already exists (does not create it).
   *
   * @returns true if the file was modified
   */
  private updateLegacyRules(projectDir: string): boolean {
    const rulesPath = join(projectDir, '.cursorrules');
    if (!existsSync(rulesPath)) {
      return false;
    }

    let content = readFileSync(rulesPath, 'utf-8');
    const missingRefs = INSTRUCTION_REFERENCES.filter((ref) => !content.includes(ref));

    if (missingRefs.length === 0) {
      return false;
    }

    const separator = content.endsWith('\n') ? '' : '\n';
    content = content + separator + missingRefs.join('\n') + '\n';
    writeFileSync(rulesPath, content, 'utf-8');
    return true;
  }

  /**
   * Create or update .cursor/rules/cleo.mdc with CLEO references.
   *
   * MDC (Markdown Component) format is Cursor's modern rule file format.
   * Each .mdc file in .cursor/rules/ is loaded as a rule set.
   *
   * @returns true if the file was created or modified
   */
  private updateModernRules(projectDir: string): boolean {
    const rulesDir = join(projectDir, '.cursor', 'rules');
    const mdcPath = join(rulesDir, 'cleo.mdc');

    const expectedContent = [
      '---',
      'description: CLEO task management protocol references',
      'globs: "**/*"',
      'alwaysApply: true',
      '---',
      '',
      ...INSTRUCTION_REFERENCES,
      '',
    ].join('\n');

    if (existsSync(mdcPath)) {
      const existing = readFileSync(mdcPath, 'utf-8');
      if (existing === expectedContent) {
        return false;
      }
    }

    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(mdcPath, expectedContent, 'utf-8');
    return true;
  }

  /**
   * Get list of instruction files that were updated.
   */
  private getUpdatedFileList(projectDir: string): string[] {
    const files: string[] = [];
    if (existsSync(join(projectDir, '.cursorrules'))) {
      files.push(join(projectDir, '.cursorrules'));
    }
    files.push(join(projectDir, '.cursor', 'rules', 'cleo.mdc'));
    return files;
  }
}
