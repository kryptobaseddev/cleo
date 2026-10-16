/**
 * T13724 — `backup.mutate` surfaces per-target capture failures instead of
 * silently producing a store-less backup.
 *
 * Covers the `cleo backup add` dispatch path (admin domain handler):
 *   - a `captureErrors` entry from createBackup stays in the success envelope
 *     data (the meta sidecar records it on disk) and queues a
 *     `W_BACKUP_CAPTURE_FAILED` warning (severity `error`) for the renderer's
 *     `meta.warnings` drain
 *   - a clean backup queues no warning — the success path is unchanged
 *   - `--global` capture failures warn with a `scope: 'global'` context
 *   - the `note` param reaches createBackup (the CLI `--note` flag's dispatch
 *     contract)
 *
 * `createBackup` / `createGlobalBackup` and `getProjectRoot` are mocked — no
 * real store or backup file is touched. (The older admin.test.ts covers the
 * same handler with stale module mocks; it is quarantined in
 * packages/cleo/vitest.quarantine.ts.)
 *
 * @task T13724
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cleocode/core/system/backup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/core/system/backup')>();
  return {
    ...actual,
    createBackup: vi.fn(),
    createGlobalBackup: vi.fn(),
  };
});

vi.mock('@cleocode/core/project-scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/core/project-scope')>();
  return { ...actual, getProjectRoot: () => '/mock/project' };
});

import { drainWarnings } from '@cleocode/core/output';
import { createBackup, createGlobalBackup } from '@cleocode/core/system/backup';
import { AdminHandler } from '../admin.js';

describe('T13724 backup.mutate — capture-failure surfacing', () => {
  let handler: AdminHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    drainWarnings();
    handler = new AdminHandler();
  });

  it('keeps a store-capture failure in the success data and queues W_BACKUP_CAPTURE_FAILED', async () => {
    vi.mocked(createBackup).mockResolvedValue({
      backupId: 'snap-denied',
      path: '/mock/backup',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'snapshot',
      files: ['config.json'],
      captureErrors: [
        {
          target: 'cleo.db',
          error: 'authorization denied: VACUUM INTO refused by the worktree build guard',
        },
      ],
    });

    const res = await handler.mutate('backup', { type: 'snapshot' });

    // Success stays success: the JSON files WERE captured.
    expect(res).toMatchObject({
      success: true,
      data: {
        backupId: 'snap-denied',
        files: ['config.json'],
        captureErrors: [
          {
            target: 'cleo.db',
            error: 'authorization denied: VACUUM INTO refused by the worktree build guard',
          },
        ],
      },
    });

    // The failure is also queued as an envelope warning (meta.warnings on
    // render) — visible in CLI output, naming the missing target.
    const warnings = drainWarnings() ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'W_BACKUP_CAPTURE_FAILED',
      severity: 'error',
      context: { backupId: 'snap-denied', target: 'cleo.db' },
    });
    expect(warnings[0]?.message).toContain('cleo.db');
    expect(warnings[0]?.message).toContain('authorization denied');
  });

  it('queues no warning on a clean backup', async () => {
    vi.mocked(createBackup).mockResolvedValue({
      backupId: 'snap-clean',
      path: '/mock/backup',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'snapshot',
      files: ['cleo.db', 'config.json'],
    });

    const res = await handler.mutate('backup', { type: 'snapshot' });

    expect(res).toMatchObject({ success: true, data: { backupId: 'snap-clean' } });
    expect(res.data).not.toHaveProperty('captureErrors');
    expect(drainWarnings()).toBeUndefined();
  });

  it('warns with a global scope context when the --global store fails to capture', async () => {
    vi.mocked(createBackup).mockResolvedValue({
      backupId: 'snap-project',
      path: '/mock/backup',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'snapshot',
      files: ['cleo.db'],
    });
    vi.mocked(createGlobalBackup).mockResolvedValue({
      backupId: 'snap-global',
      path: '/mock/global-backup',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'snapshot',
      files: [],
      captureErrors: [{ target: 'cleo.db', error: 'the global store could not be opened' }],
    });

    const res = await handler.mutate('backup', { type: 'snapshot', includeGlobal: true });

    expect(res).toMatchObject({
      success: true,
      data: {
        backupId: 'snap-project',
        global: { backupId: 'snap-global', files: [], captureErrors: [{ target: 'cleo.db' }] },
      },
    });
    const warnings = drainWarnings() ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'W_BACKUP_CAPTURE_FAILED',
      severity: 'error',
      context: { backupId: 'snap-global', target: 'cleo.db', scope: 'global' },
    });
  });

  it('passes the note param through to createBackup (the --note dispatch contract)', async () => {
    vi.mocked(createBackup).mockResolvedValue({
      backupId: 'snap-note',
      path: '/mock/backup',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'snapshot',
      files: ['cleo.db'],
    });

    await handler.mutate('backup', { type: 'snapshot', note: 'nightly' });

    expect(createBackup).toHaveBeenCalledWith('/mock/project', {
      type: 'snapshot',
      note: 'nightly',
    });
  });
});
