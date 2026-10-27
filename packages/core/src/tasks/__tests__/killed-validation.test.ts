/**
 * T13013: every path that runs an evidence tool reports a kill (a signal, or
 * resources: exit 128 + n, a heap OOM) as E_EVIDENCE_TOOL_KILLED with the
 * memory ceiling and where the heap is really set, never as failing tests.
 *
 * @task T13013
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const LIMIT =
  ' This tool runs inside a memory-bounded systemd scope (MemoryMax=8192M, swap denied).';

vi.mock('../heavy-tool-limit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../heavy-tool-limit.js')>()),
  describeMemoryLimit: () => LIMIT,
}));
const runToolCached = vi.fn();
vi.mock('../tool-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tool-cache.js')>()),
  runToolCached: (...args: unknown[]) => runToolCached(...args),
}));
vi.mock('../affected-packages.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../affected-packages.js')>()),
  planAffectedTestRun: async () => ({
    ok: true,
    command: {
      canonical: 'test',
      displayName: 'test',
      cmd: 'pnpm',
      args: ['exec', 'vitest', 'run'],
      source: 'language-default',
    },
  }),
}));

const { killedValidation } = await import('../evidence.js');
const { defaultRunTool } = await import('../done-record.js');

const run = (over: Record<string, unknown> = {}) => ({
  exitCode: 1,
  signal: null,
  resourceKill: null,
  durationMs: 41_000,
  executionRoot: '/repo',
  stdoutTail: '',
  stderrTail: 'FATAL ERROR: Reached heap limit',
  timedOut: false,
  cacheHit: false,
  ...over,
});

afterEach(() => runToolCached.mockReset());

describe('killedValidation (T13013)', () => {
  it('a signal kill and a resource kill are E_EVIDENCE_TOOL_KILLED, with the ceiling and heap advice', () => {
    for (const [over, how] of [
      [{ signal: 'SIGKILL', exitCode: null }, 'KILLED by SIGKILL'],
      [
        { resourceKill: 'exit 137 (128 + SIGKILL)' },
        'KILLED for resources (exit 137 (128 + SIGKILL))',
      ],
    ] as const) {
      const v = killedValidation('Tool "test" → pnpm run test', 'test', run(over));
      expect(v?.codeName).toBe('E_EVIDENCE_TOOL_KILLED');
      expect(v?.reason).toContain(`RAN for 41s in /repo and was ${how}.`);
      expect(v?.reason).toContain(LIMIT);
      expect(v?.reason).toContain('CLEO_HEAVY_HEAP_MB=<MiB>');
      // vitest.memory-safe sets the fork heap with execArgv, which NODE_OPTIONS does not override.
      expect(v?.reason).toMatch(/execArgv .* NODE_OPTIONS does not override it/);
      expect(v?.reason).toContain('Last output: ');
    }
  });

  it('a run that was not killed is not a kill', () => {
    expect(killedValidation('Tool "test"', 'test', run())).toBeNull();
  });

  it('cleo done: an OOM-killed affected run carries the kill, not just its exit code', async () => {
    runToolCached.mockResolvedValue(
      run({ resourceKill: 'output reports "JavaScript heap out of memory"' }),
    );
    const out = await defaultRunTool('test-affected', '/repo', '/repo');
    expect(out.exitCode).toBe(1);
    expect(out.killed).toMatch(
      /^tool:test-affected \(affected: pnpm\) RAN for 41s .* KILLED for resources/,
    );
    runToolCached.mockResolvedValue(run({ stderrTail: 'FAIL a.test.ts' }));
    expect((await defaultRunTool('test-affected', '/repo', '/repo')).killed).toBeUndefined();
  });
});
