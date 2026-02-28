/**
 * Tests for gitignore integrity, vital files, core file protection,
 * and legacy agent-outputs doctor checks.
 * @task T4700
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkCleoGitignore,
  checkVitalFilesTracked,
  checkCoreFilesNotIgnored,
  checkLegacyAgentOutputs,
} from '../doctor/checks.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `cleo-doctor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('checkCleoGitignore', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('warns when .cleo/.gitignore does not exist', () => {
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    const result = checkCleoGitignore(tempDir);
    expect(result.status).toBe('warning');
    expect(result.id).toBe('cleo_gitignore');
  });

  it('passes when .cleo/.gitignore exists (even without template)', () => {
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    writeFileSync(join(tempDir, '.cleo', '.gitignore'), '# some content\n');
    const result = checkCleoGitignore(tempDir);
    // Either 'passed' (can't compare) or 'warning' (drifted)
    expect(['passed', 'warning']).toContain(result.status);
  });
});

describe('checkVitalFilesTracked', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns info status when not a git repo', () => {
    const result = checkVitalFilesTracked(tempDir);
    expect(result.status).toBe('info');
    expect(result.id).toBe('vital_files_tracked');
  });
});

/** Create a temp dir that is a real git repo. */
function makeTempGitRepo(): string {
  const dir = makeTempDir();
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  // Need at least one commit for git check-ignore to work reliably
  writeFileSync(join(dir, '.gitkeep'), '');
  execFileSync('git', ['add', '.gitkeep'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('checkCoreFilesNotIgnored', () => {
  let tempDir: string;

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns info status when not a git repo', () => {
    tempDir = makeTempDir();
    const result = checkCoreFilesNotIgnored(tempDir);
    expect(result.status).toBe('info');
    expect(result.id).toBe('core_files_not_ignored');
  });

  it('passes when core files exist and are not ignored', () => {
    tempDir = makeTempGitRepo();
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    writeFileSync(join(tempDir, '.cleo', 'tasks.db'), '');
    writeFileSync(join(tempDir, '.cleo', 'config.json'), '{}');
    const result = checkCoreFilesNotIgnored(tempDir);
    expect(result.status).toBe('passed');
  });

  it('detects when a core file is gitignored', () => {
    tempDir = makeTempGitRepo();
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    writeFileSync(join(tempDir, '.cleo', 'tasks.db'), '');
    // Add a gitignore rule that ignores tasks.db
    writeFileSync(join(tempDir, '.gitignore'), '.cleo/tasks.db\n');
    const result = checkCoreFilesNotIgnored(tempDir);
    expect(result.status).toBe('failed');
    expect(result.message).toContain('tasks.db');
    expect(result.details.ignoredFiles).toContain('.cleo/tasks.db');
  });

  it('detects when .cleo/.gitignore ignores a core file', () => {
    tempDir = makeTempGitRepo();
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    writeFileSync(join(tempDir, '.cleo', 'config.json'), '{}');
    // Use .cleo/.gitignore to ignore config.json
    writeFileSync(join(tempDir, '.cleo', '.gitignore'), 'config.json\n');
    const result = checkCoreFilesNotIgnored(tempDir);
    expect(result.status).toBe('failed');
    expect(result.details.ignoredFiles).toContain('.cleo/config.json');
  });

  it('passes when non-existent files are in the protected list', () => {
    tempDir = makeTempGitRepo();
    // .cleo dir exists but no files inside — should pass (nothing to check)
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    const result = checkCoreFilesNotIgnored(tempDir);
    expect(result.status).toBe('passed');
  });
});

describe('checkLegacyAgentOutputs', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('passes when no legacy directory exists', () => {
    const result = checkLegacyAgentOutputs(tempDir);
    expect(result.status).toBe('passed');
    expect(result.id).toBe('legacy_agent_outputs');
  });

  it('warns when legacy claudedocs/agent-outputs/ exists', () => {
    mkdirSync(join(tempDir, 'claudedocs', 'agent-outputs'), { recursive: true });
    const result = checkLegacyAgentOutputs(tempDir);
    expect(result.status).toBe('warning');
    expect(result.message).toContain('Legacy');
    expect(result.fix).toBe('cleo upgrade');
  });
});
