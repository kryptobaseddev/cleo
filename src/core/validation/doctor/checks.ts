/**
 * Doctor health checks - ported from lib/validation/doctor-checks.sh
 *
 * Global health check functions: CLI installation, version, docs accessibility,
 * agent configs, registered projects, injection files, and aliases.
 *
 * @task T4525
 * @epic T4454
 */

import { existsSync, readFileSync, accessSync, constants, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getNodeVersionInfo, getNodeUpgradeInstructions, MINIMUM_NODE_MAJOR } from '../../platform.js';
import { detectLegacyAgentOutputs } from '../../migration/agent-outputs.js';

// ============================================================================
// Types
// ============================================================================

export type CheckStatus = 'passed' | 'failed' | 'warning' | 'info';

export interface CheckResult {
  id: string;
  category: string;
  status: CheckStatus;
  message: string;
  details: Record<string, unknown>;
  fix: string | null;
}

// ============================================================================
// Check 1: CLI Installation
// ============================================================================

/** @task T4525 */
export function checkCliInstallation(
  cleoHome: string = join(homedir(), '.cleo'),
): CheckResult {
  const exists = existsSync(cleoHome);
  return {
    id: 'cli_installation',
    category: 'installation',
    status: exists ? 'passed' : 'failed',
    message: exists
      ? `CLEO installation found at ${cleoHome}`
      : `CLEO installation not found at ${cleoHome}`,
    details: { path: cleoHome, exists },
    fix: exists ? null : 'Run install.sh to install CLEO globally',
  };
}

// ============================================================================
// Check 2: CLI Version
// ============================================================================

/** Matches X.Y.Z (semver) and YYYY.M.patch (CalVer). */
const VERSION_REGEX = /^\d+\.\d+\.\d+$/;

/** @task T4525 */
export function checkCliVersion(
  cleoHome: string = join(homedir(), '.cleo'),
): CheckResult {
  const versionFile = join(cleoHome, 'VERSION');

  if (!existsSync(versionFile)) {
    return {
      id: 'cli_version',
      category: 'installation',
      status: 'failed',
      message: 'VERSION file not found',
      details: { path: versionFile, exists: false },
      fix: 'Run install.sh to reinstall CLEO',
    };
  }

  const version = readFileSync(versionFile, 'utf-8').trim().split('\n')[0].trim();
  const valid = VERSION_REGEX.test(version);

  return {
    id: 'cli_version',
    category: 'installation',
    status: valid ? 'passed' : 'failed',
    message: valid ? `Valid CLI version: ${version}` : `Invalid VERSION format: '${version}'`,
    details: { version, valid, ...(valid ? {} : { expected: 'X.Y.Z or YYYY.M.patch (CalVer)' }) },
    fix: valid ? null : 'Run install.sh to reinstall CLEO',
  };
}

// ============================================================================
// Check 3: Docs Accessibility
// ============================================================================

/** @task T4525 */
export function checkDocsAccessibility(
  cleoHome: string = join(homedir(), '.cleo'),
): CheckResult {
  const docsFile = join(cleoHome, 'templates', 'CLEO-INJECTION.md');

  if (!existsSync(docsFile)) {
    return {
      id: 'docs_accessibility',
      category: 'installation',
      status: 'failed',
      message: 'Task management documentation not found',
      details: { path: docsFile, exists: false },
      fix: 'Run install.sh to reinstall CLEO documentation',
    };
  }

  try {
    accessSync(docsFile, constants.R_OK);
  } catch {
    return {
      id: 'docs_accessibility',
      category: 'installation',
      status: 'failed',
      message: 'Task management documentation not readable',
      details: { path: docsFile, readable: false },
      fix: `chmod +r ${docsFile}`,
    };
  }

  const size = statSync(docsFile).size;
  return {
    id: 'docs_accessibility',
    category: 'installation',
    status: 'passed',
    message: 'Task management documentation accessible',
    details: { path: docsFile, readable: true, size },
    fix: null,
  };
}

