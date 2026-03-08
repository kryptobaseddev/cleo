/**
 * Tests for init --detect and NEXUS auto-registration.
 * @task T4700
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('detects Node.js project', () => {
    writeFileSync(join(tempDir, 'package.json'), '{}');
    const info = detectProjectType(tempDir);
    expect(info.primaryType).toBe('node');
    expect(info.projectTypes).toContain('node');
  });

  it('detects Node.js with TypeScript', () => {
    writeFileSync(join(tempDir, 'package.json'), '{}');
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    const info = detectProjectType(tempDir);
    expect(info.primaryType).toBe('node');
    expect(info.conventions?.typeSystem).toContain('TypeScript');
  });

  it('detects vitest test framework', () => {
    writeFileSync(join(tempDir, 'package.json'), '{}');
    writeFileSync(join(tempDir, 'vitest.config.ts'), '{}');
    const info = detectProjectType(tempDir);
    expect(info.testing?.framework).toBe('vitest');
  });

  it('detects Python project', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '');
    const info = detectProjectType(tempDir);
    expect(info.primaryType).toBe('python');
    expect(info.testing?.framework).toBe('pytest');
  });

  it('returns unknown for empty directory', () => {
    const info = detectProjectType(tempDir);
    expect(info.projectTypes).toContain('unknown');
    expect(info.testing?.framework).toBeUndefined();
  });

  it('detects polyglot project (Node + Rust)', () => {
    writeFileSync(join(tempDir, 'package.json'), '{}');
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "test"');
    const info = detectProjectType(tempDir);
    expect(info.projectTypes).toContain('node');
    expect(info.projectTypes).toContain('rust');
    expect(info.primaryType).toBe('node'); // first detected wins
  });

  it('includes schemaVersion', () => {
    const info = detectProjectType(tempDir);
    expect(info.schemaVersion).toBe('1.0.0');
  });

  it('includes detectedAt timestamp', () => {
    const info = detectProjectType(tempDir);
    expect(info.detectedAt).toBeDefined();
    expect(new Date(info.detectedAt).getTime()).not.toBeNaN();
  });

  it('detects bun package manager', () => {
    writeFileSync(join(tempDir, 'package.json'), '{}');
    writeFileSync(join(tempDir, 'bun.lockb'), '');
    const info = detectProjectType(tempDir);
    expect(info.llmHints?.avoidPatterns).toContain('Do not use npm or npx — this project uses bun');
  });
});

describe('getGitignoreTemplate', () => {
  it('returns gitignore content', async () => {
    const { getGitignoreTemplate } = await import('../init.js');
    const template = getGitignoreTemplate();
    expect(template).toContain('Deny-by-default');
    expect(template).toContain('agent-outputs/');
  });
});
