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
 * Convert YAML parser outputs into plain JSON-compatible values.
 *
 * gray-matter/js-yaml resolves implicit date scalars (for example
 * `released: 2026-05-25`) to Date instances. Hermes skill_view responses are
 * serialized as plain JSON across runtimes, so frontmatter metadata must not
 * expose Date objects.
 */
function toJsonCompatibleYamlValue(value: unknown): unknown {
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonCompatibleYamlValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJsonCompatibleYamlValue(item)]),
    );
  }

  return value;
}

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

    const normalizedMetadata = toJsonCompatibleYamlValue(data.metadata) as
      | Record<string, string>
      | undefined;
    const allowedTools = data['allowed-tools'] ?? data.allowedTools;
    const scalarString = (value: unknown): string | undefined => {
      if (value === undefined || value === null) return undefined;
      return String(toJsonCompatibleYamlValue(value));
    };

    return {
      name: scalarString(data.name) ?? '',
      description: scalarString(data.description) ?? '',
      license: scalarString(data.license),
      compatibility: scalarString(data.compatibility),
      metadata: normalizedMetadata,
      allowedTools:
        typeof allowedTools === 'string'
          ? allowedTools.split(/\s+/)
          : Array.isArray(allowedTools)
            ? allowedTools.map(String)
            : undefined,
      version: scalarString(data.version),
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
 * import { resolveSkillsRoot } from "@cleocode/core/skills/skill-root.js";
 * import { join } from "node:path";
 *
 * const skill = await discoverSkill(join(resolveSkillsRoot(), "my-skill"));
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
 * import { resolveSkillsRoot } from "@cleocode/core/skills/skill-root.js";
 *
 * const skills = await discoverSkills(resolveSkillsRoot());
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
