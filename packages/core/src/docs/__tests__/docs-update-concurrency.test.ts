/**
 * Concurrent docs updates through the production write path (T13585).
 *
 * The Council's release condition for the CleoDocs CRDT write path — "split
 * into sections, merge two concurrent edits, nothing lost, merge order
 * doesn't matter" — as a permanent end-to-end regression test THROUGH
 * `updateDocBySlug` (the production path behind `cleo docs update`), not only
 * through the pure merge engine (`section-merge.test.ts` covers that layer).
 *
 * Scenario matrix: 2 writers × 2 landing orderings.
 *
 *   - Both writers start from ONE shared base section replica (the llmtxt
 *     multi-writer model: every writer imported the same base snapshot) and
 *     author a concurrent APPEND edit against it, each holding their own
 *     Loro state (`makeSectionEditUpdate`), exactly as llmtxt section CRDTs
 *     would give them. Neither writer's full-text input contains the other
 *     writer's edit.
 *   - Each writer's edit reaches the shared store the way the Stage C
 *     journal merge engine lands a peer update — its incremental update
 *     composes onto the stored section state via `mergeSectionUpdates`
 *     (the production composition) and `writeSectionCrdtState` (the
 *     canonical accessor) — and then the writer pushes their full-text
 *     update through `updateDocBySlug`.
 *   - Ordering A-then-B and B-then-A run as two independent fresh stores,
 *     each with BOTH writers going through `updateDocBySlug`.
 *
 * What is proven:
 *
 *   - AC1: the final stored text (the conduit head projection) contains BOTH
 *     writers' section content in either ordering, the two orderings are
 *     BYTE-IDENTICAL, and no section is duplicated or lost. Each writer's
 *     authored edit also survives verbatim in its own append-only version
 *     row (the T13604 conflict landing — a non-append edit relative to the
 *     head is recorded, never fabricated away).
 *   - AC2: the stored merged text equals the CRDT projection computed from
 *     the section states via the section-merge primitives — NOT the second
 *     writer's input text — and the head version row addresses exactly those
 *     bytes. This guards the T13595 bug class (mergedText echoing or
 *     concatenating the input) from regressing.
 *
 * Determinism note: Loro mints a random peer id per doc, so the canonical
 * order of two same-anchor concurrent inserts is a per-process coin flip.
 * The matrix therefore shares ONE base replica and ONE pair of incremental
 * updates across both stores (both writers imported the same base snapshot —
 * the causal-identity requirement of `crdt_apply_update` makes this the only
 * legitimate construction anyway); the cross-ordering byte-identity is then
 * Loro convergence on identical op bytes, and the test additionally pins the
 * in-run pure-merge order-independence as the oracle.
 *
 * Run: `npx vitest run packages/core/src/docs/__tests__/docs-update-concurrency.test.ts`
 *
 * @task T13585 (Epic T13340 / Saga T13339)
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
  writeSectionCrdtState,
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
  /** The second writer's result envelope from `updateDocBySlug`. */
  readonly secondEnvelope: UpdateDocBySlugResult;
  /** The second writer's authored edit, read back from its own version row. */
  readonly incomingVersionText: string;
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
 * Run one writer's phase: land its incremental update in the shared section
 * state (the Stage C journal-merge shape), then push its full-text update
 * through the production `updateDocBySlug` path.
 */
async function runWriterPhase(
  root: string,
  docUid: string,
  fixture: ReturnType<typeof buildSharedFixture>,
  writer: WriterId,
): Promise<UpdateDocBySlugResult> {
  const replica = writer === 'A' ? fixture.writerA : fixture.writerB;
  const stored = await readSectionCrdtState(root, docUid, SECTION_S1);
  await writeSectionCrdtState(root, {
    attachmentUid: docUid,
    sectionId: SECTION_S1,
    snapshot: mergeSectionUpdates(stored?.snapshot ?? fixture.base, [replica.update]),
    baseVersionUid: stored?.baseVersionUid ?? null,
  });
  return updateDocBySlug(root, {
    slug: SLUG,
    content: replica.doc,
    attachedBy: `agent-${writer.toLowerCase()}`,
  });
}

