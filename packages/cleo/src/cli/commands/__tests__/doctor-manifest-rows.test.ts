/**
 * `cleo doctor manifest-rows` flag contract (T12686): a bare `--repair` only
 * plans; `--apply` writes; `--dry-run` overrides `--apply`, as in
 * `cleo doctor projects`.
 *
 * @task T12686
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRepair = vi.fn();
const mockCliOutput = vi.fn();

vi.mock('@cleocode/core/memory/pipeline-manifest-sqlite.js', () => ({
  listMalformedManifestRows: vi.fn(async () => []),
  MANIFEST_ROW_APPLY_COMMAND: 'cleo doctor manifest-rows --repair --apply',
  MANIFEST_ROW_REPAIR_COMMAND: 'cleo doctor manifest-rows --repair',
  repairMalformedManifestRows: (...args: unknown[]) => mockRepair(...args),
  rollbackManifestRepair: vi.fn(),
}));

vi.mock('@cleocode/core/paths.js', () => ({ getProjectRoot: () => '/project' }));

vi.mock('../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
}));

import { doctorManifestRowsCommand } from '../doctor-manifest-rows.js';

async function invoke(args: Record<string, unknown>): Promise<void> {
  const runFn = doctorManifestRowsCommand.run as (ctx: {
    args: Record<string, unknown>;
    rawArgs: string[];
  }) => Promise<void>;
  await runFn({ args, rawArgs: [] });
}

describe('cleo doctor manifest-rows --repair / --apply (T12686)', () => {
  beforeEach(() => {
    mockRepair.mockReset();
    mockCliOutput.mockReset();
    mockRepair.mockResolvedValue({ changes: [{ entryId: 'bad' }], applied: null });
  });

  it('a bare --repair plans only and names the apply command', async () => {
    await invoke({ repair: true });
    expect(mockRepair).toHaveBeenCalledWith('/project', { dryRun: true });
    expect(mockCliOutput).toHaveBeenCalledWith(
      expect.objectContaining({ apply: 'cleo doctor manifest-rows --repair --apply' }),
      expect.objectContaining({ operation: 'doctor.manifest-rows.plan' }),
    );
  });

  it('--repair --apply writes', async () => {
    await invoke({ repair: true, apply: true });
    expect(mockRepair).toHaveBeenCalledWith('/project', { dryRun: false });
    expect(mockCliOutput.mock.calls[0]?.[1]).toMatchObject({
      operation: 'doctor.manifest-rows.apply',
    });
  });

  it('--apply alone implies --repair and writes', async () => {
    await invoke({ apply: true });
    expect(mockRepair).toHaveBeenCalledWith('/project', { dryRun: false });
  });

  it('--dry-run overrides --apply', async () => {
    await invoke({ repair: true, apply: true, 'dry-run': true });
    expect(mockRepair).toHaveBeenCalledWith('/project', { dryRun: true });
  });
});
