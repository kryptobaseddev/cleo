/**
 * docs.update dispatch envelope: recorded CRDT section conflicts reach
 * `data.sectionConflicts` (T13610 / T13604 AC1).
 *
 * review-hotfix's delta review of #2144 at d93ac3cfb found the dispatch
 * handler built `DocsUpdateResult` field by field and never copied
 * `sectionConflicts` — `cleo docs update` and every dispatch caller got no
 * `sectionConflicts` in data, only the stderr warning, so T13604 AC1 was
 * unmet. The core `updateDocBySlug` behaviour is covered by
 * `section-write-path.test.ts` (T13604); this test pins the dispatch
 * contract: whatever the core result carries MUST land in the envelope.
 *
 * `updateDocBySlug` is mocked at the module boundary — the store sandboxing
 * of the CRDT projection is irrelevant to an envelope-shape assertion, and
 * the vitest fork sandbox redirects project-root resolution away from the
 * temp store, which would make a storage-backed dispatch test assert the
 * sandbox rather than the handler.
 *
 * @task T13610 (Epic T13340 / Saga T13339)
 */

import { describe, expect, it, vi } from 'vitest';
import type { DocsSectionConflict, DocsUpdateOk } from '@cleocode/contracts';

const SECTION_CONFLICTS: DocsSectionConflict[] = [
  { sectionId: 's1', incomingVersionUid: 'uid-incoming', projectionVersionUid: 'uid-projection' },
];

/** Mutable mock result so each test controls what the core returns. */
let coreResult: DocsUpdateOk;

vi.mock('@cleocode/core/docs/docs-update', () => ({
  DOCS_UPDATE_LIFECYCLE_STATUS_LIST: 'draft|proposed|accepted|superseded|archived|deprecated',
  isLifecycleStatus: (raw: unknown): boolean => typeof raw === 'string',
  docsUpdateMimeFromPath: (filePath: string): string =>
    filePath.endsWith('.md') ? 'text/markdown' : 'application/octet-stream',
  updateDocBySlug: vi.fn(async () => ({ ok: true as const, result: coreResult })),
}));

function makeCoreResult(overrides: Partial<DocsUpdateOk> = {}): DocsUpdateOk {
  return {
    slug: 'plan-doc',
    type: null,
    attachmentId: 'att-2',
    previousAttachmentId: 'att-1',
    sha256: 'b'.repeat(64),
    previousSha256: 'a'.repeat(64),
    changed: true,
    lifecycleStatus: 'draft',
    updatedAt: '2026-10-12T00:00:00.000Z',
    version: 2,
    ownerVersion: 'test',
    docVersion: 2,
    squashed: false,
    summary: "slug 'plan-doc' was changed",
    ...overrides,
  };
}

describe('docs.update dispatch — sectionConflicts in the envelope (T13610)', () => {
  it('carries data.sectionConflicts with both version refs when the core result has them', async () => {
    const { DocsHandler } = await import('../docs.js');
    coreResult = makeCoreResult({ sectionConflicts: SECTION_CONFLICTS });

    const response = await new DocsHandler().mutate('update', {
      slug: 'plan-doc',
      content: '# Plan\n\nnew body',
    });

    expect(response.success).toBe(true);
    expect(response.error).toBeUndefined();
    const data = response.data as {
      changed: boolean;
      sectionConflicts?: DocsSectionConflict[];
    };
    expect(data.changed).toBe(true);
    expect(data.sectionConflicts).toEqual(SECTION_CONFLICTS);
    expect(data.sectionConflicts?.[0]?.sectionId).toBe('s1');
    expect(data.sectionConflicts?.[0]?.incomingVersionUid).toBe('uid-incoming');
    expect(data.sectionConflicts?.[0]?.projectionVersionUid).toBe('uid-projection');
  });

  it('omits sectionConflicts when the core result has none (no-conflict path unchanged)', async () => {
    const { DocsHandler } = await import('../docs.js');
    coreResult = makeCoreResult();

    const response = await new DocsHandler().mutate('update', {
      slug: 'plan-doc',
      content: '# Plan\n\nnew body',
    });

    expect(response.success).toBe(true);
    const data = response.data as { sectionConflicts?: DocsSectionConflict[] };
    expect(data.sectionConflicts).toBeUndefined();
  });
});
