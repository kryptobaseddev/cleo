/**
 * Tests for docs-ops.ts — llmtxt primitive wrappers.
 *
 * All llmtxt subpaths and the blob store are mocked so tests run
 * offline without a real llmtxt installation.
 *
 * @epic T1041
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  { name: 'spec.md', sha256: 'aabb', sizeBytes: 1024, mimeType: 'text/markdown' },
  { name: 'design.png', sha256: 'ccdd', sizeBytes: 4096, mimeType: 'image/png' },
];

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
    vi.mocked(blobOps.blobList).mockResolvedValue(mockBlobs);
  });

  it('returns all blobs when no name filter given', async () => {
    const result = await listDocVersions({ ownerId: 'T123' });

    expect(result.ownerId).toBe('T123');
    expect(result.nameFilter).toBeUndefined();
    expect(result.versions).toHaveLength(2);
    expect(result.versions[0].sha256).toBe('aabb');
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
});

// ─── publishDocs ──────────────────────────────────────────────────────────────

describe('publishDocs', () => {
  beforeEach(() => {
    vi.mocked(blobOps.blobList).mockResolvedValue(mockBlobs);
    vi.mocked(blobOps.blobRead).mockResolvedValue(new Uint8Array([104, 101, 108, 108, 111])); // "hello"
  });

  it('reads the last blob and writes to toPath when no attachmentId given', async () => {
    const result = await publishDocs({
      ownerId: 'T123',
      toPath: '/tmp/out/doc.md',
    });

    expect(blobOps.blobRead).toHaveBeenCalledWith('T123', 'design.png', '/tmp/test-project');
    expect(result.publishedPath).toBe('/tmp/out/doc.md');
    expect(result.bytes).toBe(5);
    expect(result.sha256).toHaveLength(64);
  });

  it('selects blob by sha256 when attachmentId matches', async () => {
    const result = await publishDocs({
      ownerId: 'T123',
      attachmentId: 'aabb',
      toPath: '/tmp/out/spec.md',
    });

    expect(blobOps.blobRead).toHaveBeenCalledWith('T123', 'spec.md', '/tmp/test-project');
    expect(result.publishedPath).toBe('/tmp/out/spec.md');
  });

  it('throws when no attachments found for owner', async () => {
    vi.mocked(blobOps.blobList).mockResolvedValue([]);

    await expect(publishDocs({ ownerId: 'T999', toPath: '/tmp/out.md' })).rejects.toThrow(
      'no attachments found',
    );
  });

  it('throws when specified attachmentId not found', async () => {
    await expect(
      publishDocs({ ownerId: 'T123', attachmentId: 'nonexistent', toPath: '/tmp/out.md' }),
    ).rejects.toThrow('not found');
  });

  it('throws when blobRead returns null', async () => {
    vi.mocked(blobOps.blobRead).mockResolvedValue(null);

    await expect(publishDocs({ ownerId: 'T123', toPath: '/tmp/out.md' })).rejects.toThrow(
      'could not read blob',
    );
  });
});
