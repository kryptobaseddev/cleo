/**
 * Cursor Install Provider
 *
 * Handles CLEO installation into Cursor environments:
 * - Ensures .cursorrules has CLEO @-references (legacy format)
 * - Creates .cursor/rules/cleo.mdc with CLEO references (modern format)
 * - Installs PreCompact hook shell shims + wires them into .cursor/hooks.json (T1013)
 *
 * Cursor supports two instruction file formats:
 * 1. Legacy: .cursorrules (flat file, project root)
 * 2. Modern: .cursor/rules/*.mdc (MDC format, per-rule files)
 *
 * This provider writes to both for maximum compatibility.
 *
 * @task T5240
 * @task T1013
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';
import {
  type InstallHookTemplatesResult,
  installProviderHookTemplates,
} from '../shared/hook-template-installer.js';
import { getCleoTemplatesTildePath } from '../shared/paths.js';

/**
 * Lines that should appear in instruction files to reference CLEO.
 * The CLEO-INJECTION.md path is resolved dynamically to support non-default
 * XDG / OS installation locations (T916).
 */
const INSTRUCTION_REFERENCES = [
  `@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`,
  '@.cleo/memory-bridge.md',
];

/**
 * Install provider for Cursor.
 *
 * Manages CLEO's integration with Cursor by:
 * 1. Creating/updating .cursorrules with @-references (legacy)
 * 2. Creating .cursor/rules/cleo.mdc with @-references (modern)
 * 3. Installing the PreCompact hook shim + registering it in .cursor/hooks.json (T1013)
 *
 * @remarks
 * Installation is idempotent and writes to both instruction file formats
 * for maximum compatibility. The legacy `.cursorrules` file is only modified
 * if it already exists (never created from scratch). The modern MDC file
 * is always created or updated to ensure Cursor's rule engine picks it up.
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

    // Step 2 (T1013): Install PreCompact hook templates + wire the handler
    // command into .cursor/hooks.json's `preCompact` event.
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

  /**
   * Install the CLEO PreCompact hook templates for Cursor (T1013).
   *
   * Writes two files to `<projectDir>/.cursor/hooks/`:
   * 1. `cleo-precompact-core.sh` — universal CLEO safestop helper.
   * 2. `precompact.sh` — Cursor-flavoured wrapper.
   *
   * Also registers a `preCompact` entry in `.cursor/hooks.json`. The native
   * event name `preCompact` comes from CAAMP's `hook-mappings.json` SSoT.
   *
   * Idempotent: re-running install skips unchanged files and avoids
   * duplicating the hooks.json entry.
   *
   * @param projectDir - Project root directory.
   * @returns Install summary, or `null` when no change was required.
   *
   * @task T1013
   */
  private installHookTemplates(projectDir: string): {
    templates: InstallHookTemplatesResult;
    hooksJsonEntryAdded: boolean;
  } | null {
    const hooksDir = join(projectDir, '.cursor', 'hooks');

    // Template copy is best-effort so missing/locked filesystems (CI sandboxes,
    // mocked `node:fs` in unit tests) don't fail the whole install.
    let templates: InstallHookTemplatesResult;
    try {
      templates = installProviderHookTemplates({
        provider: 'cursor',
        targetDir: hooksDir,
      });
    } catch {
      return null;
    }

    const hooksJsonEntryAdded = this.registerPreCompactHook(
      projectDir,
      join(hooksDir, 'precompact.sh'),
    );

    if (templates.installedFiles.length === 0 && !hooksJsonEntryAdded) {
      return null;
    }

    return { templates, hooksJsonEntryAdded };
  }

  /**
   * Register the PreCompact hook command in `.cursor/hooks.json`.
   *
   * Cursor's native event name for the canonical `PreCompact` is `preCompact`
   * (camelCase — see CAAMP `hook-mappings.json`). Entries are tagged with a
   * `# cleo-hook` comment so they can be cleanly removed on uninstall.
   *
   * @param projectDir - Project root directory.
   * @param shimPath - Absolute path to the installed `precompact.sh`.
   * @returns `true` when a new entry was written, `false` when already wired.
   *
   * @task T1013
   */
  private registerPreCompactHook(projectDir: string, shimPath: string): boolean {
    const hooksJsonPath = join(projectDir, '.cursor', 'hooks.json');

    let config: Record<string, unknown> = {};
    if (existsSync(hooksJsonPath)) {
      try {
        config = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
      } catch {
        // Start fresh on corrupt config.
      }
    }

    const hooks = (config.hooks as Record<string, unknown[]> | undefined) ?? {};
    const entries = (hooks.preCompact as unknown[] | undefined) ?? [];

    const alreadyWired = entries.some(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).command === 'string' &&
        ((entry as Record<string, unknown>).command as string).includes('# cleo-hook') &&
        ((entry as Record<string, unknown>).command as string).includes('precompact.sh'),
    );

    if (alreadyWired) {
      return false;
    }

    entries.push({
      type: 'command',
      command: `"${shimPath}" # cleo-hook`,
      timeout: 30,
    });

    hooks.preCompact = entries;
    config.hooks = hooks;

    mkdirSync(join(projectDir, '.cursor'), { recursive: true });
    writeFileSync(hooksJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return true;
  }
}
