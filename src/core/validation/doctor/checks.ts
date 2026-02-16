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
import { join } from 'node:path';
import { homedir } from 'node:os';

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
    checkCliInstallation(home),
    checkCliVersion(home),
    checkDocsAccessibility(home),
    checkAtReferenceResolution(home),
    checkRootGitignore(projectRoot),
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
