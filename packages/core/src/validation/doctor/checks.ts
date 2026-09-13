/**
 * Doctor health checks - ported from lib/validation/doctor-checks.sh
 *
 * Global health check functions: CLI installation, version, docs accessibility,
 * agent configs, registered projects, injection files, and aliases.
 *
 * @task T4525
 * @epic T4454
 */

import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listRegisteredWorktrees } from '@cleocode/worktree';
import { CORE_PROTECTED_FILES } from '../../constants.js';
import { detectLegacyAgentOutputs } from '../../migration/agent-outputs.js';
import {
  getAgentsHome,
  getCleoHome,
  getCleoTemplatesTildePath,
  getProjectRoot,
} from '../../paths.js';
import {
  getNodeUpgradeInstructions,
  getNodeVersionInfo,
  MINIMUM_NODE_MAJOR,
} from '../../platform.js';
import { checkWorktreeInclude, getGitignoreContent } from '../../scaffold.js';
import { checkGlobalSchemas as checkGlobalSchemasRaw } from '../../schema-management.js';
import { getTemplateById } from '../../templates/registry.js';

// ============================================================================
// Types
// ============================================================================
//
// CheckStatus and CheckResult are now sourced from
// `@cleocode/contracts/scaffold-diagnostics` (SG-ARCH-SOLID T9831 ·
// E-CONTRACTS-FOUNDATION T9832 Phase 0a). Re-exported here to preserve
// the public surface of `@cleocode/core/validation/doctor/checks`.

import {
  CAAMP_DAMAGED_END_PATTERN_SOURCE,
  CAAMP_DAMAGED_START_PATTERN_SOURCE,
  CAAMP_MARKER_START,
} from '@cleocode/contracts/caamp-markers';
import type { CheckResult } from '@cleocode/contracts/scaffold-diagnostics';

export type {
  CheckResult,
  CheckStatus,
} from '@cleocode/contracts/scaffold-diagnostics';

// ============================================================================
// Check 1: CLI Installation
// ============================================================================

