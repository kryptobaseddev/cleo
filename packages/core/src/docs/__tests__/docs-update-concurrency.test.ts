/**
 * Concurrent docs updates through the production write path (T13585,
 * re-scoped by the T13674 review: no test-side CRDT writes).
 *
 * The Council's release condition for the CleoDocs CRDT write path — "split
 * into sections, merge two concurrent edits, nothing lost" — as a permanent
 * end-to-end regression test THROUGH `updateDocBySlug` (the production path
 * behind `cleo docs update`), not only through the pure merge engine
 * (`section-merge.test.ts` covers that layer).
 *
 * Scenario matrix: 2 writers × 2 landing orderings.
 *
 *   - Both writers fetched ONE shared base (the seed head) and each authored
 *     a concurrent APPEND edit against it, holding only the fetched full
 *     text — exactly what two agents running `cleo docs update` have. The
 *     pre-review version of this test injected each writer's incremental
 *     Loro update into the store before calling `updateDocBySlug`; that
 *     injection masked T13674 (without it, the second writer's stale edit
 *     silently replaced the first writer's tail in the head). The injection
 *     is gone: the ONLY thing each writer passes is the full text and the
 *     base version uid (`metadata.headVersionUid` from their fetch).
 *   - Ordering A-then-B and B-then-A run as two independent fresh stores,
 *     each with BOTH writers going through `updateDocBySlug`.
 *
 * What is proven:
 *
 *   - AC1 (T13585): the final stored text (the conduit head projection)
 *     contains BOTH writers' section content in either ordering — exactly
 *     once each, no section lost or duplicated. The second writer declared
 *     the seed head as its base; that base is superseded by the first
 *     writer's landing, and the head is the MERGE (both tails), reported
 *     with `staleBaseMerged` and a `W_DOC_STALE_BASE` remedy — never the
 *     second writer's input alone (the T13674 bug).
 *   - AC2 (T13585): each ordering's head equals the CRDT projection rebuilt
 *     from the stored section states for THAT ordering (sequential tail
 *     composition: base, then the first writer's tail, then the second's) —
 *     not either writer's input text. Cross-ordering byte-identity is NOT
 *     claimed: two sequential full-text appends compose in arrival order
 *     (append-only primitives anchor each tail at the then-current end).
 *     Byte-identical convergence across orderings needs the journal merge
 *     engine landing peer CRDT updates — the sync path, not two local CLI
 *     writers. Nothing is lost in either order, which is the Council
 *     condition.
 *   - T13674 AC1/AC2: a stale declared base merges append edits (this file),
 *     records a section conflict on a non-append concurrent edit, and an
 *     unresolvable base is refused with `E_DOC_BASE_UNKNOWN` before any
 *     write.
 *
 * Determinism note: the fixture shares ONE base replica and ONE pair of
 * incremental updates across both stores so each writer's full-text input is
 * the byte-exact projection of its own edit against the shared base.
 *
 * Run: `npx vitest run packages/core/src/docs/__tests__/docs-update-concurrency.test.ts`
 *
 * @task T13585 (Epic T13340 / Saga T13339)
 * @task T13674 (stale-base detection; re-scoped to the real path)
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getConduitAttachmentVersion,
  getConduitDocHead,
  listConduitAttachmentVersions,
  readSectionCrdtState,
  resolveConduitDocUid,
} from '../../store/conduit-doc-history.js';
import { closeDb, getDb } from '../../store/sqlite.js';
import { attachments } from '../../store/tasks-schema.js';
import { type UpdateDocBySlugResult, updateDocBySlug } from '../docs-update.js';
import {
  joinSections,
  makeSectionEditUpdate,
  mergeSectionUpdates,
  sectionStateText,
  seedSectionState,
  splitDocIntoSections,
} from '../section-merge.js';

const SLUG = 'plan-doc';
const SECTION_S1 = 's1';

const S0_TEXT = '# Plan\n\npreamble.';
const S1_BASE = '## Alpha\n\nalpha body';
const S2_TEXT = '## Beta\n\nbeta body';
const BASE_DOC = joinSections([S0_TEXT, S1_BASE, S2_TEXT]);

const TAIL_A = '\n\nAppended by writer A.';
const TAIL_B = '\n\nAppended by writer B.';
const MARKER_A = 'Appended by writer A.';
const MARKER_B = 'Appended by writer B.';

type WriterId = 'A' | 'B';

/** One writer's own Loro section state: the shared base replica plus its edit. */
interface WriterReplica {
  /** The writer's incremental update, authored against the shared base. */
  readonly update: Buffer;
  /** The writer's full-text input (its own projection of its state). */
  readonly doc: string;
}