// ============================================================================
// Check 7: @ Reference Resolution
// ============================================================================

/** @task T4525 */
export function checkAtReferenceResolution(
  cleoHome: string = join(homedir(), '.cleo'),
): CheckResult {
  const docsFile = join(cleoHome, 'templates', 'CLEO-INJECTION.md');
  const reference = '@~/.cleo/templates/CLEO-INJECTION.md';

  if (!existsSync(docsFile)) {
    return {
      id: 'at_reference_resolution',
      category: 'configuration',
      status: 'failed',
      message: '@ reference target does not exist',
      details: { reference, path: docsFile, exists: false },
      fix: 'Run install.sh to reinstall CLEO documentation',
    };
  }

  try {
    accessSync(docsFile, constants.R_OK);
    const content = readFileSync(docsFile, 'utf-8');
    const firstLine = content.split('\n')[0] ?? '';

    if (!firstLine) {
      return {
        id: 'at_reference_resolution',
        category: 'configuration',
        status: 'warning',
        message: '@ reference target is empty',
        details: { reference, path: docsFile, empty: true },
        fix: 'Run install.sh to reinstall CLEO documentation',
      };
    }

    const size = statSync(docsFile).size;
    return {
      id: 'at_reference_resolution',
      category: 'configuration',
      status: 'passed',
      message: '@ reference resolution successful',
      details: { reference, path: docsFile, readable: true, size },
      fix: null,
    };
  } catch {
    return {
      id: 'at_reference_resolution',
      category: 'configuration',
      status: 'failed',
      message: '@ reference target not readable',
      details: { reference, path: docsFile, readable: false },
      fix: `chmod +r ${docsFile}`,
    };
  }
}

// ============================================================================
// Check: Root .gitignore blocking .cleo/
// ============================================================================

/**
 * Check if project root .gitignore is blocking the entire .cleo/ directory.
 * This prevents core CLEO data from being tracked by git.
 * @task T4641
 * @epic T4637
 */
export function checkRootGitignore(
  projectRoot?: string,
): CheckResult {
  const root = projectRoot ?? process.cwd();
  const gitignorePath = join(root, '.gitignore');

  if (!existsSync(gitignorePath)) {
    return {
      id: 'root_gitignore',
      category: 'configuration',
      status: 'passed',
      message: 'No root .gitignore found (no conflict)',
      details: { path: gitignorePath, exists: false },
      fix: null,
    };
  }

  let content: string;
  try {
    content = readFileSync(gitignorePath, 'utf-8');
  } catch {
    return {
      id: 'root_gitignore',
      category: 'configuration',
      status: 'warning',
      message: 'Could not read root .gitignore',
      details: { path: gitignorePath, readable: false },
      fix: null,
    };
  }

  const lines = content.split('\n');
  const blockingLines = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') return false;
    return /^\/?\.cleo\/?(\*)?$/.test(trimmed);
  });

  if (blockingLines.length > 0) {
    return {
      id: 'root_gitignore',
      category: 'configuration',
      status: 'warning',
      message: `.cleo/ is ignored in root .gitignore. Run 'cleo init' to fix.`,
      details: { path: gitignorePath, blockingLines },
      fix: `cleo init`,
    };
  }

  return {
    id: 'root_gitignore',
    category: 'configuration',
    status: 'passed',
    message: 'Root .gitignore does not block .cleo/',
    details: { path: gitignorePath },
    fix: null,
  };
}

// ============================================================================
// Check: .cleo/.gitignore integrity
// ============================================================================

/**
 * Check if .cleo/.gitignore exists and matches the template.
 * @task T4700
 */
