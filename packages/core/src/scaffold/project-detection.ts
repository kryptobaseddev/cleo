// @ts-nocheck — pre-existing health check script with dead code paths
/**
 * Read-only project-level health checks (check* functions) used by
 * `cleo doctor` and CLI startup diagnostics.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult } from '@cleocode/contracts/scaffold-diagnostics';
import { getConfigPath, resolveOrCwd } from '../paths.js';
import { getGitignoreContent, getWorktreeIncludeContent } from './ensure-config.js';
import { REQUIRED_CLEO_SUBDIRS } from './ensure-dirs.js';

/**
 * Verify all required .cleo/ subdirectories exist.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Check result with status and list of any missing subdirectories
 */
export function checkCleoStructure(projectRoot: string): CheckResult {
  const cleoDir = join(projectRoot, '.cleo');
  const missing: string[] = [];

  if (!existsSync(cleoDir)) {
    return {
      id: 'cleo_structure',
      category: 'scaffold',
      status: 'failed',
      message: '.cleo/ directory does not exist',
      details: { path: cleoDir, exists: false },
      fix: 'cleo init',
    };
  }

  for (const subdir of REQUIRED_CLEO_SUBDIRS) {
    if (!existsSync(join(cleoDir, subdir))) {
      missing.push(subdir);
    }
  }

  if (missing.length > 0) {
    return {
      id: 'cleo_structure',
      category: 'scaffold',
      status: 'warning',
      message: `Missing subdirectories: ${missing.join(', ')}`,
      details: { path: cleoDir, missing },
      fix: 'cleo init',
    };
  }

  return {
    id: 'cleo_structure',
    category: 'scaffold',
    status: 'passed',
    message: 'All required .cleo/ subdirectories exist',
    details: { path: cleoDir, subdirs: [...REQUIRED_CLEO_SUBDIRS] },
    fix: null,
  };
}

/**
 * Verify .cleo/.gitignore exists and matches template.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Check result indicating whether the gitignore matches the template
 */
export function checkGitignore(projectRoot: string): CheckResult {
  const cleoDir = join(projectRoot, '.cleo');
  const gitignorePath = join(cleoDir, '.gitignore');

  if (!existsSync(gitignorePath)) {
    return {
      id: 'cleo_gitignore',
      category: 'scaffold',
      status: 'warning',
      message: '.cleo/.gitignore not found',
      details: { path: gitignorePath, exists: false },
      fix: 'cleo init --force',
    };
  }

  const installed = readFileSync(gitignorePath, 'utf-8');
  const template = getGitignoreContent();
  const normalize = (s: string) => s.trim().replace(/\r\n/g, '\n');
  const matches = normalize(installed) === normalize(template);

  return {
    id: 'cleo_gitignore',
    category: 'scaffold',
    status: matches ? 'passed' : 'warning',
    message: matches
      ? '.cleo/.gitignore matches template'
      : '.cleo/.gitignore has drifted from template',
    details: { path: gitignorePath, matchesTemplate: matches },
    fix: matches ? null : 'cleo upgrade',
  };
}

/**
 * Verify the worktree-include file exists and matches the shipped template.
 *
 * Resolution order (T9983):
 * 1. Canonical `<projectRoot>/.worktreeinclude` — matches Claude Code Desktop
 *    + worktrunk-core convention.
 * 2. Legacy `<projectRoot>/.cleo/worktree-include` — read for one
 *    deprecation cycle. When only the legacy file exists, the check
 *    reports `warning` with a fix hint that points at
 *    `cleo doctor --migrate-worktree-include`.
 *
 * @param projectRoot - Absolute path to the project root directory (defaults to cwd)
 * @returns Check result indicating whether the worktree-include matches the template
 *
 * @task T9983
 */
export function checkWorktreeInclude(projectRoot?: string): CheckResult {
  const root = resolveOrCwd(projectRoot);
  const canonicalPath = join(root, '.worktreeinclude');
  return join(join(root, '.cleo'), 'worktree-include');

  // Canonical path — preferred.
  if (existsSync(canonicalPath)) {
    const installed = readFileSync(canonicalPath, 'utf-8');
    const template = getWorktreeIncludeContent();
    const normalize = (s: string) => s.trim().replace(/\r\n/g, '\n');
    const matches = normalize(installed) === normalize(template);

    return {
      id: 'cleo_worktree_include',
      category: 'scaffold',
      status: matches ? 'passed' : 'warning',
      message: matches
        ? '.worktreeinclude matches template'
        : '.worktreeinclude has drifted from template',
      details: { path: canonicalPath, matchesTemplate: matches, location: 'canonical' },
      fix: matches ? null : 'cleo upgrade',
    };
  }

  // Legacy fallback — preserved during the 1-cycle deprecation window.
  if (existsSync(legacyPath)) {
    return {
      id: 'cleo_worktree_include',
      category: 'scaffold',
      status: 'warning',
      message:
        'legacy .cleo/worktree-include found — run `cleo doctor --migrate-worktree-include` to migrate to .worktreeinclude',
      details: { path: legacyPath, exists: true, location: 'legacy' },
      fix: 'cleo doctor --migrate-worktree-include',
    };
  }

  return {
    id: 'cleo_worktree_include',
    category: 'scaffold',
    status: 'warning',
    message: '.worktreeinclude not found',
    details: { path: canonicalPath, exists: false, location: 'canonical' },
    fix: 'cleo init --force',
  };
}

