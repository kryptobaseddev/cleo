/**
 * `docs.doctor` dispatch translation of the named archive target (T14651):
 * `publication` + `archiveInto` reach core as one `archiveInto` pair, and a
 * half-given pair is refused before the pre-repair backup is taken.
 * Code placed in `packages/cleo/` per Package-Boundary Check — verified against AGENTS.md.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runDocsDoctor, createBackup } = vi.hoisted(() => ({
  runDocsDoctor: vi.fn(),
  createBackup: vi.fn(),
}));
vi.mock('@cleocode/core/docs/doctor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runDocsDoctor,
}));
vi.mock('@cleocode/core/system/backup', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createBackup,
}));
vi.mock('@cleocode/core/project-scope', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProjectRoot: () => '/fixture/docs-doctor',
}));
vi.mock('@cleocode/core/core-paths', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveInvokingCheckout: () => '/fixture/docs-doctor-worktree',
}));

import { Dispatcher } from '../../dispatcher.js';
import { DocsHandler } from '../docs.js';

beforeEach(() => {
  vi.clearAllMocks();
  createBackup.mockResolvedValue({ path: '/fixture/backups', backupId: 'b1', files: ['cleo.db'] });
  runDocsDoctor.mockResolvedValue({ ok: true, report: { summary: 'fixture' } });
});

function doctor(params: Record<string, unknown>) {
  const dispatcher = new Dispatcher({ handlers: new Map([['docs', new DocsHandler()]]) });
  return dispatcher.dispatch({ gateway: 'mutate', domain: 'docs', operation: 'doctor', params });
}

describe('docs.doctor named archive target dispatch (T14651)', () => {
  it('passes --publication and --archive-into to core as one archiveInto pair', async () => {
    const response = await doctor({
      apply: true,
      only: 'publication-ledger-drift',
      publication: 'docs/adr/store-notes.md',
      archiveInto: 'adr-001-store',
    });
    expect(response.success).toBe(true);
    expect(runDocsDoctor).toHaveBeenCalledExactlyOnceWith(
      '/fixture/docs-doctor',
      expect.objectContaining({
        apply: true,
        only: ['publication-ledger-drift'],
        archiveInto: { publishedPath: 'docs/adr/store-notes.md', slug: 'adr-001-store' },
        backupReceiptPath: '/fixture/backups/cleo.db.b1',
        checkoutRoot: '/fixture/docs-doctor-worktree',
      }),
    );
  });

  it('refuses a half-given pair before taking the backup', async () => {
    const response = await doctor({ apply: true, publication: 'docs/adr/store-notes.md' });
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_DOCS_DOCTOR_ARCHIVE_INTO_INVALID');
    expect(createBackup).not.toHaveBeenCalled();
    expect(runDocsDoctor).not.toHaveBeenCalled();
  });

  it('sends no archiveInto when neither flag is given', async () => {
    await doctor({ apply: false });
    expect(runDocsDoctor.mock.calls[0]?.[1]).not.toHaveProperty('archiveInto');
  });
});
