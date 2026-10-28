/**
 * Tests for docs-ops.ts — llmtxt primitive wrappers.
 *
 * All llmtxt subpaths and the blob store are mocked so tests run
 * offline without a real llmtxt installation.
 *
 * @epic T1041
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CleoError } from '../../errors.js';

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock('llmtxt/similarity', () => ({
  rankBySimilarity: vi.fn(),
}));

vi.mock('llmtxt/sdk', () => ({
  squashPatches: vi.fn(),
  diffVersions: vi.fn(),
  reconstructVersion: vi.fn(),
}));

vi.mock('llmtxt/graph', () => ({
  buildGraph: vi.fn(),
}));

vi.mock('../../store/blob-ops.js', () => ({
  blobList: vi.fn(),
  blobRead: vi.fn(),
}));

const conduitHistoryMocks = vi.hoisted(() => ({
  resolveConduitDocUid: vi.fn(async () => null),
  listConduitAttachmentVersions: vi.fn(async () => []),
  findConduitAttachmentByUid: vi.fn(async () => null),
}));

vi.mock('../../store/conduit-doc-history.js', () => ({
  resolveConduitDocUid: conduitHistoryMocks.resolveConduitDocUid,
  listConduitAttachmentVersions: conduitHistoryMocks.listConduitAttachmentVersions,
  findConduitAttachmentByUid: conduitHistoryMocks.findConduitAttachmentByUid,
}));

const attachmentStoreMocks = vi.hoisted(() => ({
  findBySlug: vi.fn(),
  listRefs: vi.fn(async () => []),
  getMetadata: vi.fn(async () => null),
  listByOwner: vi.fn(async () => []),
}));

vi.mock('../../store/attachment-store.js', () => ({
  createAttachmentStore: () => ({
    findBySlug: attachmentStoreMocks.findBySlug,
    listRefs: attachmentStoreMocks.listRefs,
    getMetadata: attachmentStoreMocks.getMetadata,
    listByOwner: attachmentStoreMocks.listByOwner,
  }),
}));

vi.mock('../../paths.js', () => ({
  getProjectRoot: vi.fn(() => '/tmp/test-project'),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import * as graphMod from 'llmtxt/graph';
import * as sdkMod from 'llmtxt/sdk';
import * as simMod from 'llmtxt/similarity';
import * as blobOps from '../../store/blob-ops.js';

import {
  buildDocsGraph,
  listDocVersions,
  mergeDocs,
  publishDocs,
  rankDocs,
  searchDocs,
} from '../docs-ops.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

const mockBlobs = [
  { name: 'spec.md', sha256: 'aabb', sizeBytes: 1024, mimeType: 'text/markdown', uploadedAt: 1000 },
  { name: 'design.png', sha256: 'ccdd', sizeBytes: 4096, mimeType: 'image/png', uploadedAt: 2000 },
];

/** Slug used by the T13727 conduit-routing tests below. */
const SLUG_FOR_CONDUIT_TEST = 't13727-conduit-doc';

// ─── searchDocs ───────────────────────────────────────────────────────────────

describe('searchDocs', () => {
  beforeEach(() => {
    vi.mocked(blobOps.blobList).mockResolvedValue(mockBlobs);
    vi.mocked(simMod.rankBySimilarity).mockReturnValue([
      { index: 0, score: 0.9 },
      { index: 1, score: 0.7 },
    ]);
  });

  it('passes query and candidates to rankBySimilarity and slices to limit', async () => {
    const result = await searchDocs('architecture', { ownerId: 'T123', limit: 5 });

    // The real rankBySimilarity API does not accept topK — options are method/threshold
    expect(simMod.rankBySimilarity).toHaveBeenCalledWith('architecture', ['spec.md', 'design.png']);
    expect(result.query).toBe('architecture');
    // sliced to limit=5, but only 2 candidates
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0].score).toBe(0.9);
    expect(result.hits[0].name).toBe('spec.md');
  });

  it('throws LLMTXT_PRIMITIVE_UNAVAILABLE when rankBySimilarity throws', async () => {
    vi.mocked(simMod.rankBySimilarity).mockImplementationOnce(() => {
      const err = new Error('MODULE_NOT_FOUND') as Error & { code: string };
      err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    });

    await expect(searchDocs('query', { ownerId: 'T1' })).rejects.toThrow('MODULE_NOT_FOUND');
  });
});