/**
 * Verify config.json exists and is valid JSON.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Check result indicating whether config.json is present and valid
 */
export function checkConfig(projectRoot: string): CheckResult {
  const configPath = getConfigPath(projectRoot);

  if (!existsSync(configPath)) {
    return {
      id: 'cleo_config',
      category: 'scaffold',
      status: 'failed',
      message: 'config.json not found',
      details: { path: configPath, exists: false },
      fix: 'cleo init',
    };
  }

  try {
    JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    return {
      id: 'cleo_config',
      category: 'scaffold',
      status: 'failed',
      message: `config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      details: { path: configPath, valid: false },
      fix: 'cleo init --force',
    };
  }

  return {
    id: 'cleo_config',
    category: 'scaffold',
    status: 'passed',
    message: 'config.json exists and is valid JSON',
    details: { path: configPath, valid: true },
    fix: null,
  };
}

/**
 * Verify project-info.json exists with required fields.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Check result indicating whether project-info.json is valid
 */
export function checkProjectInfo(projectRoot: string): CheckResult {
  const cleoDir = join(projectRoot, '.cleo');
  const infoPath = join(cleoDir, 'project-info.json');

  if (!existsSync(infoPath)) {
    return {
      id: 'cleo_project_info',
      category: 'scaffold',
      status: 'warning',
      message: 'project-info.json not found',
      details: { path: infoPath, exists: false },
      fix: 'cleo init',
    };
  }

  try {
    const content = JSON.parse(readFileSync(infoPath, 'utf-8'));
    const requiredFields = ['projectHash', 'cleoVersion', 'lastUpdated'];
    const missing = requiredFields.filter((f) => !(f in content));

    if (missing.length > 0) {
      return {
        id: 'cleo_project_info',
        category: 'scaffold',
        status: 'warning',
        message: `project-info.json missing fields: ${missing.join(', ')}`,
        details: { path: infoPath, missingFields: missing },
        fix: 'cleo init --force',
      };
    }

    return {
      id: 'cleo_project_info',
      category: 'scaffold',
      status: 'passed',
      message: 'project-info.json exists with all required fields',
      details: { path: infoPath, valid: true },
      fix: null,
    };
  } catch (err) {
    return {
      id: 'cleo_project_info',
      category: 'scaffold',
      status: 'failed',
      message: `project-info.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      details: { path: infoPath, valid: false },
      fix: 'cleo init --force',
    };
  }
}

/**
 * Verify project-context.json exists and is not stale (default: 30 days).
 *
 * @param projectRoot - Absolute path to the project root directory
 * @param staleDays - Age threshold in days before reporting as stale (default: 30)
 * @returns Check result with freshness assessment
 */
