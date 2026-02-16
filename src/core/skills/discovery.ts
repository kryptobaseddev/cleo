/**
 * Skill discovery and path resolution.
 * Delegates canonical path resolution and standard discovery to @cleocode/caamp.
 * Keeps CLEO-specific discovery logic (local project skill scanning, name mapping).
 *
 * @epic T4454
 * @task T4516
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  getCanonicalSkillsDir,
} from '@cleocode/caamp';
import type {
  Skill,
  SkillFrontmatter,
  SkillSearchPath,
  SkillSummary,
  SkillManifest,
} from './types.js';
import { SKILL_NAME_MAP } from './types.js';
import { getCleoHome, getProjectRoot } from '../paths.js';

// ============================================================================
// CAAMP Search Path Resolution
// ============================================================================

/**
 * Build the CAAMP skill search paths in priority order.
 * Uses CAAMP's canonical path functions for standard locations.
 * @task T4516
 */
export function getSkillSearchPaths(cwd?: string): SkillSearchPath[] {
  const projectRoot = getProjectRoot(cwd);
  const cleoHome = getCleoHome();

  const paths: SkillSearchPath[] = [
    { scope: 'cleo-home', path: join(cleoHome, 'skills'), priority: 1 },
    { scope: 'agent-skills', path: getCanonicalSkillsDir(), priority: 2 },
    { scope: 'app-embedded', path: join(projectRoot, 'skills'), priority: 3 },
    { scope: 'project-custom', path: join(projectRoot, '.cleo', 'skills'), priority: 5 },
  ];

  // Include marketplace cache if configured
  const mpCacheDir = process.env['CLEO_SKILLS_MP_CACHE'] ??
    join(cleoHome, '.skills-cache');
  if (existsSync(mpCacheDir)) {
    paths.push({ scope: 'marketplace', path: mpCacheDir, priority: 4 });
  }

  return paths.sort((a, b) => a.priority - b.priority);
}

/**
 * Get the primary skills directory (app-embedded).
 * @task T4516
 */
export function getSkillsDir(cwd?: string): string {
  return join(getProjectRoot(cwd), 'skills');
}

/**
 * Get the shared skills resources directory.
 * @task T4516
 */
export function getSharedDir(cwd?: string): string {
  return join(getSkillsDir(cwd), '_shared');
}

// ============================================================================
// Skill Name Resolution
// ============================================================================

/**
 * Map a user-friendly skill name to the canonical ct-prefixed directory name.
 * Supports: UPPER-CASE, lower-case, with/without ct- prefix.
 * @task T4516
 */
export function mapSkillName(input: string): { canonical: string; mapped: boolean } {
  // Direct lookup in the map
  if (SKILL_NAME_MAP[input]) {
    return { canonical: SKILL_NAME_MAP[input], mapped: true };
  }

  // Try uppercase normalization
  const upperInput = input.toUpperCase().replace(/_/g, '-');
  if (SKILL_NAME_MAP[upperInput]) {
    return { canonical: SKILL_NAME_MAP[upperInput], mapped: true };
  }

  // Fallback: normalize to ct-prefixed lowercase
  let normalized = input.toLowerCase().replace(/_/g, '-');
  if (!normalized.startsWith('ct-')) {
    normalized = `ct-${normalized}`;
  }
  return { canonical: normalized, mapped: false };
}

/**
 * List all known canonical skill names (unique values from the map).
 * @task T4516
 */
export function listCanonicalSkillNames(): string[] {
  return [...new Set(Object.values(SKILL_NAME_MAP))];
}

// ============================================================================
// Frontmatter Parsing
// ============================================================================

/**
 * Parse YAML-like frontmatter from a SKILL.md file.
 * Handles the --- delimited header with key: value pairs.
 * @task T4516
 */
