/**
 * Skill listing and injection operations.
 * @task T4784
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';

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

/** List available skills. */
export function listSkills(projectRoot: string): { skills: SkillEntry[]; total: number } {
  const skillsDir = join(projectRoot, 'skills');

  if (!existsSync(skillsDir)) {
    return { skills: [], total: 0 };
  }

  const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_'))
    .map(d => {
      const skillPath = join(skillsDir, d.name, 'SKILL.md');
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

      return {
        name: d.name,
        path: `skills/${d.name}`,
        hasSkillFile: existsSync(skillPath),
        description,
      };
    });

  return { skills: skillDirs, total: skillDirs.length };
}

/** Read skill content for injection into agent context. */
export function getSkillContent(skillName: string, projectRoot: string): SkillContent {
  if (!skillName) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'skill name is required');
  }

  const skillDir = join(projectRoot, 'skills', skillName);
  if (!existsSync(skillDir)) {
    throw new CleoError(ExitCode.NOT_FOUND, `Skill '${skillName}' not found at skills/${skillName}/`);
  }

  const skillFilePath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFilePath)) {
    throw new CleoError(ExitCode.NOT_FOUND, `Skill file not found: skills/${skillName}/SKILL.md`);
  }

  const content = readFileSync(skillFilePath, 'utf-8');

  // Check for reference files
  const refsDir = join(skillDir, 'references');
  let references: Array<{ name: string; path: string }> = [];
  if (existsSync(refsDir)) {
    try {
      references = readdirSync(refsDir)
        .filter(f => f.endsWith('.md') || f.endsWith('.txt'))
        .map(f => ({
          name: f,
          path: `skills/${skillName}/references/${f}`,
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
    path: `skills/${skillName}/SKILL.md`,
  };
}