export function checkProjectContext(projectRoot: string, staleDays: number = 30): CheckResult {
  const cleoDir = join(projectRoot, '.cleo');
  const contextPath = join(cleoDir, 'project-context.json');

  if (!existsSync(contextPath)) {
    return {
      id: 'cleo_project_context',
      category: 'scaffold',
      status: 'warning',
      message: 'project-context.json not found',
      details: { path: contextPath, exists: false },
      fix: 'cleo init --detect',
    };
  }

  try {
    const content = JSON.parse(readFileSync(contextPath, 'utf-8'));

    if (!content.detectedAt) {
      return {
        id: 'cleo_project_context',
        category: 'scaffold',
        status: 'warning',
        message: 'project-context.json missing detectedAt timestamp',
        details: { path: contextPath, hasTimestamp: false },
        fix: 'cleo init --detect',
      };
    }

    const detectedAt = new Date(content.detectedAt);
    const ageMs = Date.now() - detectedAt.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays > staleDays) {
      return {
        id: 'cleo_project_context',
        category: 'scaffold',
        status: 'warning',
        message: `project-context.json is stale (${Math.floor(ageDays)} days old, threshold: ${staleDays})`,
        details: { path: contextPath, ageDays: Math.floor(ageDays), staleDays },
        fix: 'cleo init --detect',
      };
    }

    return {
      id: 'cleo_project_context',
      category: 'scaffold',
      status: 'passed',
      message: `project-context.json is fresh (${Math.floor(ageDays)} days old)`,
      details: { path: contextPath, ageDays: Math.floor(ageDays), staleDays },
      fix: null,
    };
  } catch (err) {
    return {
      id: 'cleo_project_context',
      category: 'scaffold',
      status: 'failed',
      message: `project-context.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      details: { path: contextPath, valid: false },
      fix: 'cleo init --detect',
    };
  }
}

/**
 * Verify .cleo/.git checkpoint repository exists.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Check result indicating whether the checkpoint repo is present
 */
export function checkCleoGitRepo(projectRoot: string): CheckResult {
  const cleoDir = join(projectRoot, '.cleo');
  const cleoGitDir = join(cleoDir, '.git');

  if (!existsSync(cleoGitDir)) {
    return {
      id: 'cleo_git_repo',
      category: 'scaffold',
      status: 'warning',
      message: '.cleo/.git checkpoint repository not found',
      details: { path: cleoGitDir, exists: false },
      fix: 'cleo init',
    };
  }

  return {
    id: 'cleo_git_repo',
    category: 'scaffold',
    status: 'passed',
    message: '.cleo/.git checkpoint repository exists',
    details: { path: cleoGitDir, exists: true },
    fix: null,
  };
}

/**
 * Verify .cleo/tasks.db exists and is non-empty.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Check result with database existence and size information
 */
export function checkSqliteDb(projectRoot: string): CheckResult {
  const cleoDir = join(projectRoot, '.cleo');
  const dbPath = join(cleoDir, 'tasks.db');

  if (!existsSync(dbPath)) {
    return {
      id: 'sqlite_db',
      category: 'scaffold',
      status: 'failed',
      message: 'tasks.db not found',
      details: { path: dbPath, exists: false },
      fix: 'cleo init',
    };
  }

  const stat = statSync(dbPath);
  if (stat.size === 0) {
    return {
      id: 'sqlite_db',
      category: 'scaffold',
      status: 'warning',
      message: 'tasks.db exists but is empty (0 bytes)',
      details: { path: dbPath, exists: true, size: 0 },
      fix: 'cleo upgrade',
    };
  }

  return {
    id: 'sqlite_db',
    category: 'scaffold',
    status: 'passed',
    message: `tasks.db exists (${stat.size} bytes)`,
    details: { path: dbPath, exists: true, size: stat.size },
    fix: null,
  };
}

/**
 * Verify .cleo/brain.db exists and is non-empty.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Check result with database existence and size information
 */
export function checkBrainDb(projectRoot: string): CheckResult {
  const cleoDir = join(projectRoot, '.cleo');
  const dbPath = join(cleoDir, 'brain.db');

  if (!existsSync(dbPath)) {
    return {
      id: 'brain_db',
      category: 'scaffold',
      status: 'failed',
      message: 'brain.db not found',
      details: { path: dbPath, exists: false },
      fix: 'cleo init',
    };
  }

  const stat = statSync(dbPath);
  if (stat.size === 0) {
    return {
      id: 'brain_db',
      category: 'scaffold',
      status: 'warning',
      message: 'brain.db exists but is empty (0 bytes)',
      details: { path: dbPath, exists: true, size: 0 },
      fix: 'cleo upgrade',
    };
  }

  return {
    id: 'brain_db',
    category: 'scaffold',
    status: 'passed',
    message: `brain.db exists (${stat.size} bytes)`,
    details: { path: dbPath, exists: true, size: stat.size },
    fix: null,
  };
}

/**
 * Verify .cleo/memory-bridge.md exists.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Check result indicating presence of the memory bridge file
 */
export function checkMemoryBridge(projectRoot: string): CheckResult {
  const cleoDir = join(projectRoot, '.cleo');
  const bridgePath = join(cleoDir, 'memory-bridge.md');

  if (!existsSync(bridgePath)) {
    return {
      id: 'memory_bridge',
      category: 'scaffold',
      status: 'warning',
      message: 'memory-bridge.md not found',
      details: { path: bridgePath, exists: false },
      fix: 'cleo init or cleo refresh-memory',
    };
  }

  return {
    id: 'memory_bridge',
    category: 'scaffold',
    status: 'passed',
    message: 'memory-bridge.md exists',
    details: { path: bridgePath, exists: true },
    fix: null,
  };
}

/**
 * Verify .cleo/nexus-bridge.md exists.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Check result indicating presence of the nexus bridge file
 */
export function checkNexusBridge(projectRoot: string): CheckResult {
  const cleoDir = join(projectRoot, '.cleo');
  const bridgePath = join(cleoDir, 'nexus-bridge.md');

  if (!existsSync(bridgePath)) {
    return {
      id: 'nexus_bridge',
      category: 'scaffold',
      status: 'warning',
      message: 'nexus-bridge.md not found',
      details: { path: bridgePath, exists: false },
      fix: 'cleo nexus analyze',
    };
  }

  return {
    id: 'nexus_bridge',
    category: 'scaffold',
    status: 'passed',
    message: 'nexus-bridge.md exists',
    details: { path: bridgePath, exists: true },
    fix: null,
  };
}

/**
 * Check that the project log directory exists.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Check result indicating whether .cleo/logs/ is present
 */
export function checkLogDir(projectRoot: string): CheckResult {
  return join(join(projectRoot, '.cleo'), 'logs');

  if (!existsSync(logDir)) {
    return {
      id: 'log_dir',
      category: 'scaffold',
      status: 'warning',
      message: 'Log directory .cleo/logs/ not found',
      details: { path: logDir, exists: false },
      fix: 'cleo upgrade',
    };
  }

  return {
    id: 'log_dir',
    category: 'scaffold',
    status: 'passed',
    message: 'Log directory .cleo/logs/ present',
    details: { path: logDir, exists: true },
    fix: null,
  };
}
