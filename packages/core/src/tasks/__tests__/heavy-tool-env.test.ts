/**
 * Heavy-tool spawn ceiling (T12096) and its budget plan (T13122).
 *
 * The property that matters is that the ceiling BINDS a project which has no
 * memory-safe config of its own — that was the measured failure — and that an
 * inherited value (a shell profile, a parent process) can tighten the plan but
 * never multiply it: on 2026-10-03 a profile-wide 8 GiB heap made one evidence
 * run 6 workers × 8 GiB.
 *
 * @task T12096
 * @task T13122
 */

import { describe, expect, it } from 'vitest';
import {
  defaultHeavyHeapMb,
  GIB_PER_WORKER,
  HEAVY_TOOL_HEAP_MB,
  heavyRunBudgetMb,
  heavyToolEnv,
  heavyToolWorkers,
  inheritedHeapMb,
  MAX_HEAVY_WORKERS,
  MIN_HEAVY_WORKERS,
  mergeNodeOptions,
  planHeavyToolEnv,
  WORKSPACE_CONCURRENCY,
  withHeapCeiling,
} from '../heavy-tool-env.js';

describe('heavyToolWorkers (T12096)', () => {
  it('scales with RAM and clamps at both ends', () => {
    expect(heavyToolWorkers(62)).toBe(MAX_HEAVY_WORKERS); // ⌊62/6⌋=10 → 6
    expect(heavyToolWorkers(24)).toBe(4);
    expect(heavyToolWorkers(12)).toBe(2);
    expect(heavyToolWorkers(4)).toBe(MIN_HEAVY_WORKERS); // ⌊4/6⌋=0 → 1
    expect(heavyToolWorkers(0)).toBe(MIN_HEAVY_WORKERS);
  });

  it('uses GIB_PER_WORKER as the divisor', () => {
    expect(heavyToolWorkers(GIB_PER_WORKER * 3)).toBe(3);
  });
});

describe('mergeNodeOptions (T12096, deprecated by T13122)', () => {
  it('creates NODE_OPTIONS when absent', () => {
    expect(mergeNodeOptions(undefined, 4096)).toBe('--max-old-space-size=4096');
    expect(mergeNodeOptions('', 4096)).toBe('--max-old-space-size=4096');
  });

  it('APPENDS rather than clobbering — other flags must survive', () => {
    // Dropping a project's `--experimental-*` flags would break the very command
    // we are trying to bound.
    expect(mergeNodeOptions('--experimental-vm-modules', 4096)).toBe(
      '--experimental-vm-modules --max-old-space-size=4096',
    );
  });

  it('leaves an existing --max-old-space-size alone', () => {
    // A deliberate choice outranks our default, in either direction.
    expect(mergeNodeOptions('--max-old-space-size=8192', 4096)).toBe('--max-old-space-size=8192');
    expect(mergeNodeOptions('--max-old-space-size 8192', 4096)).toBe('--max-old-space-size 8192');
  });
});

