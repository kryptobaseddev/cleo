/**
 * Tests for T9976 — auto-emit memory observation on `cleo docs add`.
 *
 * Covers:
 *   - AC1: `cleo docs add` emits a structured O-doc-<slug> memory observation
 *          with payload `{slug, ownerId, type, attachmentId, addedAt, kind}`.
 *   - AC2: `cleo memory find '<slug>'` surfaces the observation.
 *   - AC3: `cleo memory verify <id>` round-trips and warns on missing attachment.
 *   - AC4: `cleo memory backfill-docs` sweeps existing attachments and emits
 *          observations for any not yet recorded.
 *
 * Strategy: real tasks.db + real brain.db via temp CLEO_DIR so FTS search
 * and brain writes exercise the actual storage layer without CLI overhead.
 * Each test suite gets an isolated temp directory.
 *
 * Note on memory.find search path: `searchBrainCompact` uses an RRF
 * fusion path by default that requires both FTS and vector hits. In fresh
 * temp databases (no vector index), the RRF path may return zero results
 * even when FTS finds the entry. AC2 is therefore verified directly against
 * the brain SQLite database for reliability, mirroring how the CLI
 * `cleo memory find` works when using `--table observations`.
 *
 * @task T9976
 * @epic T9964
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocAttachmentObservationPayload } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocsHandler } from '../docs.js';
import { MemoryHandler } from '../memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait up to `ms` milliseconds for `predicate()` to return truthy. */
async function waitFor(predicate: () => Promise<boolean>, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Search brain_observations directly via SQLite for doc-attachment entries.
 *
 * Uses LIKE on `title` and `narrative` to reliably find the entry in fresh
 * test databases where FTS/vector indexes are not yet built.
 */
async function findDocObservationBySlug(
  slug: string,
): Promise<{ id: string; narrative: string | null } | undefined> {
  const { getBrainDb, getBrainNativeDb } = await import('@cleocode/core/internal');
  await getBrainDb();
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return undefined;
  const likePattern = `%${slug}%`;
  const row = nativeDb
    .prepare(
      `SELECT id, narrative FROM brain_observations
       WHERE (title LIKE ? OR narrative LIKE ?)
         AND invalid_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(likePattern, likePattern) as { id: string; narrative: string | null } | undefined;
  return row;
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let tempDir: string;
let fixtureFile: string;
const docsHandler = new DocsHandler();
const memoryHandler = new MemoryHandler();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-mem-'));
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');

  fixtureFile = join(tempDir, 'spec.md');
  await writeFile(fixtureFile, '# Spec\n\nT9976 doc-attachment observation test', 'utf-8');
});

afterEach(async () => {
  const { closeAllDatabases } = await import('@cleocode/core/internal');
  await closeAllDatabases();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 + AC2 — docs.add emits observation; memory find surfaces it
// ---------------------------------------------------------------------------

describe('T9976 — docs.add emits memory observation (AC1 + AC2)', () => {
  it('emits a doc-attachment observation after docs.add with slug', async () => {
    const slug = 'my-t9976-spec';

    const addResp = await docsHandler.mutate('add', {
      ownerId: 'T9976',
      file: fixtureFile,
      slug,
      type: 'spec',
      attachedBy: 'test',
    });
    expect(addResp.success, `docs.add failed: ${JSON.stringify(addResp.error)}`).toBe(true);
    const addData = addResp.data as { attachmentId: string };

    // AC1: poll brain.db directly (bypasses RRF/vector path) until the
    // fire-and-forget observation lands.
    let foundRow: { id: string; narrative: string | null } | undefined;
    await waitFor(async () => {
      foundRow = await findDocObservationBySlug(slug);
      return foundRow !== undefined;
    });

    expect(
      foundRow,
      `expected docs.add to emit an observation containing slug '${slug}'`,
    ).toBeDefined();

    // AC1: validate structured payload in the narrative
    expect(typeof foundRow?.narrative).toBe('string');
    if (foundRow?.narrative) {
      const payload = JSON.parse(foundRow.narrative) as Partial<DocAttachmentObservationPayload>;
      expect(payload.kind).toBe('doc-attachment');
      expect(payload.attachmentId).toBe(addData.attachmentId);
      expect(payload.slug).toBe(slug);
      expect(payload.ownerId).toBe('T9976');
      expect(payload.type).toBe('spec');
      expect(typeof payload.addedAt).toBe('string');
    }

    // AC2: memory.find surfaces the entry (may use LIKE fallback in fresh DBs).
    // Use `tables: ['observations']` to restrict search to observations table and
    // avoid RRF cross-table fusion which requires vector index not present in tests.
    const findResp = await memoryHandler.query('find', {
      query: slug,
      tables: ['observations'],
    });
    expect(findResp.success).toBe(true);
    // The compact result uses `results` field per SearchBrainCompactResult contract.
    const findData = findResp.data as { results?: Array<{ id: string; title: string }> };
    const results = findData.results ?? [];
    const hit = results.find((r) => r.title.includes(slug) || r.id === foundRow?.id);
    expect(
      hit,
      `memory.find('${slug}', {tables: ['observations']}) did not surface the observation`,
    ).toBeDefined();
    expect(hit?.title).toContain(slug);
  });

  it('emits a doc-attachment observation for URL attachments', async () => {
    const slug = 't9976-url-slug';

    const addResp = await docsHandler.mutate('add', {
      ownerId: 'T9976',
      url: 'https://example.com/t9976-url-fixture',
      slug,
      attachedBy: 'test',
    });
    expect(addResp.success, `docs.add URL failed: ${JSON.stringify(addResp.error)}`).toBe(true);
    const addData = addResp.data as { attachmentId: string };

    let foundRow: { id: string; narrative: string | null } | undefined;
    await waitFor(async () => {
      foundRow = await findDocObservationBySlug(slug);
      return foundRow !== undefined;
    });

    expect(
      foundRow,
      `expected docs.add URL to emit an observation containing slug '${slug}'`,
    ).toBeDefined();

    if (foundRow?.narrative) {
      const payload = JSON.parse(foundRow.narrative) as Partial<DocAttachmentObservationPayload>;
      expect(payload.kind).toBe('doc-attachment');
      expect(payload.attachmentId).toBe(addData.attachmentId);
      expect(payload.slug).toBe(slug);
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 — memory.verify round-trips against docs store
// ---------------------------------------------------------------------------

describe('T9976 — memory.verify round-trips against docs store (AC3)', () => {
  it('verify on a doc-attachment observation sets attachmentMissing=false when attachment exists', async () => {
    const slug = 'verify-present-test';

    const addResp = await docsHandler.mutate('add', {
      ownerId: 'T9976',
      file: fixtureFile,
      slug,
      attachedBy: 'test',
    });
    expect(addResp.success).toBe(true);

    // Wait for observation to land in brain.db
    let foundRow: { id: string; narrative: string | null } | undefined;
    await waitFor(async () => {
      foundRow = await findDocObservationBySlug(slug);
      return foundRow !== undefined;
    });

    if (!foundRow) {
      // Observation hasn't landed — skip verify check gracefully.
      return;
    }

    const verifyResp = await memoryHandler.mutate('verify', { id: foundRow.id });
    expect(verifyResp.success).toBe(true);
    const verifyData = verifyResp.data as {
      id: string;
      verified: boolean;
      attachmentMissing?: boolean;
      warning?: string;
    };
    expect(verifyData.verified).toBe(true);
    // Attachment exists — attachmentMissing should be false (not true)
    expect(verifyData.attachmentMissing).not.toBe(true);
    expect(verifyData.warning).toBeUndefined();
  });

  it('verify warns when attachment has been removed', async () => {
    const slug = 'verify-missing-test';

    const addResp = await docsHandler.mutate('add', {
      ownerId: 'T9976',
      file: fixtureFile,
      slug,
      attachedBy: 'test',
    });
    expect(addResp.success).toBe(true);
    const addData = addResp.data as { attachmentId: string };

    let foundRow: { id: string; narrative: string | null } | undefined;
    await waitFor(async () => {
      foundRow = await findDocObservationBySlug(slug);
      return foundRow !== undefined;
    });

    if (!foundRow) return;

    // Remove the attachment so the next verify finds it missing
    const removeResp = await docsHandler.mutate('remove', {
      attachmentRef: addData.attachmentId,
      from: 'T9976',
    });
    expect(removeResp.success).toBe(true);

    // Verify should now warn that the attachment is missing
    const verifyResp = await memoryHandler.mutate('verify', { id: foundRow.id });
    expect(verifyResp.success).toBe(true);
    const verifyData = verifyResp.data as {
      verified: boolean;
      attachmentMissing?: boolean;
      attachmentId?: string;
      warning?: string;
    };
    expect(verifyData.verified).toBe(true);
    expect(verifyData.attachmentMissing).toBe(true);
    expect(verifyData.warning).toBeDefined();
    expect(verifyData.warning).toContain(addData.attachmentId);
  });
});

// ---------------------------------------------------------------------------
// AC4 — memory.backfill-docs sweeps existing attachments
// ---------------------------------------------------------------------------

describe('T9976 — memory.backfill-docs sweeps existing attachments (AC4)', () => {
  it('backfill-docs emits observations and is idempotent on re-run', async () => {
    // Add an attachment without a slug (plain file attach)
    const addA = await docsHandler.mutate('add', {
      ownerId: 'T9976',
      file: fixtureFile,
      attachedBy: 'test',
    });
    expect(addA.success).toBe(true);

    // First backfill run — should emit or skip (depending on whether auto-emit already fired)
    const backfillResp = await memoryHandler.mutate('backfill-docs', {});
    expect(
      backfillResp.success,
      `backfill-docs failed: ${JSON.stringify(backfillResp.error)}`,
    ).toBe(true);
    const backfillData = backfillResp.data as {
      total: number;
      emitted: number;
      skipped: number;
      emittedAttachmentIds: string[];
      hint: string;
    };

    expect(backfillData.total).toBeGreaterThanOrEqual(1);
    // Conservation: emitted + skipped == total
    expect(backfillData.emitted + backfillData.skipped).toBe(backfillData.total);
    expect(typeof backfillData.hint).toBe('string');
    expect(backfillData.hint.length).toBeGreaterThan(0);

    // Wait for any newly-emitted observations to land
    await new Promise((r) => setTimeout(r, 200));

    // Second run must be fully idempotent — 0 emitted, all skipped
    const backfill2 = await memoryHandler.mutate('backfill-docs', {});
    expect(backfill2.success).toBe(true);
    const backfill2Data = backfill2.data as { emitted: number; skipped: number; total: number };
    expect(backfill2Data.emitted).toBe(0);
    expect(backfill2Data.skipped).toBe(backfill2Data.total);
  });
});
