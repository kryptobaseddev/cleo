/**
 * Local skill discovery
 *
 * Scans directories for SKILL.md files and parses their frontmatter.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { SkillEntry, SkillMetadata } from '../../types.js';

/**
 * Parse a SKILL.md file and extract its frontmatter metadata.
 *
 * @remarks
 * Reads the file, parses YAML frontmatter via `gray-matter`, and maps the
 * fields to a {@link SkillMetadata} object. Returns `null` if the file cannot
 * be read or lacks required `name` and `description` fields.
 *
 * @param filePath - Absolute path to the SKILL.md file
 * @returns Parsed metadata, or `null` if invalid
 *
 * @example
 * ```typescript
 * const meta = await parseSkillFile("/path/to/SKILL.md");
 * if (meta) {
 *   console.log(`${meta.name}: ${meta.description}`);
 * }
 * ```
 *
 * @public
 */
export async function parseSkillFile(filePath: string): Promise<SkillMetadata | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const { data } = matter(content);

    if (!data.name || !data.description) {
      return null;
    }

    const allowedTools = data['allowed-tools'] ?? data.allowedTools;

    return {
      name: String(data.name),
      description: String(data.description),
      license: data.license ? String(data.license) : undefined,
      compatibility: data.compatibility ? String(data.compatibility) : undefined,
      metadata: data.metadata as Record<string, string> | undefined,
      allowedTools:
        typeof allowedTools === 'string'
          ? allowedTools.split(/\s+/)
          : Array.isArray(allowedTools)
            ? allowedTools.map(String)
            : undefined,
      version: data.version ? String(data.version) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Discover a single skill at a given directory path.
 *
 * @remarks
 * Checks for a `SKILL.md` file in the directory and parses its metadata.
 *
 * @param skillDir - Absolute path to a skill directory (containing SKILL.md)
 * @returns Skill entry with metadata, or `null` if no valid SKILL.md exists
 *
 * @example
 * ```typescript
 * import { getCanonicalSkillsDir } from "../paths/standard.js";
 * import { join } from "node:path";
 *
 * const skill = await discoverSkill(join(getCanonicalSkillsDir(), "my-skill"));
 * if (skill) {
 *   console.log(`Found: ${skill.name}`);
 * }
 * ```
 *
 * @public
 */
export async function discoverSkill(skillDir: string): Promise<SkillEntry | null> {
  const skillFile = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFile)) return null;

  const metadata = await parseSkillFile(skillFile);
  if (!metadata) return null;

  return {
    name: metadata.name,
    scopedName: metadata.name,
    path: skillDir,
    metadata,
  };
}

/**
 * Scan a directory for skill subdirectories, each containing a SKILL.md file.
 *
 * @remarks
 * Iterates over directories and symlinks in `rootDir` and calls
 * {@link discoverSkill} on each.
 *
 * @param rootDir - Absolute path to a skills root directory to scan
 * @returns Array of discovered skill entries
 *
 * @example
 * ```typescript
 * import { getCanonicalSkillsDir } from "../paths/standard.js";
 *
 * const skills = await discoverSkills(getCanonicalSkillsDir());
 * console.log(`Found ${skills.length} skills`);
 * ```
 *
 * @public
 */
export async function discoverSkills(rootDir: string): Promise<SkillEntry[]> {
  if (!existsSync(rootDir)) return [];

  const entries = await readdir(rootDir, { withFileTypes: true });
  const skills: SkillEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const skillDir = join(rootDir, entry.name);
    const skill = await discoverSkill(skillDir);
    if (skill) {
      skills.push(skill);
    }
  }

  return skills;
}

/**
 * Discover skills across multiple directories.
 *
 * @remarks
 * Scans each directory with {@link discoverSkills} and deduplicates results by
 * skill name, keeping the first occurrence found.
 *
 * @param dirs - Array of absolute paths to skills directories to scan
 * @returns Deduplicated array of discovered skill entries
 *
 * @example
 * ```typescript
 * const skills = await discoverSkillsMulti(["/home/user/.agents/skills", "./project-skills"]);
 * console.log(`Found ${skills.length} unique skills`);
 * ```
 *
 * @public
 */
export async function discoverSkillsMulti(dirs: string[]): Promise<SkillEntry[]> {
  const all: SkillEntry[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    const skills = await discoverSkills(dir);
    for (const skill of skills) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        all.push(skill);
      }
    }
  }

  return all;
}
