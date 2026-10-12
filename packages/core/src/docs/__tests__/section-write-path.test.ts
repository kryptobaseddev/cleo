/**
 * Section CRDT write path — store-level orchestration (T13355).
 *
 * Drives {@link projectDocUpdateThroughSections} against a real temp-dir
 * store (the T13354 conduit-doc-history harness pattern) and asserts the
 * write-path wiring on top of the canonical accessors:
 *
 *   - first update adopts the doc into the conduit family, seeds every
 *     section's local Loro state, appends the root DAG version and advances
 *     the head projection;
 *   - a later update merges the touched section via the stored CRDT state
 *     (append-only growth), chains the version parent to the previous head
 *     and lists only the touched section in `sections_modified`;
 *   - a stale writer (explicit lower HLC) loses the head race honestly:
 *     the max-HLC head stands, the loser is recorded as a conflict, and its
 *     version row still survives in the append-only history;
 *   - section states rebase onto the landed version.
 *
 * Run: `npx vitest run packages/core/src/docs/__tests__/section-write-path.test.ts`
 *
 * @task T13355 (Epic T13340 / Saga T13339)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sectionStateText } from '../section-merge.js';
import { projectDocUpdateThroughSections } from '../section-write-path.js';

let tempDir: string;

const REPLICA = 'f4d5b7e5-4a36-4c39-9f8b-8e2d6a1f2c40';
/** HLC helper: fixed replica, given phys ms. */
function hlcAt(physMs: number, ctr = 0): string {
  return `${String(physMs).padStart(13, '0')}-${String(ctr).padStart(6, '0')}-${REPLICA}`;
}

const DOC_V1 = [
  '# Plan',
  '',
  'preamble.',
  '',
  '## Alpha',
  '',
  'alpha body',
  '',
  '## Beta',
  '',
  'beta body',
].join('\n');
const DOC_V2 = [
  '# Plan',
  '',
  'preamble.',
  '',
  '## Alpha',
  '',
  'alpha body',
  '',
  'an appended line from agent B.',
  '',
  '## Beta',
  '',
  'beta body',
].join('\n');

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-section-writepath-'));
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});

