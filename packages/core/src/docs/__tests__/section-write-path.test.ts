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
 *   - section states rebase onto the landed version;
 *   - T13604: recorded conflicts reach the caller — the docs.update
 *     envelope carries `sectionConflicts` with a `W_DOC_SECTION_CONFLICT`
 *     warning, and the docs.fetch envelope surfaces `headConflict`.
 *
 * Run: `npx vitest run packages/core/src/docs/__tests__/section-write-path.test.ts`
 *
 * @task T13355 (Epic T13340 / Saga T13339)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedDoc } from '../docs-read-model.js';
import { updateDocBySlug } from '../docs-update.js';
import { buildDocsFetchResult } from '../fetch-result.js';
import { listSectionLeases, SectionLeaseManager } from '../section-leases.js';
import { sectionIds, sectionStateText, splitDocIntoSections } from '../section-merge.js';
import { projectDocUpdateThroughSections, releaseSectionLeases } from '../section-write-path.js';

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

describe('lease coordination through the write path (T13356)', () => {
  const S1_BASE = '## Alpha\n\nalpha body';

  /** A lease manager on the temp store for the given session. */
  const leases = (sessionId: string, now?: () => number): SectionLeaseManager =>
    new SectionLeaseManager(tempDir, { sessionId, ...(now !== undefined ? { now } : {}) });

  it('acquires advisory leases for the sections an edit touches (AC2)', async () => {
    const result = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-edit',
      sessionId: 'ses-edit',
      content: DOC_V1,
      hlc: hlcAt(1000),
    });
    expect(result.leaseNotices).toEqual([]);

    const held = await listSectionLeases(tempDir, 'plan-doc');
    expect(held.map((l) => l.sectionId).sort()).toEqual(['h-alpha', 'h-beta', 's0']);
    for (const lease of held) {
      expect(lease.sessionId).toBe('ses-edit');
      expect(lease.holder).toBe('agent-edit');
    }
  });

  it('AC3: a section leased by another live session yields an advisory notice — and the edit still lands', async () => {
    // Another session holds s1.
    const other = leases('ses-other');
    const foreign = await other.acquire('plan-doc', 'h-alpha', 60, 'editing elsewhere');
    expect(foreign.ok).toBe(true);

    const incoming = DOC_V1.replace(S1_BASE, '## Alpha\n\nREPLACED body');
    const result = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-edit',
      sessionId: 'ses-edit',
      content: incoming,
      hlc: hlcAt(2000),
    });

    // Advisory, not a hard failure: the notice names the holder…
    expect(result.leaseNotices).toHaveLength(1);
    expect(result.leaseNotices[0]?.sectionId).toBe('h-alpha');
    expect(result.leaseNotices[0]?.sessionId).toBe('ses-other');
    expect(result.leaseNotices[0]?.expiresAt).toBeTruthy();
    // …and the edit PROCEEDED: exact projection, head advanced.
    expect(result.mergedText).toBe(incoming);
    expect(result.head.advanced).toBe(true);
    // The foreign lease stands untouched.
    expect((await leases('ses-edit').status('plan-doc', 'h-alpha'))?.sessionId).toBe('ses-other');
  });

  it('renews on continued edits within a session without a notice (AC2)', async () => {
    const first = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-edit',
      sessionId: 'ses-edit',
      content: DOC_V1,
      hlc: hlcAt(1000),
    });
    expect(first.leaseNotices).toEqual([]);
    const before = await leases('ses-edit').status('plan-doc', 'h-alpha');
    expect(before?.sessionId).toBe('ses-edit');

    const second = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-edit',
      sessionId: 'ses-edit',
      content: DOC_V2,
      hlc: hlcAt(2000),
    });
    // Our own held lease renews instead of conflicting — no notice.
    expect(second.leaseNotices).toEqual([]);
    const after = await leases('ses-edit').status('plan-doc', 'h-alpha');
    expect(after?.leaseId).toBe(before?.leaseId);
    expect(after?.sessionId).toBe('ses-edit');
  });

  it("release path: releaseSectionLeases frees the session's sections on completion (AC2)", async () => {
    await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-edit',
      sessionId: 'ses-edit',
      content: DOC_V1,
      hlc: hlcAt(1000),
    });
    expect(await listSectionLeases(tempDir, 'plan-doc')).toHaveLength(3);

    const released = await releaseSectionLeases(tempDir, 'plan-doc', 'ses-edit');
    expect(released.sort()).toEqual(['h-alpha', 'h-beta', 's0']);
    expect(await listSectionLeases(tempDir, 'plan-doc')).toEqual([]);

    // The next editor acquires without a notice.
    const next = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-next',
      sessionId: 'ses-next',
      content: DOC_V2,
      hlc: hlcAt(2000),
    });
    expect(next.leaseNotices).toEqual([]);
  });

  it('AC4: an expired foreign lease (dead session, TTL passed) is stale — takeover without a notice', async () => {
    // A foreign session whose clock ran 10 s ago acquires with a 1 s TTL:
    // its lease expired before it was even written, relative to real time.
    const dead = leases('ses-dead', () => Date.now() - 10_000);
    const stale = await dead.acquire('plan-doc', 'h-alpha', 1, 'died mid-edit');
    expect(stale.ok).toBe(true);

    const incoming = DOC_V1.replace(S1_BASE, '## Alpha\n\nREPLACED body');
    const result = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-edit',
      sessionId: 'ses-edit',
      content: incoming,
      hlc: hlcAt(2000),
    });
    expect(result.leaseNotices).toEqual([]);
    const taken = await leases('ses-edit').status('plan-doc', 'h-alpha');
    expect(taken?.sessionId).toBe('ses-edit');
    expect(taken?.holder).toBe('agent-edit');
  });

  it('uncoordinated when no session is resolvable: edit lands, no leases, no notices', async () => {
    const result = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-edit',
      content: DOC_V1,
      hlc: hlcAt(1000),
    });
    expect(result.leaseNotices).toEqual([]);
    expect(await listSectionLeases(tempDir, 'plan-doc')).toEqual([]);
  });
});