/**
 * The shared concurrency fixture: ONE base replica and ONE pair of
 * incremental updates, shared by both stores of the matrix (see the
 * determinism note in the file header).
 */
function buildSharedFixture(): { base: Buffer; writerA: WriterReplica; writerB: WriterReplica } {
  const base = seedSectionState(S1_BASE);
  const updateA = makeSectionEditUpdate(base, TAIL_A);
  const updateB = makeSectionEditUpdate(base, TAIL_B);
  const docA = joinSections([
    S0_TEXT,
    sectionStateText(mergeSectionUpdates(base, [updateA])),
    S2_TEXT,
  ]);
  const docB = joinSections([
    S0_TEXT,
    sectionStateText(mergeSectionUpdates(base, [updateB])),
    S2_TEXT,
  ]);
  return { base, writerA: { update: updateA, doc: docA }, writerB: { update: updateB, doc: docB } };
}

/** Observable outcome of one ordering of the two-writer scenario. */
interface ScenarioOutcome {
  /** The final stored text: the conduit head projection's blob bytes. */
  readonly finalHeadText: string;
  /** The merged text rebuilt from the stored section CRDT states. */
  readonly storedSectionText: string;
  /** The head version row's content hash (must equal sha256(finalHeadText)). */
  readonly headContentHash: string;
  /** The first writer's result envelope from `updateDocBySlug`. */
  readonly firstEnvelope: UpdateDocBySlugResult;
  /** The second writer's result envelope from `updateDocBySlug`. */
  readonly secondEnvelope: UpdateDocBySlugResult;
  /** Total version rows in the append-only history. */
  readonly versionCount: number;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-concurrency-outer-'));
});

