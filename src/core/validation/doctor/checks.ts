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
// Check: AGENTS.md injection hub
// ============================================================================

/**
 * Check that AGENTS.md exists in project root and contains the CAAMP:START marker,
 * indicating it serves as the injection hub for CLEO protocol content.
 */
export function checkAgentsMdHub(
  projectRoot?: string,
): CheckResult {
  const root = projectRoot ?? process.cwd();
  const agentsMdPath = join(root, 'AGENTS.md');

  if (!existsSync(agentsMdPath)) {
    return {
      id: 'agents_md_hub',
      category: 'configuration',
      status: 'warning',
      message: 'AGENTS.md not found in project root',
      details: { path: agentsMdPath, exists: false },
      fix: 'cleo init --update-docs',
    };
  }

  let content: string;
  try {
    content = readFileSync(agentsMdPath, 'utf-8');
  } catch {
    return {
      id: 'agents_md_hub',
      category: 'configuration',
      status: 'warning',
      message: 'AGENTS.md exists but is not readable',
      details: { path: agentsMdPath, readable: false },
      fix: `chmod +r ${agentsMdPath}`,
    };
  }

  if (!content.includes('CAAMP:START')) {
    return {
      id: 'agents_md_hub',
      category: 'configuration',
      status: 'warning',
      message: 'AGENTS.md exists but has no CAAMP:START marker',
      details: { path: agentsMdPath, hasCaampMarker: false },
      fix: 'cleo init --update-docs',
    };
  }

  return {
    id: 'agents_md_hub',
    category: 'configuration',
    status: 'passed',
    message: 'AGENTS.md hub with CAAMP injection found',
    details: { path: agentsMdPath, hasCaampMarker: true },
    fix: null,
  };
}

// ============================================================================
// Check: Stale AGENT-INJECTION.md template
// ============================================================================

/**
 * Warn if the legacy .cleo/templates/AGENT-INJECTION.md file still exists.
 * This file is no longer needed — AGENTS.md is the injection hub now.
 */
export function checkStaleAgentInjection(
  projectRoot?: string,
): CheckResult {
  const root = projectRoot ?? process.cwd();
  const stalePath = join(root, '.cleo', 'templates', 'AGENT-INJECTION.md');

  if (existsSync(stalePath)) {
    return {
      id: 'stale_agent_injection',
      category: 'configuration',
      status: 'warning',
      message: 'Stale .cleo/templates/AGENT-INJECTION.md found (no longer needed)',
      details: { path: stalePath, exists: true },
      fix: `rm ${stalePath}`,
    };
  }

  return {
    id: 'stale_agent_injection',
    category: 'configuration',
    status: 'passed',
    message: 'No stale AGENT-INJECTION.md template found',
    details: { exists: false },
    fix: null,
  };
}

// ============================================================================
// Check: Injection pattern in CLAUDE.md
// ============================================================================

/**
 * Check that CLAUDE.md references @AGENTS.md instead of the old
 * @.cleo/templates/AGENT-INJECTION.md pattern.
 */
export function checkInjectionPattern(
  projectRoot?: string,
): CheckResult {
  const root = projectRoot ?? process.cwd();
  const claudeMdPath = join(root, 'CLAUDE.md');

  if (!existsSync(claudeMdPath)) {
    return {
      id: 'injection_pattern',
      category: 'configuration',
      status: 'info',
      message: 'CLAUDE.md not found (skipping injection pattern check)',
      details: { path: claudeMdPath, exists: false },
      fix: null,
    };
  }

  let content: string;
  try {
    content = readFileSync(claudeMdPath, 'utf-8');
  } catch {
    return {
      id: 'injection_pattern',
      category: 'configuration',
      status: 'warning',
      message: 'CLAUDE.md exists but is not readable',
      details: { path: claudeMdPath, readable: false },
      fix: `chmod +r ${claudeMdPath}`,
    };
  }

  if (content.includes('@.cleo/templates/AGENT-INJECTION.md')) {
    return {
      id: 'injection_pattern',
      category: 'configuration',
      status: 'warning',
      message: 'CLAUDE.md uses legacy @.cleo/templates/AGENT-INJECTION.md pattern',
      details: { path: claudeMdPath, pattern: 'legacy' },
      fix: 'cleo init --update-docs',
    };
  }

  if (content.includes('@AGENTS.md') || content.includes('CAAMP:START')) {
    return {
      id: 'injection_pattern',
      category: 'configuration',
      status: 'passed',
      message: 'CLAUDE.md uses @AGENTS.md injection pattern',
      details: { path: claudeMdPath, pattern: 'current' },
      fix: null,
    };
  }

  return {
    id: 'injection_pattern',
    category: 'configuration',
    status: 'info',
    message: 'CLAUDE.md has no CLEO injection (may be manually managed)',
    details: { path: claudeMdPath, pattern: 'none' },
    fix: null,
  };
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
 * SQLite-only (ADR-006): validates tasks.db/config/.gitignore tracking.
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

// ============================================================================
// Check: JSON schema file integrity
// ============================================================================

/**
 * Check that active JSON files (config.json, project-info.json, etc.) are valid
 * against their schemas and have current schema versions.
 *
 * Maps JsonFileIntegrityResult[] from checkSchemaIntegrity() into CheckResult[],
 * then returns a single rolled-up CheckResult for the doctor summary.
 */
export async function checkJsonSchemaIntegrity(
  projectDir: string,
): Promise<CheckResult> {
  const { checkSchemaIntegrity } = await import('../schema-integrity.js');

  let report;
  try {
    report = await checkSchemaIntegrity(projectDir);
  } catch (err) {
    return {
      id: 'json_schema_integrity',
      category: 'data',
      status: 'warning',
      message: `Could not run JSON schema integrity check: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
      fix: null,
    };
  }

  const failures = report.files.filter(
    (f) => f.status === 'missing' || f.status === 'invalid',
  );
  const warnings = report.files.filter(
    (f) => f.status === 'version_mismatch' || f.status === 'schema_not_found',
  );

  const details: Record<string, unknown> = {
    files: report.files.map((f) => ({ label: f.label, status: f.status, errors: f.errors })),
    sqliteVersion: report.sqliteVersion,
  };

  if (failures.length > 0) {
    const messages = failures.flatMap((f) => f.errors);
    return {
      id: 'json_schema_integrity',
      category: 'data',
      status: 'failed',
      message: `JSON schema integrity failures: ${messages.join('; ')}`,
      details,
      fix: 'cleo upgrade',
    };
  }

  if (warnings.length > 0) {
    const messages = warnings.flatMap((f) => f.errors);
    return {
      id: 'json_schema_integrity',
      category: 'data',
      status: 'warning',
      message: `JSON schema integrity warnings: ${messages.join('; ')}`,
      details,
      fix: 'cleo upgrade',
    };
  }

  return {
    id: 'json_schema_integrity',
    category: 'data',
    status: 'passed',
    message: `All JSON config files valid (SQLite: ${report.sqliteVersion ?? 'unknown'})`,
    details,
    fix: null,
  };
}

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
    checkAgentsMdHub(projectRoot),
    checkStaleAgentInjection(projectRoot),
    checkInjectionPattern(projectRoot),
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