describe('docs-update envelope: advisory lease notices (T13356)', () => {
  it('updateDocBySlug threads leaseNotices into the result and queues W_DOC_SECTION_LEASED', async () => {
    // Seed the legacy row so updateDocBySlug finds the slug.
    const v0 = '# Plan\n\nv0 body';
    const { getDb } = await import('../../store/sqlite.js');
    const { attachments } = await import('../../store/tasks-schema.js');
    const db = await getDb(tempDir);
    const sha0 = (await import('node:crypto'))
      .createHash('sha256')
      .update(v0, 'utf-8')
      .digest('hex');
    await db
      .insert(attachments)
      .values({
        id: 'legacy-plan',
        sha256: sha0,
        attachmentJson: JSON.stringify({ kind: 'blob', sha256: sha0 }),
        createdAt: new Date().toISOString(),
        refCount: 0,
        slug: 'plan-doc',
        lifecycleStatus: 'draft',
        docVersion: 1,
      })
      .run();

    // Bound session for the caller (gate-16 resolution): seed the session
    // row and name it via the env tier. The table object is the live
    // `tasksSessions` (re-exported as `sessions` from tasks-schema), the
    // same one session-store reads.
    const { sessions } = await import('../../store/tasks-schema.js');
    await db
      .insert(sessions)
      .values({ id: 'ses-caller', name: 'lease-envelope-test', status: 'active' })
      .run();
    process.env['CLEO_SESSION_ID'] = 'ses-caller';

    const first = await updateDocBySlug(tempDir, { slug: 'plan-doc', content: DOC_V1 });
    expect(first.ok).toBe(true);

    // Another session holds s1 while the caller edits it. (The first update
    // acquired the caller's own leases — release them so the foreign lease
    // actually lands.)
    await releaseSectionLeases(tempDir, 'plan-doc', 'ses-caller');
    const other = new SectionLeaseManager(tempDir, { sessionId: 'ses-other' });
    const foreign = await other.acquire('plan-doc', 'h-alpha', 60, 'held elsewhere');
    expect(foreign.ok).toBe(true);
    const { drainWarnings } = await import('../../output.js');
    drainWarnings();

    const incoming = DOC_V1.replace('## Alpha\n\nalpha body', '## Alpha\n\nREPLACED body');
    const second = await updateDocBySlug(tempDir, { slug: 'plan-doc', content: incoming });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.result.leaseNotices).toHaveLength(1);
    expect(second.result.leaseNotices?.[0]?.sectionId).toBe('h-alpha');
    expect(second.result.leaseNotices?.[0]?.sessionId).toBe('ses-other');
    // The edit still landed (advisory, AC3).
    expect(second.result.changed).toBe(true);

    const warnings = drainWarnings() ?? [];
    const leaseWarning = warnings.find((w) => w.code === 'W_DOC_SECTION_LEASED');
    expect(leaseWarning).toBeDefined();
    expect(leaseWarning?.message).toContain("'h-alpha'");
    expect(leaseWarning?.message).toContain('ses-other');
    delete process.env['CLEO_SESSION_ID'];
  });
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
    expect(result.sectionsModified).toEqual(['s0', 'h-alpha', 'h-beta']);
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
    for (const id of ['s0', 'h-alpha', 'h-beta']) {
      const row = await readSectionCrdtState(tempDir, result.docUid, id);
      expect(row).not.toBeNull();
      expect(row?.baseVersionUid).toBe(result.version.uid);
    }
    const alpha = await readSectionCrdtState(tempDir, result.docUid, 'h-alpha');
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
    expect(second.sectionsModified).toEqual(['h-alpha']);
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
    const alpha = await readSectionCrdtState(tempDir, second.docUid, 'h-alpha');
    const alphaText = sectionStateText(alpha?.snapshot ?? Buffer.alloc(0));
    expect(alphaText).toContain('an appended line from agent B.');
    expect(alphaText.startsWith('## Alpha')).toBe(true);
    const beta = await readSectionCrdtState(tempDir, second.docUid, 'h-beta');
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
    const stored = await readSectionCrdtState(tempDir, docUid as string, 'h-alpha');
    await writeSectionCrdtState(tempDir, {
      attachmentUid: docUid as string,
      sectionId: 'h-alpha',
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
    // A pure append composition is a merge, not a conflict.
    expect(b.conflicts).toEqual([]);
  });

  it('T13595: a concurrent non-append edit lands as its own version with a recorded head conflict — never fabricated text', async () => {
    const s0 = '# Plan\n\npreamble.';
    const s1Base = '## Alpha\n\nalpha body';
    const s2 = '## Beta\n\nbeta body';
    const baseDoc = [s0, s1Base, s2].join('\n');
    // The incoming writer REPLACES mid-text in s1 (a non-append edit
    // relative to the base) while the stored state carries an unlanded
    // concurrent edit.
    const incomingDoc = [s0, '## Alpha\n\nalpha REPLACED body', s2].join('\n');

    await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-seed',
      content: baseDoc,
      hlc: hlcAt(1000),
    });
    const { seedSectionState } = await import('../section-merge.js');
    const { readSectionCrdtState, writeSectionCrdtState, resolveConduitDocUid } = await import(
      '../../store/conduit-doc-history.js'
    );
    const docUid = await resolveConduitDocUid(tempDir, 'plan-doc');
    const stored = await readSectionCrdtState(tempDir, docUid as string, 'h-alpha');
    await writeSectionCrdtState(tempDir, {
      attachmentUid: docUid as string,
      sectionId: 'h-alpha',
      snapshot: seedSectionState(`${s1Base}\n\nA1`),
      baseVersionUid: stored?.baseVersionUid ?? null,
    });

    const b = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-b',
      content: incomingDoc,
      hlc: hlcAt(2000),
    });

    // No fabricated concatenation: the head projection keeps the stored
    // (concurrent) content — 'REPLACED' appears NOWHERE in it.
    expect(b.mergedText).toBe([s0, `${s1Base}\n\nA1`, s2].join('\n'));
    expect(b.mergedText).not.toContain('REPLACED');
    expect(b.mergedText).toContain('A1');

    // The conflict is recorded with both version refs.
    expect(b.conflicts).toHaveLength(1);
    const conflict = b.conflicts[0]!;
    expect(conflict.sectionId).toBe('h-alpha');
    expect(conflict.projectionVersionUid).toBe(b.version.uid);
    expect(conflict.incomingVersionUid).not.toBe(b.version.uid);

    // The head kept the projection; the conflict names loser + winner. (The
    // conflict upsert lands after the projection upsert, so read the head
    // row fresh.)
    expect(b.head.advanced).toBe(true);
    const { getConduitDocHead } = await import('../../store/conduit-doc-history.js');
    const headAfter = await getConduitDocHead(tempDir, b.docUid);
    expect(headAfter?.headVersionUid).toBe(b.version.uid);
    expect(headAfter?.conflictCount).toBe(1);
    const headConflict = JSON.parse(headAfter?.lastConflictJson ?? '{}') as {
      versionUid?: string;
      winnerVersionUid?: string;
    };
    expect(headConflict.versionUid).toBe(conflict.incomingVersionUid);
    expect(headConflict.winnerVersionUid).toBe(b.version.uid);

    // BOTH versions survive in the append-only history, and the incoming
    // (authored) edit is retrievable verbatim from its own version blob.
    const { listConduitAttachmentVersions } = await import('../../store/conduit-doc-history.js');
    const versions = await listConduitAttachmentVersions(tempDir, b.docUid);
    expect(versions.map((v) => v.uid)).toEqual(
      expect.arrayContaining([b.version.uid, conflict.incomingVersionUid]),
    );
    const incomingVersion = versions.find((v) => v.uid === conflict.incomingVersionUid);
    expect(incomingVersion?.changeSummary).toContain('conflict recorded');
    const { readFileSync } = await import('node:fs');
    const { getCleoDirAbsolute } = await import('../../paths.js');
    const { join: joinPath } = await import('node:path');
    const incomingBlob = readFileSync(
      joinPath(
        getCleoDirAbsolute(tempDir),
        'attachments',
        'sha256',
        incomingVersion?.storageKey ?? '',
      ),
      'utf-8',
    );
    expect(incomingBlob).toBe(incomingDoc);
  });

  it('T13596: the blob tombstone sweep does not remove a version blob a legacy doc shared bytes with', async () => {
    // A legacy attachments row references the same bytes the projection
    // writes as its version blob (same sha256 → same content-addressed
    // path). The legacy row then goes (its tombstone/lifecycle end), and
    // the sweep runs with no grace: the version blob must survive because
    // the conduit doc-history family references it.
    const text = '# Legacy\n\nshared bytes body';
    const { getDb } = await import('../../store/sqlite.js');
    const { attachments } = await import('../../store/tasks-schema.js');
    const { eq } = await import('drizzle-orm');
    const db = await getDb(tempDir);
    const sha = (await import('node:crypto'))
      .createHash('sha256')
      .update(text, 'utf-8')
      .digest('hex');
    await db
      .insert(attachments)
      .values({
        id: 'legacy-1',
        sha256: sha,
        attachmentJson: JSON.stringify({
          kind: 'blob',
          sha256: sha,
          storageKey: `${sha.slice(0, 2)}/${sha.slice(2)}.txt`,
          mime: 'text/plain',
          size: Buffer.byteLength(text, 'utf-8'),
        }),
        createdAt: new Date().toISOString(),
        refCount: 0,
        slug: 'legacy-doc',
        lifecycleStatus: 'draft',
        docVersion: 1,
      })
      .run();

    // The projection writes the SAME bytes (identical content → same sha).
    await projectDocUpdateThroughSections(tempDir, {
      slug: 'legacy-doc',
      authorAgentId: 'agent-a',
      content: text,
      hlc: hlcAt(1000),
    });

    // The legacy row goes; nothing in the legacy tables names the sha now.
    await db.delete(attachments).where(eq(attachments.id, 'legacy-1')).run();

    // Age the blob past any grace period.
    const { getCleoDirAbsolute } = await import('../../paths.js');
    const { join: joinPath } = await import('node:path');
    const blobPath = joinPath(
      getCleoDirAbsolute(tempDir),
      'attachments',
      'sha256',
      `${sha.slice(0, 2)}/${sha.slice(2)}.md`,
    );
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await utimes(blobPath, old, old);

    const { repairAttachmentStore } = await import('../../store/attachment-repair.js');
    const result = await repairAttachmentStore({ cwd: tempDir, gracePeriodMs: 0, dryRun: false });

    // The version blob survived: the sweep skipped it as conduit-history
    // referenced (and did NOT delete it).
    const { existsSync } = await import('node:fs');
    expect(existsSync(blobPath)).toBe(true);
    expect(
      result.actions.some(
        (a) => a.kind === 'skip-referenced-blob' && a.sha256 === sha && /conduit/.test(a.reason),
      ),
    ).toBe(true);
    expect(
      result.actions.some((a) => a.kind === 'delete-unreferenced-blob' && a.sha256 === sha),
    ).toBe(false);
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
    const edit = await readSectionCrdtState(tempDir, second.docUid, 'h-edit');
    expect(sectionStateText(edit?.snapshot ?? Buffer.alloc(0))).toBe('## Edit\n\nabc 123 def');
    const cut = await readSectionCrdtState(tempDir, second.docUid, 'h-cut');
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
    const s1 = await readSectionCrdtState(tempDir, first.docUid, 'h-alpha');
    expect(sectionStateText(s1?.snapshot ?? Buffer.alloc(0))).not.toContain(
      'an appended line from agent B.',
    );
  });

  it('T13584: inserting a section before an approved section keeps its id, state and approval', async () => {
    const v1 = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-a',
      content: DOC_V1,
      hlc: hlcAt(1000),
    });
    const {
      listConduitAttachmentApprovals,
      readSectionCrdtState,
      recordConduitAttachmentApproval,
    } = await import('../../store/conduit-doc-history.js');
    await recordConduitAttachmentApproval(tempDir, {
      attachmentUid: v1.docUid,
      versionUid: v1.version.uid ?? '',
      sectionId: 'h-beta',
      reviewerAgentId: 'reviewer',
      versionReviewed: 1,
    });

    const withGamma = DOC_V1.replace('## Beta', '## Gamma\n\ngamma body\n\n## Beta');
    const v2 = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-b',
      content: withGamma,
      hlc: hlcAt(2000),
    });

    // Only the inserted section is new; Beta kept its id and its state.
    expect(v2.sectionsModified).toEqual(['h-gamma']);
    const beta = await readSectionCrdtState(tempDir, v2.docUid, 'h-beta');
    expect(sectionStateText(beta?.snapshot ?? Buffer.alloc(0))).toBe('## Beta\n\nbeta body');
    // The approval's section id still names Beta in the new version.
    const [approval] = await listConduitAttachmentApprovals(
      tempDir,
      v1.version.uid ?? '',
      'h-beta',
    );
    const v2Sections = splitDocIntoSections(v2.mergedText);
    const at = sectionIds(v2Sections).indexOf(approval?.sectionId ?? '');
    expect(v2Sections[at]).toBe('## Beta\n\nbeta body');
  });

  it('T13584: a stale-base insert before a concurrently edited section neither conflicts nor drops the edit', async () => {
    const v1 = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-seed',
      content: DOC_V1,
      hlc: hlcAt(1000),
    });
    // A appends to Beta and lands.
    await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-a',
      content: `${DOC_V1}\n\nA's beta line.`,
      hlc: hlcAt(2000),
    });
    // B, authored against v1, inserts Gamma before Beta.
    const b = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-b',
      content: DOC_V1.replace('## Beta', '## Gamma\n\ngamma body\n\n## Beta'),
      baseSections: splitDocIntoSections(DOC_V1),
      hlc: hlcAt(3000),
    });
    expect(v1.version.uid).toBeTruthy();
    expect(b.conflicts).toEqual([]);
    expect(b.mergedText).toContain('## Gamma\n\ngamma body');
    expect(b.mergedText).toContain("A's beta line.");
  });

  it('T13584: a doc whose states carry legacy positional ids still merges a stale-base append', async () => {
    await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-seed',
      content: DOC_V1,
      hlc: hlcAt(1000),
    });
    const a = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-a',
      content: DOC_V2,
      hlc: hlcAt(2000),
    });
    // Rewind the local states to the pre-T13584 positional keys.
    const { getNativeDb } = await import('../../store/sqlite.js');
    const native = getNativeDb(tempDir);
    for (const [legacy, stable] of [
      ['s1', 'h-alpha'],
      ['s2', 'h-beta'],
    ]) {
      native
        ?.prepare(
          'UPDATE section_crdt_states SET section_id = ? WHERE attachment_uid = ? AND section_id = ?',
        )
        .run(legacy, a.docUid, stable);
    }
    // B, authored against v1, appends its own Alpha line: it must compose
    // onto the landed head (A's line survives), not re-seed over it.
    const b = await projectDocUpdateThroughSections(tempDir, {
      slug: 'plan-doc',
      authorAgentId: 'agent-b',
      content: DOC_V1.replace('alpha body', 'alpha body\n\nB alpha line.'),
      baseSections: splitDocIntoSections(DOC_V1),
      hlc: hlcAt(3000),
    });
    expect(b.conflicts).toEqual([]);
    expect(b.mergedText).toContain('an appended line from agent B.');
    expect(b.mergedText).toContain('B alpha line.');
  });

  it('T13604: updateDocBySlug threads section conflicts into the result envelope and emits a W_DOC_SECTION_CONFLICT warning', async () => {
    // Seed the legacy row so updateDocBySlug finds the slug.
    const v0 = '# Plan\n\nv0 body';
    const { getDb } = await import('../../store/sqlite.js');
    const { attachments } = await import('../../store/tasks-schema.js');
    const db = await getDb(tempDir);
    const sha0 = (await import('node:crypto'))
      .createHash('sha256')
      .update(v0, 'utf-8')
      .digest('hex');
    await db
      .insert(attachments)
      .values({
        id: 'legacy-plan',
        sha256: sha0,
        attachmentJson: JSON.stringify({ kind: 'blob', sha256: sha0 }),
        createdAt: new Date().toISOString(),
        refCount: 0,
        slug: 'plan-doc',
        lifecycleStatus: 'draft',
        docVersion: 1,
      })
      .run();

    const s0 = '# Plan\n\npreamble.';
    const s1Base = '## Alpha\n\nalpha body';
    const s2 = '## Beta\n\nbeta body';
    const baseDoc = [s0, s1Base, s2].join('\n');

    const first = await updateDocBySlug(tempDir, { slug: 'plan-doc', content: baseDoc });
    expect(first.ok).toBe(true);

    // Inject an unlanded concurrent edit into s1, then update with a
    // non-append edit on the same section through the docs update path.
    const { seedSectionState } = await import('../section-merge.js');
    const { readSectionCrdtState, writeSectionCrdtState, resolveConduitDocUid } = await import(
      '../../store/conduit-doc-history.js'
    );
    const docUid = await resolveConduitDocUid(tempDir, 'plan-doc');
    const stored = await readSectionCrdtState(tempDir, docUid as string, 'h-alpha');
    await writeSectionCrdtState(tempDir, {
      attachmentUid: docUid as string,
      sectionId: 'h-alpha',
      snapshot: seedSectionState(`${s1Base}\n\nA1`),
      baseVersionUid: stored?.baseVersionUid ?? null,
    });
    const incomingDoc = [s0, '## Alpha\n\nalpha REPLACED body', s2].join('\n');

    const second = await updateDocBySlug(tempDir, { slug: 'plan-doc', content: incomingDoc });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected a successful update');
    // The envelope carries the conflict with both version refs…
    expect(second.result.changed).toBe(true);
    expect(second.result.sectionConflicts).toHaveLength(1);
    expect(second.result.sectionConflicts?.[0]?.sectionId).toBe('h-alpha');
    expect(second.result.sectionConflicts?.[0]?.incomingVersionUid).toBeTruthy();
    expect(second.result.sectionConflicts?.[0]?.projectionVersionUid).toBeTruthy();
    // …and a stderr warning names the section (stdout stays clean, ADR-086).
    const { drainWarnings } = await import('../../output.js');
    const warnings = drainWarnings() ?? [];
    const conflictWarning = warnings.find((w) => w.code === 'W_DOC_SECTION_CONFLICT');
    expect(conflictWarning).toBeDefined();
    expect(conflictWarning?.message).toContain("'h-alpha'");
    expect(conflictWarning?.message).toContain('plan-doc');
  });

  it('T13604: the docs fetch envelope surfaces headConflict and stays clean without conflicts', async () => {
    const s0 = '# Plan\n\npreamble.';
    const s1Base = '## Alpha\n\nalpha body';
    const s2 = '## Beta\n\nbeta body';
    const baseDoc = [s0, s1Base, s2].join('\n');

    const makeResolvedDoc = (slug: string): ResolvedDoc => ({
      id: 'att-x',
      sha256: 'a'.repeat(64),
      kind: 'spec',
      title: null,
      slug,
      displayNumber: null,
      ownerId: 'T1',
      ownerType: 'task',
      blobName: null,
      sizeBytes: Buffer.byteLength(baseDoc, 'utf-8'),
      refCount: 0,
      mimeType: 'text/markdown',
      summary: null,
      lifecycleStatus: 'draft',
      createdAt: '2026-10-12T00:00:00.000Z',
      publishedPath: null,
      publishedAt: null,
      lastPublishedBlobSha: null,
      publicationDrift: 'unpublished',
      source: 'tasks-db',
    });

    // No-conflict doc: the envelope carries no headConflict field.
    await projectDocUpdateThroughSections(tempDir, {
      slug: 'clean-doc',
      authorAgentId: 'agent-a',
      content: baseDoc,
      hlc: hlcAt(1000),
    });
    const cleanResult = await buildDocsFetchResult({
      doc: makeResolvedDoc('clean-doc'),
      content: baseDoc,
      projectRoot: tempDir,
    });
    expect(cleanResult.headConflict).toBeUndefined();

    // Conflicted doc: a recorded non-append concurrent edit shows up.
    await projectDocUpdateThroughSections(tempDir, {
      slug: 'conflicted-doc',
      authorAgentId: 'agent-a',
      content: baseDoc,
      hlc: hlcAt(1000),
    });
    const { seedSectionState } = await import('../section-merge.js');
    const { readSectionCrdtState, writeSectionCrdtState, resolveConduitDocUid } = await import(
      '../../store/conduit-doc-history.js'
    );
    const docUid = await resolveConduitDocUid(tempDir, 'conflicted-doc');
    const stored = await readSectionCrdtState(tempDir, docUid as string, 'h-alpha');
    await writeSectionCrdtState(tempDir, {
      attachmentUid: docUid as string,
      sectionId: 'h-alpha',
      snapshot: seedSectionState(`${s1Base}\n\nA1`),
      baseVersionUid: stored?.baseVersionUid ?? null,
    });
    const incomingDoc = [s0, '## Alpha\n\nalpha REPLACED body', s2].join('\n');
    const conflicted = await projectDocUpdateThroughSections(tempDir, {
      slug: 'conflicted-doc',
      authorAgentId: 'agent-b',
      content: incomingDoc,
      hlc: hlcAt(2000),
    });
    expect(conflicted.conflicts).toHaveLength(1);

    const fetchResult = await buildDocsFetchResult({
      doc: makeResolvedDoc('conflicted-doc'),
      content: conflicted.mergedText,
      projectRoot: tempDir,
    });
    expect(fetchResult.headConflict?.conflictCount).toBe(1);
    expect(fetchResult.headConflict?.lastConflict?.versionUid).toBe(
      conflicted.conflicts[0]?.incomingVersionUid,
    );
    expect(fetchResult.headConflict?.lastConflict?.winnerVersionUid).toBe(conflicted.version.uid);
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
