/**
 * Regression test for T10375 (Saga T10288 → Epic T10293 E5.5).
 *
 * Verifies that `cleo docs add` links documents correctly for the specific
 * class of slug shapes used during the retroactive-normalization sweep
 * performed by T10371 + T10373 — kebab-case task/ADR identifiers like
 * `t10268-saga-closeout`, `adr-085-cross-db-invariants`, and friends.
 *
 * T13985 (owner decision D11180) retired the "Doc attached" observation this
 * suite used to pin: the link is now an `llmtxt:<sha> --documents--> owner`
 * edge, and the cases assert that edge (and the absence of an observation).
 *
 * Real-world end-to-end confirmation (against the project brain.db) was
 * collected as part of this task's closeout — the test below pins the
 * payload contract so the auto-emit cannot silently regress for the
 * retroactive-slug shape.
 *
 * Why a dedicated test: the existing `docs-memory-observation.test.ts`
 * exercises arbitrary slugs. This file specifically asserts:
 *
 *   1. The slug shapes normalization mints (`<subject-kebab>`,
 *      `adr-<digits>-<kebab>`) flow through the auto-emit without surprise
 *      (FTS-friendly, no escaping issues). The sweep's task-anchored shape
 *      (`t<digits>-<kebab>`) is refused for new docs since T14129 (D11210);
 *      the last case pins that refusal.
 *   2. Each document is linked to its owner by an
 *      `llmtxt:<sha> --documents--> task:<id>` edge.
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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocsAddResult } from '@cleocode/contracts/operations/docs';
import {
  _resetBrainWriterForTests,
  shutdownBrainWriter,
} from '@cleocode/core/memory/brain-writer-thread';
import { awaitBackgroundOps } from '@cleocode/core/store/background-ops';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsHandler } from '../docs.js';

// ---------------------------------------------------------------------------
// Helpers — mirrors the read-back helper in docs-memory-observation.test.ts so
// the two suites can evolve independently if BRAIN storage details shift.
// ---------------------------------------------------------------------------

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
  vi.stubEnv('CLEO_ROOT', tempDir);
  vi.stubEnv('CLEO_DIR', join(tempDir, '.cleo'));
  vi.stubEnv('CLEO_BRAIN_BYPASS_WRITER_THREAD', '1');
  await mkdir(join(tempDir, '.cleo'));
  await writeFile(
    join(tempDir, '.cleo/project-info.json'),
    JSON.stringify({ projectId: 'observation-fixture', projectRoot: tempDir }),
  );

  fixtureFile = join(tempDir, 'doc.md');
  await writeFile(
    fixtureFile,
    '# Retroactively-Normalized Doc\n\nT10375 regression fixture.',
    'utf-8',
  );
});

afterEach(async () => {
  await awaitBackgroundOps();
  await shutdownBrainWriter();
  _resetBrainWriterForTests();
  const { closeAllDatabases } = await import('@cleocode/core/internal');
  await closeAllDatabases();
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Slug-shape table — the subject and ADR-ID shapes. The sweep's task-anchored
// shape (`t10268-saga-closeout`) can no longer be minted (T14129, D11210).
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
    label: 'subject note slug (saga-closeout shape)',
    slug: 'retroactive-note-fixture',
    ownerId: 'T10999',
    type: 'note',
  },
  {
    label: 'subject long-form slug (e4-cli-verb-matrix shape)',
    slug: 'e4-cli-verb-matrix-fixture',
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

describe('T10375/T13985 — documents link for retroactively-normalized docs (E5.5)', () => {
  for (const testCase of RETROACTIVE_SLUG_CASES) {
    it(`links ${testCase.label} by a documents edge, with no observation`, async () => {
      const addResp = await docsHandler.mutate('add', {
        ownerId: testCase.ownerId,
        file: fixtureFile,
        slug: testCase.slug,
        type: testCase.type,
        attachedBy: 'test-T10375',
      });
      expect(addResp.success, `docs.add failed: ${JSON.stringify(addResp.error)}`).toBe(true);
      expect(
        (addResp.data as DocsAddResult).projection,
        JSON.stringify(addResp.data),
      ).toMatchObject({ status: 'completed', receipt: { documents: true } });

      // D11180 (T13985): no "Doc attached" observation, whatever the slug shape.
      expect(await findDocObservationBySlug(testCase.slug)).toBeUndefined();

      const { getBrainDb, getBrainNativeDb } = await import('@cleocode/core/internal');
      await getBrainDb();
      const edge = getBrainNativeDb()
        ?.prepare(
          "SELECT from_id FROM brain_page_edges WHERE to_id = ? AND edge_type = 'documents'",
        )
        .get(`task:${testCase.ownerId}`);
      expect(edge?.from_id).toMatch(/^llmtxt:[a-f0-9]{64}$/);
    });
  }

  it('refuses a task-anchored slug with E_DOC_NAME_RULE and a subject suggestion (T14129)', async () => {
    const addResp = await docsHandler.mutate('add', {
      ownerId: 'T10999',
      file: fixtureFile,
      slug: 't10999-retroactive-note-fixture',
      type: 'note',
      attachedBy: 'test-T14129',
    });
    expect(addResp.success).toBe(false);
    expect(addResp.error?.code).toBe('E_DOC_NAME_RULE');
    expect(addResp.error?.message).toContain('carries a task id');
    expect(addResp.error?.fix).toBe('cleo docs add ... --slug retroactive-note-fixture');
    expect(addResp.error?.details).toMatchObject({
      suggestion: 'retroactive-note-fixture',
      reasons: ['task-id'],
    });
  });
});
