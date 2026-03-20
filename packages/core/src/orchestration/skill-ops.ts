/**
 * Skill listing and injection operations.
 * @task T4784
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCanonicalSkillsDir } from '@cleocode/caamp';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

export interface SkillEntry {
  name: string;
  path: string;
  hasSkillFile: boolean;
  description: string;
}

export interface SkillContent {
  skill: string;
  content: string;
  contentLength: number;
  estimatedTokens: number;
  references: Array<{ name: string; path: string }>;
  path: string;
}

/** List available skills from canonical and project-local directories. */
export function listSkills(projectRoot: string): { skills: SkillEntry[]; total: number } {
  const seen = new Set<string>();
  const allSkills: SkillEntry[] = [];

  // Scan a skills directory and collect entries
  function scanSkillsDir(dir: string): void {
    if (!existsSync(dir)) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const d of entries) {
        if (!d.isDirectory() || d.name.startsWith('_') || seen.has(d.name)) continue;
        seen.add(d.name);

        const skillPath = join(dir, d.name, 'SKILL.md');
        let description = '';

        if (existsSync(skillPath)) {
          try {
            const content = readFileSync(skillPath, 'utf-8');
            const descMatch = content.match(/description:\s*[|>]?\s*\n?\s*(.+)/);
            if (descMatch) {
              description = descMatch[1]!.trim();
            }
          } catch {
            // ignore
          }
        }

        allSkills.push({
          name: d.name,
          path: join(dir, d.name),
          hasSkillFile: existsSync(skillPath),
          description,
        });
      }
    } catch {
      // ignore unreadable directories
    }
  }

  // 1. Scan project-local skills (higher priority, listed first)
  scanSkillsDir(join(projectRoot, '.cleo', 'skills'));

  // 2. Scan canonical (global) skills
  scanSkillsDir(getCanonicalSkillsDir());

  return { skills: allSkills, total: allSkills.length };
}

/** Read skill content for injection into agent context. Checks project-local skills first. */
export function getSkillContent(skillName: string, projectRoot: string): SkillContent {
  if (!skillName) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'skill name is required');
  }

  // Check project-local skills first, then canonical
  const projectSkillDir = join(projectRoot, '.cleo', 'skills', skillName);
  const canonicalSkillDir = join(getCanonicalSkillsDir(), skillName);
  const skillDir = existsSync(projectSkillDir) ? projectSkillDir : canonicalSkillDir;

  if (!existsSync(skillDir)) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Skill '${skillName}' not found at ${canonicalSkillDir} or ${projectSkillDir}`,
    );
  }

  const skillFilePath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFilePath)) {
    throw new CleoError(ExitCode.NOT_FOUND, `Skill file not found: ${skillFilePath}`);
  }

  const content = readFileSync(skillFilePath, 'utf-8');

  // Check for reference files
  const refsDir = join(skillDir, 'references');
  let references: Array<{ name: string; path: string }> = [];
  if (existsSync(refsDir)) {
    try {
      references = readdirSync(refsDir)
        .filter((f) => f.endsWith('.md') || f.endsWith('.txt'))
        .map((f) => ({
          name: f,
          path: join(skillDir, 'references', f),
        }));
    } catch {
      // ignore
    }
  }

  return {
    skill: skillName,
    content,
    contentLength: content.length,
    estimatedTokens: Math.ceil(content.length / 4),
    references,
    path: skillFilePath,
  };
}
