/**
 * `cleo doctor type-matrix` writes only with `--apply` or `--rollback`, and
 * refuses a missing `--resolutions` file as E_VALIDATION (T14096).
 *
 * Core is mocked: no store is opened. The repair itself is covered by
 * `packages/core/src/doctor/__tests__/type-matrix-repair.test.ts`.
 *
 * @task T14096
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const repair = vi.hoisted(() => ({
  planTypeMatrixRepair: vi.fn(),
  applyTypeMatrixRepair: vi.fn(),
  rollbackTypeMatrixRepair: vi.fn(),
  parseTypeMatrixResolutions: vi.fn(),
}));
const lines = vi.hoisted(() => ({ cliOutput: vi.fn(), cliError: vi.fn() }));

vi.mock('@cleocode/core/doctor/type-matrix-repair.js', () => repair);
vi.mock('@cleocode/core/paths.js', () => ({ getProjectRoot: () => '/tmp/no-such-project' }));
vi.mock('../../renderers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../renderers/index.js')>()),
  ...lines,
}));

import { doctorTypeMatrixCommand } from '../doctor-type-matrix.js';

type Run = (ctx: {
  args: Record<string, unknown>;
  rawArgs: string[];
  cmd: object;
}) => Promise<void>;
const run = (args: Record<string, unknown>) =>
  (doctorTypeMatrixCommand as { run: Run }).run({ args, rawArgs: [], cmd: {} });

const REPORT = { dryRun: true, violations: 1, unresolved: ['T2'], operations: [], plans: [] };

beforeEach(() => {
  process.exitCode = undefined;
  repair.planTypeMatrixRepair.mockResolvedValue(REPORT);
  repair.applyTypeMatrixRepair.mockResolvedValue({ ...REPORT, dryRun: false });
});

afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe('cleo doctor type-matrix', () => {
  it('without --apply it only plans, and exits 1 while a violation is unresolved', async () => {
    await run({});
    expect(repair.planTypeMatrixRepair).toHaveBeenCalledWith('/tmp/no-such-project', []);
    expect(repair.applyTypeMatrixRepair).not.toHaveBeenCalled();
    expect(repair.rollbackTypeMatrixRepair).not.toHaveBeenCalled();
    expect(lines.cliOutput).toHaveBeenCalledWith(REPORT, {
      command: 'doctor',
      operation: 'doctor.type-matrix.plan',
    });
    expect(process.exitCode).toBe(1);
  });

  it('with --apply it applies', async () => {
    await run({ apply: true });
    expect(repair.applyTypeMatrixRepair).toHaveBeenCalledWith('/tmp/no-such-project', []);
    expect(repair.planTypeMatrixRepair).not.toHaveBeenCalled();
  });

  it('refuses a missing --resolutions file as E_VALIDATION, writing nothing', async () => {
    await run({ apply: true, resolutions: '/tmp/no-such-resolutions-file.json' });
    expect(lines.cliError).toHaveBeenCalledWith(
      expect.stringMatching(/no such file/),
      expect.anything(),
      { name: 'E_VALIDATION' },
    );
    expect(repair.applyTypeMatrixRepair).not.toHaveBeenCalled();
  });
});
