/**
 * `cleo doctor dep-cycles` and the default `cleo doctor` run report stored
 * dependency cycles and exit 2 while one remains (T12886).
 *
 * Core is mocked: no store is opened. The store-level detection is covered by
 * `packages/core/src/store/__tests__/dependency-cycle-guard.test.ts`.
 *
 * @task T12886
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cycles = vi.hoisted(() => ({ scanDependencyCycles: vi.fn() }));
const saga = vi.hoisted(() => ({ auditSagaHierarchy: vi.fn() }));
const dispatch = vi.hoisted(() => ({ dispatchFromCli: vi.fn(), dispatchRaw: vi.fn() }));
const lines = vi.hoisted(() => ({ humanLine: vi.fn(), cliOutput: vi.fn(), cliError: vi.fn() }));

vi.mock('@cleocode/core/doctor/dependency-cycles.js', () => cycles);
vi.mock('@cleocode/core/doctor/saga-audit.js', () => saga);
vi.mock('@cleocode/core/paths.js', () => ({ getProjectRoot: () => '/tmp/no-such-project' }));
vi.mock('../../../dispatch/adapters/cli.js', () => dispatch);
vi.mock('../migrate-agents-v2.js', () => ({ readMigrationConflicts: () => [] }));
vi.mock('../../renderers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../renderers/index.js')>()),
  ...lines,
}));
vi.mock('@cleocode/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core')>()),
  getProjectRoot: () => '/tmp/no-such-project',
}));

import { doctorCommand } from '../doctor.js';
import { doctorDepCyclesCommand } from '../doctor-dep-cycles.js';

type Run = (ctx: {
  args: Record<string, unknown>;
  rawArgs: string[];
  cmd: { subCommands?: unknown };
}) => Promise<void>;
const runOf = (command: unknown) => (command as { run: Run }).run;

const CYCLIC = {
  edgeCount: 3,
  components: [{ tasks: ['T1', 'T2'], cycle: ['T1', 'T2', 'T1'] }],
  repairPlan: [
    {
      edge: { taskId: 'T2', dependsOn: 'T1' },
      command: 'cleo update T2 --remove-depends T1',
      breaks: ['T1', 'T2', 'T1'],
    },
  ],
  cycleCount: 1,
  readOnly: true,
};
const CLEAN = { edgeCount: 3, components: [], repairPlan: [], cycleCount: 0, readOnly: true };

beforeEach(() => {
  process.exitCode = undefined;
  saga.auditSagaHierarchy.mockResolvedValue({ sagas: [], count: 0, driftCount: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe('cleo doctor dep-cycles', () => {
  it('outputs the report with the repair plan and exits 2 while a cycle remains', async () => {
    cycles.scanDependencyCycles.mockResolvedValue(CYCLIC);
    await runOf(doctorDepCyclesCommand)({ args: {}, rawArgs: [], cmd: {} });
    expect(cycles.scanDependencyCycles).toHaveBeenCalledWith('/tmp/no-such-project');
    expect(lines.cliOutput).toHaveBeenCalledWith(CYCLIC, {
      command: 'doctor',
      operation: 'doctor.dep-cycles.run',
    });
    expect(process.exitCode).toBe(2);
  });

  it('exits 0 on a clean store', async () => {
    cycles.scanDependencyCycles.mockResolvedValue(CLEAN);
    await runOf(doctorDepCyclesCommand)({ args: {}, rawArgs: [], cmd: {} });
    expect(lines.cliOutput).toHaveBeenCalledWith(CLEAN, expect.anything());
    expect(process.exitCode).toBeUndefined();
  });
});

describe('default cleo doctor run', () => {
  const run = () =>
    runOf(doctorCommand)({ args: {}, rawArgs: [], cmd: { subCommands: undefined } });

  it('prints the cycles and repair plan and exits 2', async () => {
    cycles.scanDependencyCycles.mockResolvedValue(CYCLIC);
    await run();
    expect(dispatch.dispatchFromCli).toHaveBeenCalledWith(
      'query',
      'admin',
      'health',
      expect.anything(),
      expect.anything(),
    );
    const printed = lines.humanLine.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('Dependency cycles: 1');
    expect(printed).toContain('T1 → T2 → T1');
    expect(printed).toContain('cleo update T2 --remove-depends T1');
    expect(process.exitCode).toBe(2);
  });

  it('leaves the exit code alone when there is no cycle', async () => {
    cycles.scanDependencyCycles.mockResolvedValue(CLEAN);
    await run();
    expect(process.exitCode).toBeUndefined();
  });
});
