/**
 * `cleo doctor twin-collapse`: one action per run. `--release-snapshot` with
 * `--recover` would release the snapshot the recovery is about to read, so
 * any two of `--recover`, `--release-snapshot`, `--rollback` and `--retry`
 * are refused before anything runs (T12767 review).
 *
 * Core is mocked: no store is opened.
 *
 * @task T12767
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  inspectProjectTwinCollapse: vi.fn(),
  recoverTwinCollapse: vi.fn(),
  releaseProjectTwinCollapseSnapshot: vi.fn(),
  retryTwinCollapse: vi.fn(),
  rollbackTwinCollapse: vi.fn(),
}));
const renderers = vi.hoisted(() => ({ cliError: vi.fn(), cliOutput: vi.fn() }));

vi.mock('@cleocode/core/doctor/twin-collapse.js', () => core);
vi.mock('@cleocode/core/paths.js', () => ({ getProjectRoot: () => '/tmp/no-such-project' }));
vi.mock('../../renderers/index.js', () => renderers);

import { doctorTwinCollapseCommand } from '../doctor-twin-collapse.js';

type Run = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const run = (args: Record<string, unknown>) =>
  (doctorTwinCollapseCommand as unknown as { run: Run }).run({ args, rawArgs: [] });

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe('doctor twin-collapse: one action per run', () => {
  it('refuses --release-snapshot with --recover, and runs neither', async () => {
    await run({ 'release-snapshot': 'migration-20260928-153200', recover: true, confirm: true });
    expect(renderers.cliError).toHaveBeenCalledWith(
      expect.stringMatching(/--recover and --release-snapshot are separate actions/),
      'E_INVALID_INPUT',
      expect.anything(),
    );
    expect(process.exitCode).toBe(2);
    expect(core.recoverTwinCollapse).not.toHaveBeenCalled();
    expect(core.releaseProjectTwinCollapseSnapshot).not.toHaveBeenCalled();
    expect(core.inspectProjectTwinCollapse).not.toHaveBeenCalled();
  });

  it('refuses any two actions (--rollback with --retry)', async () => {
    await run({ rollback: 'twin_collapse_recovery:x', retry: true });
    expect(renderers.cliError).toHaveBeenCalledWith(
      expect.stringMatching(/--rollback and --retry are separate actions/),
      'E_INVALID_INPUT',
      expect.anything(),
    );
    expect(core.rollbackTwinCollapse).not.toHaveBeenCalled();
    expect(core.retryTwinCollapse).not.toHaveBeenCalled();
  });

  it('runs a single action', async () => {
    core.releaseProjectTwinCollapseSnapshot.mockResolvedValue({ dryRun: true });
    await run({ 'release-snapshot': 'migration-20260928-153200', 'dry-run': true });
    expect(renderers.cliError).not.toHaveBeenCalled();
    expect(core.releaseProjectTwinCollapseSnapshot).toHaveBeenCalledWith(
      '/tmp/no-such-project',
      'migration-20260928-153200',
      expect.objectContaining({ dryRun: true, confirm: false }),
    );
  });
});
