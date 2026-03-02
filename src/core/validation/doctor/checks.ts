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
import { CORE_PROTECTED_FILES } from '../../constants.js';
import { getGitignoreContent } from '../../scaffold.js';
import { checkGlobalSchemas as checkGlobalSchemasRaw } from '../../schema-management.js';

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

  // Load template from shared scaffold module (replaces CLI init.js require anti-pattern)
  let templateContent: string | null = null;
  try {
    templateContent = getGitignoreContent();
  } catch {
    // If we can't load the shared module, try the file directly
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
 * Check that vital CLEO configuration files are tracked by git.
 * Only checks config files (config.json, .gitignore, project-info.json,
 * project-context.json). SQLite databases are excluded per ADR-013.
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

  // Build vital file list from centralized constant
  const engine = detectStorageEngine(root);
  const vitalFiles = CORE_PROTECTED_FILES.map(f => `.cleo/${f}`);

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
// Check: Core files not gitignored
// ============================================================================

/**
 * Check that core CLEO files are not being ignored by .gitignore.
 * Uses `git check-ignore` to detect files that would be excluded by
 * any gitignore rule (root, .cleo/, or global).
 * Returns critical status if any protected file is gitignored.
 */
export function checkCoreFilesNotIgnored(
  projectRoot?: string,
): CheckResult {
  const root = projectRoot ?? process.cwd();
  const gitDir = join(root, '.git');

  if (!existsSync(gitDir)) {
    return {
      id: 'core_files_not_ignored',
      category: 'configuration',
      status: 'info',
      message: 'Not a git repository (skipping gitignore check)',
      details: { isGitRepo: false },
      fix: null,
    };
  }

  const ignoredFiles: string[] = [];

  for (const file of CORE_PROTECTED_FILES) {
    const relPath = `.cleo/${file}`;
    const fullPath = join(root, relPath);
    if (!existsSync(fullPath)) continue;

    try {
      execFileSync('git', ['check-ignore', '-q', relPath], {
        cwd: root,
        stdio: 'pipe',
      });
      // Exit code 0 means the file IS ignored
      ignoredFiles.push(relPath);
    } catch {
      // Non-zero exit means the file is NOT ignored (good)
    }
  }

  if (ignoredFiles.length > 0) {
    return {
      id: 'core_files_not_ignored',
      category: 'configuration',
      status: 'failed',
      message: `Critical CLEO files are gitignored: ${ignoredFiles.join(', ')}`,
      details: { ignoredFiles },
      fix: 'Remove ignore rules for these files from .gitignore and .cleo/.gitignore, then: git add ' + ignoredFiles.join(' '),
    };
  }

  return {
    id: 'core_files_not_ignored',
    category: 'configuration',
    status: 'passed',
    message: 'No core CLEO files are gitignored',
    details: { checkedFiles: CORE_PROTECTED_FILES.map(f => `.cleo/${f}`) },
    fix: null,
  };
}

// ============================================================================
// Check: SQLite databases not tracked by git
// ============================================================================

/**
 * Check that SQLite databases (.cleo/tasks.db) are NOT tracked by project git.
 * Tracked SQLite files cause data loss from merge conflicts (ADR-013).
 * Warns if tasks.db is currently tracked so the user can untrack it.
 * @task T5160
 */
export function checkSqliteNotTracked(
  projectRoot?: string,
): CheckResult {
  const root = projectRoot ?? process.cwd();
  const gitDir = join(root, '.git');

  if (!existsSync(gitDir)) {
    return {
      id: 'sqlite_not_tracked',
      category: 'configuration',
      status: 'info',
      message: 'Not a git repository (skipping SQLite tracking check)',
      details: { isGitRepo: false },
      fix: null,
    };
  }

  const sqliteFile = '.cleo/tasks.db';
  const fullPath = join(root, sqliteFile);

  if (!existsSync(fullPath)) {
    return {
      id: 'sqlite_not_tracked',
      category: 'configuration',
      status: 'passed',
      message: 'No SQLite database found (nothing to check)',
      details: { file: sqliteFile, exists: false },
      fix: null,
    };
  }

  try {
    execFileSync('git', ['ls-files', '--error-unmatch', sqliteFile], {
      cwd: root,
      stdio: 'pipe',
    });
    // Exit code 0 means the file IS tracked — that's the problem
    return {
      id: 'sqlite_not_tracked',
      category: 'configuration',
      status: 'warning',
      message: `${sqliteFile} is tracked by git — this risks data loss from merge conflicts (see ADR-013)`,
      details: { file: sqliteFile, tracked: true },
      fix: `git rm --cached ${sqliteFile}`,
    };
  } catch {
    // Non-zero exit means the file is NOT tracked (good)
    return {
      id: 'sqlite_not_tracked',
      category: 'configuration',
      status: 'passed',
      message: 'SQLite database is not tracked by git',
      details: { file: sqliteFile, tracked: false },
      fix: null,
    };
  }
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
// Check: CAAMP marker integrity
// ============================================================================

/**
 * Verify balanced CAAMP:START/END markers in CLAUDE.md and AGENTS.md.
 * @task T5153
 */
export function checkCaampMarkerIntegrity(projectRoot?: string): CheckResult {
  const root = projectRoot ?? process.cwd();
  const files = ['CLAUDE.md', 'AGENTS.md'];
  const issues: string[] = [];

  for (const file of files) {
    const filePath = join(root, file);
    if (!existsSync(filePath)) continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const startCount = (content.match(/<!-- CAAMP:START -->/g) || []).length;
    const endCount = (content.match(/<!-- CAAMP:END -->/g) || []).length;

    if (startCount !== endCount) {
      issues.push(`${file}: ${startCount} CAAMP:START vs ${endCount} CAAMP:END`);
    }
    if (startCount === 0) {
      issues.push(`${file}: no CAAMP markers found`);
    }
  }

  if (issues.length > 0) {
    return {
      id: 'caamp_marker_integrity',
      category: 'configuration',
      status: 'warning',
      message: `CAAMP marker issues: ${issues.join('; ')}`,
      details: { issues },
      fix: 'cleo init --update-docs',
    };
  }

  return {
    id: 'caamp_marker_integrity',
    category: 'configuration',
    status: 'passed',
    message: 'CAAMP markers balanced in all config files',
    details: { checkedFiles: files },
    fix: null,
  };
}

// ============================================================================
// Check: @ reference target existence
// ============================================================================

/**
 * Parse @ references from AGENTS.md CAAMP block and verify each target file exists.
 * @task T5153
 */
export function checkAtReferenceTargetExists(projectRoot?: string): CheckResult {
  const root = projectRoot ?? process.cwd();
  const agentsPath = join(root, 'AGENTS.md');

  if (!existsSync(agentsPath)) {
    return {
      id: 'at_reference_targets',
      category: 'configuration',
      status: 'info',
      message: 'AGENTS.md not found (skipping @ reference check)',
      details: { exists: false },
      fix: null,
    };
  }

  let content: string;
  try {
    content = readFileSync(agentsPath, 'utf-8');
  } catch {
    return {
      id: 'at_reference_targets',
      category: 'configuration',
      status: 'warning',
      message: 'AGENTS.md not readable',
      details: { readable: false },
      fix: null,
    };
  }

  // Extract CAAMP block content
  const caampMatch = content.match(/<!-- CAAMP:START -->([\s\S]*?)<!-- CAAMP:END -->/);
  if (!caampMatch) {
    return {
      id: 'at_reference_targets',
      category: 'configuration',
      status: 'info',
      message: 'No CAAMP block found in AGENTS.md',
      details: { hasCaampBlock: false },
      fix: null,
    };
  }

  const block = caampMatch[1];
  // Match @path references (lines starting with @)
  const refs = block.match(/^@(.+)$/gm) || [];
  const missing: string[] = [];

  for (const ref of refs) {
    const rawPath = ref.slice(1).trim(); // Remove @ prefix
    // Resolve ~ to homedir
    const resolvedPath = rawPath.startsWith('~/')
      ? join(homedir(), rawPath.slice(2))
      : join(root, rawPath);

    if (!existsSync(resolvedPath)) {
      missing.push(rawPath);
    }
  }

  if (missing.length > 0) {
    return {
      id: 'at_reference_targets',
      category: 'configuration',
      status: 'warning',
      message: `Missing @ reference targets: ${missing.join(', ')}`,
      details: { missing, totalRefs: refs.length },
      fix: 'cleo init --update-docs',
    };
  }

  return {
    id: 'at_reference_targets',
    category: 'configuration',
    status: 'passed',
    message: `All ${refs.length} @ reference targets exist`,
    details: { totalRefs: refs.length },
    fix: null,
  };
}

// ============================================================================
// Check: Template freshness
// ============================================================================

/**
 * Compare templates/CLEO-INJECTION.md vs ~/.cleo/templates/CLEO-INJECTION.md.
 * @task T5153
 */
export function checkTemplateFreshness(projectRoot?: string, cleoHome?: string): CheckResult {
  const root = projectRoot ?? process.cwd();
  const home = cleoHome ?? join(homedir(), '.cleo');
  const sourcePath = join(root, 'templates', 'CLEO-INJECTION.md');
  const deployedPath = join(home, 'templates', 'CLEO-INJECTION.md');

  if (!existsSync(sourcePath)) {
    return {
      id: 'template_freshness',
      category: 'configuration',
      status: 'info',
      message: 'Source template not found (not in project root)',
      details: { sourcePath, exists: false },
      fix: null,
    };
  }

  if (!existsSync(deployedPath)) {
    return {
      id: 'template_freshness',
      category: 'configuration',
      status: 'warning',
      message: 'Deployed template not found at ~/.cleo/templates/',
      details: { deployedPath, exists: false },
      fix: 'cp templates/CLEO-INJECTION.md ~/.cleo/templates/CLEO-INJECTION.md',
    };
  }

  const sourceContent = readFileSync(sourcePath, 'utf-8');
  const deployedContent = readFileSync(deployedPath, 'utf-8');

  if (sourceContent !== deployedContent) {
    return {
      id: 'template_freshness',
      category: 'configuration',
      status: 'warning',
      message: 'Deployed template differs from source — may be stale',
      details: { sourcePath, deployedPath, match: false },
      fix: 'cp templates/CLEO-INJECTION.md ~/.cleo/templates/CLEO-INJECTION.md',
    };
  }

  return {
    id: 'template_freshness',
    category: 'configuration',
    status: 'passed',
    message: 'Deployed template matches source',
    details: { sourcePath, deployedPath, match: true },
    fix: null,
  };
}

// ============================================================================
// Check: Tier markers present
// ============================================================================

/**
 * Verify all 3 tier markers exist with matching close tags in deployed template.
 * @task T5153
 */
export function checkTierMarkersPresent(cleoHome?: string): CheckResult {
  const home = cleoHome ?? join(homedir(), '.cleo');
  const templatePath = join(home, 'templates', 'CLEO-INJECTION.md');

  if (!existsSync(templatePath)) {
    return {
      id: 'tier_markers_present',
      category: 'configuration',
      status: 'warning',
      message: 'Template not found — cannot check tier markers',
      details: { path: templatePath, exists: false },
      fix: 'Run install.sh to reinstall CLEO',
    };
  }

  const content = readFileSync(templatePath, 'utf-8');
  const expectedTiers = ['minimal', 'standard', 'orchestrator'];
  const missing: string[] = [];
  const unclosed: string[] = [];

  for (const tier of expectedTiers) {
    const openTag = `<!-- TIER:${tier} -->`;
    const closeTag = `<!-- /TIER:${tier} -->`;

    if (!content.includes(openTag)) {
      missing.push(tier);
    } else if (!content.includes(closeTag)) {
      unclosed.push(tier);
    }
  }

  if (missing.length > 0 || unclosed.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
    if (unclosed.length > 0) parts.push(`unclosed: ${unclosed.join(', ')}`);
    return {
      id: 'tier_markers_present',
      category: 'configuration',
      status: 'warning',
      message: `Tier marker issues: ${parts.join('; ')}`,
      details: { missing, unclosed },
      fix: 'Regenerate template from source: cp templates/CLEO-INJECTION.md ~/.cleo/templates/',
    };
  }

  return {
    id: 'tier_markers_present',
    category: 'configuration',
    status: 'passed',
    message: 'All 3 tier markers present with matching close tags',
    details: { tiers: expectedTiers },
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
// Check: Global schema health
// ============================================================================

/**
 * Check that global schemas at ~/.cleo/schemas/ are installed and not stale.
 * Delegates to checkGlobalSchemas() from schema-management.ts.
 */
export function checkGlobalSchemaHealth(
  _projectRoot?: string,
): CheckResult {
  try {
    const result = checkGlobalSchemasRaw();

    if (result.missing.length > 0) {
      return {
        id: 'global_schema_health',
        category: 'configuration',
        status: 'warning',
        message: `Missing global schemas: ${result.missing.join(', ')}`,
        details: { missing: result.missing, installed: result.installed, bundled: result.bundled },
        fix: 'cleo upgrade',
      };
    }

    if (result.stale.length > 0) {
      return {
        id: 'global_schema_health',
        category: 'configuration',
        status: 'warning',
        message: `Stale global schemas: ${result.stale.join(', ')}`,
        details: { stale: result.stale, installed: result.installed, bundled: result.bundled },
        fix: 'cleo upgrade',
      };
    }

    return {
      id: 'global_schema_health',
      category: 'configuration',
      status: 'passed',
      message: `All ${result.installed} global schemas installed and current`,
      details: { installed: result.installed, bundled: result.bundled },
      fix: null,
    };
  } catch (err) {
    return {
      id: 'global_schema_health',
      category: 'configuration',
      status: 'warning',
      message: `Could not check global schemas: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
      fix: null,
    };
  }
}

// ============================================================================
// Check: No deprecated local schemas
// ============================================================================

/**
 * Warn if deprecated .cleo/schemas/ directory still exists in the project.
 * Schemas should live in ~/.cleo/schemas/ (global), not in project directories.
 */
export function checkNoLocalSchemas(
  projectRoot?: string,
): CheckResult {
  const root = projectRoot ?? process.cwd();
  const localSchemasDir = join(root, '.cleo', 'schemas');

  if (!existsSync(localSchemasDir)) {
    return {
      id: 'no_local_schemas',
      category: 'configuration',
      status: 'passed',
      message: 'No deprecated .cleo/schemas/ directory found',
      details: { path: localSchemasDir, exists: false },
      fix: null,
    };
  }

  return {
    id: 'no_local_schemas',
    category: 'configuration',
    status: 'warning',
    message: 'Deprecated .cleo/schemas/ directory found — schemas should be global',
    details: { path: localSchemasDir, exists: true },
    fix: 'cleo upgrade (will migrate to ~/.cleo/schemas/)',
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
    checkRootGitignore(projectRoot),
    checkCleoGitignore(projectRoot),
    checkVitalFilesTracked(projectRoot),
    checkCoreFilesNotIgnored(projectRoot),
    checkSqliteNotTracked(projectRoot),
    checkLegacyAgentOutputs(projectRoot),
    // Injection chain checks (T5153)
    checkCaampMarkerIntegrity(projectRoot),
    checkAtReferenceTargetExists(projectRoot),
    checkTemplateFreshness(projectRoot, home),
    checkTierMarkersPresent(home),
    // Global schema and local schema deprecation checks
    checkGlobalSchemaHealth(projectRoot),
    checkNoLocalSchemas(projectRoot),
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
