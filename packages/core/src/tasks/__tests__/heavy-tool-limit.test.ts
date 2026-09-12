/**
 * T12116 — the heavy-tool memory bound must be the kernel's, not the runner's.
 *
 * Before this, the only ceilings were `NODE_OPTIONS` + `VITEST_MAX_WORKERS` +
 * `npm_config_workspace_concurrency`: advisory, Node-specific, and blind to
 * `cargo test`, `pytest`, `go test` or a `make` target. These tests pin the
 * three properties that make the new bound different — it is applied by the
 * kernel to the whole process tree, it denies swap, and it degrades to exactly
 * the old behaviour where systemd is unavailable rather than to no behaviour.
 */

import { describe, expect, it } from 'vitest';
import { heavyToolEnv, isHeavyTool } from '../heavy-tool-env.js';
import {
  HEAVY_TOOL_MEMORY_CEILING_MB,
  HEAVY_TOOL_MEMORY_FLOOR_MB,
  MEMORY_MAX_ENV,
  resolveMemoryMaxMb,
  withMemoryLimit,
} from '../heavy-tool-limit.js';

describe('resolveMemoryMaxMb', () => {
  it('derives the ceiling from host RAM', () => {
    // 32 GiB × 25% = 8192, which is also the clamp — pick a host where the
    // derivation is visible rather than coincidental.
    expect(resolveMemoryMaxMb(16, {})).toBe(4_096);
  });

  it('clamps a large host to the ceiling', () => {
    expect(resolveMemoryMaxMb(512, {})).toBe(HEAVY_TOOL_MEMORY_CEILING_MB);
  });

  it('clamps a small host to the floor, so a real suite can still run', () => {
    expect(resolveMemoryMaxMb(2, {})).toBe(HEAVY_TOOL_MEMORY_FLOOR_MB);
  });

  it('honours an operator override', () => {
    expect(resolveMemoryMaxMb(62, { [MEMORY_MAX_ENV]: '1234' })).toBe(1_234);
  });

  it('ignores a malformed override rather than trusting it', () => {
    expect(resolveMemoryMaxMb(16, { [MEMORY_MAX_ENV]: 'lots' })).toBe(4_096);
  });
});

describe('withMemoryLimit', () => {
  const confined = { available: true, totalRamGib: 62, env: {} };

  it('confines test in a scope that denies swap', () => {
    const c = withMemoryLimit('test', 'pnpm', ['run', 'test'], confined);

    expect(c.confined).toBe(true);
    expect(c.cmd).toBe('systemd-run');
    // Denying swap is the whole point: the failure being guarded against was a
    // throttle-and-thrash freeze, which logs nothing, not an OOM kill.
    expect(c.args).toContain('MemorySwapMax=0');
    expect(c.args).toContain(`MemoryMax=${HEAVY_TOOL_MEMORY_CEILING_MB}M`);
  });

  it('passes the real command after the -- separator, unaltered', () => {
    const c = withMemoryLimit('test', 'pnpm', ['run', 'test', '--filter', 'core'], confined);
    const tail = c.args.slice(c.args.indexOf('--') + 1);
    expect(tail).toEqual(['pnpm', 'run', 'test', '--filter', 'core']);
  });

  it('reaps its transient unit so repeated verifies do not accumulate scopes', () => {
    expect(withMemoryLimit('test', 'pnpm', [], confined).args).toContain('--collect');
  });

  it('confines build as well as test', () => {
    expect(withMemoryLimit('build', 'pnpm', ['run', 'build'], confined).confined).toBe(true);
  });

  it.each([
    'lint',
    'typecheck',
    'audit',
    'security-scan',
  ] as const)('leaves %s unwrapped — it is one cheap process, not a fork bomb', (canonical) => {
    const c = withMemoryLimit(canonical, 'pnpm', ['run', canonical], confined);
    expect(c.confined).toBe(false);
    expect(c.cmd).toBe('pnpm');
  });

  it('degrades to the unwrapped command when systemd is unavailable', () => {
    // Off-Linux, or in a container with no user manager. The env overlay stays
    // the only bound — the same protection as before this module, never less.
    const c = withMemoryLimit('test', 'pnpm', ['run', 'test'], { ...confined, available: false });

    expect(c.confined).toBe(false);
    expect(c.cmd).toBe('pnpm');
    expect(c.args).toEqual(['run', 'test']);
    expect(c.memoryMaxMb).toBeNull();
  });
});

describe('heavyToolEnv beyond vitest', () => {
  it('bounds non-Node runners, which previously had no ceiling at all', () => {
    const overlay = heavyToolEnv('test', {}, 62);

    // CLEO is a general task runner; its consumers are not all Node projects.
    expect(overlay.RUST_TEST_THREADS).toBeDefined();
    expect(overlay.GOMAXPROCS).toBeDefined();
    expect(overlay.PYTEST_XDIST_AUTO_NUM_WORKERS).toBeDefined();
    expect(overlay.JEST_MAX_WORKERS).toBeDefined();
    expect(overlay.CARGO_BUILD_JOBS).toBeDefined();
    expect(overlay.MAKEFLAGS).toBe(`-j${overlay.VITEST_MAX_WORKERS}`);
  });

  it('agrees on one worker count across every runner', () => {
    const overlay = heavyToolEnv('test', {}, 62);
    const counts = new Set([
      overlay.VITEST_MAX_WORKERS,
      overlay.JEST_MAX_WORKERS,
      overlay.RUST_TEST_THREADS,
      overlay.GOMAXPROCS,
    ]);
    expect(counts.size).toBe(1);
  });

  it('never overrides a value the project set deliberately', () => {
    const overlay = heavyToolEnv('test', { RUST_TEST_THREADS: '32', GOMAXPROCS: '64' }, 62);
    expect(overlay.RUST_TEST_THREADS).toBeUndefined();
    expect(overlay.GOMAXPROCS).toBeUndefined();
  });

  it('still leaves cheap tools alone', () => {
    expect(heavyToolEnv('lint', {}, 62)).toEqual({});
  });
});

describe('isHeavyTool — one definition, not four', () => {
  // Before this predicate, "heavy" was an independent literal in four places:
  // heavy-tool-env.ts, tool-semaphore.ts, tool-cache.ts and heavy-tool-limit.ts.
  // They agreed by coincidence. Adding a fifth heavy tool took four coordinated
  // edits, and missing one produced a SILENT asymmetry — a tool inheriting the
  // long spawn deadline but no memory bound, which is the exact ordering hazard
  // the release sequencing exists to prevent, reappearing inside one process.
  it.each(['test', 'build'] as const)('treats %s as heavy', (c) => {
    expect(isHeavyTool(c)).toBe(true);
  });

  it.each(['lint', 'typecheck', 'audit', 'security-scan'] as const)('treats %s as cheap', (c) => {
    expect(isHeavyTool(c)).toBe(false);
  });

  it.each([
    'test',
    'build',
    'lint',
    'typecheck',
    'audit',
    'security-scan',
  ] as const)('the memory ceiling and the worker caps agree about %s', (c) => {
    // The tripwire. If these two ever disagree, one bound is being applied
    // without the other — which is worse than neither, because a tool with a
    // raised worker cap and no memory ceiling is unbounded by construction.
    const confined = withMemoryLimit(c, 'pnpm', [], { available: true, env: {} }).confined;
    const capped = Object.keys(heavyToolEnv(c, {}, 62)).length > 0;

    expect(confined).toBe(isHeavyTool(c));
    expect(capped).toBe(isHeavyTool(c));
  });
});