export function checkCleoGitignore(
  projectRoot?: string,
): CheckResult {
  const root = projectRoot ?? process.cwd();
  const gitignorePath = join(root, '.cleo', '.gitignore');

  if (!existsSync(gitignorePath)) {
    return {
      id: 'cleo_gitignore',
      category: 'configuration',
      status: 'warning',
      message: '.cleo/.gitignore not found',
      details: { path: gitignorePath, exists: false },
      fix: 'cleo init --force',
    };
  }

  // Load installed content
  let installedContent: string;
  try {
    installedContent = readFileSync(gitignorePath, 'utf-8');
  } catch {
    return {
      id: 'cleo_gitignore',
      category: 'configuration',
      status: 'warning',
      message: '.cleo/.gitignore exists but is not readable',
      details: { path: gitignorePath, readable: false },
      fix: `chmod +r ${gitignorePath}`,
    };
  }

  // Load template
  let templateContent: string | null = null;
  try {
    const { getGitignoreTemplate } = require('../../cli/commands/init.js') as { getGitignoreTemplate: () => string };
    templateContent = getGitignoreTemplate();
  } catch {
    // If we can't load the template, try the file directly
    try {
      const templatePaths = [
        join(root, 'templates', 'cleo-gitignore'),
        join(homedir(), '.cleo', 'templates', 'cleo-gitignore'),
      ];
      for (const tp of templatePaths) {
        if (existsSync(tp)) {
          templateContent = readFileSync(tp, 'utf-8');
          break;
        }
      }
    } catch {
      // Can't load template
    }
  }

  if (!templateContent) {
    return {
      id: 'cleo_gitignore',
      category: 'configuration',
      status: 'passed',
      message: '.cleo/.gitignore exists (cannot verify against template)',
      details: { path: gitignorePath, exists: true, templateAvailable: false },
      fix: null,
    };
  }

  // Compare
  const normalizeContent = (s: string) => s.trim().replace(/\r\n/g, '\n');
  const isMatch = normalizeContent(installedContent) === normalizeContent(templateContent);

  return {
    id: 'cleo_gitignore',
    category: 'configuration',
    status: isMatch ? 'passed' : 'warning',
    message: isMatch
      ? '.cleo/.gitignore matches template'
      : '.cleo/.gitignore has drifted from template',
    details: {
      path: gitignorePath,
      matchesTemplate: isMatch,
      ...(!isMatch ? { fix: 'cleo upgrade' } : {}),
    },
    fix: isMatch ? null : 'cleo upgrade',
  };
}

// ============================================================================
// Check: Vital files tracked by git
// ============================================================================

/**
 * Detect the storage engine from project config.
 * Per ADR-006, always returns 'sqlite'.
 */
function detectStorageEngine(_projectRoot: string): string {
  return 'sqlite';
}

/**
 * Check that vital CLEO files are tracked by git.
 * Engine-aware: checks the right data files based on storage.engine config.
 * @task T4700
 */
export function checkVitalFilesTracked(
  projectRoot?: string,
): CheckResult {
  const root = projectRoot ?? process.cwd();
  const gitDir = join(root, '.git');

  if (!existsSync(gitDir)) {
    return {
      id: 'vital_files_tracked',
      category: 'configuration',
      status: 'info',
      message: 'Not a git repository (skipping vital file tracking check)',
      details: { gitDir, isGitRepo: false },
      fix: null,
    };
  }

  // Build vital file list based on storage engine
  const engine = detectStorageEngine(root);
  const vitalFiles: string[] = [
    '.cleo/config.json',
    '.cleo/.gitignore',
  ];

  // SQLite is the only engine per ADR-006
  vitalFiles.push('.cleo/tasks.db');

  const untracked: string[] = [];

  for (const file of vitalFiles) {
    const fullPath = join(root, file);
    if (!existsSync(fullPath)) continue; // file doesn't exist, that's fine

    try {
      execFileSync('git', ['ls-files', '--error-unmatch', file], {
        cwd: root,
        stdio: 'pipe',
      });
    } catch {
      untracked.push(file);
    }
  }

  if (untracked.length > 0) {
    return {
      id: 'vital_files_tracked',
      category: 'configuration',
      status: 'warning',
      message: `${untracked.length} vital file(s) not tracked by git: ${untracked.join(', ')}`,
      details: { engine, untracked },
      fix: `git add ${untracked.join(' ')}`,
    };
  }

  return {
    id: 'vital_files_tracked',
    category: 'configuration',
    status: 'passed',
    message: `All vital CLEO files are tracked by git (engine: ${engine})`,
    details: { engine, checkedFiles: vitalFiles },
    fix: null,
  };
}