describe('heavyToolEnv (T12096)', () => {
  it('bounds a test spawn on all three levers', () => {
    // The PepsVida case: 15 workspace packages with test scripts, no vitest
    // config capping anything.
    const env = heavyToolEnv('test', {}, 62);
    expect(env.NODE_OPTIONS).toBe(`--max-old-space-size=${HEAVY_TOOL_HEAP_MB}`);
    expect(env.VITEST_MAX_WORKERS).toBe(String(MAX_HEAVY_WORKERS));
    expect(env.npm_config_workspace_concurrency).toBe(String(WORKSPACE_CONCURRENCY));
  });

  it('bounds build the same way', () => {
    expect(heavyToolEnv('build', {}, 62).NODE_OPTIONS).toBeDefined();
  });

  it('leaves LIGHT tools completely alone', () => {
    // Serialising lint/typecheck would cost time and buy nothing — they are
    // single-process.
    for (const t of ['lint', 'typecheck', 'audit', 'security-scan'] as const) {
      expect(heavyToolEnv(t, {}, 62)).toEqual({});
    }
  });

  it('keeps inherited values within the plan, and clamps the ones above it (T13122)', () => {
    // T12096 let every inherited value win. These three, inherited together,
    // were 4 packages × 12 workers × 16 GiB = 768 GiB of permitted heap.
    const env = heavyToolEnv(
      'test',
      {
        VITEST_MAX_WORKERS: '12',
        npm_config_workspace_concurrency: '4',
        NODE_OPTIONS: '--max-old-space-size=16384',
      },
      62,
    );
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=16384'); // fits the 24 GiB budget
    expect(env.VITEST_MAX_WORKERS).toBe('1'); // ⌊24576 / 16384⌋
    expect(env.npm_config_workspace_concurrency).toBe(String(WORKSPACE_CONCURRENCY));

    const low = heavyToolEnv('test', { VITEST_MAX_WORKERS: '2' }, 62);
    expect(low.VITEST_MAX_WORKERS).toBeUndefined(); // a lower count is kept
  });

  it('still bounds workers on a small machine', () => {
    expect(heavyToolEnv('test', {}, 8).VITEST_MAX_WORKERS).toBe('1');
  });

  it('worst case is bounded by RAM, which is the whole point', () => {
    // packages-in-flight × workers × heap must not exceed the machine. The old
    // arrangement had no bound on the first factor at all.
    const env = heavyToolEnv('test', {}, 62);
    const workers = Number(env.VITEST_MAX_WORKERS);
    const packages = Number(env.npm_config_workspace_concurrency);
    const worstCaseGib = (packages * workers * HEAVY_TOOL_HEAP_MB) / 1024;
    expect(worstCaseGib).toBeLessThanOrEqual(62);
  });
});

describe('heap budget (T13122)', () => {
  it('leaves the default plan unchanged on 8 GiB and up', () => {
    expect(heavyRunBudgetMb(64)).toBe(MAX_HEAVY_WORKERS * HEAVY_TOOL_HEAP_MB);
    expect(heavyRunBudgetMb(16)).toBe(2 * HEAVY_TOOL_HEAP_MB);
    expect(heavyRunBudgetMb(8)).toBe(HEAVY_TOOL_HEAP_MB);
    expect(defaultHeavyHeapMb(8)).toBe(HEAVY_TOOL_HEAP_MB);
  });

  it('never gives one process the whole of a small machine', () => {
    // 4096 MiB on a 4 GiB box is no ceiling at all.
    expect(defaultHeavyHeapMb(4)).toBe(2048);
    expect(heavyToolEnv('test', {}, 4).NODE_OPTIONS).toBe('--max-old-space-size=2048');
    expect(defaultHeavyHeapMb(1)).toBe(1024);
  });
});

describe('inheritedHeapMb / withHeapCeiling (T13122)', () => {
  it('reads the size and the percentage forms, percentage first', () => {
    expect(inheritedHeapMb('--max-old-space-size=8192', 65536)).toBe(8192);
    expect(inheritedHeapMb('--max_old_space_size 6144', 65536)).toBe(6144);
    expect(inheritedHeapMb('--max-old-space-size-percentage=25', 65536)).toBe(16384);
    // Node 24 lets the percentage form win whatever the order.
    expect(
      inheritedHeapMb('--max-old-space-size-percentage=25 --max-old-space-size=2048', 65536),
    ).toBe(16384);
    expect(inheritedHeapMb('--enable-source-maps', 65536)).toBeNull();
    expect(inheritedHeapMb(undefined, 65536)).toBeNull();
  });

  it('replaces every old-space flag and keeps every other flag in order', () => {
    expect(
      withHeapCeiling(
        '--require ./a.js --max-old-space-size=8192 --enable-source-maps --max-old-space-size-percentage=50 --max-semi-space-size=64',
        4096,
      ),
    ).toBe(
      '--require ./a.js --enable-source-maps --max-semi-space-size=64 --max-old-space-size=4096',
    );
    expect(withHeapCeiling('--max-old-space-size 8192 --trace-gc', 4096)).toBe(
      '--trace-gc --max-old-space-size=4096',
    );
    expect(withHeapCeiling(undefined, 4096)).toBe('--max-old-space-size=4096');
  });
});