afterEach(async () => {
  closeDb();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Run one writer's phase the way a real agent does: push its full-text
 * update through the production `updateDocBySlug` path, declaring the
 * version uid it fetched as its base. NO test-side CRDT writes — the store
 * sees exactly what two `cleo docs update` callers would send.
 */
async function runWriterPhase(
  root: string,
  baseVersionUid: string,
  fixture: ReturnType<typeof buildSharedFixture>,
  writer: WriterId,
): Promise<UpdateDocBySlugResult> {
  const replica = writer === 'A' ? fixture.writerA : fixture.writerB;
  return updateDocBySlug(root, {
    slug: SLUG,
    content: replica.doc,
    attachedBy: `agent-${writer.toLowerCase()}`,
    baseVersionUid,
  });
}

/**
 * Run the two-writer scenario on a fresh store in the given landing order.
 * Both writers go through `updateDocBySlug` with the seed head declared as
 * their base — the second writer's base is therefore stale, which is the
 * T13674 case.
 */
async function runScenario(
  fixture: ReturnType<typeof buildSharedFixture>,
  first: WriterId,
  second: WriterId,
): Promise<ScenarioOutcome> {
  const root = await mkdtemp(join(tmpdir(), `cleo-docs-concurrency-${first}-${second}-`));
  process.env['CLEO_DIR'] = join(root, '.cleo');
  closeDb();
  try {
    // Seed the slug through the production path so updateDocBySlug finds it;
    // the projection adopts the doc into the conduit family. The legacy
    // row's bytes differ from BASE_DOC so the update is a real write (an
    // identical-content update would take the noop fast-path and never
    // project).
    const db = await getDb(root);
    const v0 = '# Plan\n\nv0 body';
    const sha0 = createHash('sha256').update(v0, 'utf-8').digest('hex');
    await db
      .insert(attachments)
      .values({
        id: 'legacy-plan',
        sha256: sha0,
        attachmentJson: JSON.stringify({ kind: 'blob', sha256: sha0 }),
        createdAt: new Date().toISOString(),
        refCount: 0,
        slug: SLUG,
        lifecycleStatus: 'draft',
        docVersion: 1,
      })
      .run();
    const seed = await updateDocBySlug(root, { slug: SLUG, content: BASE_DOC });
    expect(seed.ok).toBe(true);

    const docUid = await resolveConduitDocUid(root, SLUG);
    expect(docUid).not.toBeNull();

    // The version both writers fetched — each declares it as its base.
    const seedHead = await getConduitDocHead(root, docUid as string);
    expect(seedHead).not.toBeNull();
    const baseVersionUid = seedHead?.headVersionUid ?? '';

    const firstResult = await runWriterPhase(root, baseVersionUid, fixture, first);
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) throw new Error('first writer update failed');
    // The first writer's base was the current head: a clean single-writer
    // landing — no merge, no conflict.
    expect(firstResult.result.sectionConflicts).toBeUndefined();
    expect(firstResult.result.staleBaseMerged).toBeUndefined();

    const secondResult = await runWriterPhase(root, baseVersionUid, fixture, second);
    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) throw new Error('second writer update failed');

    // The final stored text: the conduit head projection's blob bytes.
    const head = await getConduitDocHead(root, docUid as string);
    expect(head).not.toBeNull();
    const headVersion = await getConduitAttachmentVersion(root, head?.headVersionUid ?? '');
    expect(headVersion).not.toBeNull();
    const { getCleoDirAbsolute } = await import('../../paths.js');
    const finalHeadText = readFileSync(
      join(getCleoDirAbsolute(root), 'attachments', 'sha256', headVersion?.storageKey ?? ''),
      'utf-8',
    );

    // The merged text rebuilt from the stored section CRDT states (AC2
    // observability: the stored state, not any input, is the source).
    const stored = await readSectionCrdtState(root, docUid as string, SECTION_S1);
    const storedSectionText = joinSections([
      S0_TEXT,
      sectionStateText(stored?.snapshot ?? Buffer.alloc(0)),
      S2_TEXT,
    ]);

    const versions = await listConduitAttachmentVersions(root, docUid as string);
    return {
      finalHeadText,
      storedSectionText,
      headContentHash: headVersion?.contentHash ?? '',
      firstEnvelope: firstResult,
      secondEnvelope: secondResult,
      versionCount: versions.length,
    };
  } finally {
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(root, { recursive: true, force: true });
  }
}

