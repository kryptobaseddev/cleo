import type { DoctorRepairResult, StoreRepairReceipt } from '@cleocode/contracts/db-recovery.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorRepairStoreCommand } from '../doctor-repair-store.js';

const mocks = vi.hoisted(() => ({
  repair: vi.fn(),
  root: vi.fn(),
  output: vi.fn(),
  error: vi.fn(),
  inspect: vi.fn(),
  legacyRepair: vi.fn(),
  legacyLoads: 0,
}));
vi.mock('@cleocode/core/store/repair-store.js', () => ({ repairStoresFromDoctor: mocks.repair }));
vi.mock('@cleocode/core/store/repair-malformed-dbs.js', () => {
  mocks.legacyLoads++;
  return { repairMalformedDbs: mocks.legacyRepair };
});
vi.mock('@cleocode/core/project-scope', async (original) => ({
  ...(await original<typeof import('@cleocode/core/project-scope')>()),
  getProjectRoot: mocks.root,
  isMissingProjectError: (error: Error) => error.message.startsWith('Not inside a CLEO project'),
}));
vi.mock('../../renderers/index.js', () => ({ cliOutput: mocks.output, cliError: mocks.error }));
vi.mock('@cleocode/core/store/open-cleo-db.js', async (original) => ({
  ...(await original<typeof import('@cleocode/core/store/open-cleo-db.js')>()),
  inspectStoreIntegrity: mocks.inspect,
}));

const receipt: StoreRepairReceipt = {
  version: 1,
  scope: 'project',
  target: '/tmp/project/.cleo/cleo.db',
  startedAt: '2026-11-13T00:00:00Z',
  status: 'healthy',
  quarantineDir: null,
  snapshot: null,
  snapshotAt: null,
  delta: true,
  files: [],
  tables: {},
  missingTaskIds: [],
  diagnostics: [],
  integrityOK: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.root.mockReturnValue('/tmp/project');
  mocks.repair.mockResolvedValue([receipt]);
  mocks.inspect.mockReturnValue({ healthy: true, detail: 'ok' });
});

afterEach(() => {
  process.exitCode = undefined;
});

async function invoke(global = false, dryRun = false, confirm = false): Promise<void> {
  await doctorRepairStoreCommand.run?.({
    args: { _: [], global, 'dry-run': dryRun, 'confirm-owner-store': confirm },
    rawArgs: [],
    cmd: doctorRepairStoreCommand,
  });
}

describe('doctor repair-store', () => {
  it('emits the core receipts and forwards the project and invocation directory', async () => {
    await invoke();
    expect(mocks.repair).toHaveBeenCalledWith({
      projectRoot: '/tmp/project',
      cwd: process.cwd(),
      scope: 'project',
      dryRun: false,
      confirmOwnerStore: false,
    });
    expect(mocks.output).toHaveBeenCalledWith(
      { stores: [receipt] },
      { command: 'doctor', operation: 'doctor.repair-store' },
    );
  });
  it('runs global repair outside a project without resolving a project store', async () => {
    mocks.root.mockImplementation(() => {
      throw new Error('Not inside a CLEO project');
    });
    await invoke(true, true);
    expect(mocks.root).not.toHaveBeenCalled();
    expect(mocks.repair).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'global', dryRun: true }),
    );
  });
  it('lets the exact error fix inspect global damage when invoked outside a project', async () => {
    mocks.root.mockImplementation(() => {
      throw new Error('Not inside a CLEO project');
    });
    await invoke();
    expect(mocks.repair).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: process.cwd() }),
    );
  });
  it('forwards explicit owner-store confirmation', async () => {
    await invoke(false, false, true);
    expect(mocks.repair).toHaveBeenCalledWith(expect.objectContaining({ confirmOwnerStore: true }));
  });
  it('plain doctor reports damaged global storage before any normal health operation', async () => {
    const { resolveDualScopeDbPath } = await import('@cleocode/core/store/dual-scope-db.js');
    const global = resolveDualScopeDbPath('global');
    mocks.inspect.mockImplementation((path: string) => ({
      healthy: path !== global,
      detail: path === global ? 'global malformed' : 'ok',
    }));
    const { doctorCommand } = await import('../doctor.js');
    await doctorCommand.run?.({ args: { _: [] }, rawArgs: [], cmd: doctorCommand });
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining('global malformed'),
      3,
      { name: 'E_DB_CORRUPT', fix: 'cleo doctor repair-store' },
      { operation: 'doctor' },
    );
    expect(mocks.repair).not.toHaveBeenCalled();
  });
  it('loads legacy repair logic only when that subcommand runs and preserves its flags', async () => {
    const result: DoctorRepairResult = {
      dryRun: true,
      roles: [],
      malformedCount: 0,
      repairedCount: 0,
      failedCount: 0,
    };
    mocks.legacyRepair.mockReturnValue(result);
    const { doctorRepairCommand } = await import('../doctor-repair.js');
    expect(mocks.legacyLoads).toBe(0);
    await doctorRepairCommand.run?.({
      args: { _: [], role: 'tasks', 'dry-run': true, 'confirm-owner-store': false },
      rawArgs: [],
      cmd: doctorRepairCommand,
    });
    expect(mocks.legacyLoads).toBe(1);
    expect(mocks.legacyRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/tmp/project',
        roles: ['tasks'],
        dryRun: true,
        confirmOwnerStore: false,
        cwd: process.cwd(),
      }),
    );
    expect(mocks.output).toHaveBeenCalledWith(
      result,
      expect.objectContaining({ command: 'doctor repair' }),
    );
  });
});