// ─── mergeDocs ────────────────────────────────────────────────────────────────

describe('mergeDocs', () => {
  beforeEach(() => {
    vi.mocked(sdkMod.squashPatches).mockReturnValue({
      patchText: 'merged content',
      contentHash: 'abc',
      tokenCount: 10,
    });
    vi.mocked(sdkMod.reconstructVersion).mockReturnValue({
      content: 'cherry content',
      version: 1,
      patchesApplied: 1,
      contentHash: 'def',
      tokenCount: 5,
    });
    vi.mocked(sdkMod.diffVersions).mockReturnValue({
      fromVersion: 1,
      toVersion: 2,
      addedLines: 2,
      removedLines: 1,
      addedTokens: 5,
      removedTokens: 2,
      patchText: 'diff output',
    });
  });

  it('calls squashPatches for three-way strategy with full VersionEntry objects', async () => {
    const result = await mergeDocs('contentA', 'contentB', {
      strategy: 'three-way',
      base: 'base',
    });

    expect(sdkMod.squashPatches).toHaveBeenCalledWith(
      'base',
      expect.arrayContaining([
        expect.objectContaining({ versionNumber: 1, patchText: 'contentA', createdBy: 'cleo' }),
        expect.objectContaining({ versionNumber: 2, patchText: 'contentB', createdBy: 'cleo' }),
      ]),
    );
    expect(result.merged).toBe('merged content');
    expect(result.strategy).toBe('three-way');
    expect(result.hasConflicts).toBe(false);
  });

  it('calls reconstructVersion for cherry-pick strategy', async () => {
    const result = await mergeDocs('contentA', 'contentB', { strategy: 'cherry-pick' });

    expect(sdkMod.reconstructVersion).toHaveBeenCalledWith(
      '',
      expect.arrayContaining([
        expect.objectContaining({ versionNumber: 1, patchText: 'contentA', createdBy: 'cleo' }),
      ]),
      1,
    );
    expect(result.merged).toBe('cherry content');
    expect(result.strategy).toBe('cherry-pick');
    expect(result.hasConflicts).toBe(false);
  });

  it('calls diffVersions for multi-diff strategy and returns patchText', async () => {
    const result = await mergeDocs('contentA', 'contentB', { strategy: 'multi-diff' });

    expect(sdkMod.diffVersions).toHaveBeenCalledWith(
      '',
      expect.arrayContaining([
        expect.objectContaining({ versionNumber: 1, patchText: 'contentA' }),
        expect.objectContaining({ versionNumber: 2, patchText: 'contentB' }),
      ]),
      1,
      2,
    );
    expect(result.merged).toBe('diff output');
    expect(result.strategy).toBe('multi-diff');
  });

  it('sets hasConflicts and uses conflict markers when squashPatches throws', async () => {
    vi.mocked(sdkMod.squashPatches).mockImplementationOnce(() => {
      throw new Error('patch conflict');
    });

    const result = await mergeDocs('A', 'B', { strategy: 'three-way' });

    expect(result.hasConflicts).toBe(true);
    expect(result.merged).toContain('<<<<<<< A');
    expect(result.merged).toContain('>>>>>>> B');
  });
});

// ─── buildDocsGraph ───────────────────────────────────────────────────────────

