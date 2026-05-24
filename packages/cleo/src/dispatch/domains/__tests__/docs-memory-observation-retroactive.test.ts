/**
 * Regression test for T10375 (Saga T10288 → Epic T10293 E5.5).
 *
 * Verifies that the T9976 docs->memory auto-emit fires correctly for the
 * specific class of slug shapes used during the retroactive-normalization
 * sweep performed by T10371 + T10373 — kebab-case task/ADR identifiers like
 * `t10268-saga-closeout`, `adr-085-cross-db-invariants`, and friends.
 *
 * Real-world end-to-end confirmation (against the project brain.db) was
 * collected as part of this task's closeout — the test below pins the
 * payload contract so the auto-emit cannot silently regress for the
 * retroactive-slug shape.
 *
 * Why a dedicated test: the existing `docs-memory-observation.test.ts`
 * exercises arbitrary slugs. This file specifically asserts:
 *
 *   1. The slug shapes used by the T10371/T10373 normalization sweep
 *      (`t<digits>-<kebab>`, `adr-<digits>-<kebab>`) flow through the
 *      auto-emit without surprise (FTS-friendly, no escaping issues).
 *   2. The {@link DocAttachmentObservationPayload} contract is preserved
 *      end-to-end: every required field lands in `brain_observations.narrative`
 *      with the exact shape consumers depend on.
 *   3. Both `type='adr'` and `type='note'` (the dominant retroactive types)
 *      round-trip correctly.
 *
 * Strategy: real tasks.db + real brain.db via temp CLEO_DIR, mirroring the
 * existing T9976 test suite so the same storage path is exercised.
 *
 * @task T10375
 * @saga T10288
 * @epic T10293
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocAttachmentObservationPayload } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocsHandler } from '../docs.js';

// ---------------------------------------------------------------------------
// Helpers — mirrors the read-back helper in docs-memory-observation.test.ts so
// the two suites can evolve independently if BRAIN storage details shift.
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
 * Read the doc-attachment observation row for `slug` directly from
 * `brain_observations` via LIKE on `title` and `narrative` — bypasses RRF
 * fusion which requires both FTS and vector hits (and the latter is not
 * built in fresh temp brains).
 */
