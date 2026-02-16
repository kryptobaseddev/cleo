/**
 * Multi-source skill path resolver for CAAMP integration.
 * Ported from lib/skills/skill-paths.sh
 *
 * Resolves skills, protocols, and shared resources from multiple locations.
 * Supports CAAMP canonical paths, project-embedded paths, and explicit overrides.
 *
 * Priority order:
 * 1. CLEO_SKILL_PATH entries (explicit overrides, highest priority)
 * 2. Source-determined paths based on CLEO_SKILL_SOURCE
 *
 * @task T4552
 * @epic T4545
 */

import { existsSync, lstatSync, realpathSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Source type classification for a skill directory. */
export type SkillSourceType = 'embedded' | 'caamp' | 'project-link' | 'global-link';

/** Skill source mode. */
export type SkillSourceMode = 'auto' | 'caamp' | 'embedded';

/** Search path entry with its origin. */
export interface SkillSearchPath {
  path: string;
  origin: 'override' | 'caamp' | 'embedded';
}

/**
 * Get the CAAMP canonical skill location.
 * @task T4552
 */
function getCaampCanonical(): string {
  const agentsHome = process.env['AGENTS_HOME'] ?? join(homedir(), '.agents');
  return join(agentsHome, 'skills');
}

/**
 * Get the project-embedded skill location.
 * @task T4552
 */
function getProjectEmbedded(projectRoot?: string): string {
  const root = projectRoot ?? process.cwd();
  return join(root, 'skills');
}

/**
 * Get the project root directory.
 * @task T4552
 */
function getProjectRoot(cwd?: string): string {
  return cwd ?? process.cwd();
}

/**
 * Safely resolve to a real path.
 * @task T4552
 */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Get ordered skill search paths based on configuration.
 *
 * Priority:
 * 1. CLEO_SKILL_PATH entries (colon-separated, explicit overrides)
 * 2. Source-determined paths based on CLEO_SKILL_SOURCE
 *
 * CLEO_SKILL_SOURCE modes:
 * - auto: CAAMP canonical + embedded (default)
 * - caamp: CAAMP canonical only
 * - embedded: Project embedded only
 *
 * @task T4552
 */
export function getSkillSearchPaths(projectRoot?: string): SkillSearchPath[] {
  const sourceMode = (process.env['CLEO_SKILL_SOURCE'] ?? 'auto') as SkillSourceMode;
  const paths: SkillSearchPath[] = [];

  // Explicit override paths get highest priority
  const overridePaths = process.env['CLEO_SKILL_PATH'];
  if (overridePaths) {
    for (const p of overridePaths.split(':')) {
      if (p && existsSync(p)) {
        paths.push({ path: p, origin: 'override' });
      }
    }
  }

  const caampDir = getCaampCanonical();
  const embeddedDir = getProjectEmbedded(projectRoot);

  // Source-determined paths
  switch (sourceMode) {
    case 'caamp':
      if (existsSync(caampDir)) {
        paths.push({ path: caampDir, origin: 'caamp' });
      }
      break;
    case 'embedded':
      if (existsSync(embeddedDir)) {
        paths.push({ path: embeddedDir, origin: 'embedded' });
      }
      break;
    case 'auto':
    default:
      // CAAMP first (external package takes precedence), then embedded
      if (existsSync(caampDir)) {
        paths.push({ path: caampDir, origin: 'caamp' });
      }
      if (existsSync(embeddedDir)) {
        paths.push({ path: embeddedDir, origin: 'embedded' });
      }
      break;
  }

  return paths;
}

/**
 * Resolve a skill directory containing SKILL.md.
 * Searches all paths from getSkillSearchPaths() in priority order.
 * First match wins.
 *
 * @task T4552
 */
export function resolveSkillPath(skillName: string, projectRoot?: string): string | null {
  const searchPaths = getSkillSearchPaths(projectRoot);

  for (const { path: searchPath } of searchPaths) {
    const candidate = join(searchPath, skillName);
    if (existsSync(join(candidate, 'SKILL.md'))) {
      return safeRealpath(candidate);
    }
  }

  return null;
}

/**
 * Resolve a protocol .md file.
 *
 * Search order per base path:
 * 1. {base}/_ct-skills-protocols/{protocol_name}.md (Strategy B shared dir)
 * 2. {PROJECT_ROOT}/protocols/{protocol_name}.md (legacy embedded fallback)
 *
 * @task T4552
 */
export function resolveProtocolPath(
  protocolName: string,
  projectRoot?: string,
): string | null {
  const searchPaths = getSkillSearchPaths(projectRoot);

  // Search Strategy B shared directories in each base path
  for (const { path: searchPath } of searchPaths) {
    const candidate = join(searchPath, '_ct-skills-protocols', `${protocolName}.md`);
    if (existsSync(candidate)) {
      return safeRealpath(candidate);
    }
  }

  // Legacy fallback: project root protocols directory
  const root = getProjectRoot(projectRoot);
  const legacy = join(root, 'protocols', `${protocolName}.md`);
  if (existsSync(legacy)) {
    return safeRealpath(legacy);
  }

  return null;
}

/**
 * Resolve a shared resource .md file.
 *
 * Search order per base path:
 * 1. {base}/_ct-skills-shared/{resource_name}.md (Strategy B shared dir)
 * 2. {base}/_shared/{resource_name}.md (legacy embedded layout)
 *
 * @task T4552
 */
export function resolveSharedPath(
  resourceName: string,
  projectRoot?: string,
): string | null {
  const searchPaths = getSkillSearchPaths(projectRoot);

  for (const { path: searchPath } of searchPaths) {
    // Strategy B: _ct-skills-shared/ directory
    const candidate = join(searchPath, '_ct-skills-shared', `${resourceName}.md`);
    if (existsSync(candidate)) {
      return safeRealpath(candidate);
    }

    // Legacy: _shared/ directory within each base path
    const legacy = join(searchPath, '_shared', `${resourceName}.md`);
    if (existsSync(legacy)) {
      return safeRealpath(legacy);
    }
  }

  return null;
}

/**
 * Classify the source of a skill directory.
 *
 * Determines where a skill directory lives in the search hierarchy:
 * - "embedded": Within the project's skills/ directory
 * - "caamp": Within the CAAMP canonical directory (~/.agents/skills)
 * - "project-link": Symlink pointing to project directory
 * - "global-link": Symlink pointing to CAAMP or external location
 *
 * @task T4552
 */
export function getSkillSourceType(
  skillDir: string,
  projectRoot?: string,
): SkillSourceType | null {
  const normalizedDir = safeRealpath(skillDir);
  const caampDir = safeRealpath(getCaampCanonical());
  const embeddedDir = getProjectEmbedded(projectRoot);
  const root = getProjectRoot(projectRoot);

  // Check if skill_dir is a symlink
  try {
    const stats = lstatSync(skillDir);
    if (stats.isSymbolicLink()) {
      const linkTarget = safeRealpath(readlinkSync(skillDir));

      // Symlink target under CAAMP = global-link
      if (linkTarget.startsWith(caampDir)) {
        return 'global-link';
      }

      // Symlink target under project = project-link
      if (linkTarget.startsWith(embeddedDir) || linkTarget.startsWith(root)) {
        return 'project-link';
      }

      // Symlink to somewhere else
      return 'global-link';
    }
  } catch {
    // If lstat fails, continue with directory-based classification
  }

  // Not a symlink - classify by containing directory
  if (normalizedDir.startsWith(resolve(embeddedDir)) || normalizedDir.startsWith(join(root, 'skills'))) {
    return 'embedded';
  }

  if (normalizedDir.startsWith(caampDir)) {
    return 'caamp';
  }

  // Could not classify (likely from explicit CLEO_SKILL_PATH override)
  return null;
}