describe('buildDocsGraph', () => {
  beforeEach(() => {
    vi.mocked(blobOps.blobList).mockResolvedValue(mockBlobs);
    vi.mocked(graphMod.buildGraph).mockReturnValue({
      nodes: [{ id: 'spec.md', label: 'spec.md', type: 'attachment', weight: 1 }],
      edges: [{ source: 'spec.md', target: 'design.png', type: 'references', weight: 0.5 }],
      stats: { agentCount: 1, topicCount: 0, decisionCount: 0, edgeCount: 1 },
    });
  });

  it('passes MessageInput objects to buildGraph with blob metadata in content', async () => {
    const result = await buildDocsGraph({ ownerId: 'T123' });

    expect(graphMod.buildGraph).toHaveBeenCalled();
    const callArg = vi.mocked(graphMod.buildGraph).mock.calls[0][0];
    // Each item is a MessageInput — content holds the blob metadata
    expect(callArg[0].content).toContain('spec.md');
    expect(callArg[0].content).toContain('sha256:aabb');

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].kind).toBe('attachment');
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].relation).toBe('references');
  });

  it('surfaces errors thrown by buildGraph', async () => {
    vi.mocked(graphMod.buildGraph).mockImplementationOnce(() => {
      const err = new Error('graph primitive error') as Error & { code: string };
      err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    });

    const resultOrError = await buildDocsGraph({ ownerId: 'T123' }).catch((e) => e);
    expect(resultOrError).toBeInstanceOf(Error);
  });
});

// ─── rankDocs ─────────────────────────────────────────────────────────────────

describe('rankDocs', () => {
  beforeEach(() => {
    vi.mocked(blobOps.blobList).mockResolvedValue(mockBlobs);
    vi.mocked(simMod.rankBySimilarity).mockClear();
    vi.mocked(simMod.rankBySimilarity).mockReturnValue([
      { index: 1, score: 0.85 },
      { index: 0, score: 0.6 },
    ]);
  });

  it('uses ownerId as query when no explicit query given', async () => {
    const result = await rankDocs({ ownerId: 'T123' });

    expect(simMod.rankBySimilarity).toHaveBeenCalledWith('T123', ['spec.md', 'design.png']);
    expect(result.ownerId).toBe('T123');
    expect(result.hits[0].name).toBe('design.png');
    expect(result.hits[0].score).toBe(0.85);
  });

  it('uses explicit query when provided', async () => {
    await rankDocs({ ownerId: 'T123', query: 'design' });

    expect(simMod.rankBySimilarity).toHaveBeenCalledWith('design', expect.any(Array));
  });

  it('returns empty hits when no blobs attached to owner', async () => {
    vi.mocked(blobOps.blobList).mockResolvedValue([]);

    const result = await rankDocs({ ownerId: 'T999' });

    expect(result.hits).toHaveLength(0);
    expect(simMod.rankBySimilarity).not.toHaveBeenCalled();
  });
});

// ─── listDocVersions ──────────────────────────────────────────────────────────

