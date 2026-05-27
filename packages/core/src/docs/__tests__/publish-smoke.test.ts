/**
 * End-to-end smoke test for publish verb consolidation (T11190/T10516-K1).
 *
 * Covers:
 *   AC1 — publish, dry-run, and rollback flows
 *   AC2 — all doc types through consolidated publish path
 *   AC3 — audit trail entry for each publish operation
 *
 * AC4-AC5 (CLI surface tests) live in:
 *   packages/cleo/src/cli/commands/__tests__/docs-publish-smoke.test.ts
 *
 * @task T11190
 * @saga T10516 (SG-DOCS-CLI-SIMPLIFICATION)
 * @epic T10521 (T10516-E: Docs dogfood regression harness)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Module mocks (hoisted) ──────────────────────────────────────────────────

vi.mock('../../store/blob-ops.js', () => ({
  blobList: vi.fn(),
  blobRead: vi.fn(),
}));

vi.mock('../../paths.js', () => ({
  getProjectRoot: vi.fn(() => '/tmp/test-project'),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import * as blobOps from '../../store/blob-ops.js';

import {
  publishDocs,
  recordPublication,
  readPublicationsLedger,
  listPublications,
} from '../docs-ops.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

function newProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'publish-smoke-test-'));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  return root;
}

function blob(name: string, sha: string, uploadedAt = 1000, sizeBytes = 100) {
  return { name, sha256: sha, sizeBytes, mimeType: 'text/markdown', uploadedAt };
}

// ─── AC1: publishDocs — publish, explicit attachment (rollback), and dry-run ──

describe('AC1: publishDocs — publish, explicit attachment (rollback), and dry-run', () => {
  beforeEach(() => {
    vi.mocked(blobOps.blobList).mockResolvedValue([]);
    vi.mocked(blobOps.blobRead).mockResolvedValue(new Uint8Array([]));
  });

  it('publishes the most-recently-uploaded blob by default (publish flow)', async () => {
    const blobs = [
      blob('v1.md', 'sha-old', 1000),
      blob('v2.md', 'sha-new', 5000),
      blob('v3.md', 'sha-mid', 2000),
    ];
    vi.mocked(blobOps.blobList).mockResolvedValue(blobs);
    vi.mocked(blobOps.blobRead).mockResolvedValue(new Uint8Array([97, 98, 99]));

    const result = await publishDocs({
      ownerId: 'T123',
      toPath: join(tmpdir(), 'out', 'doc.md'),
      allowOutsideRoot: true,
    });

    expect(result.blobSha256).toBe('sha-new');
    expect(result.blobName).toBe('v2.md');
    expect(result.bytes).toBe(3);
    expect(result.ownerId).toBe('T123');
    expect(result.sha256).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('rollback: publishes an explicit historical version via attachmentId', async () => {
    const blobs = [
      blob('spec.md', 'sha-v1', 1000),
      blob('spec.md', 'sha-v2', 2000),
      blob('spec.md', 'sha-v3', 3000),
    ];
    vi.mocked(blobOps.blobList).mockResolvedValue(blobs);
    vi.mocked(blobOps.blobRead).mockResolvedValue(new Uint8Array([120]));

    const result = await publishDocs({
      ownerId: 'T123',
      attachmentId: 'sha-v1',
      toPath: join(tmpdir(), 'out', 'rollback.md'),
      allowOutsideRoot: true,
    });

    expect(result.blobSha256).toBe('sha-v1');
    expect(result.blobName).toBe('spec.md');
  });

  it('rollback: explicit attachmentId overrides latest', async () => {
    const blobs = [
      blob('doc.md', 'ancient', 1),
      blob('doc.md', 'latest', 999999),
    ];
    vi.mocked(blobOps.blobList).mockResolvedValue(blobs);
    vi.mocked(blobOps.blobRead).mockResolvedValue(new Uint8Array([1]));

    const result = await publishDocs({
      ownerId: 'T456',
      attachmentId: 'ancient',
      toPath: join(tmpdir(), 'out', 'ancient.md'),
      allowOutsideRoot: true,
    });

    expect(result.blobSha256).toBe('ancient');
  });

  it('dry-run: throws when no attachments exist for the owner', async () => {
    vi.mocked(blobOps.blobList).mockResolvedValue([]);

    await expect(
      publishDocs({ ownerId: 'T_NONE', toPath: join(tmpdir(), 'x.md'), allowOutsideRoot: true }),
    ).rejects.toThrow('no attachments found');
  });

  it('dry-run: throws when explicit attachmentId is not found', async () => {
    vi.mocked(blobOps.blobList).mockResolvedValue([blob('only.md', 'sha-only', 1000)]);

    await expect(
      publishDocs({
        ownerId: 'T123',
        attachmentId: 'sha-missing',
        toPath: join(tmpdir(), 'x.md'),
        allowOutsideRoot: true,
      }),
    ).rejects.toThrow('not found');
  });

  it('refuses to write outside projectRoot when allowOutsideRoot is not set', async () => {
    vi.mocked(blobOps.blobList).mockResolvedValue([blob('a.md', 'sha', 1000)]);

    await expect(
      publishDocs({ ownerId: 'T1', toPath: '/etc/passwd' }),
    ).rejects.toThrow('refusing to write outside projectRoot');
  });
});

// ─── AC2: all doc types through consolidated publish path ─────────────────────

describe('AC2: all doc types through consolidated publish path', () => {
  const docTypes = ['spec', 'adr', 'research', 'handoff', 'note', 'llm-readme', 'plan', 'release-note'];

  beforeEach(() => {
    vi.mocked(blobOps.blobRead).mockResolvedValue(new Uint8Array([100, 101, 102]));
  });

  for (const kind of docTypes) {
    it(`publishes doc type '${kind}' through the consolidated path`, async () => {
      const blobs = [blob(`${kind}.md`, `sha-${kind}`, 5000, 200)];
      vi.mocked(blobOps.blobList).mockResolvedValue(blobs);

      const result = await publishDocs({
        ownerId: 'T100',
        toPath: join(tmpdir(), 'out', `docs/${kind}/test.md`),
        allowOutsideRoot: true,
      });

      expect(result.blobSha256).toBe(`sha-${kind}`);
      expect(result.blobName).toBe(`${kind}.md`);
      expect(result.bytes).toBe(3);
    });
  }

  it('handles a mix of doc types from the same owner', async () => {
    const blobs = [
      blob('adr-001.md', 'sha-adr', 5000),
      blob('spec-design.md', 'sha-spec', 4000),
      blob('research-findings.md', 'sha-research', 3000),
    ];
    vi.mocked(blobOps.blobList).mockResolvedValue(blobs);

    const result = await publishDocs({
      ownerId: 'T_MIXED',
      toPath: join(tmpdir(), 'out', 'mixed.md'),
      allowOutsideRoot: true,
    });

    expect(result.blobSha256).toBe('sha-adr');
    expect(result.blobName).toBe('adr-001.md');
  });
});

// ─── AC3: audit trail — publications ledger ───────────────────────────────────

describe('AC3: audit trail — publications ledger', () => {
  let root: string;

  beforeEach(() => {
    root = newProjectRoot();
    vi.mocked(blobOps.blobRead).mockResolvedValue(new Uint8Array([97]));
    vi.mocked(blobOps.blobList).mockResolvedValue([blob('doc.md', 'sha-audit', 1000)]);
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('recordPublication creates an audit trail entry in the ledger', async () => {
    await recordPublication({
      ownerId: 'T_AUDIT',
      blobName: 'doc.md',
      publishedPath: 'docs/adr/test.md',
      lastBlobSha: 'sha-audit',
      projectRoot: root,
    });

    const entries = await readPublicationsLedger(root);
    expect(entries).toHaveLength(1);
    expect(entries[0].ownerId).toBe('T_AUDIT');
    expect(entries[0].blobName).toBe('doc.md');
    expect(entries[0].publishedPath).toBe('docs/adr/test.md');
    expect(entries[0].lastBlobSha).toBe('sha-audit');
    expect(entries[0].publishedAt).toBeTruthy();
    expect(() => new Date(entries[0].publishedAt)).not.toThrow();
  });

  it('recordPublication upserts on (ownerId, blobName, publishedPath)', async () => {
    await recordPublication({
      ownerId: 'T_UPSERT', blobName: 'spec.md',
      publishedPath: 'docs/spec/api.md', lastBlobSha: 'sha-v1', projectRoot: root,
    });
    await recordPublication({
      ownerId: 'T_UPSERT', blobName: 'spec.md',
      publishedPath: 'docs/spec/api.md', lastBlobSha: 'sha-v2', projectRoot: root,
    });

    const entries = await readPublicationsLedger(root);
    expect(entries).toHaveLength(1);
    expect(entries[0].lastBlobSha).toBe('sha-v2');
  });

  it('recordPublication adds distinct entries for different paths', async () => {
    await recordPublication({
      ownerId: 'T_MULTI', blobName: 'doc.md',
      publishedPath: 'docs/adr/001.md', lastBlobSha: 'sha-1', projectRoot: root,
    });
    await recordPublication({
      ownerId: 'T_MULTI', blobName: 'doc.md',
      publishedPath: 'docs/spec/design.md', lastBlobSha: 'sha-2', projectRoot: root,
    });

    const entries = await readPublicationsLedger(root);
    expect(entries).toHaveLength(2);
    const paths = entries.map((e) => e.publishedPath).sort();
    expect(paths).toEqual(['docs/adr/001.md', 'docs/spec/design.md']);
  });

  it('listPublications returns all entries', async () => {
    await recordPublication({ ownerId: 'T_A', blobName: 'a.md', publishedPath: 'docs/a.md', lastBlobSha: 'sha-a', projectRoot: root });
    await recordPublication({ ownerId: 'T_B', blobName: 'b.md', publishedPath: 'docs/b.md', lastBlobSha: 'sha-b', projectRoot: root });
    await recordPublication({ ownerId: 'T_C', blobName: 'c.md', publishedPath: 'docs/c.md', lastBlobSha: 'sha-c', projectRoot: root });

    expect(await listPublications({ projectRoot: root })).toHaveLength(3);
  });

  it('readPublicationsLedger returns empty array for missing ledger', async () => {
    expect(await readPublicationsLedger(join(root, 'nonexistent'))).toEqual([]);
  });

  it('readPublicationsLedger returns empty array for corrupt JSON', async () => {
    writeFileSync(join(root, '.cleo', 'docs-publications.json'), 'not json {{{', 'utf-8');
    expect(await readPublicationsLedger(root)).toEqual([]);
  });
});

// ─── Integration: full publish lifecycle smoke ────────────────────────────────

describe('Integration: full publish lifecycle smoke', () => {
  let root: string;

  beforeEach(() => {
    root = newProjectRoot();
    vi.mocked(blobOps.blobRead).mockResolvedValue(new Uint8Array([99, 108, 101, 111])); // "cleo"
    vi.mocked(blobOps.blobList).mockResolvedValue([blob('smoke.md', 'sha-smoke', 9999, 256)]);
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('full smoke: publish + audit trail + re-read', async () => {
    const result = await publishDocs({
      ownerId: 'T_SMOKE',
      toPath: join(root, 'docs', 'adr', 'smoke-test.md'),
      projectRoot: root,
    });

    expect(result.blobSha256).toBe('sha-smoke');
    expect(result.relativePath).toBe('docs/adr/smoke-test.md');
    expect(result.sha256).toBe(createHash('sha256').update('cleo').digest('hex'));

    await recordPublication({
      ownerId: result.ownerId,
      blobName: result.blobName,
      publishedPath: result.relativePath,
      lastBlobSha: result.blobSha256,
      projectRoot: root,
    });

    const entries = await listPublications({ projectRoot: root });
    expect(entries).toHaveLength(1);
    expect(entries[0].publishedPath).toBe('docs/adr/smoke-test.md');

    // Publish again with updated blob
    vi.mocked(blobOps.blobList).mockResolvedValue([blob('smoke.md', 'sha-v2', 99999, 512)]);
    vi.mocked(blobOps.blobRead).mockResolvedValue(new Uint8Array([118, 50]));

    const result2 = await publishDocs({
      ownerId: 'T_SMOKE',
      toPath: join(root, 'docs', 'adr', 'smoke-test.md'),
      projectRoot: root,
    });

    expect(result2.blobSha256).toBe('sha-v2');

    await recordPublication({
      ownerId: result2.ownerId,
      blobName: result2.blobName,
      publishedPath: result2.relativePath,
      lastBlobSha: result2.blobSha256,
      projectRoot: root,
    });

    const entriesAfter = await listPublications({ projectRoot: root });
    expect(entriesAfter).toHaveLength(1);
    expect(entriesAfter[0].lastBlobSha).toBe('sha-v2');
  });

  it('full smoke: multiple doc types in one lifecycle', async () => {
    const docs = [
      { kind: 'adr', name: 'adr-099.md', sha: 'sha-adr', uploadedAt: 10000 },
      { kind: 'spec', name: 'api-spec.md', sha: 'sha-spec', uploadedAt: 9000 },
      { kind: 'research', name: 'findings.md', sha: 'sha-research', uploadedAt: 8000 },
    ];

    for (const doc of docs) {
      vi.mocked(blobOps.blobList).mockResolvedValue([blob(doc.name, doc.sha, doc.uploadedAt)]);
      vi.mocked(blobOps.blobRead).mockResolvedValue(
        new Uint8Array(Buffer.from(`content-${doc.kind}`)),
      );

      const result = await publishDocs({
        ownerId: `T_${doc.kind.toUpperCase()}`,
        toPath: join(root, 'docs', doc.kind, doc.name),
        projectRoot: root,
      });

      await recordPublication({
        ownerId: result.ownerId,
        blobName: result.blobName,
        publishedPath: result.relativePath,
        lastBlobSha: result.blobSha256,
        projectRoot: root,
      });
    }

    const entries = await listPublications({ projectRoot: root });
    expect(entries).toHaveLength(3);

    const owners = entries.map((e) => e.ownerId).sort();
    expect(owners).toEqual(['T_ADR', 'T_RESEARCH', 'T_SPEC']);

    const paths = entries.map((e) => e.publishedPath).sort();
    expect(paths).toEqual([
      'docs/adr/adr-099.md',
      'docs/research/findings.md',
      'docs/spec/api-spec.md',
    ]);
  });
});
