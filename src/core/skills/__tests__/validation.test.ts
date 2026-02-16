/**
 * Tests for skill validation.
 * @task T4522
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateSkill, validateReturnMessage, validateSkills } from '../validation.js';

let testDir: string;

function createTestDir(): string {
  const dir = join(tmpdir(), `cleo-validate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createSkill(dir: string, name: string, frontmatter: string): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\nBody`);
  return skillDir;
}

beforeEach(() => {
  testDir = createTestDir();
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('validateSkill', () => {
  it('should validate a well-formed skill', () => {
    const skillDir = createSkill(testDir, 'ct-good-skill', 'name: Good Skill\ndescription: A valid skill\nversion: 1.0.0');
    const result = validateSkill(skillDir);

    expect(result.valid).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  it('should report error for missing SKILL.md', () => {
    mkdirSync(join(testDir, 'ct-no-md'), { recursive: true });
    const result = validateSkill(join(testDir, 'ct-no-md'));

    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === 'SKILL_MD_MISSING')).toBe(true);
  });

  it('should report error for missing name', () => {
    const skillDir = createSkill(testDir, 'ct-no-name', 'description: Missing name');
    const result = validateSkill(skillDir);

    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === 'FM_NAME_MISSING')).toBe(true);
  });

  it('should report error for missing description', () => {
    const skillDir = createSkill(testDir, 'ct-no-desc', 'name: No Desc');
    const result = validateSkill(skillDir);

    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === 'FM_DESCRIPTION_MISSING')).toBe(true);
  });

  it('should warn about non-standard naming', () => {
    const skillDir = createSkill(testDir, 'bad-naming', 'name: Bad Naming\ndescription: No ct- prefix');
    const result = validateSkill(skillDir);

    expect(result.warningCount).toBeGreaterThan(0);
    expect(result.issues.some(i => i.code === 'NAMING_CONVENTION')).toBe(true);
  });

  it('should report error for non-existent directory', () => {
    const result = validateSkill(join(testDir, 'nonexistent'));

    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === 'SKILL_DIR_NOT_FOUND')).toBe(true);
  });

  it('should report error for invalid protocol', () => {
    const skillDir = createSkill(testDir, 'ct-bad-protocol', 'name: Bad Proto\ndescription: Test\nprotocol: invalid');
    const result = validateSkill(skillDir);

    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === 'FM_INVALID_PROTOCOL')).toBe(true);
  });
});

describe('validateSkills', () => {
  it('should validate multiple skills', () => {
    const dir1 = createSkill(testDir, 'ct-a', 'name: A\ndescription: Skill A');
    const dir2 = createSkill(testDir, 'ct-b', 'name: B\ndescription: Skill B');

    const results = validateSkills([dir1, dir2]);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.valid)).toBe(true);
  });
});

describe('validateReturnMessage', () => {
  it('should accept valid completion messages', () => {
    const valid = [
      'Research complete. See MANIFEST.jsonl for summary.',
      'Epic created. See MANIFEST.jsonl for summary.',
      'Tests complete. See MANIFEST.jsonl for summary.',
      'Documentation complete. See MANIFEST.jsonl for summary.',
      'Task complete. See MANIFEST.jsonl for summary.',
    ];

    for (const msg of valid) {
      expect(validateReturnMessage(msg).valid).toBe(true);
    }
  });

  it('should accept bracket-prefixed messages', () => {
    expect(validateReturnMessage('[Research] complete. See MANIFEST.jsonl for summary.').valid).toBe(true);
    expect(validateReturnMessage('[Implementation] partial. See MANIFEST.jsonl for details.').valid).toBe(true);
    expect(validateReturnMessage('[Release] blocked. See MANIFEST.jsonl for blocker details.').valid).toBe(true);
  });

  it('should reject empty messages', () => {
    expect(validateReturnMessage('').valid).toBe(false);
  });

  it('should reject invalid messages', () => {
    expect(validateReturnMessage('Done!').valid).toBe(false);
    expect(validateReturnMessage('I finished the task').valid).toBe(false);
  });
});