describe('listDocVersions', () => {
  beforeEach(() => {
    vi.mocked(blobOps.blobList).mockClear();
    vi.mocked(blobOps.blobList).mockResolvedValue(mockBlobs);
    attachmentStoreMocks.findBySlug.mockReset();
    attachmentStoreMocks.findBySlug.mockResolvedValue(null);
    attachmentStoreMocks.listRefs.mockReset();
    attachmentStoreMocks.listRefs.mockResolvedValue([]);
    conduitHistoryMocks.resolveConduitDocUid.mockReset();
    conduitHistoryMocks.resolveConduitDocUid.mockResolvedValue(null);
    conduitHistoryMocks.listConduitAttachmentVersions.mockReset();
    conduitHistoryMocks.listConduitAttachmentVersions.mockResolvedValue([]);
    conduitHistoryMocks.findConduitAttachmentByUid.mockReset();
    conduitHistoryMocks.findConduitAttachmentByUid.mockResolvedValue(null);
  });

  it('returns all blobs when no name filter given', async () => {
    const result = await listDocVersions({ ownerId: 'T123' });

    expect(result.ownerId).toBe('T123');
    expect(result.nameFilter).toBeUndefined();
    expect(result.versions).toHaveLength(2);
    expect(result.versions[0].sha256).toBe('aabb');
    expect(attachmentStoreMocks.findBySlug).not.toHaveBeenCalled();
  });

  it('filters by name when name option provided', async () => {
    const result = await listDocVersions({ ownerId: 'T123', name: 'spec.md' });

    expect(result.nameFilter).toBe('spec.md');
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0].name).toBe('spec.md');
  });

  it('returns empty versions list when blobList returns empty', async () => {
    vi.mocked(blobOps.blobList).mockResolvedValue([]);

    const result = await listDocVersions({ ownerId: 'T999' });

    expect(result.versions).toHaveLength(0);
  });

  it('throws E_NOT_FOUND when the arg is neither an owner with blobs nor a known slug (T13725)', async () => {
    vi.mocked(blobOps.blobList).mockResolvedValue([]);
    attachmentStoreMocks.findBySlug.mockResolvedValue(null);

    const err = await listDocVersions({ ownerId: 't999-no-such-doc' }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(CleoError);
    expect((err as CleoError).code).toBe(ExitCode.NOT_FOUND);
    expect(err.message).toContain("no doc or owner found for 't999-no-such-doc'");
  });

  it('resolves a doc slug to its owning task and lists that owner’s blobs (T13725)', async () => {
    vi.mocked(blobOps.blobList).mockImplementation((ownerId: string) =>
      Promise.resolve(ownerId === 'T777' ? mockBlobs : []),
    );
    attachmentStoreMocks.findBySlug.mockResolvedValue({
      metadata: { id: 'att-doc-1' },
      slug: 't777-my-doc',
    });
    attachmentStoreMocks.listRefs.mockResolvedValue([{ ownerType: 'task', ownerId: 'T777' }]);

    const result = await listDocVersions({ ownerId: 't777-my-doc' });

    expect(result.ownerId).toBe('T777');
    expect(result.versions).toHaveLength(2);
    expect(result.versions[0].sha256).toBe('aabb');
  });

  it('returns an empty list when the slug resolves to a doc whose owners have no mirrored blobs (T13725)', async () => {
    vi.mocked(blobOps.blobList).mockResolvedValue([]);
    attachmentStoreMocks.findBySlug.mockResolvedValue({
      metadata: { id: 'att-doc-2' },
      slug: 't778-legacy-doc',
    });
    attachmentStoreMocks.listRefs.mockResolvedValue([{ ownerType: 'task', ownerId: 'T778' }]);

    const result = await listDocVersions({ ownerId: 't778-legacy-doc' });

    expect(result.ownerId).toBe('t778-legacy-doc');
    expect(result.versions).toHaveLength(0);
  });

  it('prefers conduit history over the manifest when the slug has conduit version rows (T13727)', async () => {
    const conduitRows = [
      {
        uid: 'v-3',
        contentHash: 'hash-v3',
        versionNumber: 1,
        originalSize: 30,
        createdAt: '2026-10-16T10:00:00.000Z',
        slug: null,
      },
      {
        uid: 'v-2',
        contentHash: 'hash-v2',
        versionNumber: 2,
        originalSize: 20,
        createdAt: '2026-10-15T10:00:00.000Z',
        slug: SLUG_FOR_CONDUIT_TEST,
      },
      {
        uid: 'v-1',
        contentHash: 'hash-v1',
        versionNumber: 1,
        originalSize: 10,
        createdAt: '2026-10-14T10:00:00.000Z',
        slug: SLUG_FOR_CONDUIT_TEST,
      },
    ];
    conduitHistoryMocks.resolveConduitDocUid.mockResolvedValue('doc-uid-1');
    conduitHistoryMocks.findConduitAttachmentByUid.mockResolvedValue({
      uid: 'doc-uid-1',
      slug: SLUG_FOR_CONDUIT_TEST,
    });
    conduitHistoryMocks.listConduitAttachmentVersions.mockResolvedValue(conduitRows);
    // The manifest ALSO has entries for this arg — conduit must win.
    vi.mocked(blobOps.blobList).mockImplementation((ownerId: string) =>
      Promise.resolve(ownerId === SLUG_FOR_CONDUIT_TEST ? mockBlobs : []),
    );

    const result = await listDocVersions({ ownerId: SLUG_FOR_CONDUIT_TEST });

    expect(result.ownerId).toBe(SLUG_FOR_CONDUIT_TEST);
    // Newest createdAt first; every version listed with its content hash.
    expect(result.versions.map((v) => v.sha256)).toEqual(['hash-v3', 'hash-v2', 'hash-v1']);
    expect(result.versions.map((v) => v.docVersion)).toEqual([1, 2, 1]);
    // Read-time display ordinals 1..N (chronological, uid tiebreak) — the
    // stored ordinals repeat across the seam (1,2,1) but the display cannot.
    expect(result.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(result.versions.map((v) => v.storedVersionNumber)).toEqual([1, 2, 1]);
    for (const entry of result.versions) {
      expect(entry.name).toBe(SLUG_FOR_CONDUIT_TEST);
      expect(entry.attachmentId).toBe(entry.sha256);
    }
    expect(blobOps.blobList).not.toHaveBeenCalled();
  });

  it('honours --name against the conduit doc slug (T13727)', async () => {
    conduitHistoryMocks.resolveConduitDocUid.mockResolvedValue('doc-uid-1');
    conduitHistoryMocks.findConduitAttachmentByUid.mockResolvedValue({
      uid: 'doc-uid-1',
      slug: SLUG_FOR_CONDUIT_TEST,
    });
    conduitHistoryMocks.listConduitAttachmentVersions.mockResolvedValue([
      {
        uid: 'v-3',
        contentHash: 'hash-v3',
        versionNumber: 1,
        originalSize: 30,
        createdAt: '2026-10-16T10:00:00.000Z',
        slug: null,
      },
    ]);

    const miss = await listDocVersions({ ownerId: SLUG_FOR_CONDUIT_TEST, name: 'other.md' });
    expect(miss.versions).toHaveLength(0);
    expect(miss.nameFilter).toBe('other.md');

    const hit = await listDocVersions({
      ownerId: SLUG_FOR_CONDUIT_TEST,
      name: SLUG_FOR_CONDUIT_TEST,
    });
    expect(hit.versions).toHaveLength(1);
  });

  it('falls back to the manifest when the doc has a conduit row but zero version rows (T13727)', async () => {
    conduitHistoryMocks.resolveConduitDocUid.mockResolvedValue('doc-uid-1');
    conduitHistoryMocks.findConduitAttachmentByUid.mockResolvedValue({
      uid: 'doc-uid-1',
      slug: 't779-adopted-no-history',
    });
    conduitHistoryMocks.listConduitAttachmentVersions.mockResolvedValue([]);
    vi.mocked(blobOps.blobList).mockImplementation((ownerId: string) =>
      Promise.resolve(ownerId === 'T779' ? mockBlobs : []),
    );
    attachmentStoreMocks.findBySlug.mockResolvedValue({
      metadata: { id: 'att-doc-3' },
      slug: 't779-adopted-no-history',
    });
    attachmentStoreMocks.listRefs.mockResolvedValue([{ ownerType: 'task', ownerId: 'T779' }]);

    const result = await listDocVersions({ ownerId: 't779-adopted-no-history' });

    expect(result.ownerId).toBe('T779');
    expect(result.versions).toHaveLength(2);
    // Manifest-fallback entries carry no stored version sequence — the
    // display/stored ordinal fields are honestly absent, not fabricated.
    for (const entry of result.versions) {
      expect(entry.version).toBeUndefined();
      expect(entry.storedVersionNumber).toBeUndefined();
    }
  });

  it('falls back to the manifest when conduit resolution fails (T13727)', async () => {
    conduitHistoryMocks.resolveConduitDocUid.mockRejectedValue(new Error('store unreachable'));

    const slugResult = await listDocVersions({ ownerId: SLUG_FOR_CONDUIT_TEST });

    // The manifest lists the arg verbatim (it owns blobs in this mock); the
    // command must not fail because the store was unreachable.
    expect(slugResult.versions).toHaveLength(2);
    expect(slugResult.versions[0]!.sha256).toBe('aabb');
  });
});