/**
 * Run the two-writer scenario on a fresh store in the given landing order.
 * Both writers go through `updateDocBySlug`; the store's section state is
 * first normalized to the shared base replica (both writers imported the
 * same base snapshot — the common causal base their updates were authored
 * against).
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

    // Normalize the stored s1 state to the shared base replica — the state
    // both writers' incremental updates were authored against.
    const current = await readSectionCrdtState(root, docUid as string, SECTION_S1);
    await writeSectionCrdtState(root, {
      attachmentUid: docUid as string,
      sectionId: SECTION_S1,
      snapshot: fixture.base,
      baseVersionUid: current?.baseVersionUid ?? null,
    });

    const firstResult = await runWriterPhase(root, docUid as string, fixture, first);
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) throw new Error('first writer update failed');
    // The first writer's edit is not concurrent with anything: no conflicts.
    expect(firstResult.result.sectionConflicts).toBeUndefined();

    const secondResult = await runWriterPhase(root, docUid as string, fixture, second);
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

    // The second writer's authored edit survives verbatim in its own
    // append-only version row (the T13604 conflict landing).
    const secondDoc = second === 'A' ? fixture.writerA.doc : fixture.writerB.doc;
    const incomingUid = secondResult.result.sectionConflicts?.[0]?.incomingVersionUid;
    expect(incomingUid).toBeTruthy();
    const incomingVersion = await getConduitAttachmentVersion(root, incomingUid ?? '');
    expect(incomingVersion).not.toBeNull();
    const incomingVersionText = readFileSync(
      join(getCleoDirAbsolute(root), 'attachments', 'sha256', incomingVersion?.storageKey ?? ''),
      'utf-8',
    );
    expect(incomingVersionText).toBe(secondDoc);

    const versions = await listConduitAttachmentVersions(root, docUid as string);
    return {
      finalHeadText,
      storedSectionText,
      headContentHash: headVersion?.contentHash ?? '',
      secondEnvelope: secondResult,
      incomingVersionText,
      versionCount: versions.length,
    };
  } finally {
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(root, { recursive: true, force: true });
  }
}

describe('concurrent docs updates through docs-update (T13585)', () => {
  it('AC1: two writers both survive in either landing order — byte-identical results, nothing lost or duplicated', async () => {
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

      // The honest-concurrency envelope: the second writer's non-append
      // edit (relative to the landed head) is recorded as a section
      // conflict, not silently dropped…
      const envelope = outcome.secondEnvelope;
      if (!envelope.ok) throw new Error('unreachable: asserted above');
      expect(envelope.result.sectionConflicts, label).toHaveLength(1);
      expect(envelope.result.sectionConflicts?.[0]?.sectionId, label).toBe(SECTION_S1);
      // …and the authored edit itself survives verbatim in its own version
      // row (nothing lost).
      expect(outcome.incomingVersionText, label).toBe(
        label === 'A-then-B' ? fixture.writerB.doc : fixture.writerA.doc,
      );

      // History is append-only and complete: seed version + first writer's
      // version + second writer's projection and incoming versions.
      expect(outcome.versionCount, label).toBe(4);
    }

    // The headline: merge order does not matter — the two orderings produce
    // byte-identical stored text.
    expect(bThenA.finalHeadText).toBe(aThenB.finalHeadText);
  });

  it('AC2: the stored merged text derives from the CRDT state, not the input text', async () => {
    const fixture = buildSharedFixture();

    // The pure-merge oracle: the CRDT projection of BOTH writers' updates,
    // composed in either order (Loro convergence on identical op bytes).
    const projectionAB = sectionStateText(
      mergeSectionUpdates(fixture.base, [fixture.writerA.update, fixture.writerB.update]),
    );
    const projectionBA = sectionStateText(
      mergeSectionUpdates(fixture.base, [fixture.writerB.update, fixture.writerA.update]),
    );
    expect(projectionBA).toBe(projectionAB);
    const expectedDoc = joinSections([S0_TEXT, projectionAB, S2_TEXT]);

    const aThenB = await runScenario(fixture, 'A', 'B');
    const bThenA = await runScenario(fixture, 'B', 'A');

    for (const [label, outcome] of [
      ['A-then-B', aThenB],
      ['B-then-A', bThenA],
    ] as const) {
      // The final stored text IS the CRDT projection, byte for byte…
      expect(outcome.finalHeadText, label).toBe(expectedDoc);
      // …and so is the merged text rebuilt from the stored section states…
      expect(outcome.storedSectionText, label).toBe(expectedDoc);
      // …while NEITHER writer's input text equals it — guarding the T13595
      // bug class (mergedText echoing/concatenating the input instead of
      // projecting from the CRDT state).
      expect(outcome.finalHeadText, label).not.toBe(fixture.writerA.doc);
      expect(outcome.finalHeadText, label).not.toBe(fixture.writerB.doc);
      // The head version row addresses exactly the projected bytes.
      expect(outcome.headContentHash, label).toBe(
        createHash('sha256').update(expectedDoc, 'utf-8').digest('hex'),
      );
    }
  });
});
