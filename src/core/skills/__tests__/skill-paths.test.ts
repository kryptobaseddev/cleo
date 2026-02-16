/**
 * Tests for skill paths resolver (skill-paths.ts).
 * @task T4552
 * @epic T4545
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:fs
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    lstatSync: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
    readlinkSync: vi.fn(),
  };
});

import { existsSync } from 'node:fs';
import { getSkillSearchPaths } from '../skill-paths.js';

describe('getSkillSearchPaths', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env vars
    delete process.env['CLEO_SKILL_SOURCE'];
    delete process.env['CLEO_SKILL_PATH'];
    delete process.env['AGENTS_HOME'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should return empty array when no directories exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const paths = getSkillSearchPaths('/tmp/project');
    expect(paths).toEqual([]);
  });

  it('should include CAAMP and embedded in auto mode when both exist', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    process.env['AGENTS_HOME'] = '/home/user/.agents';

    const paths = getSkillSearchPaths('/tmp/project');

    const origins = paths.map((p) => p.origin);
    expect(origins).toContain('caamp');
    expect(origins).toContain('embedded');
  });

  it('should respect CLEO_SKILL_SOURCE=caamp', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    process.env['CLEO_SKILL_SOURCE'] = 'caamp';
    process.env['AGENTS_HOME'] = '/home/user/.agents';

    const paths = getSkillSearchPaths('/tmp/project');

    const origins = paths.map((p) => p.origin);
    expect(origins).toContain('caamp');
    expect(origins).not.toContain('embedded');
  });

  it('should respect CLEO_SKILL_SOURCE=embedded', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    process.env['CLEO_SKILL_SOURCE'] = 'embedded';

    const paths = getSkillSearchPaths('/tmp/project');

    const origins = paths.map((p) => p.origin);
    expect(origins).not.toContain('caamp');
    expect(origins).toContain('embedded');
  });

  it('should put override paths first', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    process.env['CLEO_SKILL_PATH'] = '/custom/skills';
    process.env['AGENTS_HOME'] = '/home/user/.agents';

    const paths = getSkillSearchPaths('/tmp/project');

    expect(paths[0]?.origin).toBe('override');
    expect(paths[0]?.path).toBe('/custom/skills');
  });
});
