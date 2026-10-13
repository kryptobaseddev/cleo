/**
 * T13654 (fix 2) — attachment-repair fails closed when the publications
 * ledger is unreadable.
 *
 * The sweep's last safety net before deleting an unreferenced legacy blob
 * is the publications-ledger protection set. If reading the ledger throws,
 * the repair MUST treat every candidate as potentially published and delete
 * NOTHING — the previous `.catch(() => new Set())` silently emptied the
 * protection set and let the sweep delete published blobs.
 *
 * The ledger read goes through `readDocsPublicationSha256Set`
 * (packages/core/src/docs/publications-store.ts), mocked here to throw; the
 * control case (ledger readable, sha not in it) deletes the same file.
 *
 * @task T13654
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ledgerMock = vi.hoisted(() => ({
  readDocsPublicationSha256Set: vi.fn<() => Promise<Set<string>>>(),
}));

vi.mock('../../docs/publications-store.js', () => ({
  readDocsPublicationSha256Set: ledgerMock.readDocsPublicationSha256Set,
}));

let tempDir: string;

/** An unreferenced legacy blob file old enough to pass the grace period. */
function seedUnreferencedLegacyBlob(content: string): { sha256: string; filePath: string } {
  const sha256 = createHash('sha256').update(content).digest('hex');
  const filePath = join(
    tempDir,
    '.cleo',
    'attachments',
    'sha256',
    sha256.slice(0, 2),
    `${sha256.slice(2)}.md`,
  );
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content);
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  utimesSync(filePath, old, old);
  return { sha256, filePath };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-repair-fail-closed-'));
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  const { closeDb } = await import('../sqlite.js');
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import('../sqlite.js');
  closeDb();
  delete process.env['CLEO_DIR'];
  ledgerMock.readDocsPublicationSha256Set.mockReset();
  await rm(tempDir, { recursive: true, force: true });
});

describe('repairAttachmentStore — publications-ledger fail-closed (T13654)', () => {
  it('deletes nothing and reports the fail-closed reason when the ledger read throws', async () => {
    const { sha256, filePath } = seedUnreferencedLegacyBlob('# Orphan\n');
    ledgerMock.readDocsPublicationSha256Set.mockRejectedValue(new Error('ledger unreadable'));

    const { repairAttachmentStore } = await import('../attachment-repair.js');
    const result = await repairAttachmentStore({ cwd: tempDir, dryRun: false, gracePeriodMs: 0 });

    // The blob is still on disk …
    expect(existsSync(filePath)).toBe(true);
    // … recorded as skipped-referenced with the fail-closed reason …
    const skip = result.actions.find((a) => a.kind === 'skip-referenced-blob');
    expect(skip).toBeDefined();
    expect(skip?.sha256).toBe(sha256);
    expect(skip?.reason).toContain('failing closed');
    // … and no deletion was planned or executed.
    expect(result.actions.filter((a) => a.kind === 'delete-unreferenced-blob')).toEqual([]);
    expect(
      result.actions.find((a) => a.kind === 'delete-unreferenced-blob' && a.sha256 === sha256),
    ).toBeUndefined();
  });

  it('control: the same unreferenced blob IS deleted when the ledger reads and does not name it', async () => {
    const { sha256, filePath } = seedUnreferencedLegacyBlob('# Orphan\n');
    ledgerMock.readDocsPublicationSha256Set.mockResolvedValue(new Set<string>());

    const { repairAttachmentStore } = await import('../attachment-repair.js');
    const result = await repairAttachmentStore({ cwd: tempDir, dryRun: false, gracePeriodMs: 0 });

    expect(existsSync(filePath)).toBe(false);
    const deletion = result.actions.find((a) => a.kind === 'delete-unreferenced-blob');
    expect(deletion?.sha256).toBe(sha256);
  });

  it('control: a blob named by the ledger is protected when the ledger reads', async () => {
    const { sha256, filePath } = seedUnreferencedLegacyBlob('# Published orphan\n');
    ledgerMock.readDocsPublicationSha256Set.mockResolvedValue(new Set([sha256]));

    const { repairAttachmentStore } = await import('../attachment-repair.js');
    const result = await repairAttachmentStore({ cwd: tempDir, dryRun: false, gracePeriodMs: 0 });

    expect(existsSync(filePath)).toBe(true);
    expect(
      result.actions.find((a) => a.kind === 'skip-referenced-blob' && a.sha256 === sha256),
    ).toBeDefined();
  });
});
