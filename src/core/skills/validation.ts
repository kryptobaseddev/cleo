/**
 * Skill validation functions.
 * Ports lib/skills/skill-validate.sh.
 *
 * Validates skill structure, frontmatter requirements, and protocol compliance.
 *
 * @epic T4454
 * @task T4517
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { SkillFrontmatter } from './types.js';
import { parseFrontmatter } from './discovery.js';

// ============================================================================
// Validation Types
// ============================================================================

/** Validation issue severity. */
export type IssueSeverity = 'error' | 'warning' | 'info';

/** Single validation issue. */
export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  path?: string;
}

/** Validation result for a skill. */
export interface SkillValidationResult {
  valid: boolean;
  skillName: string;
  skillPath: string;
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
}

// ============================================================================
// Structural Validation
// ============================================================================

/** Valid protocol types for validation. */
const VALID_PROTOCOLS: Set<string> = new Set<string>([
  'research', 'consensus', 'specification', 'decomposition',
  'implementation', 'contribution', 'release', 'artifact-publish', 'provenance',
]);

/**
 * Validate a skill directory structure and content.
 * @task T4517
 */
export function validateSkill(skillDir: string): SkillValidationResult {
  const issues: ValidationIssue[] = [];
  const dirName = basename(skillDir);

  // Check directory exists
  if (!existsSync(skillDir)) {
    issues.push({
      severity: 'error',
      code: 'SKILL_DIR_NOT_FOUND',
      message: `Skill directory not found: ${skillDir}`,
    });
    return buildResult(dirName, skillDir, issues);
  }

  // Check SKILL.md exists
  const skillMdPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    issues.push({
      severity: 'error',
      code: 'SKILL_MD_MISSING',
      message: 'SKILL.md not found in skill directory',
      path: skillMdPath,
    });
    return buildResult(dirName, skillDir, issues);
  }

  // Parse and validate frontmatter
  const content = readFileSync(skillMdPath, 'utf-8');
  const fm = parseFrontmatter(content);

  validateFrontmatter(fm, issues, skillMdPath);

  // Check naming convention
  if (!dirName.startsWith('ct-') && !dirName.startsWith('_')) {
    issues.push({
      severity: 'warning',
      code: 'NAMING_CONVENTION',
      message: `Skill directory should use ct- prefix: ${dirName}`,
    });
  }

  // Check for optional files
  const optionalFiles = ['README.md', 'references'];
  for (const file of optionalFiles) {
    const filePath = join(skillDir, file);
    if (!existsSync(filePath)) {
      issues.push({
        severity: 'info',
        code: 'OPTIONAL_MISSING',
        message: `Optional file/dir not found: ${file}`,
        path: filePath,
      });
    }
  }

  return buildResult(dirName, skillDir, issues);
}

/**
 * Validate skill frontmatter content.
 * @task T4517
 */
function validateFrontmatter(
  fm: SkillFrontmatter,
  issues: ValidationIssue[],
  path: string,
): void {
  // Required fields
  if (!fm.name) {
    issues.push({
      severity: 'error',
      code: 'FM_NAME_MISSING',
      message: 'Frontmatter missing required "name" field',
      path,
    });
  }

  if (!fm.description) {
    issues.push({
      severity: 'error',
      code: 'FM_DESCRIPTION_MISSING',
      message: 'Frontmatter missing required "description" field',
      path,
    });
  }

  // Protocol validation
  if (fm.protocol && !VALID_PROTOCOLS.has(fm.protocol)) {
    issues.push({
      severity: 'error',
      code: 'FM_INVALID_PROTOCOL',
      message: `Invalid protocol type: ${fm.protocol}. Valid: ${[...VALID_PROTOCOLS].join(', ')}`,
      path,
    });
  }

  // Version format
  if (fm.version && !/^\d+\.\d+\.\d+/.test(fm.version)) {
    issues.push({
      severity: 'warning',
      code: 'FM_VERSION_FORMAT',
      message: `Version should be X.Y.Z or YYYY.M.patch format: ${fm.version}`,
      path,
    });
  }

  // Invocable skills must have a command
  if (fm.invocable && !fm.command) {
    issues.push({
      severity: 'warning',
      code: 'FM_INVOCABLE_NO_COMMAND',
      message: 'Invocable skill should define a "command" field',
      path,
    });
  }
}

/**
 * Validate multiple skills at once.
 * @task T4517
 */
export function validateSkills(skillDirs: string[]): SkillValidationResult[] {
  return skillDirs.map(validateSkill);
}

/**
 * Validate a return message against protocol-compliant patterns.
 * @task T4517
 */
export function validateReturnMessage(message: string): { valid: boolean; error?: string } {
  const validPatterns = [
    /^Research complete\. See MANIFEST\.jsonl for summary\.$/,
    /^Epic created\. See MANIFEST\.jsonl for summary\.$/,
    /^Tests complete\. See MANIFEST\.jsonl for summary\.$/,
    /^Documentation complete\. See MANIFEST\.jsonl for summary\.$/,
    /^Task complete\. See MANIFEST\.jsonl for summary\.$/,
    /^\[.+\] complete\. See MANIFEST\.jsonl for summary\.$/,
    /^\[.+\] partial\. See MANIFEST\.jsonl for details\.$/,
    /^\[.+\] blocked\. See MANIFEST\.jsonl for blocker details\.$/,
  ];

  const trimmed = message.trim();
  if (!trimmed) {
    return { valid: false, error: 'Return message is empty' };
  }

  for (const pattern of validPatterns) {
    if (pattern.test(trimmed)) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    error: `Return message does not match protocol format: "${trimmed.slice(0, 100)}"`,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function buildResult(
  skillName: string,
  skillPath: string,
  issues: ValidationIssue[],
): SkillValidationResult {
  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;

  return {
    valid: errorCount === 0,
    skillName,
    skillPath,
    issues,
    errorCount,
    warningCount,
  };
}
