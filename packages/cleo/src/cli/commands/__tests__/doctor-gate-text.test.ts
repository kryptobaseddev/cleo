/**
 * `cleo doctor gate-text` (T14635): the CLI wrapper passes `--apply` and
 * `--reason` through and exits 1 only while criteria on open tasks remain.
 *
 * Core is mocked: no store is opened. The scan and conversion are covered by
 * `packages/core/src/doctor/__tests__/gate-text.test.ts`.
 *
 * @task T14635
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({ scanGateTextAcceptance: vi.fn() }));
const lines = vi.hoisted(() => ({ cliOutput: vi.fn() }));

vi.mock('@cleocode/core/doctor/gate-text.js', () => core);
vi.mock('@cleocode/core/paths.js', () => ({ getProjectRoot: () => '/tmp/no-such-project' }));
vi.mock('../../renderers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../renderers/index.js')>()),
  ...lines,
}));

import { doctorGateTextCommand } from '../doctor-gate-text.js';

type Run = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const runOf = (command: unknown) => (command as { run: Run }).run;
const run = (args: Record<string, unknown>) => runOf(doctorGateTextCommand)({ args, rawArgs: [] });

const report = (remaining: number, terminal = 0) => ({
  applied: false,
  tasksScanned: 3,
  found: remaining + terminal,
  converted: 0,
  remaining,
  terminal,
  tasks: [],
});

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
  vi.clearAllMocks();
});

describe('cleo doctor gate-text (T14635)', () => {
  it('a dry run with remaining criteria exits 1', async () => {
    core.scanGateTextAcceptance.mockResolvedValue(report(2));
    await run({});
    expect(core.scanGateTextAcceptance).toHaveBeenCalledWith('/tmp/no-such-project', {
      apply: false,
    });
    expect(process.exitCode).toBe(1);
  });

  it('--apply --reason passes both through and exits 0 once nothing remains', async () => {
    core.scanGateTextAcceptance.mockResolvedValue({ ...report(0), applied: true, converted: 2 });
    await run({ apply: true, reason: 'legacy rows' });
    expect(core.scanGateTextAcceptance).toHaveBeenCalledWith('/tmp/no-such-project', {
      apply: true,
      reason: 'legacy rows',
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('criteria on terminal tasks alone do not fail the command', async () => {
    core.scanGateTextAcceptance.mockResolvedValue(report(0, 3));
    await run({ apply: true });
    expect(process.exitCode).toBeUndefined();
  });
});
