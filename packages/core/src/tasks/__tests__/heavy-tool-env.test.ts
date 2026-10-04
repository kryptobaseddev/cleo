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
  admissionCapacityBytes,
  boundMakeflags,
  defaultHeavyHeapMb,
  defaultSingleProcessHeapMb,
  GIB_PER_WORKER,
  HEAVY_TOOL_HEAP_MB,
  heavyRunBudgetMb,
  heavyToolEnv,
  heavyToolWorkers,
  inheritedHeapMb,
  MAX_HEAVY_WORKERS,
  MAX_SEMI_SPACE_MB,
  MIN_HEAVY_WORKERS,
  mergeNodeOptions,
  PER_RUN_BUDGET_SHARE,
  perRunBudgetShare,
  planHeavyToolEnv,
  WORKSPACE_CONCURRENCY,
  withHeapCeiling,
  withoutNpmEnvConfigWarnings,
} from '../heavy-tool-env.js';

describe('heavyToolWorkers (T12096)', () => {
  it('plans for half the admission budget and clamps at both ends (T13132)', () => {
    // 62 GiB: budget 46.5 GiB, half 23.25 → ⌊23.25/6⌋ = 3 (it was 6, the whole budget).
    expect(heavyToolWorkers(62)).toBe(3);
    expect(heavyToolWorkers(128)).toBe(MAX_HEAVY_WORKERS); // ⌊48/6⌋ = 8 → 6
    expect(heavyToolWorkers(24)).toBe(1); // budget 18, half 9 → 1
    expect(heavyToolWorkers(4)).toBe(MIN_HEAVY_WORKERS);
    expect(heavyToolWorkers(0)).toBe(MIN_HEAVY_WORKERS);
  });

  it('a CI runner plans for the whole budget, so CI keeps its parallelism (T13132)', () => {
    // A 16 GiB GitHub runner: 2 workers, as before T13132; a shared 16 GiB laptop: 1.
    expect(heavyToolWorkers(16, { CI: 'true' })).toBe(2);
    expect(heavyToolWorkers(16, {})).toBe(1);
    expect(heavyToolWorkers(64, { CI: 'true' })).toBe(MAX_HEAVY_WORKERS);
    expect(planHeavyToolEnv('test', { CI: 'true' }, 16).resources?.workers).toBe(2);
    expect(planHeavyToolEnv('test', {}, 16).resources?.workers).toBe(1);
    // CI=false is not CI; CLEO_PER_RUN_SHARE overrides both ways.
    expect(perRunBudgetShare({ CI: 'false' })).toBe(PER_RUN_BUDGET_SHARE);
    expect(perRunBudgetShare({ CI: 'true', CLEO_PER_RUN_SHARE: '0.5' })).toBe(0.5);
    expect(perRunBudgetShare({ CLEO_PER_RUN_SHARE: '1' })).toBe(1);
    expect(perRunBudgetShare({ CLEO_PER_RUN_SHARE: '7' })).toBe(PER_RUN_BUDGET_SHARE);
  });

  it('uses GIB_PER_WORKER as the divisor of half the budget', () => {
    // 48 GiB: budget 36, half 18.
    expect(heavyToolWorkers(48)).toBe(Math.floor(18 / GIB_PER_WORKER));
    expect(heavyToolWorkers(48) * GIB_PER_WORKER).toBeLessThanOrEqual(
      (admissionCapacityBytes(48 * 1024 ** 3) / 1024 ** 3) * PER_RUN_BUDGET_SHARE,
    );
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
    expect(env.VITEST_MAX_WORKERS).toBe(String(heavyToolWorkers(62)));
    expect(env.npm_config_workspace_concurrency).toBe(String(WORKSPACE_CONCURRENCY));
  });

  it('bounds build the same way', () => {
    expect(heavyToolEnv('build', {}, 62).NODE_OPTIONS).toBeDefined();
  });

  it('leaves network-bound tools completely alone', () => {
    for (const t of ['audit', 'security-scan'] as const) {
      expect(heavyToolEnv(t, {}, 62)).toEqual({});
    }
  });

  it('gives typecheck and lint a heap ceiling and workspace concurrency, no worker variables (T13123)', () => {
    // One TypeScript program holds 2–5 GB on a large monorepo; a profile heap
    // reached every tsc CLEO started, with no ceiling of its own.
    for (const t of ['lint', 'typecheck'] as const) {
      expect(heavyToolEnv(t, {}, 62)).toEqual({
        NODE_OPTIONS: `--max-old-space-size=${HEAVY_TOOL_HEAP_MB}`,
        npm_config_workspace_concurrency: String(WORKSPACE_CONCURRENCY),
        pnpm_config_workspace_concurrency: String(WORKSPACE_CONCURRENCY),
      });
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
    // The budget is 3 workers × 4096 = 12288 MiB (T13132): the 16 GiB heap is
    // clamped to it, and one worker fits.
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=12288');
    expect(env.VITEST_MAX_WORKERS).toBe('1'); // ⌊12288 / 12288⌋
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
  it('budgets the default heap for half the admission budget (T13132)', () => {
    expect(heavyRunBudgetMb(64)).toBe(4 * HEAVY_TOOL_HEAP_MB);
    expect(heavyRunBudgetMb(128)).toBe(MAX_HEAVY_WORKERS * HEAVY_TOOL_HEAP_MB);
    expect(heavyRunBudgetMb(16)).toBe(HEAVY_TOOL_HEAP_MB);
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
    // Half the 36 GiB budget is 3 × 4096 = 12288 MiB: one 8 GiB worker fits.
    expect(resources?.heapMb).toBe(8192);
    expect(resources?.heapSource).toBe('inherited');
    expect(resources?.workers).toBe(1);
    expect(overlay.VITEST_MAX_WORKERS).toBe('1');
    expect(overlay.NODE_OPTIONS).toBe('--max-old-space-size=8192');
    expect(product(resources!)).toBeLessThanOrEqual(resources!.budgetMb);
    expect(resources?.summary).toContain('heap 8192 MiB (inherited NODE_OPTIONS)');
    expect(resources?.summary).toContain('1 worker(s)');
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

  it('maxWorkers narrows the plan and its budget: a run naming one test file gets one worker (T13132)', () => {
    const { overlay, resources } = planHeavyToolEnv('test', {}, 64, 1);
    expect(resources?.workers).toBe(1);
    expect(resources?.budgetMb).toBe(HEAVY_TOOL_HEAP_MB);
    expect(overlay.VITEST_MAX_WORKERS).toBe('1');
    // Never above the machine's plan, never below one.
    expect(planHeavyToolEnv('test', {}, 64, 50).resources?.workers).toBe(4);
    expect(planHeavyToolEnv('test', {}, 64, 0).resources?.workers).toBe(1);
  });

  it('clamps inherited worker counts above the plan and keeps those within it', () => {
    const { overlay, resources } = planHeavyToolEnv(
      'test',
      { VITEST_MAX_WORKERS: '16', JEST_MAX_WORKERS: '50%', RUST_TEST_THREADS: '2' },
      64,
    );
    expect(overlay.VITEST_MAX_WORKERS).toBe('4'); // the plan on 64 GiB (T13132)
    expect(overlay.JEST_MAX_WORKERS).toBe('4'); // not a count CLEO can bound: replaced
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

    // pnpm 11+ reads only the pnpm_config_ spelling, pnpm 10 only npm_config_:
    // both are set, and an inherited value under either is bounded.
    const pnpm12 = planHeavyToolEnv('test', { pnpm_config_workspace_concurrency: '8' }, 64);
    expect(pnpm12.overlay.pnpm_config_workspace_concurrency).toBe('1');
    expect(pnpm12.overlay.npm_config_workspace_concurrency).toBe('1');
    expect(pnpm12.resources?.workspaceConcurrency).toBe(1);
    expect(pnpm12.resources?.clamped.map((c) => c.name)).toContain(
      'pnpm_config_workspace_concurrency',
    );

    const asked = planHeavyToolEnv('test', { CLEO_HEAVY_WORKSPACE_CONCURRENCY: '2' }, 64);
    expect(asked.resources?.workspaceConcurrency).toBe(2);
    expect(asked.resources?.workers).toBe(2); // ⌊16384 / (2 × 4096)⌋
    expect(asked.resources?.overBudget).toBe(false);
  });

  it('every launcher gets both workspace spellings: an npm test script may run pnpm -r (review of #1808)', () => {
    // `npm test` → `pnpm -r test` on pnpm 10 reads only the npm_config_
    // spelling: dropping it for npm launchers unbounded exactly that chain.
    const { overlay } = planHeavyToolEnv('test', {}, 64);
    expect(overlay.npm_config_workspace_concurrency).toBe('1');
    expect(overlay.pnpm_config_workspace_concurrency).toBe('1');
  });

  it('bounds an uppercase workspace spelling, which outranks the lowercase one', () => {
    const { overlay, resources } = planHeavyToolEnv(
      'test',
      { NPM_CONFIG_WORKSPACE_CONCURRENCY: '16', PNPM_CONFIG_WORKSPACE_CONCURRENCY: '16' },
      64,
    );
    expect(overlay.NPM_CONFIG_WORKSPACE_CONCURRENCY).toBe('1');
    expect(overlay.PNPM_CONFIG_WORKSPACE_CONCURRENCY).toBe('1');
    expect(resources?.workspaceConcurrency).toBe(1);
    expect(resources?.clamped.map((c) => c.name)).toEqual([
      'NPM_CONFIG_WORKSPACE_CONCURRENCY',
      'PNPM_CONFIG_WORKSPACE_CONCURRENCY',
    ]);
  });

  it('caps an inherited semi-space: three of them count toward the heap limit', () => {
    // node 24: --max-old-space-size=4096 with --max-semi-space-size=4096 is a
    // 16384 MiB heap_size_limit, four times the plan.
    const { overlay, resources } = planHeavyToolEnv(
      'test',
      { NODE_OPTIONS: '--max-semi-space-size=4096 --enable-source-maps' },
      64,
    );
    expect(overlay.NODE_OPTIONS).toBe(
      `--enable-source-maps --max-semi-space-size=${MAX_SEMI_SPACE_MB} --max-old-space-size=4096`,
    );
    expect(resources?.clamped).toContainEqual({
      name: 'NODE_OPTIONS',
      from: '--max-semi-space-size=4096',
      to: `--max-semi-space-size=${MAX_SEMI_SPACE_MB}`,
    });
    // At or under Node's own default it is left alone.
    expect(
      planHeavyToolEnv('test', { NODE_OPTIONS: '--max-semi-space-size=32' }, 64).overlay
        .NODE_OPTIONS,
    ).toBe('--max-semi-space-size=32 --max-old-space-size=4096');
  });

  it('bounds an inherited MAKEFLAGS -j unless it carries a jobserver', () => {
    expect(boundMakeflags(undefined, 3)).toBe('-j3');
    expect(boundMakeflags('-j18', 3)).toBe('-j3');
    expect(boundMakeflags('-j', 3)).toBe('-j3'); // bare -j is unlimited
    expect(boundMakeflags('--no-print-directory -j 18', 3)).toBe('--no-print-directory -j3');
    expect(boundMakeflags('--jobs=18 -k', 3)).toBe('-k -j3');
    expect(boundMakeflags('-j2', 3)).toBeNull(); // within the plan: kept
    expect(boundMakeflags('-k', 3)).toBeNull(); // serial: kept
    expect(boundMakeflags('-j --jobserver-auth=fifo:/tmp/GMfifo1', 3)).toBeNull();
    // Short-flag clusters and make's dash-less first word (review NIT).
    expect(boundMakeflags('-sj18', 3)).toBe('-s -j3');
    expect(boundMakeflags('-kj', 3)).toBe('-k -j3');
    expect(boundMakeflags('j18', 3)).toBe('-j3');
    expect(boundMakeflags('kj --no-print-directory', 3)).toBe('-k --no-print-directory -j3');
    expect(boundMakeflags('-sj2', 3)).toBeNull();
    // A flag that takes an argument owns the rest of the cluster: -Ij18 is
    // `-I j18`, -Cj is `-C j`; neither is a job count, so neither is split.
    expect(boundMakeflags('-Ij18', 3)).toBeNull();
    expect(boundMakeflags('-Cj', 3)).toBeNull();
    const { overlay, resources } = planHeavyToolEnv('test', { MAKEFLAGS: '-j18' }, 64);
    expect(overlay.MAKEFLAGS).toBe('-j4');
    expect(resources?.clamped).toContainEqual({ name: 'MAKEFLAGS', from: '-j18', to: '-j4' });
  });

  it('bounds a dash spelling of the workspace variable too (review NIT)', () => {
    const { overlay } = planHeavyToolEnv('test', { 'npm_config_workspace-concurrency': '16' }, 64);
    expect(overlay['npm_config_workspace-concurrency']).toBe('1');
  });

  it('drops a coloured npm warning too: ANSI codes are stripped before matching (review NIT)', () => {
    const esc = String.fromCharCode(27);
    const coloured = `${esc}[33mnpm warn${esc}[39m Unknown env config "workspace-concurrency".`;
    expect(withoutNpmEnvConfigWarnings(`${coloured}\nreal error`)).toBe('real error');
  });

  it("drops npm's unknown-env-config warnings from captured output, nothing else", () => {
    const stderr = [
      'npm warn Unknown env config "workspace-concurrency". This will stop working in the next major version of npm.',
      "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      'npm warn deprecated something',
    ].join('\n');
    expect(withoutNpmEnvConfigWarnings(stderr)).toBe(
      [
        "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        'npm warn deprecated something',
      ].join('\n'),
    );
  });

  it('ignores an unusable override and notes it', () => {
    const { resources } = planHeavyToolEnv('test', { CLEO_HEAVY_HEAP_MB: 'lots' }, 64);
    expect(resources?.heapSource).toBe('default');
    expect(resources?.summary).toContain('ignored CLEO_HEAVY_HEAP_MB="lots"');
  });

  it('an inherited value never takes the run over budget, on any machine, as the child sees it', () => {
    // Evaluated on the environment the CHILD receives (env + overlay), not on
    // the plan's own numbers: every spelling a package manager may read, the
    // full V8 limit (old + 3 × semi) and make's job count.
    // 18-core 48/64 GiB desktops, a 16 GiB CI runner, a 7 GiB macOS runner, an
    // 8 GiB 4-core laptop, a 4 GiB box.
    const jobs = (makeflags: string | undefined): number => {
      const words = (makeflags ?? '').split(/\s+/);
      if (words.some((w) => w.startsWith('--jobserver-'))) return 0;
      const counts = words.flatMap((w) => /^-j(\d+)$/.exec(w)?.[1] ?? []).map(Number);
      return words.includes('-j') ? Number.POSITIVE_INFINITY : Math.max(0, ...counts);
    };
    for (const ram of [4, 7, 8, 16, 48, 64]) {
      for (const heap of [undefined, '512', '4096', '8192', '65536']) {
        for (const semi of [undefined, '16', '4096']) {
          for (const workers of [undefined, '1', '17', 'x']) {
            for (const packages of [undefined, '1', '4', '0']) {
              for (const upper of [false, true]) {
                const env: NodeJS.ProcessEnv = {
                  ...(heap || semi
                    ? {
                        NODE_OPTIONS: [
                          heap ? `--max-old-space-size=${heap}` : '',
                          semi ? `--max-semi-space-size=${semi}` : '',
                        ].join(' '),
                      }
                    : {}),
                  ...(workers ? { VITEST_MAX_WORKERS: workers, MAKEFLAGS: `-j${workers}` } : {}),
                  ...(packages
                    ? upper
                      ? { NPM_CONFIG_WORKSPACE_CONCURRENCY: packages }
                      : { npm_config_workspace_concurrency: packages }
                    : {}),
                };
                const { overlay, resources } = planHeavyToolEnv('test', env, ram);
                const r = resources!;
                const child: NodeJS.ProcessEnv = { ...env, ...overlay };
                const childPackages = Math.max(
                  ...Object.keys(child)
                    .filter((k) =>
                      [
                        'npm_config_workspace_concurrency',
                        'pnpm_config_workspace_concurrency',
                      ].includes(k.toLowerCase()),
                    )
                    .map((k) => Number(child[k])),
                );
                const childWorkers = Number(child.VITEST_MAX_WORKERS);
                const childHeap = inheritedHeapMb(child.NODE_OPTIONS, Math.floor(ram * 1024)) ?? 0;
                const childSemi = Number(
                  /--max-semi-space-size=(\d+)/.exec(child.NODE_OPTIONS ?? '')?.[1] ?? 0,
                );
                const label = JSON.stringify({ ram, env });
                expect(childPackages, label).toBe(r.workspaceConcurrency);
                expect(childWorkers, label).toBeLessThanOrEqual(r.workers);
                expect(childHeap, label).toBe(r.heapMb);
                expect(childSemi, label).toBeLessThanOrEqual(MAX_SEMI_SPACE_MB);
                expect(jobs(child.MAKEFLAGS), label).toBeLessThanOrEqual(r.workers);
                expect(childPackages * childWorkers * childHeap, label).toBeLessThanOrEqual(
                  r.budgetMb,
                );
                expect(r.overBudget, label).toBe(false);
                expect(childWorkers, label).toBeLessThanOrEqual(heavyToolWorkers(ram));
              }
            }
          }
        }
      }
    }
  });

  it('cuts heap flags out without touching the rest: quoted whitespace survives', () => {
    expect(
      withHeapCeiling('--require "/tmp/a  b.js" --max-old-space-size=8192 --trace-gc', 4096),
    ).toBe('--require "/tmp/a  b.js" --trace-gc --max-old-space-size=4096');
  });

  it('plans nothing for a network-bound tool', () => {
    expect(planHeavyToolEnv('audit', { NODE_OPTIONS: '--max-old-space-size=8192' }, 64)).toEqual({
      overlay: {},
      resources: null,
    });
  });

  it("never raises a single process's heap above Node's own default on a small machine", () => {
    // V8 defaults old space to a quarter of RAM below 16 GiB; the heavy default
    // (half of RAM, up to 4 GiB) would have doubled an 8 GiB laptop's tsc.
    expect(defaultSingleProcessHeapMb(64)).toBe(4096);
    expect(defaultSingleProcessHeapMb(16)).toBe(4096);
    expect(defaultSingleProcessHeapMb(8)).toBe(2048);
    expect(defaultSingleProcessHeapMb(2)).toBe(1024);
    expect(planHeavyToolEnv('typecheck', {}, 8).overlay.NODE_OPTIONS).toBe(
      '--max-old-space-size=2048',
    );
    // A forking tool keeps the heavy default.
    expect(planHeavyToolEnv('test', {}, 8).overlay.NODE_OPTIONS).toBe('--max-old-space-size=4096');
  });

  it('plans a typecheck as one process under the same budget (T13123)', () => {
    const kept = planHeavyToolEnv('typecheck', { NODE_OPTIONS: '--max-old-space-size=8192' }, 64);
    expect(kept.resources?.heapMb).toBe(8192);
    expect(kept.resources?.heapSource).toBe('inherited');
    expect(kept.resources?.workers).toBe(1);
    expect(kept.resources?.summary).toContain('one process');
    expect(kept.overlay.VITEST_MAX_WORKERS).toBeUndefined();
    expect(kept.overlay.MAKEFLAGS).toBeUndefined();

    // An 8 GiB laptop: a profile-wide 8 GiB heap is above the budget.
    const laptop = planHeavyToolEnv('lint', { NODE_OPTIONS: '--max-old-space-size=8192' }, 8);
    expect(laptop.resources?.heapSource).toBe('clamped');
    expect(laptop.overlay.NODE_OPTIONS).toBe('--max-old-space-size=4096');

    // CLEO_HEAVY_WORKERS means nothing to a single process and is not read.
    const ignored = planHeavyToolEnv('typecheck', { CLEO_HEAVY_WORKERS: 'x' }, 64);
    expect(ignored.resources?.summary).not.toContain('ignored');
  });
});
