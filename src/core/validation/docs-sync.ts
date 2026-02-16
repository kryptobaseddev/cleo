/**
 * Documentation drift detection - ported from lib/validation/docs-sync.sh
 *
 * Detects drift between scripts/, COMMANDS-INDEX.json, wrapper templates,
 * and README documentation. Helps keep documentation in sync with code.
 *
 * @task T4527
 * @epic T4454
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface DriftIssue {
  type: 'missing_from_index' | 'orphaned_index' | 'missing_from_wrapper' | 'missing_from_readme';
  severity: 'error' | 'warning';
  item: string;
  message: string;
}

export interface DriftReport {
  mode: 'quick' | 'full';
  issues: DriftIssue[];
  exitCode: 0 | 1 | 2;
}

export interface CommandIndexEntry {
  name: string;
  script?: string;
  aliasFor?: string | null;
  note?: string | null;
}

export interface CommandIndex {
  commands: CommandIndexEntry[];
}

// ============================================================================
// Script Discovery
// ============================================================================

/**
 * Get command names from scripts directory.
 * Returns sorted list of script basenames without .sh extension.
 * @task T4527
 */
export function getScriptCommands(scriptsDir: string): string[] {
  if (!existsSync(scriptsDir)) return [];

  try {
    return readdirSync(scriptsDir)
      .filter(f => f.endsWith('.sh'))
      .map(f => f.replace(/\.sh$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Get script names from COMMANDS-INDEX.json.
 * @task T4527
 */
export function getIndexScripts(indexPath: string): string[] {
  if (!existsSync(indexPath)) return [];

  try {
    const content = readFileSync(indexPath, 'utf-8');
    const index: CommandIndex = JSON.parse(content);
    return index.commands
      .map(cmd => cmd.script ?? '')
      .filter(s => s)
      .map(s => s.replace(/\.sh$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Get command names from COMMANDS-INDEX.json.
 * @task T4527
 */
export function getIndexCommands(indexPath: string): string[] {
  if (!existsSync(indexPath)) return [];

  try {
    const content = readFileSync(indexPath, 'utf-8');
    const index: CommandIndex = JSON.parse(content);
    return index.commands.map(cmd => cmd.name).sort();
  } catch {
    return [];
  }
}

// ============================================================================
// Sync Checking
// ============================================================================

/**
 * Check commands index vs scripts directory for sync.
 * @task T4527
 */
export function checkCommandsSync(
  scriptsDir: string,
  indexPath: string,
): DriftIssue[] {
  const issues: DriftIssue[] = [];

  const scriptCmds = new Set(getScriptCommands(scriptsDir));
  const indexScripts = new Set(getIndexScripts(indexPath));

  // Scripts not in index
  for (const cmd of scriptCmds) {
    if (!indexScripts.has(cmd)) {
      issues.push({
        type: 'missing_from_index',
        severity: 'error',
        item: `${cmd}.sh`,
        message: `Script '${cmd}.sh' not in COMMANDS-INDEX.json`,
      });
    }
  }

  // Index entries without scripts
  for (const cmd of indexScripts) {
    if (!scriptCmds.has(cmd)) {
      issues.push({
        type: 'orphaned_index',
        severity: 'error',
        item: `${cmd}.sh`,
        message: `Index entry '${cmd}.sh' has no corresponding script`,
      });
    }
  }

  return issues;
}

/**
 * Check wrapper template sync with COMMANDS-INDEX.
 * @task T4527
 */
export function checkWrapperSync(
  wrapperPath: string,
  indexPath: string,
): DriftIssue[] {
  if (!existsSync(wrapperPath) || !existsSync(indexPath)) return [];

  const issues: DriftIssue[] = [];

  try {
    const wrapperContent = readFileSync(wrapperPath, 'utf-8');
    const indexContent = readFileSync(indexPath, 'utf-8');
    const index: CommandIndex = JSON.parse(indexContent);

    // Extract commands from wrapper _get_all_commands() function
    const match = wrapperContent.match(/_get_all_commands\(\)\s*\{[^}]*echo\s+"([^"]+)"/);
    const wrapperCmds = new Set(
      match ? match[1].split(/\s+/).filter(Boolean) : [],
    );

    // Get non-alias, non-dev-tool commands from index
    const devToolPattern = /Usually called via|Internal development|dev tool/i;
    const indexCmds = index.commands
      .filter(cmd => !cmd.aliasFor && (!cmd.note || !devToolPattern.test(cmd.note)))
      .map(cmd => cmd.name);

    // Find commands in index but not in wrapper
    for (const cmd of indexCmds) {
      if (!wrapperCmds.has(cmd)) {
        issues.push({
          type: 'missing_from_wrapper',
          severity: 'warning',
          item: cmd,
          message: `Command '${cmd}' in index but not in wrapper template`,
        });
      }
    }
  } catch {
    // Parse errors are non-fatal
  }

  return issues;
}

// ============================================================================
// Full Drift Detection
// ============================================================================

const CRITICAL_COMMANDS = [
  'list', 'add', 'complete', 'find', 'show', 'analyze', 'session', 'focus', 'dash',
];

/**
 * Run full drift detection across scripts, index, wrapper, and README.
 * @task T4527
 */
export function detectDrift(
  mode: 'quick' | 'full' = 'full',
  projectRoot: string = '.',
): DriftReport {
  const issues: DriftIssue[] = [];

  // Check commands sync (always)
  const scriptsDir = join(projectRoot, 'scripts');
  const indexPath = join(projectRoot, 'docs/commands/COMMANDS-INDEX.json');
  issues.push(...checkCommandsSync(scriptsDir, indexPath));

  // Check wrapper sync (always)
  const wrapperPath = join(projectRoot, 'installer/lib/link.sh');
  issues.push(...checkWrapperSync(wrapperPath, indexPath));

  // Full mode: check README coverage
  if (mode === 'full') {
    const readmePath = join(projectRoot, 'README.md');
    if (existsSync(readmePath)) {
      try {
        const readme = readFileSync(readmePath, 'utf-8');
        const readmeCmds = new Set(
          (readme.match(/cleo [a-z-]+/g) ?? []).map(m => m.replace('cleo ', '')),
        );

        for (const cmd of CRITICAL_COMMANDS) {
          if (!readmeCmds.has(cmd)) {
            issues.push({
              type: 'missing_from_readme',
              severity: 'warning',
              item: cmd,
              message: `Critical command '${cmd}' missing from README`,
            });
          }
        }
      } catch {
        // README parse errors are non-fatal
      }
    }
  }

  // Determine exit code
  const hasErrors = issues.some(i => i.severity === 'error');
  const hasWarnings = issues.some(i => i.severity === 'warning');
  const exitCode: 0 | 1 | 2 = hasErrors ? 2 : hasWarnings ? 1 : 0;

  return { mode, issues, exitCode };
}

/**
 * Check if drift detection should run automatically based on config.
 * @task T4527
 */
export function shouldRunDriftDetection(
  enabled: boolean = true,
  autoCheck: boolean = false,
  command?: string,
  criticalCommands: string[] = [],
): boolean {
  if (!enabled) return false;
  if (!autoCheck) return false;
  if (!command) return true;
  if (criticalCommands.length === 0) return true;
  return criticalCommands.includes(command);
}
