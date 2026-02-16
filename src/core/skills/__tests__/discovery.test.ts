/**
 * Tests for skill discovery and path resolution.
 * @task T4522
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseFrontmatter,
  discoverSkill,
  discoverSkillsInDir,
  discoverAllSkills,
  findSkill,
  mapSkillName,
  listCanonicalSkillNames,
  toSkillSummary,
  generateManifest,
  getSkillSearchPaths,
} from '../discovery.js';

// Test helpers
let testDir: string;

function createTestDir(): string {
  const dir = join(tmpdir(), `cleo-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createSkill(dir: string, name: string, frontmatter: string, body: string = ''): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`);
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

describe('parseFrontmatter', () => {
  it('should parse basic key-value pairs', () => {
    const content = '---\nname: test-skill\ndescription: A test skill\nversion: 1.0.0\n---\nBody content';
    const fm = parseFrontmatter(content);

    expect(fm.name).toBe('test-skill');
    expect(fm.description).toBe('A test skill');
    expect(fm.version).toBe('1.0.0');
  });

  it('should parse boolean values', () => {
    const content = '---\nname: test\ndescription: test\ninvocable: true\n---';
    const fm = parseFrontmatter(content);

    expect(fm.invocable).toBe(true);
  });

  it('should parse list values', () => {
    const content = '---\nname: test\ndescription: test\ntags:\n  - research\n  - analysis\n---';
    const fm = parseFrontmatter(content);

    expect(fm.tags).toEqual(['research', 'analysis']);
  });

  it('should return empty for content without frontmatter', () => {
    const content = 'No frontmatter here';
    const fm = parseFrontmatter(content);

    expect(fm.name).toBe('');
    expect(fm.description).toBe('');
  });

  it('should parse numeric values', () => {
    const content = '---\nname: test\ndescription: test\ndispatchPriority: 5\n---';
    const fm = parseFrontmatter(content);

    expect(fm.dispatchPriority).toBe(5);
  });

  it('should strip quotes from values', () => {
    const content = '---\nname: "quoted-name"\ndescription: \'quoted desc\'\n---';
    const fm = parseFrontmatter(content);

    expect(fm.name).toBe('quoted-name');
    expect(fm.description).toBe('quoted desc');
  });
});

describe('discoverSkill', () => {
  it('should discover a skill with SKILL.md', () => {
    createSkill(testDir, 'ct-test', 'name: test\ndescription: Test skill');
    const skill = discoverSkill(join(testDir, 'ct-test'));

    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('test');
    expect(skill!.dirName).toBe('ct-test');
    expect(skill!.frontmatter.description).toBe('Test skill');
  });

  it('should return null for directory without SKILL.md', () => {
    mkdirSync(join(testDir, 'no-skill'), { recursive: true });
    const skill = discoverSkill(join(testDir, 'no-skill'));

    expect(skill).toBeNull();
  });

  it('should return null for non-existent directory', () => {
    const skill = discoverSkill(join(testDir, 'nonexistent'));
    expect(skill).toBeNull();
  });
});

describe('discoverSkillsInDir', () => {
  it('should discover all skills in a directory', () => {
    createSkill(testDir, 'ct-skill-a', 'name: Skill A\ndescription: First');
    createSkill(testDir, 'ct-skill-b', 'name: Skill B\ndescription: Second');
    mkdirSync(join(testDir, 'not-a-skill'), { recursive: true }); // No SKILL.md

    const skills = discoverSkillsInDir(testDir);

    expect(skills).toHaveLength(2);
    expect(skills.map(s => s.dirName).sort()).toEqual(['ct-skill-a', 'ct-skill-b']);
  });

  it('should skip hidden directories', () => {
    createSkill(testDir, '.hidden-skill', 'name: Hidden\ndescription: should be hidden');
    createSkill(testDir, 'ct-visible', 'name: Visible\ndescription: should be found');

    const skills = discoverSkillsInDir(testDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].dirName).toBe('ct-visible');
  });

  it('should skip _shared directory', () => {
    createSkill(testDir, '_shared', 'name: Shared\ndescription: should be hidden');
    createSkill(testDir, 'ct-visible', 'name: Visible\ndescription: should be found');

    const skills = discoverSkillsInDir(testDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].dirName).toBe('ct-visible');
  });

  it('should return empty for non-existent directory', () => {
    const skills = discoverSkillsInDir(join(testDir, 'nonexistent'));
    expect(skills).toHaveLength(0);
  });
});

describe('mapSkillName', () => {
  it('should map canonical names', () => {
    expect(mapSkillName('ct-task-executor')).toEqual({ canonical: 'ct-task-executor', mapped: true });
  });

  it('should map user-friendly names', () => {
    expect(mapSkillName('research')).toEqual({ canonical: 'ct-research-agent', mapped: true });
    expect(mapSkillName('RESEARCH')).toEqual({ canonical: 'ct-research-agent', mapped: true });
  });

  it('should normalize unknown names with ct- prefix', () => {
    expect(mapSkillName('custom-skill')).toEqual({ canonical: 'ct-custom-skill', mapped: false });
  });

  it('should not double-prefix', () => {
    expect(mapSkillName('ct-already-prefixed')).toEqual({ canonical: 'ct-already-prefixed', mapped: false });
  });

  it('should handle uppercase variants', () => {
    expect(mapSkillName('TASK-EXECUTOR')).toEqual({ canonical: 'ct-task-executor', mapped: true });
    expect(mapSkillName('ORCHESTRATOR')).toEqual({ canonical: 'ct-orchestrator', mapped: true });
  });
});

describe('listCanonicalSkillNames', () => {
  it('should return unique canonical names', () => {
    const names = listCanonicalSkillNames();
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length); // All unique
    expect(names).toContain('ct-task-executor');
    expect(names).toContain('ct-research-agent');
  });
});

describe('toSkillSummary', () => {
  it('should convert skill to summary', () => {
    createSkill(testDir, 'ct-test', 'name: Test\ndescription: Test desc\nversion: 1.2.3\ntags:\n  - research');
    const skill = discoverSkill(join(testDir, 'ct-test'))!;
    const summary = toSkillSummary(skill);

    expect(summary.name).toBe('Test');
    expect(summary.description).toBe('Test desc');
    expect(summary.version).toBe('1.2.3');
    expect(summary.tags).toEqual(['research']);
    expect(summary.invocable).toBe(false);
  });
});

describe('getSkillSearchPaths', () => {
  it('should return ordered search paths', () => {
    const paths = getSkillSearchPaths(testDir);

    expect(paths.length).toBeGreaterThanOrEqual(4);
    // Should be in priority order
    for (let i = 1; i < paths.length; i++) {
      expect(paths[i].priority).toBeGreaterThanOrEqual(paths[i - 1].priority);
    }
  });
});
