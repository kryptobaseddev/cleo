/**
 * Project version checking and warning system.
 * Ported from lib/ui/version-check.sh
 *
 * Fast checks that run on every command to warn about outdated projects.
 * Compares schema versions, CLAUDE.md injection versions, and detects
 * legacy structure indicators.
 *
 * @task T4552
 * @epic T4545
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoHome } from '../paths.js';
import { readJson } from '../../store/json.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Commands that handle their own version checks (skip warnings). */
const VERSION_CHECK_SKIP_COMMANDS = new Set([
  'upgrade', 'migrate', 'init', 'validate', 'help', 'version',
  '--help', '-h', '--version', '-v',
]);

/** Version check result. */
export interface VersionCheckResult {
  needsUpdate: boolean;
  warnings: string[];
}

/**
 * Check if a project needs updates.
 * Returns warnings for outdated schemas, injections, or legacy structures.
 * @task T4552
 */
export async function checkProjectNeedsUpdate(
  projectDir: string = '.',
  accessor?: DataAccessor,
): Promise<VersionCheckResult> {
  const warnings: string[] = [];
  const todoFile = join(projectDir, '.cleo', 'todo.json');
  const claudeMd = join(projectDir, 'CLAUDE.md');

  // Not a cleo project
  if (!existsSync(todoFile)) {
    return { needsUpdate: false, warnings: [] };
  }

  // Check schema version
  const todoData = accessor
    ? (await accessor.loadTodoFile()) as unknown as Record<string, unknown>
    : await readJson<Record<string, unknown>>(todoFile);
  if (todoData) {
    const meta = todoData._meta as Record<string, unknown> | undefined;
    const currentVersion = meta?.schemaVersion as string | undefined;

    if (!currentVersion) {
      warnings.push('Missing ._meta.schemaVersion. Run: cleo upgrade');
    } else {
      // Check for legacy structure indicators
      const hasTopLevelPhases = 'phases' in todoData;
      const projectField = todoData.project;
      const projectIsString = typeof projectField === 'string';

      if (hasTopLevelPhases || projectIsString) {
        warnings.push('Schema has legacy structure. Run: cleo upgrade');
      } else {
        // Get expected version from schema file
        const schemaDir = process.env['SCHEMA_DIR'] ?? join(getCleoHome(), 'schemas');
        const schemaPath = join(schemaDir, 'todo.schema.json');

        if (existsSync(schemaPath)) {
          try {
            const schemaContent = readFileSync(schemaPath, 'utf-8');
            const schema = JSON.parse(schemaContent) as Record<string, unknown>;
            const expectedVersion = schema.schemaVersion as string | undefined;

            if (expectedVersion && currentVersion !== expectedVersion) {
              warnings.push(
                `Schema outdated (${currentVersion} → ${expectedVersion}). Run: cleo upgrade`,
              );
            }
          } catch {
            // Schema read failure is non-fatal
          }
        }
      }
    }
  }

  // Check CLAUDE.md injection version
  if (existsSync(claudeMd)) {
    try {
      const claudeContent = readFileSync(claudeMd, 'utf-8');
      const versionMatch = claudeContent.match(/CLEO:START v(\d+\.\d+\.\d+)/);
      const injectionVersion = versionMatch?.[1];

      if (injectionVersion) {
        const versionFilePath = join(getCleoHome(), 'VERSION');
        if (existsSync(versionFilePath)) {
          const installedVersion = readFileSync(versionFilePath, 'utf-8').trim();
          if (injectionVersion !== installedVersion) {
            warnings.push(
              `CLAUDE.md outdated (${injectionVersion} → ${installedVersion}). Run: cleo upgrade`,
            );
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return {
    needsUpdate: warnings.length > 0,
    warnings,
  };
}

/**
 * Show version warnings if applicable (call before command execution).
 * Respects skip commands and CLEO_SKIP_VERSION_CHECK env var.
 * Outputs warnings to stderr so they don't interfere with JSON output.
 * @task T4552
 */
export async function showVersionWarnings(
  command?: string,
): Promise<string[]> {
  // Skip for commands that handle their own checks
  if (command && VERSION_CHECK_SKIP_COMMANDS.has(command)) {
    return [];
  }

  // Skip if env var is set
  if (process.env['CLEO_SKIP_VERSION_CHECK']) {
    return [];
  }

  const result = await checkProjectNeedsUpdate('.');

  // Output warnings to stderr
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      process.stderr.write(`[WARN] ${warning}\n`);
    }
  }

  return result.warnings;
}