describe('projectDocUpdateThroughSections (T13355)', () => {
  it('first update adopts the doc, seeds section states, appends the root version and advances the head', async () => {
    const result = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-a',
      content: DOC_V1,
      hlc: hlcAt(1000),
    });

    expect(result.adopted).toBe(true);
    expect(result.docUid).not.toBe('');
    expect(result.mergedText).toBe(DOC_V1);
    expect(result.sectionsModified).toEqual(['s0', 's1', 's2']);
    expect(result.version.parentVersionUid).toBeNull();
    expect(result.version.versionNumber).toBe(1);
    expect(result.head.advanced).toBe(true);
    expect(result.head.conflictRecorded).toBe(false);
    expect(result.head.head.headHlc).toBe(hlcAt(1000));

    // Every section seeded with text-equal Loro state.
    const { readSectionCrdtState, resolveConduitDocUid } = await import(
      '../../store/conduit-doc-history.js'
    );
    const uid = await resolveConduitDocUid(tempDir, 'plan-doc');
    expect(uid).toBe(result.docUid);
    for (const id of ['s0', 's1', 's2']) {
      const row = await readSectionCrdtState(tempDir, result.docUid, id);
      expect(row).not.toBeNull();
      expect(row?.baseVersionUid).toBe(result.version.uid);
    }
    const alpha = await readSectionCrdtState(tempDir, result.docUid, 's1');
    expect(sectionStateText(alpha?.snapshot ?? Buffer.alloc(0))).toContain('alpha body');
  });

  it('re-adopting a known slug does not create a second conduit row', async () => {
    await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-a',
      content: DOC_V1,
      hlc: hlcAt(1000),
    });
    const second = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-b',
      content: DOC_V1,
      hlc: hlcAt(2000),
    });
    expect(second.adopted).toBe(false);
    expect(second.docUid).not.toBe('');
  });

  it('second update merges the touched section, chains the DAG parent and advances the head', async () => {
    const first = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-a',
      content: DOC_V1,
      hlc: hlcAt(1000),
    });
    const second = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-b',
      content: DOC_V2,
      hlc: hlcAt(2000),
    });

    expect(second.adopted).toBe(false);
    expect(second.sectionsModified).toEqual(['s1']);
    expect(second.mergedText).toBe(DOC_V2);
    // DAG: the version chains onto the previous head's version.
    expect(second.version.parentVersionUid).toBe(first.version.uid);
    expect(second.version.versionNumber).toBe(2);
    // Head advanced under the max-HLC rule.
    expect(second.head.advanced).toBe(true);
    expect(second.head.head.headVersionUid).toBe(second.version.uid);
    expect(second.head.head.conflictCount).toBe(0);

    // The stored section state carries the merged edit; the untouched
    // section is byte-identical.
    const { readSectionCrdtState } = await import('../../store/conduit-doc-history.js');
    const alpha = await readSectionCrdtState(tempDir, second.docUid, 's1');
    const alphaText = sectionStateText(alpha?.snapshot ?? Buffer.alloc(0));
    expect(alphaText).toContain('an appended line from agent B.');
    expect(alphaText.startsWith('## Alpha')).toBe(true);
    const beta = await readSectionCrdtState(tempDir, second.docUid, 's2');
    expect(sectionStateText(beta?.snapshot ?? Buffer.alloc(0))).toBe('## Beta\n\nbeta body');

    // History is append-only: both versions present, newest ordinal first.
    const { listConduitAttachmentVersions } = await import('../../store/conduit-doc-history.js');
    const versions = await listConduitAttachmentVersions(tempDir, second.docUid);
    expect(versions).toHaveLength(2);
    expect(versions[0]?.uid).toBe(second.version.uid);
    expect(versions[1]?.uid).toBe(first.version.uid);
  });

  it('stale writer loses the head race honestly: conflict recorded, loser version survives', async () => {
    const first = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-a',
      content: DOC_V1,
      hlc: hlcAt(2000),
    });
    // A stale concurrent writer with a LOWER HLC than the standing head.
    const stale = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-c',
      content: DOC_V2,
      hlc: hlcAt(1000),
    });

    expect(stale.head.advanced).toBe(false);
    expect(stale.head.conflictRecorded).toBe(true);
    expect(stale.head.head.headVersionUid).toBe(first.version.uid);
    expect(stale.head.head.headHlc).toBe(hlcAt(2000));
    expect(stale.head.head.conflictCount).toBe(1);
    const conflict = JSON.parse(stale.head.head.lastConflictJson ?? '{}') as {
      versionUid?: string;
      hlc?: string;
    };
    expect(conflict.versionUid).toBe(stale.version.uid);
    expect(conflict.hlc).toBe(hlcAt(1000));

    // The losing version is NOT shadowed: it survives in the append-only
    // history, and the derived contributors rollup counts both authors.
    const { listConduitAttachmentVersions } = await import('../../store/conduit-doc-history.js');
    const versions = await listConduitAttachmentVersions(tempDir, stale.docUid);
    expect(versions.map((v) => v.uid)).toContain(stale.version.uid);
    expect(versions.map((v) => v.uid)).toContain(first.version.uid);
  });

  it('minted HLCs (no explicit hlc) are monotone: successive local writes always advance the head', async () => {
    const first = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-a',
      content: DOC_V1,
    });
    const second = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-b',
      content: DOC_V2,
    });
    const third = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-b',
      content: DOC_V2,
    });
    expect(first.head.advanced).toBe(true);
    expect(second.head.advanced).toBe(true);
    // Byte-identical content still appends a version and advances the head:
    // the minted HLC strictly increases even within one process.
    expect(third.head.advanced).toBe(true);
    expect(third.head.head.headHlc > second.head.head.headHlc).toBe(true);
    expect(second.head.head.headHlc > first.head.head.headHlc).toBe(true);
    const { listConduitAttachmentVersions } = await import('../../store/conduit-doc-history.js');
    expect(await listConduitAttachmentVersions(tempDir, third.docUid)).toHaveLength(3);
  });

  it('T13585+T13589: same-base writers project exactly; the head race is resolved by max-HLC with the loser kept in history', async () => {
    const s0 = '# Plan\n\npreamble.';
    const s1Base = '## Alpha\n\nalpha body';
    const s2 = '## Beta\n\nbeta body';
    const baseDoc = [s0, s1Base, s2].join('\n');
    // Agent A and agent B both edit section s1 from the SAME base, unaware
    // of each other.
    const docA = [s0, `${s1Base}\n\nA1`, s2].join('\n');
    const docB = [s0, `${s1Base}\n\nB1`, s2].join('\n');

    const v1 = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-seed',
      content: baseDoc,
      hlc: hlcAt(1000),
    });
    const a = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-a',
      content: docA,
      hlc: hlcAt(2000),
    });
    // A landed first: B's stored state equals the head's text, so B is a
    // single-writer edit and must project EXACTLY (T13589) — no fabricated
    // concatenation. B's HLC is lower, so it loses the head race honestly.
    const b = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-b',
      content: docB,
      hlc: hlcAt(1500),
    });

    // B's input is projected byte-exactly into the version row.
    expect(b.mergedText).toBe(docB);
    const { createHash } = await import('node:crypto');
    expect(b.version.contentHash).toBe(createHash('sha256').update(docB, 'utf-8').digest('hex'));

    // Head race: A's higher HLC keeps the head; B's loss is recorded, and
    // B's version row survives in the append-only history.
    expect(b.head.advanced).toBe(false);
    expect(b.head.conflictRecorded).toBe(true);
    expect(b.head.head.headVersionUid).toBe(a.version.uid);
    const conflict = JSON.parse(b.head.head.lastConflictJson ?? '{}') as {
      versionUid?: string;
    };
    expect(conflict.versionUid).toBe(b.version.uid);

    const { listConduitAttachmentVersions } = await import('../../store/conduit-doc-history.js');
    const versions = await listConduitAttachmentVersions(tempDir, b.docUid);
    expect(versions.map((v) => v.uid)).toEqual(
      expect.arrayContaining([v1.version.uid, a.version.uid, b.version.uid]),
    );

    // A's content is the standing head: its version blob resolves to docA.
    const { readFileSync } = await import('node:fs');
    const { getCleoDirAbsolute } = await import('../../paths.js');
    const { join: joinPath } = await import('node:path');
    const headBlob = readFileSync(
      joinPath(getCleoDirAbsolute(tempDir), 'attachments', 'sha256', a.version.storageKey),
      'utf-8',
    );
    expect(headBlob).toBe(docA);
  });

  it('T13585: when stored state differs from the previous head, the merge path preserves BOTH writers', async () => {
    const s0 = '# Plan\n\npreamble.';
    const s1Base = '## Alpha\n\nalpha body';
    const s2 = '## Beta\n\nbeta body';
    const baseDoc = [s0, s1Base, s2].join('\n');
    const docB = [s0, `${s1Base}\n\nB1`, s2].join('\n');

    await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-seed',
      content: baseDoc,
      hlc: hlcAt(1000),
    });

    // Simulate an UNLANDED concurrent edit in the stored state (the shape
    // Stage C journal apply produces before the local head advances): A's
    // edit sits in section_crdt_states but not in the head's text.
    const { seedSectionState } = await import('../section-merge.js');
    const { readSectionCrdtState, writeSectionCrdtState, resolveConduitDocUid } = await import(
      '../../store/conduit-doc-history.js'
    );
    const docUid = await resolveConduitDocUid(tempDir, 'plan-doc');
    expect(docUid).not.toBeNull();
    const stored = await readSectionCrdtState(tempDir, docUid as string, 's1');
    await writeSectionCrdtState(tempDir, {
      attachmentUid: docUid as string,
      sectionId: 's1',
      snapshot: seedSectionState(`${s1Base}\n\nA1`),
      baseVersionUid: stored?.baseVersionUid ?? null,
    });

    const b = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-b',
      content: docB,
      hlc: hlcAt(2000),
    });

    // Stored (A1) != head text (base) → merge path: BOTH edits survive in
    // the projection, and the merged text — not the input — is what the
    // version row and head address.
    expect(b.mergedText).toContain('A1');
    expect(b.mergedText).toContain('B1');
    expect(b.mergedText).not.toBe(docB);
    const { createHash } = await import('node:crypto');
    expect(b.version.contentHash).toBe(
      createHash('sha256').update(b.mergedText, 'utf-8').digest('hex'),
    );
    expect(b.head.advanced).toBe(true);
    expect(b.head.head.headVersionUid).toBe(b.version.uid);

    // The head version's blob is the merged text.
    const { readFileSync } = await import('node:fs');
    const { getCleoDirAbsolute } = await import('../../paths.js');
    const { join: joinPath } = await import('node:path');
    const headBlob = readFileSync(
      joinPath(getCleoDirAbsolute(tempDir), 'attachments', 'sha256', b.version.storageKey),
      'utf-8',
    );
    expect(headBlob).toBe(b.mergedText);
  });

  it('T13589 regression: mid-text replace and tail deletion project byte-exactly through version and head rows', async () => {
    // The two probed cases from review, in ONE authored update.
    const v1 = ['# Doc', '## Edit\n\nabc XYZ def', '## Cut\n\nkeep this. remove this.'].join('\n');
    const v2 = ['# Doc', '## Edit\n\nabc 123 def', '## Cut\n\nkeep this.'].join('\n');

    await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-a',
      content: v1,
      hlc: hlcAt(1000),
    });
    const second = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-a',
      content: v2,
      hlc: hlcAt(2000),
    });

    // The projection is byte-identical to the authored input — no
    // 'abc XYZ def123 def' concatenation, and the deletion applied.
    expect(second.mergedText).toBe(v2);
    expect(second.mergedText).not.toContain('XYZ');
    expect(second.version.contentHash).toBe(
      (await import('node:crypto')).createHash('sha256').update(v2, 'utf-8').digest('hex'),
    );
    expect(second.head.advanced).toBe(true);
    expect(second.head.head.headVersionUid).toBe(second.version.uid);

    // The head version row's blob IS the authored input.
    const { readFileSync } = await import('node:fs');
    const { getCleoDirAbsolute } = await import('../../paths.js');
    const { join: joinPath } = await import('node:path');
    const blob = readFileSync(
      joinPath(getCleoDirAbsolute(tempDir), 'attachments', 'sha256', second.version.storageKey),
      'utf-8',
    );
    expect(blob).toBe(v2);

    // The section states hold the authored text exactly.
    const { readSectionCrdtState } = await import('../../store/conduit-doc-history.js');
    const edit = await readSectionCrdtState(tempDir, second.docUid, 's1');
    expect(sectionStateText(edit?.snapshot ?? Buffer.alloc(0))).toBe('## Edit\n\nabc 123 def');
    const cut = await readSectionCrdtState(tempDir, second.docUid, 's2');
    expect(sectionStateText(cut?.snapshot ?? Buffer.alloc(0))).toBe('## Cut\n\nkeep this.');
  });

  it('T13583: a failure after the version append rolls the whole projection back — no forkable half-landed state', async () => {
    const first = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-a',
      content: DOC_V1,
      hlc: hlcAt(1000),
    });

    // An empty explicit HLC passes the input layer but fails the head
    // upsert's non-empty guard AFTER the version append and the section
    // writes ran — the transaction must roll all of it back.
    await expect(
      projectDocUpdateThroughSections(tempDir, {
        slug: 'plan-doc',
        authorAgentId: 'agent-b',
        content: DOC_V2,
        hlc: '',
      }),
    ).rejects.toThrow(/headHlc/);

    const { getConduitDocHead, listConduitAttachmentVersions, readSectionCrdtState } = await import(
      '../../store/conduit-doc-history.js'
    );
    // No version row from the failed projection: the next update cannot
    // fork onto a half-landed non-head version.
    expect(await listConduitAttachmentVersions(tempDir, first.docUid)).toHaveLength(1);
    // The head is untouched by the failed projection.
    const head = await getConduitDocHead(tempDir, first.docUid);
    expect(head?.headVersionUid).toBe(first.version.uid);
    expect(head?.conflictCount).toBe(0);
    // The failed call's section-state write rolled back too.
    const s1 = await readSectionCrdtState(tempDir, first.docUid, 's1');
    expect(sectionStateText(s1?.snapshot ?? Buffer.alloc(0))).not.toContain(
      'an appended line from agent B.',
    );
  });

  it('a higher-HLC concurrent head advances the projection', async () => {
    const first = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-a',
      content: DOC_V1,
      hlc: hlcAt(1000),
    });
    const winner = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-b',
      content: DOC_V2,
      hlc: hlcAt(3000),
    });
    expect(winner.head.advanced).toBe(true);
    expect(winner.head.head.headVersionUid).toBe(winner.version.uid);
    expect(winner.version.parentVersionUid).toBe(first.version.uid);
  });
});