// ============================================================================
// Check: Legacy agent-outputs path
// ============================================================================

/**
 * Check if any legacy output directories still exist.
 * Delegates detection to the migration/agent-outputs utility.
 * @task T4700
 */
export function checkLegacyAgentOutputs(
  projectRoot?: string,
): CheckResult {
  const root = projectRoot ?? process.cwd();
  const cleoDir = join(root, '.cleo');
  const detection = detectLegacyAgentOutputs(root, cleoDir);

  if (detection.hasLegacy) {
    return {
      id: 'legacy_agent_outputs',
      category: 'configuration',
      status: 'warning',
      message: `Legacy output directory found: ${detection.legacyPaths.join(', ')}`,
      details: { paths: detection.legacyPaths, exists: true },
      fix: 'cleo upgrade',
    };
  }

  return {
    id: 'legacy_agent_outputs',
    category: 'configuration',
    status: 'passed',
    message: 'No legacy output directories found',
    details: { exists: false },
    fix: null,
  };
}

// ============================================================================
// Check: Node.js Version
// ============================================================================

/**
 * Check that Node.js meets the minimum required version.
 * Provides OS-specific upgrade instructions when below minimum.
 */
export function checkNodeVersion(): CheckResult {
  const nodeInfo = getNodeVersionInfo();
  const { version, major, minor, patch, meetsMinimum } = nodeInfo;

  if (meetsMinimum) {
    return {
      id: 'node_version',
      category: 'runtime',
      status: 'passed',
      message: `Node.js v${version} meets minimum requirement (v${MINIMUM_NODE_MAJOR}+)`,
      details: { version, major, minor, patch, minimum: MINIMUM_NODE_MAJOR },
      fix: null,
    };
  }

  const upgrade = getNodeUpgradeInstructions();

  return {
    id: 'node_version',
    category: 'runtime',
    status: 'failed',
    message: `Node.js v${version} is below minimum v${MINIMUM_NODE_MAJOR}.0.0`,
    details: {
      version,
      major,
      minor,
      patch,
      minimum: MINIMUM_NODE_MAJOR,
      platform: upgrade.platform,
      arch: upgrade.arch,
      upgradeOptions: upgrade.instructions,
    },
    fix: upgrade.recommended,
  };
}

// ============================================================================
// Run All Checks
// ============================================================================

/**
 * Run all global health checks and return results array.
 * @task T4525
 */
export function runAllGlobalChecks(
  cleoHome?: string,
  projectRoot?: string,
): CheckResult[] {
  const home = cleoHome ?? join(homedir(), '.cleo');

  return [
    checkNodeVersion(),
    checkCliInstallation(home),
    checkCliVersion(home),
    checkDocsAccessibility(home),
    checkAtReferenceResolution(home),
    checkRootGitignore(projectRoot),
    checkCleoGitignore(projectRoot),
    checkVitalFilesTracked(projectRoot),
    checkLegacyAgentOutputs(projectRoot),
  ];
}

// ============================================================================
// Health Status Calculation
// ============================================================================

/**
 * Calculate overall status from check results.
 * Returns: 0=passed, 50=warning, 52=critical.
 * @task T4525
 */
export function calculateHealthStatus(checks: CheckResult[]): number {
  const hasFailed = checks.some(c => c.status === 'failed');
  const hasWarning = checks.some(c => c.status === 'warning');

  if (hasFailed) return 52;
  if (hasWarning) return 50;
  return 0;
}