// ─── publishDocs ──────────────────────────────────────────────────────────────

describe('publishDocs', () => {
  beforeEach(() => {
    vi.mocked(blobOps.blobList).mockResolvedValue(mockBlobs);
    vi.mocked(blobOps.blobRead).mockResolvedValue(new Uint8Array([104, 101, 108, 108, 111])); // "hello"
  });

  it('selects latest blob by uploadedAt when no attachmentId given', async () => {
    const result = await publishDocs({
      ownerId: 'T123',
      // Outside the mocked projectRoot — caller opts into the bypass explicitly.
      toPath: '/tmp/out/doc.md',
      allowOutsideRoot: true,
    });

    expect(blobOps.blobRead).toHaveBeenCalledWith('T123', 'design.png', '/tmp/test-project');
    expect(result.publishedPath).toBe('/tmp/out/doc.md');
    expect(result.bytes).toBe(5);
    expect(result.sha256).toHaveLength(64);
    // T9701 — richer envelope fields.
    expect(result.blobName).toBe('design.png');
    expect(result.blobSha256).toBe('ccdd');
    expect(result.ownerId).toBe('T123');
    expect(typeof result.relativePath).toBe('string');
  });

  it('selects blob by sha256 when attachmentId matches', async () => {
    const result = await publishDocs({
      ownerId: 'T123',
      attachmentId: 'aabb',
      toPath: '/tmp/out/spec.md',
      allowOutsideRoot: true,
    });

    expect(blobOps.blobRead).toHaveBeenCalledWith('T123', 'spec.md', '/tmp/test-project');
    expect(result.publishedPath).toBe('/tmp/out/spec.md');
    expect(result.blobName).toBe('spec.md');
    expect(result.blobSha256).toBe('aabb');
  });

  it('throws when no attachments found for owner', async () => {
    vi.mocked(blobOps.blobList).mockResolvedValue([]);

    await expect(
      publishDocs({ ownerId: 'T999', toPath: '/tmp/out.md', allowOutsideRoot: true }),
    ).rejects.toThrow('no attachments found');
  });

  it('throws when specified attachmentId not found', async () => {
    await expect(
      publishDocs({
        ownerId: 'T123',
        attachmentId: 'nonexistent',
        toPath: '/tmp/out.md',
        allowOutsideRoot: true,
      }),
    ).rejects.toThrow('not found');
  });

  it('throws when blobRead returns null', async () => {
    vi.mocked(blobOps.blobRead).mockResolvedValue(null);

    await expect(
      publishDocs({ ownerId: 'T123', toPath: '/tmp/out.md', allowOutsideRoot: true }),
    ).rejects.toThrow('could not read blob');
  });

  // T9701 — path-escape guard: writes outside projectRoot are rejected unless
  // the caller passes allowOutsideRoot:true. CLI never sets that flag.
  it('rejects absolute toPath that escapes projectRoot by default', async () => {
    await expect(
      publishDocs({
        ownerId: 'T123',
        toPath: '/etc/passwd',
      }),
    ).rejects.toThrow(/outside projectRoot/);
  });

  // T9701 — same protection for relative `..` traversal sequences.
  it('rejects relative toPath that resolves outside projectRoot', async () => {
    await expect(
      publishDocs({
        ownerId: 'T123',
        toPath: '../../escape.md',
      }),
    ).rejects.toThrow(/outside projectRoot/);
  });

  // T13919 / T12583 — dry-run and execute run the same checks and refuse an
  // outside-root destination with the same typed code; nothing is created.
  it('T13919: dry-run and execute refuse an outside-root destination alike, creating nothing', async () => {
    const outside = join(tmpdir(), `cleo-t13919-${process.pid}-${Date.now()}`, 'admin', 'x.md');
    for (const dryRun of [true, false]) {
      const err = await publishDocs({ ownerId: 'T123', toPath: outside, dryRun }).catch(
        (e: unknown) => e,
      );
      expect(err, `dryRun=${dryRun}`).toMatchObject({
        name: 'CleoError',
        code: 6,
        message: expect.stringMatching(/outside projectRoot/),
        fix: expect.stringMatching(/registered canonical task worktree/),
      });
      expect(String((err as Error).message)).not.toMatch(/allowOutsideRoot/);
      expect(existsSync(dirname(dirname(outside))), `dryRun=${dryRun}`).toBe(false);
    }
  });

  it('T14081: a linked non-canonical worktree is refused naming the canonical path and both routes', async () => {
    // An empty GIT_DIR is invalid on Linux git: inherit the environment as
    // publish-smoke's T13376 fixture does, from a realpath'd temp root.
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-t14081-root-')));
    const linked = `${root}-linked`;
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      git(root, 'init', '-q');
      git(
        root,
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      );
      git(root, 'worktree', 'add', '-q', linked);
      for (const dryRun of [true, false]) {
        const err = await publishDocs({
          ownerId: 'T123',
          toPath: join(linked, 'docs', 'x.md'),
          projectRoot: root,
          dryRun,
        }).catch((e: unknown) => e);
        expect(err, `dryRun=${dryRun}`).toMatchObject({
          code: 6,
          message: expect.stringMatching(
            /linked worktree .*only the canonical CLEO worktree path .*T13376/,
          ),
          fix: expect.stringMatching(
            /Only canonical CLEO worktrees are publication targets \(T13376\).*store's project root.*CLEO-created worktree \(cleo orchestrate spawn/,
          ),
        });
        expect(existsSync(join(linked, 'docs')), `dryRun=${dryRun}`).toBe(false);
      }
    } finally {
      await rm(linked, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('T13919: a dry run inside the root reports what would be written and writes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cleo-t13919-root-'));
    try {
      const result = await publishDocs({
        ownerId: 'T123',
        toPath: 'docs/out/spec.md',
        projectRoot: root,
        dryRun: true,
      });
      expect(result).toMatchObject({
        dryRun: true,
        relativePath: join('docs', 'out', 'spec.md'),
        bytes: 5,
      });
      expect(existsSync(join(root, 'docs'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // ── T11042 regression: publish default selects latest owner version ────────

  // T11042-B1a: When no explicit attachmentId is given, publishDocs MUST select
  // the **most recently attached** blob for the owner, not simply the last
  // element of whatever order blobList returns.
  it('T11042: publish default selects most-recently-attached blob (not arbitrary last)', async () => {
    // Three blobs: blob-B is most recent (uploadedAt: 3000), blob-A is oldest (1000)
    const timestamped = [
      { name: 'v1.md', sha256: 'old', sizeBytes: 100, mimeType: 'text/markdown', uploadedAt: 1000 },
      { name: 'v2.md', sha256: 'mid', sizeBytes: 200, mimeType: 'text/markdown', uploadedAt: 3000 },
      { name: 'v3.md', sha256: 'new', sizeBytes: 300, mimeType: 'text/markdown', uploadedAt: 2000 },
    ];
    vi.mocked(blobOps.blobList).mockResolvedValue(timestamped);

    const result = await publishDocs({
      ownerId: 'T123',
      toPath: '/tmp/out/doc.md',
      allowOutsideRoot: true,
    });

    // Must pick v2.md (uploadedAt: 3000), NOT v3.md (last in array, uploadedAt: 2000)
    expect(result.blobSha256).toBe('mid');
    expect(result.blobName).toBe('v2.md');
  });

  // T11042-B1b: After a docs-update rotates the slug onto a new content blob,
  // the publish default MUST pick up the new blob's SHA.
  it('T11042: publish after update picks up the updated blob SHA (not stale pre-update blob)', async () => {
    // Simulate an update: blob-B (newer uploadedAt) replaces blob-A
    const updated = [
      {
        name: 'spec.md',
        sha256: 'stale',
        sizeBytes: 100,
        mimeType: 'text/markdown',
        uploadedAt: 1000,
      },
      {
        name: 'spec.md',
        sha256: 'fresh',
        sizeBytes: 200,
        mimeType: 'text/markdown',
        uploadedAt: 5000,
      },
    ];
    vi.mocked(blobOps.blobList).mockResolvedValue(updated);

    const result = await publishDocs({
      ownerId: 'T123',
      toPath: '/tmp/out/spec.md',
      allowOutsideRoot: true,
    });

    // Must pick the fresh SHA (uploadedAt: 5000), not the stale one
    expect(result.blobSha256).toBe('fresh');
    expect(result.blobName).toBe('spec.md');
  });

  // T11042-B1c: The SHA returned by publishDocs.sha256 MUST match the SHA
  // that blobList reports for the same (ownerId, blobName) pair.
  it('T11042: publish sha256 agrees with blob manifest sha256 for selected blob', async () => {
    const blobs = [
      { name: 'x.md', sha256: 'aaa111', sizeBytes: 50, mimeType: 'text/markdown', uploadedAt: 500 },
      { name: 'x.md', sha256: 'bbb222', sizeBytes: 75, mimeType: 'text/markdown', uploadedAt: 999 },
    ];
    vi.mocked(blobOps.blobList).mockResolvedValue(blobs);

    // blobRead returns bytes whose sha256 will be verified against manifest
    vi.mocked(blobOps.blobRead).mockResolvedValue(new Uint8Array([120, 120, 120])); // "xxx"

    const result = await publishDocs({
      ownerId: 'T123',
      toPath: '/tmp/out/x.md',
      allowOutsideRoot: true,
    });

    // The selected blob should be the latest: bbb222 (uploadedAt: 999)
    expect(result.blobSha256).toBe('bbb222');
    expect(result.blobName).toBe('x.md');
    // The sha256 of written bytes matches the computed hash (not the manifest sha)
    // but blobSha256 must match the manifest's canonical hash
    expect(result.sha256).toBeTruthy();
  });

  // T11042 edge case: explicit attachmentId still works for historical versions
  it('T11042: explicit attachmentId overrides latest selection for historical versions', async () => {
    const blobs = [
      {
        name: 'old.md',
        sha256: 'old-sha',
        sizeBytes: 100,
        mimeType: 'text/markdown',
        uploadedAt: 100,
      },
      {
        name: 'new.md',
        sha256: 'new-sha',
        sizeBytes: 200,
        mimeType: 'text/markdown',
        uploadedAt: 9999,
      },
    ];
    vi.mocked(blobOps.blobList).mockResolvedValue(blobs);

    // Explicitly request the OLD version
    const result = await publishDocs({
      ownerId: 'T123',
      attachmentId: 'old-sha',
      toPath: '/tmp/out/old.md',
      allowOutsideRoot: true,
    });

    // Must use the explicitly-requested historical version, not the latest
    expect(result.blobSha256).toBe('old-sha');
    expect(result.blobName).toBe('old.md');
  });
});