describe('planHeavyToolEnv (T13122)', () => {
  const product = (r: { workspaceConcurrency: number; workers: number; heapMb: number }): number =>
    r.workspaceConcurrency * r.workers * r.heapMb;

  it('the 2026-10-03 incident: a profile-wide 8 GiB heap no longer doubles the run', () => {
    // ~/.zprofile exported NODE_OPTIONS=--max-old-space-size=8192; the run got
    // 6 workers sized for 4 GiB each, i.e. 48 GiB.
    const { overlay, resources } = planHeavyToolEnv(
      'test',
      { NODE_OPTIONS: '--max-old-space-size=8192' },
      48,
    );
    expect(resources?.heapMb).toBe(8192);
    expect(resources?.heapSource).toBe('inherited');
    expect(resources?.workers).toBe(3);
    expect(overlay.VITEST_MAX_WORKERS).toBe('3');
    expect(overlay.NODE_OPTIONS).toBe('--max-old-space-size=8192');
    expect(product(resources!)).toBeLessThanOrEqual(resources!.budgetMb);
    expect(resources?.summary).toContain('heap 8192 MiB (inherited NODE_OPTIONS)');
    expect(resources?.summary).toContain('3 worker(s)');
  });

  it('clamps an inherited heap above the budget, and says so (8 GiB laptop)', () => {
    const { overlay, resources } = planHeavyToolEnv(
      'test',
      { NODE_OPTIONS: '--enable-source-maps --max-old-space-size=8192' },
      8,
    );
    expect(resources?.heapSource).toBe('clamped');
    expect(resources?.inheritedHeapMb).toBe(8192);
    expect(resources?.heapMb).toBe(4096);
    expect(resources?.workers).toBe(1);
    expect(overlay.NODE_OPTIONS).toBe('--enable-source-maps --max-old-space-size=4096');
    expect(resources?.clamped).toContainEqual({
      name: 'NODE_OPTIONS',
      from: '--max-old-space-size=8192',
      to: '--max-old-space-size=4096',
    });
    expect(resources?.summary).toMatch(/clamped NODE_OPTIONS .*CLEO_HEAVY_HEAP_MB/);
  });

  it('clamps the percentage form too, and removes it so it cannot outrank the ceiling', () => {
    const { overlay, resources } = planHeavyToolEnv(
      'test',
      { NODE_OPTIONS: '--max-old-space-size-percentage=75' },
      64,
    );
    expect(resources?.heapSource).toBe('clamped');
    expect(resources?.heapMb).toBe(heavyRunBudgetMb(64));
    expect(overlay.NODE_OPTIONS).toBe(`--max-old-space-size=${heavyRunBudgetMb(64)}`);
  });

  it('only CLEO_HEAVY_HEAP_MB asks for more, and the plan reports the run as over budget', () => {
    const { overlay, resources } = planHeavyToolEnv(
      'test',
      { CLEO_HEAVY_HEAP_MB: '32768', NODE_OPTIONS: '--max-old-space-size=8192' },
      64,
    );
    expect(resources?.heapSource).toBe('override');
    expect(resources?.heapMb).toBe(32768);
    expect(resources?.workers).toBe(1);
    expect(resources?.overBudget).toBe(true);
    expect(overlay.NODE_OPTIONS).toBe('--max-old-space-size=32768');
    expect(resources?.summary).toContain('OVER budget');
  });

  it('CLEO_HEAVY_WORKERS sets every runner, overriding inherited counts', () => {
    const { overlay, resources } = planHeavyToolEnv(
      'test',
      { CLEO_HEAVY_WORKERS: '2', VITEST_MAX_WORKERS: '1', GOMAXPROCS: '64' },
      64,
    );
    expect(resources?.workersSource).toBe('override');
    expect(overlay.VITEST_MAX_WORKERS).toBe('2');
    expect(overlay.GOMAXPROCS).toBe('2');
    expect(resources?.clamped).toEqual([]);
  });

  it('clamps inherited worker counts above the plan and keeps those within it', () => {
    const { overlay, resources } = planHeavyToolEnv(
      'test',
      { VITEST_MAX_WORKERS: '16', JEST_MAX_WORKERS: '50%', RUST_TEST_THREADS: '2' },
      64,
    );
    expect(overlay.VITEST_MAX_WORKERS).toBe('6');
    expect(overlay.JEST_MAX_WORKERS).toBe('6'); // not a count CLEO can bound: replaced
    expect(overlay.RUST_TEST_THREADS).toBeUndefined();
    expect(resources?.kept).toContain('RUST_TEST_THREADS=2');
    expect(resources?.clamped.map((c) => c.name)).toEqual([
      'VITEST_MAX_WORKERS',
      'JEST_MAX_WORKERS',
    ]);
  });

  it('bounds inherited workspace concurrency; the override shrinks workers to fit', () => {
    const inherited = planHeavyToolEnv('test', { npm_config_workspace_concurrency: '4' }, 64);
    expect(inherited.overlay.npm_config_workspace_concurrency).toBe('1');
    expect(inherited.resources?.clamped[0]?.name).toBe('npm_config_workspace_concurrency');

    const asked = planHeavyToolEnv('test', { CLEO_HEAVY_WORKSPACE_CONCURRENCY: '2' }, 64);
    expect(asked.resources?.workspaceConcurrency).toBe(2);
    expect(asked.resources?.workers).toBe(3); // ⌊24576 / (2 × 4096)⌋
    expect(asked.resources?.overBudget).toBe(false);
  });

  it('ignores an unusable override and notes it', () => {
    const { resources } = planHeavyToolEnv('test', { CLEO_HEAVY_HEAP_MB: 'lots' }, 64);
    expect(resources?.heapSource).toBe('default');
    expect(resources?.summary).toContain('ignored CLEO_HEAVY_HEAP_MB="lots"');
  });

  it('an inherited value never takes the run over budget, on any machine', () => {
    // 18-core 48/64 GiB desktops, a 16 GiB CI runner, a 7 GiB macOS runner, an
    // 8 GiB 4-core laptop, a 4 GiB box.
    for (const ram of [4, 7, 8, 16, 48, 64]) {
      for (const heap of [undefined, '512', '2048', '4096', '8192', '16384', '65536']) {
        for (const workers of [undefined, '1', '4', '17', 'x']) {
          for (const packages of [undefined, '1', '4', '0']) {
            const env: NodeJS.ProcessEnv = {
              ...(heap ? { NODE_OPTIONS: `--max-old-space-size=${heap}` } : {}),
              ...(workers ? { VITEST_MAX_WORKERS: workers } : {}),
              ...(packages ? { npm_config_workspace_concurrency: packages } : {}),
            };
            const { overlay, resources } = planHeavyToolEnv('test', env, ram);
            const r = resources!;
            const effectiveWorkers = Number(overlay.VITEST_MAX_WORKERS ?? env.VITEST_MAX_WORKERS);
            expect(r.workspaceConcurrency * effectiveWorkers * r.heapMb).toBeLessThanOrEqual(
              r.budgetMb,
            );
            expect(r.overBudget).toBe(false);
            expect(effectiveWorkers).toBeLessThanOrEqual(heavyToolWorkers(ram));
          }
        }
      }
    }
  });

  it('plans nothing for a light tool', () => {
    expect(
      planHeavyToolEnv('typecheck', { NODE_OPTIONS: '--max-old-space-size=8192' }, 64),
    ).toEqual({ overlay: {}, resources: null });
  });
});
