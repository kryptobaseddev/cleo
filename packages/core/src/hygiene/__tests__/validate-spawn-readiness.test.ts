/**
 * Unit tests for validate-spawn-readiness hygiene runner (T10451).
 *
 * @task T10451
 * @saga T10431
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { runSpawnReadinessHygiene } from '../validate-spawn-readiness.js';

describe('runSpawnReadinessHygiene', () => {
  const tmpDir = join(process.cwd(), 'tmp-hygiene-test');

  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns allPassed=false when CHANGELOG.md is missing', async () => {
    const result = await runSpawnReadinessHygiene(tmpDir);
    expect(result.allPassed).toBe(false);
    const changelogGate = result.gates.find((g) => g.name === 'changelog-drift');
    expect(changelogGate?.passed).toBe(false);
  });

  it('returns allPassed=false when CHANGELOG.md has no version header', async () => {
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\nSome text\n');
    const result = await runSpawnReadinessHygiene(tmpDir);
    expect(result.allPassed).toBe(false);
    const changelogGate = result.gates.find((g) => g.name === 'changelog-drift');
    expect(changelogGate?.passed).toBe(false);
  });

  it('passes changelog-drift when CHANGELOG.md has valid header', async () => {
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), '## [2026.5.120] (2026-05-24)\n\nChanges\n');
    const result = await runSpawnReadinessHygiene(tmpDir);
    const changelogGate = result.gates.find((g) => g.name === 'changelog-drift');
    expect(changelogGate?.passed).toBe(true);
  });

  it('skips worktree-location gate when no worktreePath provided', async () => {
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), '## [2026.5.120] (2026-05-24)\n\nChanges\n');
    const result = await runSpawnReadinessHygiene(tmpDir);
    const worktreeGate = result.gates.find((g) => g.name === 'worktree-location');
    expect(worktreeGate?.passed).toBe(true);
    expect(worktreeGate?.message).toContain('skipping');
  });

  it('fails worktree-location when cwd does not match expected path', async () => {
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), '## [2026.5.120] (2026-05-24)\n\nChanges\n');
    const result = await runSpawnReadinessHygiene(tmpDir, '/nonexistent/worktree');
    const worktreeGate = result.gates.find((g) => g.name === 'worktree-location');
    expect(worktreeGate?.passed).toBe(false);
  });

  it('includes checkedAt timestamp', async () => {
    const result = await runSpawnReadinessHygiene(tmpDir);
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
