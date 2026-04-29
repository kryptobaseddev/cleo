/**
 * Tests for the canonical release pipeline (T1597 / ADR-063).
 *
 * Covers:
 *   - Full pipeline happy path on a fixture project
 *   - releaseStart rejects mismatched version schemes (calver/semver/sha)
 *   - releaseVerify aggregates gate failures + ungreen child tasks
 *   - releasePublish reads `publish.command` from project-context
 *   - releasePublish honours dry-run (no exec)
 *   - releaseReconcile auto-completes shipped tasks and clears handle
 *   - branch detection never hard-codes "main"
 *
 * @task T1597
 * @adr ADR-063
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearInvariants, registerInvariant } from '../invariants/index.js';
import {
  loadActiveReleaseHandle,
  releasePublish,
  releaseReconcile,
  releaseStart,
  releaseVerify,
} from '../pipeline.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeFixtureProject(
  opts: { publishCommand?: string; versionScheme?: string; primaryType?: string } = {},
): string {
  const dir = join(
    tmpdir(),
    `cleo-release-pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, '.cleo'), { recursive: true });

  const ctx: Record<string, unknown> = {
    schemaVersion: '1.0.0',
    primaryType: opts.primaryType ?? 'node',
  };
  if (opts.publishCommand) {
    ctx.publish = { command: opts.publishCommand };
  }
  if (opts.versionScheme) {
    ctx.version = { scheme: opts.versionScheme };
  }
  writeFileSync(join(dir, '.cleo', 'project-context.json'), JSON.stringify(ctx, null, 2));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.1' }));

  // Initialize git so detectBranch resolves cleanly.
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    execFileSync('git', ['checkout', '-q', '-b', 'release/test'], { cwd: dir });
  } catch {
    // git unavailable in sandbox — pipeline falls back to "HEAD"
  }
  return dir;
}

// ---------------------------------------------------------------------------
// releaseStart
// ---------------------------------------------------------------------------

describe('releaseStart', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeFixtureProject();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists handle, normalizes version, derives tag', async () => {
    const handle = await releaseStart('2026.4.155', { projectRoot: dir });
    expect(handle.version).toBe('2026.4.155');
    expect(handle.tag).toBe('v2026.4.155');
    expect(handle.scheme).toBe('auto');
    expect(handle.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(existsSync(join(dir, '.cleo/release/handle.json'))).toBe(true);

    const reloaded = loadActiveReleaseHandle(dir);
    expect(reloaded.tag).toBe('v2026.4.155');
  });

  it('strips leading "v" before normalization', async () => {
    const handle = await releaseStart('v1.4.2', { projectRoot: dir });
    expect(handle.version).toBe('1.4.2');
    expect(handle.tag).toBe('v1.4.2');
  });

  it('respects branch override', async () => {
    const handle = await releaseStart('2026.4.156', {
      projectRoot: dir,
      branch: 'release/canary',
    });
    expect(handle.branch).toBe('release/canary');
  });

  it('rejects non-CalVer version under calver scheme', async () => {
    const cv = makeFixtureProject({ versionScheme: 'calver' });
    try {
      await expect(releaseStart('1.4.2', { projectRoot: cv })).rejects.toThrow(/CalVer/);
    } finally {
      rmSync(cv, { recursive: true, force: true });
    }
  });

  it('rejects non-SemVer version under semver scheme', async () => {
    const sv = makeFixtureProject({ versionScheme: 'semver' });
    try {
      await expect(releaseStart('2026.4.155', { projectRoot: sv })).rejects.toThrow(/SemVer/);
    } finally {
      rmSync(sv, { recursive: true, force: true });
    }
  });

  it('rejects non-SHA version under sha scheme', async () => {
    const sh = makeFixtureProject({ versionScheme: 'sha' });
    try {
      await expect(releaseStart('2026.4.155', { projectRoot: sh })).rejects.toThrow(/SHA/);
    } finally {
      rmSync(sh, { recursive: true, force: true });
    }
  });

  it('does not hard-code "main" — falls back to detected branch', async () => {
    const handle = await releaseStart('2026.4.155', { projectRoot: dir });
    expect(handle.branch).not.toBe('');
    expect(typeof handle.branch).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// releaseVerify
// ---------------------------------------------------------------------------

describe('releaseVerify', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeFixtureProject();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes when all gates green and no ungreen children', async () => {
    const handle = await releaseStart('2026.4.155', { projectRoot: dir, epicId: 'T-EPIC' });
    const result = await releaseVerify(handle, {
      runGate: async () => ({ passed: true }),
      auditChildren: async () => ({ examined: 3, ungreen: [] }),
    });
    expect(result.passed).toBe(true);
    expect(result.gates).toHaveLength(5);
    expect(result.gates.every((g) => g.passed)).toBe(true);
    expect(result.ungreenChildren).toEqual([]);
    expect(result.childrenExamined).toBe(3);
  });

  it('fails when any gate fails', async () => {
    const handle = await releaseStart('2026.4.155', { projectRoot: dir });
    const result = await releaseVerify(handle, {
      runGate: async (gate) => ({
        passed: gate !== 'lint',
        ...(gate === 'lint' ? { reason: 'biome found 3 issues' } : {}),
      }),
      auditChildren: async () => ({ examined: 0, ungreen: [] }),
    });
    expect(result.passed).toBe(false);
    const lint = result.gates.find((g) => g.gate === 'lint');
    expect(lint?.passed).toBe(false);
    expect(lint?.reason).toContain('biome');
  });

  it('rejects when child tasks have ungreen gates', async () => {
    const handle = await releaseStart('2026.4.155', { projectRoot: dir, epicId: 'T-EPIC' });
    const result = await releaseVerify(handle, {
      runGate: async () => ({ passed: true }),
      auditChildren: async () => ({
        examined: 5,
        ungreen: [
          { taskId: 'T100', missingGates: ['testsPassed'] },
          { taskId: 'T101', missingGates: ['qaPassed', 'documented'] },
        ],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.ungreenChildren).toHaveLength(2);
  });

  it('skips child audit when no epicId is set', async () => {
    const handle = await releaseStart('2026.4.155', { projectRoot: dir });
    const auditFn = vi.fn(async () => ({ examined: 0, ungreen: [] }));
    const result = await releaseVerify(handle, {
      runGate: async () => ({ passed: true }),
      auditChildren: auditFn,
    });
    expect(auditFn).not.toHaveBeenCalled();
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// releasePublish
// ---------------------------------------------------------------------------

describe('releasePublish', () => {
  it('reads publish.command from project-context (npm)', async () => {
    const dir = makeFixtureProject({ publishCommand: 'echo NPM_PUBLISH_FIXTURE' });
    try {
      const handle = await releaseStart('2026.4.155', { projectRoot: dir });
      const result = await releasePublish(handle, { dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.command).toBe('echo NPM_PUBLISH_FIXTURE');
      expect(result.output).toContain('NPM_PUBLISH_FIXTURE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads publish.command for cargo (rust project)', async () => {
    const dir = makeFixtureProject({
      primaryType: 'rust',
      publishCommand: 'cargo publish --dry-run',
    });
    try {
      const handle = await releaseStart('1.4.2', { projectRoot: dir });
      const result = await releasePublish(handle, { dryRun: true });
      expect(result.command).toBe('cargo publish --dry-run');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to per-primaryType default when publish.command is absent', async () => {
    const dir = makeFixtureProject({ primaryType: 'rust' });
    try {
      const handle = await releaseStart('1.4.2', { projectRoot: dir });
      const result = await releasePublish(handle, { dryRun: true });
      expect(result.command).toBe('cargo publish');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours commandOverride', async () => {
    const dir = makeFixtureProject();
    try {
      const handle = await releaseStart('2026.4.155', { projectRoot: dir });
      const result = await releasePublish(handle, {
        dryRun: true,
        commandOverride: 'echo OVERRIDDEN',
      });
      expect(result.command).toBe('echo OVERRIDDEN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// releaseReconcile
// ---------------------------------------------------------------------------

describe('releaseReconcile', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeFixtureProject();
    clearInvariants();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    clearInvariants();
  });

  it('auto-completes reconciled tasks and clears handle on success', async () => {
    registerInvariant({
      id: 'fixture-archive-reason',
      description: 'fixture',
      severity: 'info',
      check: async () => ({
        id: 'fixture-archive-reason',
        severity: 'info',
        message: 'fixture',
        processed: 2,
        reconciled: 1,
        unreconciled: 1,
        errors: 0,
        details: {
          reconciled: ['T200'],
          unreconciled: ['T201'],
        },
      }),
    });

    const handle = await releaseStart('2026.4.155', { projectRoot: dir });
    expect(existsSync(join(dir, '.cleo/release/handle.json'))).toBe(true);

    const result = await releaseReconcile(handle);
    expect(result.success).toBe(true);
    expect(result.tag).toBe('v2026.4.155');
    expect(result.reconciledTasks).toEqual(['T200']);
    expect(result.unreconciledTasks).toEqual(['T201']);
    // Handle is cleared after a successful, non-dry-run reconcile.
    expect(existsSync(join(dir, '.cleo/release/handle.json'))).toBe(false);
  });

  it('keeps handle on dry-run', async () => {
    registerInvariant({
      id: 'fixture-noop',
      description: 'noop',
      severity: 'info',
      check: async () => ({
        id: 'fixture-noop',
        severity: 'info',
        message: 'noop',
        processed: 0,
        reconciled: 0,
        unreconciled: 0,
        errors: 0,
        details: {},
      }),
    });

    const handle = await releaseStart('2026.4.155', { projectRoot: dir });
    const result = await releaseReconcile(handle, { dryRun: true });
    expect(result.success).toBe(true);
    expect(existsSync(join(dir, '.cleo/release/handle.json'))).toBe(true);
  });

  it('reports errors when an invariant fails', async () => {
    registerInvariant({
      id: 'fixture-bad',
      description: 'bad',
      severity: 'error',
      check: async () => ({
        id: 'fixture-bad',
        severity: 'error',
        message: 'kaboom',
        processed: 0,
        reconciled: 0,
        unreconciled: 0,
        errors: 1,
        details: {},
      }),
    });

    const handle = await releaseStart('2026.4.155', { projectRoot: dir });
    const result = await releaseReconcile(handle);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('fixture-bad');
  });
});

// ---------------------------------------------------------------------------
// Full pipeline integration
// ---------------------------------------------------------------------------

describe('canonical pipeline (start → verify → publish → reconcile)', () => {
  it('flows through all four steps for a fixture node project', async () => {
    const dir = makeFixtureProject({
      publishCommand: 'echo PUBLISHED',
      versionScheme: 'calver',
    });
    clearInvariants();
    registerInvariant({
      id: 'fixture-final',
      description: 'final',
      severity: 'info',
      check: async () => ({
        id: 'fixture-final',
        severity: 'info',
        message: 'ok',
        processed: 1,
        reconciled: 1,
        unreconciled: 0,
        errors: 0,
        details: { reconciled: ['T-DONE'] },
      }),
    });

    try {
      const handle = await releaseStart('2026.4.999', {
        projectRoot: dir,
        epicId: 'T-EPIC',
      });
      expect(handle.tag).toBe('v2026.4.999');

      const verify = await releaseVerify(handle, {
        runGate: async () => ({ passed: true }),
        auditChildren: async () => ({ examined: 0, ungreen: [] }),
      });
      expect(verify.passed).toBe(true);

      const publish = await releasePublish(handle, { dryRun: true });
      expect(publish.success).toBe(true);
      expect(publish.command).toBe('echo PUBLISHED');

      const reconcile = await releaseReconcile(handle);
      expect(reconcile.success).toBe(true);
      expect(reconcile.reconciledTasks).toEqual(['T-DONE']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      clearInvariants();
    }
  });
});
