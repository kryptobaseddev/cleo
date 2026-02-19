/**
 * Tests for gitignore integrity, vital files, and legacy agent-outputs doctor checks.
 * @task T4700
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkCleoGitignore,
  checkVitalFilesTracked,
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
