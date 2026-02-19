/**
 * Tests for init --detect and NEXUS auto-registration.
 * @task T4700
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectProjectType } from '../../../store/project-detect.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `cleo-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('detectProjectType', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('detects Node.js project', () => {
    writeFileSync(join(tempDir, 'package.json'), '{}');
    const info = detectProjectType(tempDir);
    expect(info.type).toBe('node');
    expect(info.packageManager).toBe('npm');
  });

  it('detects Node.js with TypeScript', () => {
    writeFileSync(join(tempDir, 'package.json'), '{}');
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    const info = detectProjectType(tempDir);
    expect(info.type).toBe('node');
    expect(info.hasTypeScript).toBe(true);
  });

  it('detects vitest test framework', () => {
    writeFileSync(join(tempDir, 'package.json'), '{}');
    writeFileSync(join(tempDir, 'vitest.config.ts'), '{}');
    const info = detectProjectType(tempDir);
    expect(info.testFramework).toBe('vitest');
  });

  it('detects Python project', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '');
    const info = detectProjectType(tempDir);
    expect(info.type).toBe('python');
    expect(info.testFramework).toBe('pytest');
  });

  it('returns unknown for empty directory', () => {
    const info = detectProjectType(tempDir);
    expect(info.type).toBe('unknown');
    expect(info.testFramework).toBe('unknown');
  });
});

describe('getGitignoreTemplate', () => {
  it('returns gitignore content', async () => {
    const { getGitignoreTemplate } = await import('../init.js');
    const template = getGitignoreTemplate();
    expect(template).toContain('CLEO Project Data');
    expect(template).toContain('agent-outputs/');
  });
});
