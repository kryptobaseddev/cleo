import type { StoreRepairReceipt } from '@cleocode/contracts/db-recovery.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorRepairStoreCommand } from '../doctor-repair-store.js';

const mocks = vi.hoisted(() => ({ repair: vi.fn(), root: vi.fn(), output: vi.fn() }));
vi.mock('@cleocode/core/store/repair-store.js', () => ({ repairStoresFromDoctor: mocks.repair }));
vi.mock('@cleocode/core/project-scope', () => ({
  getProjectRoot: mocks.root,
  isMissingProjectError: (error: Error) => error.message.startsWith('Not inside a CLEO project'),
}));
vi.mock('../../renderers/index.js', () => ({ cliOutput: mocks.output }));

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
});