export function parseFrontmatter(content: string): SkillFrontmatter {
  const lines = content.split('\n');
  const result: Record<string, unknown> = {};

  if (lines[0]?.trim() !== '---') {
    return { name: '', description: '' };
  }

  let inFrontmatter = true;
  let currentKey = '';
  let currentList: string[] = [];
  let inList = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim() === '---') {
      // End of frontmatter
      if (inList && currentKey) {
        result[currentKey] = currentList;
      }
      inFrontmatter = false;
      break;
    }

    if (!inFrontmatter) break;

    // List item continuation
    if (line.match(/^\s+-\s+/) && inList) {
      currentList.push(line.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    // New key: value pair
    const kvMatch = line.match(/^(\w[\w_-]*):\s*(.*)/);
    if (kvMatch) {
      // Save previous list if any
      if (inList && currentKey) {
        result[currentKey] = currentList;
        inList = false;
      }

      const key = kvMatch[1];
      const value = kvMatch[2].trim();

      if (value === '' || value === '|') {
        // Start of list or multiline
        currentKey = key;
        currentList = [];
        inList = true;
      } else if (value === 'true' || value === 'false') {
        result[key] = value === 'true';
      } else if (/^\d+$/.test(value)) {
        result[key] = parseInt(value, 10);
      } else {
        result[key] = value.replace(/^["']|["']$/g, '');
      }
    }
  }

  // Convert known camelCase keys
  const fm = result as Record<string, unknown>;
  return {
    name: (fm['name'] as string) ?? '',
    description: (fm['description'] as string) ?? '',
    version: fm['version'] as string | undefined,
    author: fm['author'] as string | undefined,
    tags: fm['tags'] as string[] | undefined,
    triggers: fm['triggers'] as string[] | undefined,
    dispatchPriority: fm['dispatchPriority'] as number | undefined,
    model: fm['model'] as string | undefined,
    allowedTools: (fm['allowed_tools'] ?? fm['allowedTools']) as string[] | undefined,
    invocable: fm['invocable'] as boolean | undefined,
    command: fm['command'] as string | undefined,
    protocol: fm['protocol'] as SkillFrontmatter['protocol'],
  };
}

// ============================================================================
// Skill Discovery
// ============================================================================

/**
 * Discover a single skill from a directory.
 * Tries CAAMP's parseSkillFile first, falls back to local parsing.
 * @task T4516
 */
export function discoverSkill(skillDir: string): Skill | null {
  const skillMdPath = join(skillDir, 'SKILL.md');

  if (!existsSync(skillMdPath)) {
    return null;
  }

  const content = readFileSync(skillMdPath, 'utf-8');
  const frontmatter = parseFrontmatter(content);

  const dirName = basename(skillDir);
  return {
    name: frontmatter.name || dirName,
    dirName,
    path: skillDir,
    skillMdPath,
    frontmatter,
    content,
  };
}

/**
 * Discover all skills in a single directory.
 * Scans for subdirectories containing SKILL.md.
 * @task T4516
 */
export function discoverSkillsInDir(dir: string): Skill[] {
  if (!existsSync(dir)) {
    return [];
  }

  const skills: Skill[] = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      // Skip hidden dirs and _shared
      if (entry.startsWith('.') || entry.startsWith('_')) continue;

      const entryPath = join(dir, entry);
      try {
        if (statSync(entryPath).isDirectory()) {
          const skill = discoverSkill(entryPath);
          if (skill) {
            skills.push(skill);
          }
        }
      } catch {
        // Skip entries we can't stat
      }
    }
  } catch {
    // Directory not readable
  }

  return skills;
}

/**
 * Discover all skills across CAAMP search paths.
 * Returns skills in priority order (earlier paths take precedence).
 * @task T4516
 */
export function discoverAllSkills(cwd?: string): Skill[] {
  const searchPaths = getSkillSearchPaths(cwd);
  const seen = new Set<string>();
  const skills: Skill[] = [];

  for (const sp of searchPaths) {
    const found = discoverSkillsInDir(sp.path);
    for (const skill of found) {
      // First discovery wins (higher priority path)
      if (!seen.has(skill.dirName)) {
        seen.add(skill.dirName);
        skills.push(skill);
      }
    }
  }

  return skills;
}

/**
 * Find a specific skill by name across all search paths.
 * @task T4516
 */
export function findSkill(name: string, cwd?: string): Skill | null {
  const { canonical } = mapSkillName(name);
  const searchPaths = getSkillSearchPaths(cwd);

  for (const sp of searchPaths) {
    const skillDir = join(sp.path, canonical);
    const skill = discoverSkill(skillDir);
    if (skill) return skill;
  }

  // Try without ct- prefix (legacy)
  if (canonical.startsWith('ct-')) {
    const legacy = canonical.slice(3);
    for (const sp of searchPaths) {
      const skillDir = join(sp.path, legacy);
      const skill = discoverSkill(skillDir);
      if (skill) return skill;
    }
  }

  return null;
}

/**
 * Convert a Skill to a lightweight SkillSummary.
 * @task T4516
 */
export function toSkillSummary(skill: Skill): SkillSummary {
  return {
    name: skill.name,
    dirName: skill.dirName,
    description: skill.frontmatter.description,
    tags: skill.frontmatter.tags ?? [],
    version: skill.frontmatter.version ?? '0.0.0',
    invocable: skill.frontmatter.invocable ?? false,
    command: skill.frontmatter.command,
    protocol: skill.frontmatter.protocol,
  };
}

/**
 * Generate a skill manifest from discovered skills.
 * @task T4516
 */
export function generateManifest(cwd?: string): SkillManifest {
  const searchPaths = getSkillSearchPaths(cwd);
  const skills = discoverAllSkills(cwd);

  return {
    _meta: {
      generatedAt: new Date().toISOString(),
      ttlSeconds: 300,
      skillCount: skills.length,
      searchPaths: searchPaths.map(p => p.path),
    },
    skills: skills.map(toSkillSummary),
  };
}

/**
 * Resolve a skill template path (SKILL.md) by name.
 * @task T4516
 */
export function resolveTemplatePath(name: string, cwd?: string): string | null {
  const skill = findSkill(name, cwd);
  return skill?.skillMdPath ?? null;
}