describe('concurrent docs updates through docs-update (T13585, real path)', () => {
  it('AC1: a stale base merges — both writers survive in either landing order, the merge is reported, nothing is lost', async () => {
    const fixture = buildSharedFixture();
    const aThenB = await runScenario(fixture, 'A', 'B');
    const bThenA = await runScenario(fixture, 'B', 'A');

    for (const [label, outcome] of [
      ['A-then-B', aThenB],
      ['B-then-A', bThenA],
    ] as const) {
      // Both writers' content is in the final stored text…
      expect(outcome.finalHeadText, label).toContain(MARKER_A);
      expect(outcome.finalHeadText, label).toContain(MARKER_B);
      // …exactly once each (no duplicated sections)…
      expect(outcome.finalHeadText.split(MARKER_A), label).toHaveLength(2);
      expect(outcome.finalHeadText.split(MARKER_B), label).toHaveLength(2);
      // …and no section was lost: the untouched sections are byte-identical
      // and the edited section still carries the full base heading and body.
      const sections = splitDocIntoSections(outcome.finalHeadText);
      expect(sections, label).toHaveLength(3);
      expect(sections[0], label).toBe(S0_TEXT);
      expect(sections[2], label).toBe(S2_TEXT);
      expect(sections[1]?.startsWith(S1_BASE), label).toBe(true);

      // The stale-base envelope (T13674): the second writer declared the
      // seed head, which the first writer superseded — the update merged the
      // concurrent edit instead of replacing it, and says so explicitly.
      const envelope = outcome.secondEnvelope;
      if (!envelope.ok) throw new Error('unreachable: asserted above');
      expect(envelope.result.staleBaseMerged, label).toBe(true);
      // An append merge is NOT a conflict — nothing was refused, nothing was
      // parked in a side version row.
      expect(envelope.result.sectionConflicts, label).toBeUndefined();

      // History is append-only and complete: seed version + one version per
      // writer (the T13604 conflict side row exists only for non-append
      // concurrent edits — covered by the conflict test below).
      expect(outcome.versionCount, label).toBe(3);
    }

    // Each ordering composes the tails in arrival order: both appends
    // survive in both orders, anchored after the shared base.
    expect(aThenB.finalHeadText).toContain(`${S1_BASE}${TAIL_A}${TAIL_B}`);
    expect(bThenA.finalHeadText).toContain(`${S1_BASE}${TAIL_B}${TAIL_A}`);
  });

  it('AC2: the stored head derives from the CRDT state, not the input text', async () => {
    const fixture = buildSharedFixture();

    // The per-ordering oracle: the CRDT projection of the stored section
    // state after the two sequential writes — base, first tail, second tail
    // (see the header note on why per-ordering, not cross-ordering).
    const aThenB = await runScenario(fixture, 'A', 'B');
    const bThenA = await runScenario(fixture, 'B', 'A');

    for (const [label, outcome] of [
      ['A-then-B', aThenB],
      ['B-then-A', bThenA],
    ] as const) {
      // The final stored text IS the CRDT state projection, byte for byte…
      expect(outcome.storedSectionText, label).toBe(outcome.finalHeadText);
      // …while NEITHER writer's input text equals it — guarding the T13595
      // bug class (the head echoing or concatenating an input instead of
      // projecting from the CRDT state).
      expect(outcome.finalHeadText, label).not.toBe(fixture.writerA.doc);
      expect(outcome.finalHeadText, label).not.toBe(fixture.writerB.doc);
      // The head version row addresses exactly the projected bytes.
      expect(outcome.headContentHash, label).toBe(
        createHash('sha256').update(outcome.finalHeadText, 'utf-8').digest('hex'),
      );
    }
  });

  it('T13674: a stale base with a NON-append concurrent edit records a named section conflict — the edit is never silently dropped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cleo-docs-concurrency-conflict-'));
    process.env['CLEO_DIR'] = join(root, '.cleo');
    closeDb();
    try {
      const db = await getDb(root);
      const v0 = '# Plan\n\nv0 body';
      const sha0 = createHash('sha256').update(v0, 'utf-8').digest('hex');
      await db
        .insert(attachments)
        .values({
          id: 'legacy-plan',
          sha256: sha0,
          attachmentJson: JSON.stringify({ kind: 'blob', sha256: sha0 }),
          createdAt: new Date().toISOString(),
          refCount: 0,
          slug: SLUG,
          lifecycleStatus: 'draft',
          docVersion: 1,
        })
        .run();
      const seed = await updateDocBySlug(root, { slug: SLUG, content: BASE_DOC });
      expect(seed.ok).toBe(true);
      const docUid = (await resolveConduitDocUid(root, SLUG)) as string;
      const seedHead = await getConduitDocHead(root, docUid);
      const baseVersionUid = seedHead?.headVersionUid ?? '';

      // Writer A lands an append against the base (a clean edit).
      const docA = joinSections([S0_TEXT, `${S1_BASE}${TAIL_A}`, S2_TEXT]);
      const aResult = await updateDocBySlug(root, {
        slug: SLUG,
        content: docA,
        attachedBy: 'agent-a',
        baseVersionUid,
      });
      expect(aResult.ok).toBe(true);

      // Writer B fetched the SAME base but REPLACES the section body
      // (non-append relative to the base). With the stale base declared,
      // this cannot be expressed with append-only primitives — it must be
      // recorded as a conflict, not applied over A's edit.
      const docB = joinSections([S0_TEXT, '## Alpha\n\nrewritten by B.', S2_TEXT]);
      const bResult = await updateDocBySlug(root, {
        slug: SLUG,
        content: docB,
        attachedBy: 'agent-b',
        baseVersionUid,
      });
      expect(bResult.ok, JSON.stringify(bResult)).toBe(true);
      if (!bResult.ok) return;
      expect(bResult.result.sectionConflicts).toHaveLength(1);
      expect(bResult.result.sectionConflicts?.[0]?.sectionId).toBe(SECTION_S1);
      expect(bResult.result.staleBaseMerged).toBe(true);

      // A's edit is still the head projection; B's edit survives in its own
      // append-only version row — both preserved, nothing fabricated.
      const head = await getConduitDocHead(root, docUid);
      const headVersion = await getConduitAttachmentVersion(root, head?.headVersionUid ?? '');
      const { getCleoDirAbsolute } = await import('../../paths.js');
      const finalHeadText = readFileSync(
        join(getCleoDirAbsolute(root), 'attachments', 'sha256', headVersion?.storageKey ?? ''),
        'utf-8',
      );
      expect(finalHeadText).toContain(MARKER_A);
      expect(finalHeadText).not.toContain('rewritten by B.');

      const incomingUid = bResult.result.sectionConflicts?.[0]?.incomingVersionUid;
      const incomingVersion = await getConduitAttachmentVersion(root, incomingUid ?? '');
      expect(incomingVersion).not.toBeNull();
      const incomingText = readFileSync(
        join(getCleoDirAbsolute(root), 'attachments', 'sha256', incomingVersion?.storageKey ?? ''),
        'utf-8',
      );
      expect(incomingText).toBe(docB);
    } finally {
      closeDb();
      delete process.env['CLEO_DIR'];
      await rm(root, { recursive: true, force: true });
    }
  });

  it('T13674: an unresolvable declared base is refused before any write (E_DOC_BASE_UNKNOWN)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cleo-docs-concurrency-badbase-'));
    process.env['CLEO_DIR'] = join(root, '.cleo');
    closeDb();
    try {
      const db = await getDb(root);
      const v0 = '# Plan\n\nv0 body';
      const sha0 = createHash('sha256').update(v0, 'utf-8').digest('hex');
      await db
        .insert(attachments)
        .values({
          id: 'legacy-plan',
          sha256: sha0,
          attachmentJson: JSON.stringify({ kind: 'blob', sha256: sha0 }),
          createdAt: new Date().toISOString(),
          refCount: 0,
          slug: SLUG,
          lifecycleStatus: 'draft',
          docVersion: 1,
        })
        .run();
      const seed = await updateDocBySlug(root, { slug: SLUG, content: BASE_DOC });
      expect(seed.ok).toBe(true);

      const refused = await updateDocBySlug(root, {
        slug: SLUG,
        content: `${BASE_DOC}\n\nmore.`,
        baseVersionUid: 'ver_does_not_exist',
      });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error.code).toBe('E_DOC_BASE_UNKNOWN');
      expect(refused.error.message).toContain('ver_does_not_exist');

      // Nothing was written: the doc row still carries the seed bytes.
      const docUid = (await resolveConduitDocUid(root, SLUG)) as string;
      const versions = await listConduitAttachmentVersions(root, docUid);
      expect(versions).toHaveLength(1);
    } finally {
      closeDb();
      delete process.env['CLEO_DIR'];
      await rm(root, { recursive: true, force: true });
    }
  });
});