async function findDocObservationBySlug(
  slug: string,
): Promise<{ id: string; title: string | null; narrative: string | null } | undefined> {
  const { getBrainDb, getBrainNativeDb } = await import('@cleocode/core/internal');
  await getBrainDb();
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return undefined;
  const likePattern = `%${slug}%`;
  const row = nativeDb
    .prepare(
      `SELECT id, title, narrative FROM brain_observations
       WHERE (title LIKE ? OR narrative LIKE ?)
         AND invalid_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(likePattern, likePattern) as
    | { id: string; title: string | null; narrative: string | null }
    | undefined;
  return row;
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let tempDir: string;
let fixtureFile: string;
const docsHandler = new DocsHandler();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-retro-'));
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');

  fixtureFile = join(tempDir, 'doc.md');
  await writeFile(
    fixtureFile,
    '# Retroactively-Normalized Doc\n\nT10375 regression fixture.',
    'utf-8',
  );
});

afterEach(async () => {
  const { closeAllDatabases } = await import('@cleocode/core/internal');
  await closeAllDatabases();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Slug-shape table — covers both the task-ID and ADR-ID conventions used by
// the T10371/T10373 retroactive sweep.
// ---------------------------------------------------------------------------

interface RetroactiveSlugCase {
  /** Display label for the test row. */
  label: string;
  /** The slug as written by the sweep (kebab-case). */
  slug: string;
  /** The owner task this attachment hangs off. */
  ownerId: string;
  /** DocKind classification (`adr`, `note`, etc.). */
  type: string;
}

const RETROACTIVE_SLUG_CASES: RetroactiveSlugCase[] = [
  {
    label: 'task-anchored note slug (t10268-saga-closeout shape)',
    slug: 't10999-retroactive-note-fixture',
    ownerId: 'T10999',
    type: 'note',
  },
  {
    label: 'task-anchored long-form slug (t10292-e4-cli-verb-matrix shape)',
    slug: 't10999-e4-cli-verb-matrix-fixture',
    ownerId: 'T10999',
    type: 'note',
  },
  {
    label: 'ADR slug (adr-085-cross-db-invariants shape)',
    slug: 'adr-999-cross-db-invariants-fixture',
    ownerId: 'T10999',
    type: 'adr',
  },
  {
    label: 'long ADR slug (adr-083-cleo-persona-and-hierarchy-reconciliation shape)',
    slug: 'adr-999-cleo-persona-and-hierarchy-reconciliation-fixture',
    ownerId: 'T10999',
    type: 'adr',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T10375 — auto-emit on retroactively-normalized docs (E5.5)', () => {
  for (const testCase of RETROACTIVE_SLUG_CASES) {
    it(`emits a complete doc-attachment payload for ${testCase.label}`, async () => {
      const addResp = await docsHandler.mutate('add', {
        ownerId: testCase.ownerId,
        file: fixtureFile,
        slug: testCase.slug,
        type: testCase.type,
        attachedBy: 'test-T10375',
      });
      expect(addResp.success, `docs.add failed: ${JSON.stringify(addResp.error)}`).toBe(true);
      const addData = addResp.data as { attachmentId: string };

      let foundRow: { id: string; title: string | null; narrative: string | null } | undefined;
      await waitFor(async () => {
        foundRow = await findDocObservationBySlug(testCase.slug);
        return foundRow !== undefined;
      });

      // Auto-emit landed.
      expect(
        foundRow,
        `expected docs.add to emit a doc-attachment observation for slug '${testCase.slug}'`,
      ).toBeDefined();
      if (!foundRow) return;

      // Title shape — what `cleo memory find '<slug>'` matches on via FTS.
      expect(foundRow.title).toBe(`Doc attached: ${testCase.slug}`);

      // Narrative — full structured payload.
      expect(typeof foundRow.narrative).toBe('string');
      if (!foundRow.narrative) return;
      const payload = JSON.parse(foundRow.narrative) as DocAttachmentObservationPayload;

      // Every required field of the contract must be present and correct.
      expect(payload.kind).toBe('doc-attachment');
      expect(payload.attachmentId).toBe(addData.attachmentId);
      expect(payload.ownerId).toBe(testCase.ownerId);
      expect(payload.slug).toBe(testCase.slug);
      expect(payload.type).toBe(testCase.type);
      expect(typeof payload.addedAt).toBe('string');
      // addedAt must be ISO 8601 — the contract calls for it and `verify`
      // round-tripping against the docs store depends on it.
      expect(() => new Date(payload.addedAt).toISOString()).not.toThrow();
    });
  }

  it('payload shape stays stable across the retroactive batch (sanity check)', async () => {
    // This is an explicit guard against silent contract-drift — if a future
    // change drops a field from the payload, this test catches it without
    // having to update every per-slug case above.
    const slug = 't10999-shape-sanity-fixture';
    const addResp = await docsHandler.mutate('add', {
      ownerId: 'T10999',
      file: fixtureFile,
      slug,
      type: 'note',
      attachedBy: 'test-T10375',
    });
    expect(addResp.success).toBe(true);

    let foundRow: { id: string; title: string | null; narrative: string | null } | undefined;
    await waitFor(async () => {
      foundRow = await findDocObservationBySlug(slug);
      return foundRow !== undefined;
    });

    expect(foundRow).toBeDefined();
    if (!foundRow?.narrative) return;
    const payload = JSON.parse(foundRow.narrative) as DocAttachmentObservationPayload;

    // Exact key set — extra keys are tolerated (forward-compatible) but
    // every required key MUST be present.
    expect(payload).toMatchObject({
      kind: 'doc-attachment',
      attachmentId: expect.any(String),
      ownerId: 'T10999',
      slug,
      type: 'note',
      addedAt: expect.any(String),
    });
  });
});
