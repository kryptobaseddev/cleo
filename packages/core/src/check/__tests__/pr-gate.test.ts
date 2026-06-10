/**
 * Tests for the unified pre-PR gate runner (T11956 · DHQ-073).
 *
 * Covers the pure selection/argv-building logic deterministically, plus an
 * end-to-end `runPrGate` run scoped via `--only` to a single cheap gate so the
 * suite stays fast and hermetic (no full build/test invocation).
 *
 * @task T11956
 * @epic T11679
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildGateArgv,
  formatPrGateSummary,
  PR_GATES,
  runPrGate,
  selectPrGates,
} from '../pr-gate.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('PR_GATES registry', () => {
  it('has unique, kebab-case gate ids', () => {
    const ids = PR_GATES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('includes the canonical CI gates an agent commonly trips', () => {
    const coreIds = PR_GATES.filter((g) => g.tier === 'core').map((g) => g.id);
    expect(coreIds).toContain('typecheck');
    expect(coreIds).toContain('canon-docs');
    expect(coreIds).toContain('build');
    expect(coreIds).toContain('test');
    expect(coreIds).toContain('arch');
    expect(coreIds).toContain('lockfile');
    expect(coreIds).toContain('biome');
  });

  it('marks build/typecheck/test as heavy (cgroup-cap candidates)', () => {
    for (const id of ['build', 'typecheck', 'test']) {
      const gate = PR_GATES.find((g) => g.id === id);
      expect(gate?.heavy).toBe(true);
    }
  });
});

describe('selectPrGates', () => {
  it('runs only the core tier by default', () => {
    const { toRun, skipped } = selectPrGates({});
    expect(toRun.every((g) => g.tier === 'core')).toBe(true);
    expect(skipped).toHaveLength(0);
    expect(toRun.some((g) => g.tier === 'full')).toBe(false);
  });

  it('adds the full tier when full: true', () => {
    const { toRun } = selectPrGates({ full: true });
    expect(toRun.some((g) => g.tier === 'full')).toBe(true);
    expect(toRun.length).toBe(PR_GATES.length);
  });

  it('narrows to --only ids and marks the rest skipped', () => {
    const { toRun, skipped } = selectPrGates({ only: ['biome', 'typecheck'] });
    expect(toRun.map((g) => g.id).sort()).toEqual(['biome', 'typecheck']);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.some((g) => g.id === 'biome')).toBe(false);
  });
});

describe('buildGateArgv', () => {
  it('does not cgroup-cap a non-heavy gate', () => {
    const gate = PR_GATES.find((g) => g.id === 'biome');
    if (!gate) throw new Error('biome gate missing');
    const { command, capped } = buildGateArgv(gate, '16G');
    expect(capped).toBe(false);
    expect(command).toBe('pnpm');
  });

  it('cgroup-caps a heavy gate on Linux when systemd-run exists', () => {
    const gate = PR_GATES.find((g) => g.id === 'build');
    if (!gate) throw new Error('build gate missing');
    const { command, args, capped } = buildGateArgv(gate, '12G');
    if (capped) {
      // Linux + systemd-run present: wrapped in a memory-capped scope.
      expect(command).toBe('systemd-run');
      expect(args).toContain('MemoryMax=12G');
      expect(args).toContain('MemorySwapMax=0');
      expect(args).toContain('pnpm');
    } else {
      // macOS / no systemd-run: runs uncapped.
      expect(command).toBe('pnpm');
    }
  });
});

describe('runPrGate', () => {
  it('reports every gate as skipped when --only matches nothing', () => {
    const summary = runPrGate({ only: ['does-not-exist'], cwd: REPO_ROOT });
    expect(summary.summary.pass).toBe(0);
    expect(summary.summary.fail).toBe(0);
    expect(summary.gates.every((g) => g.status === 'skipped')).toBe(true);
    // No gate ran, so the run "passed" (nothing failed).
    expect(summary.passed).toBe(true);
  });

  it('runs a single cheap real gate end-to-end (merge-bar-aggregate)', { timeout: 30_000 }, () => {
    const summary = runPrGate({ only: ['merge-bar-aggregate'], cwd: REPO_ROOT });
    const gate = summary.gates.find((g) => g.id === 'merge-bar-aggregate');
    expect(gate).toBeDefined();
    // The lint passes against the real checked-in workflows.
    expect(gate?.status).toBe('pass');
    expect(summary.passed).toBe(true);
    // Other gates were filtered out, not executed.
    expect(summary.gates.filter((g) => g.status === 'skipped').length).toBeGreaterThan(0);
  });

  it('emits progress lines via the onProgress sink', () => {
    const lines: string[] = [];
    runPrGate({
      only: ['merge-bar-aggregate'],
      cwd: REPO_ROOT,
      onProgress: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.includes('Merge-Bar Aggregate'))).toBe(true);
  });
});

describe('formatPrGateSummary', () => {
  it('renders a human report with status icons and a result tally', () => {
    const summary = runPrGate({ only: ['merge-bar-aggregate'], cwd: REPO_ROOT });
    const report = formatPrGateSummary(summary);
    expect(report).toContain('Pre-PR Gate (cleo check pr)');
    expect(report).toContain('[PASS] Merge-Bar Aggregate Gate Lint');
    expect(report).toContain('[SKIP]');
    expect(report).toMatch(/Result: \d+ passed, \d+ failed, \d+ skipped/);
  });
});