/** @task T4525 */
export function checkCliInstallation(cleoHome: string = getCleoHome()): CheckResult {
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
export function checkCliVersion(cleoHome: string = getCleoHome()): CheckResult {
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
export function checkDocsAccessibility(cleoHome: string = getCleoHome()): CheckResult {
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

/**
 * Resolve the canonical absolute path to the installed CLEO-INJECTION.md via
 * the SSoT template registry (T9879). All doctor checks read from this single
 * path so the install target lives next to its source-of-truth entry in
 * `packages/core/src/templates/manifest-data.ts`.
 */
function resolveInjectionInstallPath(): string {
  const entry = getTemplateById('cleo-injection');
  if (entry === undefined) {
    throw new Error('SSoT registry missing cleo-injection template entry');
  }
  return join(getCleoHome(), entry.installPath);
}

/** @task T4525 */
export function checkAtReferenceResolution(): CheckResult {
  const docsFile = resolveInjectionInstallPath();
  const reference = `@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`;

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
export function checkAgentsMdHub(projectRoot?: string): CheckResult {
  const root = getProjectRoot(projectRoot);
  const agentsMdPath = join(root, 'AGENTS.md');

  if (!existsSync(agentsMdPath)) {
    return {
      id: 'agents_md_hub',
      category: 'configuration',
      status: 'warning',
      message: 'AGENTS.md not found in project root',
      details: { path: agentsMdPath, exists: false },
      fix: 'cleo upgrade',
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

  // A *whole-marker* match, not a substring one. `content.includes('CAAMP:START')`
  // is also satisfied by the damaged literal `!-- CAAMP:START -->`, so this
  // check reported the corrupt hub as healthy — one of two independent
  // "detect nothing / fix nothing" loops that let a one-byte defect survive a
  // month of upgrades (T12051).
  const hasCanonicalMarker = content.includes(CAAMP_MARKER_START);

  if (!hasCanonicalMarker) {
    const hasDamagedMarker = new RegExp(CAAMP_DAMAGED_START_PATTERN_SOURCE, 'mi').test(content);

    return {
      id: 'agents_md_hub',
      category: 'configuration',
      status: 'warning',
      message: hasDamagedMarker
        ? 'AGENTS.md has a damaged CAAMP:START marker'
        : 'AGENTS.md exists but has no CAAMP:START marker',
      details: { path: agentsMdPath, hasCaampMarker: false, hasDamagedMarker },
      // `cleo upgrade` re-runs injection, which cannot repair a damaged marker.
      fix: hasDamagedMarker ? 'cleo caamp repair' : 'cleo upgrade',
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
export function checkRootGitignore(projectRoot?: string): CheckResult {
  const root = getProjectRoot(projectRoot);
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
  const blockingLines = lines.filter((line) => {
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
export function checkCleoGitignore(projectRoot?: string): CheckResult {
  const root = getProjectRoot(projectRoot);
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
        join(getCleoHome(), 'templates', 'cleo-gitignore'),
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
 *
 * Per ADR-006, SQLite is the only supported storage engine. This function
 * checks the project's .cleo/config.json for an explicit storageEngine
 * override (for forward compatibility) but defaults to 'sqlite'.
 *
 * The projectRoot parameter is used to locate the project-level config.
 */
function detectStorageEngine(projectRoot: string): string {
  const configPath = join(projectRoot, '.cleo', 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (typeof config.storageEngine === 'string' && config.storageEngine) {
        return config.storageEngine;
      }
    } catch {
      // Invalid config; fall through to default
    }
  }
  // ADR-006: SQLite is the canonical and only supported storage engine
  return 'sqlite';
}

/**
 * Check that vital CLEO configuration files are tracked by git.
 * Only checks config files (config.json, .gitignore, project-info.json,
 * project-context.json). SQLite databases are excluded per ADR-013.
 * @task T4700
 */
export function checkVitalFilesTracked(projectRoot?: string): CheckResult {
  const root = getProjectRoot(projectRoot);
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
  const vitalFiles = CORE_PROTECTED_FILES.map((f) => `.cleo/${f}`);

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
export function checkCoreFilesNotIgnored(projectRoot?: string): CheckResult {
  const root = getProjectRoot(projectRoot);
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
      fix:
        'Remove ignore rules for these files from .gitignore and .cleo/.gitignore, then: git add ' +
        ignoredFiles.join(' '),
    };
  }

  return {
    id: 'core_files_not_ignored',
    category: 'configuration',
    status: 'passed',
    message: 'No core CLEO files are gitignored',
    details: { checkedFiles: CORE_PROTECTED_FILES.map((f) => `.cleo/${f}`) },
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
export function checkSqliteNotTracked(projectRoot?: string): CheckResult {
  const root = getProjectRoot(projectRoot);
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
// Check: Shared-worktree git hazards (T12161)
// ============================================================================

/**
 * Worktrees that share this repository's single `.git` directory.
 *
 * Returns 1 for an ordinary checkout. Anything above 1 means several working
 * trees — in this project, usually several concurrent agent sessions — are
 * backed by ONE object store, ONE config file and ONE stash stack.
 *
 * @param root - repository path to inspect.
 * @returns worktree count, or `null` when git could not answer.
 */
function sharedWorktreeCount(root: string): number | null {
  // Routed through `@cleocode/worktree` rather than a raw `git worktree list`
  // per D010 / T9984 — the registry is that package's surface, and it already
  // owns porcelain parsing. `listRegisteredWorktrees` never throws: an
  // unreadable registry yields `[]`. A real repository always has at least one
  // registered worktree, so an empty list means "could not determine", which is
  // `null` here and NOT "zero worktrees" — the difference decides whether the
  // caller warns or stays silent.
  const registered = listRegisteredWorktrees(root);
  return registered.length > 0 ? registered.length : null;
}

/**
 * Warn when a stash stack is shared by several worktrees.
 *
 * ## The failure this exists to stop (T12161)
 *
 * The stash is a property of the repository, not of the working tree. Every
 * worktree sharing a `.git` sees the same stack, so `git stash pop` — which
 * takes `stash@{0}` when given no argument — pops whatever another session
 * pushed most recently, into YOUR tree, on YOUR branch.
 *
 * Measured 2026-09-12 in this repo: an agent ran `git stash push` on an
 * untracked file (a no-op, so nothing was pushed), then `git stash pop`, and
 * silently received an unrelated entry from a 26-deep stack belonging to
 * another session's branch work. It modified a generated manifest the agent
 * had never touched. It was caught before commit by a diff review, not by any
 * tooling.
 *
 * The stack here is not transient: entries date back months, across branches
 * that are long merged. A single-worktree repo has none of this exposure,
 * which is why the check stays silent there rather than nagging every user
 * about a normal stash.
 *
 * @param projectRoot - repository to inspect; defaults to the resolved root.
 * @returns a warning naming the depth and the top entry, or a pass.
 *
 * @task T12161
 */
export function checkSharedWorktreeStashes(projectRoot?: string): CheckResult {
  const root = getProjectRoot(projectRoot);
  const id = 'shared_worktree_stashes';

  if (!existsSync(join(root, '.git'))) {
    return {
      id,
      category: 'configuration',
      status: 'info',
      message: 'Not a git repository (skipping shared-stash check)',
      details: { isGitRepo: false },
      fix: null,
    };
  }

  const worktrees = sharedWorktreeCount(root);
  let entries: string[];
  try {
    entries = execFileSync('git', ['stash', 'list', '--pretty=%H %gd %gs'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter((l) => l.trim().length > 0);
  } catch {
    return {
      id,
      category: 'configuration',
      status: 'info',
      message: 'Could not read the stash list (skipping shared-stash check)',
      details: { worktrees },
      fix: null,
    };
  }

  // A stash in a single-worktree repo is ordinary and private. The hazard is
  // specifically that another tree can pop it out from under you.
  if (entries.length === 0 || worktrees === null || worktrees < 2) {
    return {
      id,
      category: 'configuration',
      status: 'passed',
      message:
        entries.length === 0
          ? 'Stash stack is empty'
          : `${entries.length} stash entr${entries.length === 1 ? 'y' : 'ies'}, single worktree — not shared`,
      details: { stashCount: entries.length, worktrees },
      fix: null,
    };
  }

  return {
    id,
    category: 'configuration',
    status: 'warning',
    message:
      `${entries.length} stash entries are shared by ${worktrees} worktrees — ` +
      "a bare `git stash pop` here takes another session's work, not yours",
    details: {
      stashCount: entries.length,
      worktrees,
      // SHA first, deliberately. `stash@{n}` is a POSITION, not an identity:
      // dropping any entry renumbers every one below it, so an index cited in a
      // report can name a different stash by the time anyone reads it. Observed
      // 2026-09-12: one stash referred to as `stash@{2}` and then `stash@{1}`
      // inside a single session. The SHA is stable and `git stash show <sha>`
      // accepts it.
      topEntry: entries[0] ?? null,
    },
    fix: 'Never use a bare `git stash pop` in this repo. Run `git stash list`, identify your own entry, and apply it explicitly with `git stash apply stash@{N}`.',
  };
}

/**
 * Warn when a repo-LOCAL identity override is absent from recent history.
 *
 * ## The failure this exists to stop (T12161)
 *
 * `user.name` and `user.email` set at `--local` scope live in `.git/config`,
 * which every worktree shares. One session setting a throwaway identity — for
 * a measurement, a probe, a bisect — silently re-authors every commit made by
 * every other session in every other worktree until someone notices.
 *
 * Measured 2026-09-12 in this repo: `user.name` was left as `compose probe
 * <probe@local>` after a merge-composition experiment, and three commits from
 * a different session on a different branch were authored under it. Nothing
 * warned; it was found by reading `git log` for an unrelated reason.
 *
 * ## Why this reads `--local` and not the effective identity
 *
 * `git config user.email` returns the MERGED value — local, then global, then
 * system. Reading that would flag a first-time contributor whose perfectly
 * correct global identity simply has no commits here yet, which is noise. A
 * repo-local override is different in kind: it is a deliberate act scoped to
 * this repository, it is the only kind that one session can impose on another
 * through the shared `.git`, and when it authored none of recent history the
 * overwhelmingly likely explanation is that somebody else set it for something
 * else. So the remedy is to REMOVE the override and fall back to the
 * committer's own global identity — not to set another value.
 *
 * Gated on a shared `.git` for the same reason as the stash check: a local
 * identity in a single-worktree repo affects only the person who set it.
 *
 * @param projectRoot - repository to inspect; defaults to the resolved root.
 * @returns a warning naming the override, or a pass.
 *
 * @task T12161
 */
export function checkSharedGitIdentity(projectRoot?: string): CheckResult {
  const root = getProjectRoot(projectRoot);
  const id = 'shared_git_identity';

  if (!existsSync(join(root, '.git'))) {
    return {
      id,
      category: 'configuration',
      status: 'info',
      message: 'Not a git repository (skipping shared-identity check)',
      details: { isGitRepo: false },
      fix: null,
    };
  }

  const worktrees = sharedWorktreeCount(root);
  if (worktrees === null || worktrees < 2) {
    return {
      id,
      category: 'configuration',
      status: 'passed',
      message: 'Single worktree — git identity is not shared',
      details: { worktrees },
      fix: null,
    };
  }

  const gitValue = (args: readonly string[]): string | null => {
    try {
      const out = execFileSync('git', [...args], {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  };

  const localEmail = gitValue(['config', '--local', 'user.email']);

  // No repo-local override: whatever identity is in play came from the
  // committer's own global config and is none of this check's business.
  if (localEmail === null) {
    return {
      id,
      category: 'configuration',
      status: 'passed',
      message: 'No repo-local git identity override — each session uses its own global identity',
      details: { worktrees, localOverride: null },
      fix: null,
    };
  }

  const authors = (gitValue(['log', '-50', '--format=%ae']) ?? '')
    .split('\n')
    .filter((l) => l.trim().length > 0);

  // No history to compare against proves nothing either way.
  if (authors.length === 0) {
    return {
      id,
      category: 'configuration',
      status: 'passed',
      message: 'No commit history to compare the local git identity against',
      details: { worktrees, localOverride: localEmail },
      fix: null,
    };
  }

  if (authors.includes(localEmail)) {
    return {
      id,
      category: 'configuration',
      status: 'passed',
      message: `Repo-local git identity (${localEmail}) appears in recent history`,
      details: { worktrees, localOverride: localEmail, sampled: authors.length },
      fix: null,
    };
  }

  const mostRecent = authors[0] ?? '(unknown)';
  return {
    id,
    category: 'configuration',
    status: 'warning',
    message:
      `Repo-local git identity "${localEmail}" authored none of the last ${authors.length} ` +
      `commits, and this .git is shared by ${worktrees} worktrees — every session ` +
      'committing right now is attributed to it',
    details: {
      worktrees,
      localOverride: localEmail,
      sampled: authors.length,
      mostRecentHistoricalAuthor: mostRecent,
    },
    fix: 'If this override is left over from another session, remove it so each session uses its own identity: git config --local --unset user.email && git config --local --unset user.name',
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
export function checkLegacyAgentOutputs(projectRoot?: string): CheckResult {
  const root = getProjectRoot(projectRoot);
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
// Check: Canonical RCASD Paths (ADR-045)
// ============================================================================

/**
 * Validate that artifacts are at canonical RCASD paths per ADR-045.
 * Detects drift: deprecated flat dirs, misplaced agent outputs, etc.
 *
 * @task T708 (scaffolding path drift validator)
 */
export function checkCanonicalRcasdPaths(projectRoot?: string): CheckResult {
  const root = getProjectRoot(projectRoot);
  const cleoDir = join(root, '.cleo');
  const failures: string[] = [];

  // 1. Check for deprecated flat directories with content
  const deprecatedDirs = ['research', 'consensus', 'specs', 'decomposition'];
  for (const dir of deprecatedDirs) {
    const dirPath = join(cleoDir, dir);
    if (existsSync(dirPath)) {
      try {
        const entries = (require('node:fs').readdirSync(dirPath) as string[]).filter(
          (e) => !e.startsWith('.'),
        );
        if (entries.length > 0) {
          failures.push(
            `deprecated .cleo/${dir}/ contains files (should migrate to .cleo/rcasd/{epicId}/${dir}/)`,
          );
        }
      } catch {
        // directory exists but can't read; skip
      }
    }
  }

  // 2. Check for misplaced audit files at .cleo/rcasd/ root
  const rcasdPath = join(cleoDir, 'rcasd');
  if (existsSync(rcasdPath)) {
    try {
      const rootFiles = (require('node:fs').readdirSync(rcasdPath) as string[]).filter((e) =>
        e.endsWith('.md'),
      );
      if (rootFiles.length > 0) {
        failures.push(
          `misplaced .md files in .cleo/rcasd/ root (audit-*.md, etc. should be in .cleo/agent-outputs/)`,
        );
      }
    } catch {
      // directory exists but can't read; skip
    }
  }

  // 3. Check for claudedocs legacy location
  const claudedocsPath = join(root, 'claudedocs');
  if (existsSync(claudedocsPath)) {
    try {
      const agentOutputs = join(claudedocsPath, 'agent-outputs');
      if (existsSync(agentOutputs)) {
        failures.push(
          `legacy claudedocs/agent-outputs/ directory exists (should migrate to .cleo/agent-outputs/)`,
        );
      }
    } catch {
      // path exists but can't read; skip
    }
  }

  // 4. Check for @see references pointing to deprecated paths in source code
  // (This is a sample check; full validation should be done at lint time)
  // For now, just provide guidance in the message.

  if (failures.length > 0) {
    return {
      id: 'canonical_rcasd_paths',
      category: 'configuration',
      status: 'warning',
      message: `Canonical path drift detected (ADR-045): ${failures.join('; ')}`,
      details: {
        issues: failures,
        canonical: {
          rcasdStages: '.cleo/rcasd/{epicId}/{stage}/{epicId}-{stage}.md',
          agentOutputs: '.cleo/agent-outputs/{taskId}-{slug}.md',
          publishedSpecs: 'docs/specs/SPEC-NAME.md',
        },
      },
      fix: 'cleo upgrade (migrates old paths) or manually move files per ADR-045',
    };
  }

  return {
    id: 'canonical_rcasd_paths',
    category: 'configuration',
    status: 'passed',
    message: 'All artifacts at canonical RCASD paths (ADR-045 compliant)',
    details: {
      canonical: {
        rcasdStages: '.cleo/rcasd/{epicId}/{stage}/{epicId}-{stage}.md',
        agentOutputs: '.cleo/agent-outputs/{taskId}-{slug}.md',
        publishedSpecs: 'docs/specs/SPEC-NAME.md',
      },
    },
    fix: null,
  };
}

// ============================================================================
// Check: CAAMP marker integrity
// ============================================================================

/**
 * Verify CAAMP marker integrity across the instruction-file cascade.
 *
 * Checks three distinct failure modes:
 *
 * - **Damaged markers** — a marker whose delimiters were mangled (for example
 *   `!-- CAAMP:START -->`, having lost its leading `<`). The strict block
 *   pattern cannot see these, so before T12051 they were invisible here while
 *   causing `inject()` to prepend duplicate blocks on every run.
 * - **Unbalanced markers** — START and END counts differ.
 * - **Duplicate blocks** — more than one block in a file, which means the
 *   referenced protocol text is loaded into every agent's context more than
 *   once.
 *
 * The **global hub** `~/.agents/AGENTS.md` is included deliberately. It is the
 * most-written file in the system — every `cleo init`, `cleo upgrade` and
 * `cleo doctor` run rewrites it no matter which project invoked them — and it
 * was previously the one file no health check inspected. The corruption this
 * check now catches was found there.
 *
 * @param projectRoot - Project directory to check; defaults to the resolved project root
 * @returns Check result naming each offending file
 *
 * @task T5153
 * @task T12051
 */
export function checkCaampMarkerIntegrity(projectRoot?: string): CheckResult {
  const root = getProjectRoot(projectRoot);
  const files = [
    join(getAgentsHome(), 'AGENTS.md'),
    join(root, 'CLAUDE.md'),
    join(root, 'AGENTS.md'),
  ];
  const issues: string[] = [];
  const checked: string[] = [];

  for (const filePath of files) {
    if (!existsSync(filePath)) continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    checked.push(filePath);
    const label = filePath.replace(homedir(), '~');

    // Fresh RegExp per use — a shared /g pattern carries a mutable lastIndex.
    const canonicalStart = (content.match(/<!-- CAAMP:START -->/g) ?? []).length;
    const canonicalEnd = (content.match(/<!-- CAAMP:END -->/g) ?? []).length;
    const tolerantStart = (
      content.match(new RegExp(CAAMP_DAMAGED_START_PATTERN_SOURCE, 'gmi')) ?? []
    ).length;
    const tolerantEnd = (content.match(new RegExp(CAAMP_DAMAGED_END_PATTERN_SOURCE, 'gmi')) ?? [])
      .length;

    const damaged = tolerantStart - canonicalStart + (tolerantEnd - canonicalEnd);
    if (damaged > 0) {
      issues.push(`${label}: ${damaged} damaged CAAMP marker(s)`);
    }
    if (canonicalStart !== canonicalEnd) {
      issues.push(`${label}: ${canonicalStart} CAAMP:START vs ${canonicalEnd} CAAMP:END`);
    }
    if (tolerantStart === 0) {
      issues.push(`${label}: no CAAMP markers found`);
    } else if (tolerantStart > 1) {
      issues.push(`${label}: ${tolerantStart} CAAMP blocks (expected 1)`);
    }
  }

  if (issues.length > 0) {
    return {
      id: 'caamp_marker_integrity',
      category: 'configuration',
      status: 'warning',
      message: `CAAMP marker issues: ${issues.join('; ')}`,
      details: { issues, checkedFiles: checked },
      // `cleo upgrade` cannot repair a damaged marker — it re-runs injection,
      // which is what created the duplicates. `cleo caamp repair` heals them.
      fix: 'cleo caamp repair',
    };
  }

  return {
    id: 'caamp_marker_integrity',
    category: 'configuration',
    status: 'passed',
    message: 'CAAMP markers well-formed and unique in all instruction files',
    details: { checkedFiles: checked },
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
  const root = getProjectRoot(projectRoot);
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
      fix: 'cleo upgrade',
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
 * Compare templates/CLEO-INJECTION.md vs the XDG-canonical deployed path.
 * @task T5153
 */
export function checkTemplateFreshness(projectRoot?: string): CheckResult {
  const root = getProjectRoot(projectRoot);
  const sourcePath = join(root, 'templates', 'CLEO-INJECTION.md');
  const deployedPath = resolveInjectionInstallPath();
  const deployedTildePath = `${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`;

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
      message: `Deployed template not found at ${deployedTildePath}`,
      details: { deployedPath, exists: false },
      fix: 'cleo install',
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
      fix: 'cleo install',
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
export function checkTierMarkersPresent(): CheckResult {
  const templatePath = resolveInjectionInstallPath();

  if (!existsSync(templatePath)) {
    return {
      id: 'tier_markers_present',
      category: 'configuration',
      status: 'warning',
      message: 'Template not found — cannot check tier markers',
      details: { path: templatePath, exists: false },
      fix: 'cleo install',
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
      fix: 'cleo install',
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
 *
 * The projectRoot parameter exists for API consistency with other check
 * functions in runAllGlobalChecks(), but global schemas live at ~/.cleo/schemas/
 * (not per-project). The parameter is intentionally unused because schema
 * health is a system-wide concern, not project-scoped.
 */
export function checkGlobalSchemaHealth(_projectRoot?: string): CheckResult {
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
export function checkNoLocalSchemas(projectRoot?: string): CheckResult {
  const root = getProjectRoot(projectRoot);
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
// Check: Orphan worktrees (T9043)
// ============================================================================

/**
 * Audit orphaned CLEO agent worktree directories.
 *
 * Lists all directories under `~/.local/share/cleo/worktrees/` (or the
 * XDG-resolved equivalent) whose names are NOT in the provided
 * `activeTaskIds` set. Surfaces them as a `warning` so the operator can
 * clean them with `cleo gc --worktrees`.
 *
 * @param worktreesRoot - Override for the worktrees root (testing).
 * @param activeTaskIds - Set of currently active task IDs to preserve.
 * @returns CheckResult with orphan paths in `details.orphans`.
 *
 * @task T9043
 */
export function auditOrphanWorktrees(
  worktreesRoot?: string,
  activeTaskIds: Set<string> = new Set(),
): CheckResult {
  const xdgData = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  const root = worktreesRoot ?? join(xdgData, 'cleo', 'worktrees');

  if (!existsSync(root)) {
    return {
      id: 'orphan_worktrees',
      category: 'worktree',
      status: 'passed',
      message: 'Worktrees root does not exist — nothing to audit',
      details: { root, orphans: [] },
      fix: null,
    };
  }

  // Collect task dirs across all project hashes.
  const orphans: Array<{ path: string; ageLabel: string }> = [];

  let projectEntries: string[];
  try {
    projectEntries = readdirSync(root);
  } catch {
    return {
      id: 'orphan_worktrees',
      category: 'worktree',
      status: 'info',
      message: 'Could not read worktrees root',
      details: { root, orphans: [] },
      fix: null,
    };
  }

  const now = Date.now();
  for (const projectHash of projectEntries) {
    const projectDir = join(root, projectHash);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }

    let taskEntries: string[];
    try {
      taskEntries = readdirSync(projectDir);
    } catch {
      continue;
    }

    for (const taskId of taskEntries) {
      if (activeTaskIds.has(taskId)) continue;
      const worktreePath = join(projectDir, taskId);
      try {
        const st = statSync(worktreePath);
        if (!st.isDirectory()) continue;
        const ageMs = now - st.mtimeMs;
        const hours = Math.floor(ageMs / (1000 * 60 * 60));
        const days = Math.floor(hours / 24);
        const ageLabel = days > 0 ? `${days}d ${hours % 24}h` : `${hours}h`;
        orphans.push({ path: worktreePath, ageLabel });
      } catch {
        orphans.push({ path: worktreePath, ageLabel: 'unknown' });
      }
    }
  }

  if (orphans.length === 0) {
    return {
      id: 'orphan_worktrees',
      category: 'worktree',
      status: 'passed',
      message: 'No orphaned worktrees found',
      details: { root, orphans: [] },
      fix: null,
    };
  }

  return {
    id: 'orphan_worktrees',
    category: 'worktree',
    status: 'warning',
    message: `${orphans.length} orphaned worktree director${orphans.length === 1 ? 'y' : 'ies'} found`,
    details: { root, orphans, count: orphans.length },
    fix: 'cleo gc --worktrees',
  };
}

// ============================================================================
// Check: Orphan temp dirs (T9043)
// ============================================================================

/**
 * Audit orphaned CLEO-generated temp directories.
 *
 * Scans `os.tmpdir()` for directories matching any prefix in
 * `CLEO_TEMP_PREFIXES` that are older than 2 hours (the default orphan
 * threshold). Surfaces them as a `warning` so the operator can clean them
 * with `cleo gc --temp`.
 *
 * @param tempDirOverride - Override for os.tmpdir() (testing).
 * @param maxAgeMs - Maximum age threshold in ms (default: 2 hours).
 * @returns CheckResult with orphan paths in `details.orphans`.
 *
 * @task T9043
 */
export async function auditOrphanTempDirs(
  tempDirOverride?: string,
  maxAgeMs?: number,
): Promise<CheckResult> {
  const { listOrphanTempDirs } = await import('../../gc/cleanup.js');
  const ageMs = maxAgeMs ?? 2 * 60 * 60 * 1000;

  let orphans: ReturnType<typeof listOrphanTempDirs>;
  try {
    orphans = listOrphanTempDirs(ageMs, tempDirOverride);
  } catch {
    return {
      id: 'orphan_temp_dirs',
      category: 'temp',
      status: 'info',
      message: 'Could not scan temp directory',
      details: { orphans: [] },
      fix: null,
    };
  }

  if (orphans.length === 0) {
    return {
      id: 'orphan_temp_dirs',
      category: 'temp',
      status: 'passed',
      message: 'No orphaned CLEO temp directories found',
      details: { orphans: [] },
      fix: null,
    };
  }

  return {
    id: 'orphan_temp_dirs',
    category: 'temp',
    status: 'warning',
    message: `${orphans.length} orphaned CLEO temp director${orphans.length === 1 ? 'y' : 'ies'} found`,
    details: {
      orphans: orphans.map((o) => ({ path: o.path, age: o.ageLabel })),
      count: orphans.length,
    },
    fix: 'cleo gc --temp',
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
export async function checkJsonSchemaIntegrity(projectDir: string): Promise<CheckResult> {
  const { checkSchemaIntegrity } = await import('../schema-integrity.js');

  let report: import('../schema-integrity.js').SchemaIntegrityReport;
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

  const failures = report.files.filter((f) => f.status === 'missing' || f.status === 'invalid');
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

// ============================================================================
// Check: exodus stranded-residue (T11777)
// ============================================================================

/**
 * Detect stranded legacy source DBs after an exodus cutover.
 *
 * Once a scope's exodus completion marker (`exodus-complete`) exists, every one
 * of the six legacy source DBs for that scope SHOULD have been archived into the
 * scope's `_archive/` directory. A source still present on disk is "stranded
 * residue" — it re-arms the `tasks_tasks=0` auto-recover / exodus-on-open
 * corruption trigger (DHQ-052 · T11662). This check surfaces that residue so it
 * can be archived via `cleo doctor exodus-residue --fix`.
 *
 * Read-only. Returns `'passed'` when no marker exists yet (a pre-cutover install
 * where the legacy DBs are still the live source of truth — NOT residue) or when
 * every marked scope's sources have been archived. Returns `'warning'` when
 * residue is found (it is recoverable, never data-loss — the fix only MOVES
 * files into `_archive/`).
 *
 * @param projectRoot - Project root used to resolve the project `.cleo/` dir.
 * @returns A {@link CheckResult} describing stranded residue (if any).
 *
 * @task T11777
 */
export async function checkExodusStrandedResidue(projectRoot?: string): Promise<CheckResult> {
  // Lazy import: keep the heavy exodus barrel out of the doctor module graph at
  // load time; only the pure read helpers (plan + residue detect) are used here.
  const { buildExodusPlan, detectStrandedResidue } = await import('../../store/exodus/index.js');

  let stranded: import('../../store/exodus/archive.js').StrandedResidueEntry[];
  try {
    const plan = buildExodusPlan(projectRoot);
    stranded = detectStrandedResidue(plan.sources, projectRoot);
  } catch (err) {
    return {
      id: 'exodus_stranded_residue',
      category: 'data',
      status: 'warning',
      message: `Could not run exodus stranded-residue check: ${err instanceof Error ? err.message : String(err)}`,
      details: {},
      fix: null,
    };
  }

  if (stranded.length === 0) {
    return {
      id: 'exodus_stranded_residue',
      category: 'data',
      status: 'passed',
      message: 'No stranded legacy exodus source DBs (clean cutover or pre-migration install)',
      details: { strandedCount: 0 },
      fix: null,
    };
  }

  return {
    id: 'exodus_stranded_residue',
    category: 'data',
    status: 'warning',
    message:
      `${stranded.length} legacy exodus source DB(s) still present after cutover ` +
      `(stranded residue re-arms the exodus-on-open corruption trigger): ` +
      stranded.map((s) => `${s.name} (${s.scope})`).join(', '),
    details: {
      strandedCount: stranded.length,
      stranded: stranded.map((s) => ({ name: s.name, path: s.path, scope: s.scope })),
    },
    fix: 'cleo doctor exodus-residue --fix',
  };
}

/**
 * Run all global health checks and return results array.
 * @task T4525
 */
export function runAllGlobalChecks(cleoHome?: string, projectRoot?: string): CheckResult[] {
  const home = cleoHome ?? getCleoHome();

  return [
    checkNodeVersion(),
    checkCliInstallation(home),
    checkCliVersion(home),
    checkDocsAccessibility(home),
    checkAtReferenceResolution(),
    checkAgentsMdHub(projectRoot),
    checkRootGitignore(projectRoot),
    checkCleoGitignore(projectRoot),
    checkWorktreeInclude(projectRoot),
    checkVitalFilesTracked(projectRoot),
    checkCoreFilesNotIgnored(projectRoot),
    checkSqliteNotTracked(projectRoot),
    checkLegacyAgentOutputs(projectRoot),
    // ADR-045 canonical paths check (T708)
    checkCanonicalRcasdPaths(projectRoot),
    // Injection chain checks (T5153)
    checkCaampMarkerIntegrity(projectRoot),
    checkAtReferenceTargetExists(projectRoot),
    checkTemplateFreshness(projectRoot),
    checkTierMarkersPresent(),
    // Global schema and local schema deprecation checks
    checkGlobalSchemaHealth(projectRoot),
    checkNoLocalSchemas(projectRoot),
    // Orphan worktrees audit (T9043)
    auditOrphanWorktrees(),
    // Shared-worktree git hazards (T12161)
    checkSharedWorktreeStashes(projectRoot),
    checkSharedGitIdentity(projectRoot),
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
  const hasFailed = checks.some((c) => c.status === 'failed');
  const hasWarning = checks.some((c) => c.status === 'warning');

  if (hasFailed) return 52;
  if (hasWarning) return 50;
  return 0;
}
