/**
 * T9704 — git⇄llmtxt round-trip idempotency tests.
 *
 * Verifies that the three commands shipped under T9701/T9702/T9703 satisfy
 * the umbrella acceptance criteria of T9634:
 *
 *   - Running `publish` twice → same file SHA and the destination is byte-
 *     identical (T9634 AC4).
 *   - Running `sync --from` twice on unchanged content → second call returns
 *     `action: 'noop'` and the manifest gains NO new blob version (T9634 AC5).
 *   - Running `status` twice on the same state → identical drift envelope
 *     (envelope-shape determinism, transitively covering T9634 AC6).
 *
 * Implementation note: these tests exercise the core fns directly with an
 * explicit `projectRoot` so vitest discovery does not need to spawn `node
 * dist/cli/index.js`. Calling through the CLI adds zero coverage over the
 * core contract — the CLI is a thin pass-through verified in
 * docs-publish-envelope.test.ts.
 *
 * @epic T9626 (W0)
 * @task T9704 (ST-PUB-2d — idempotency)
 * @saga T9625
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CleoBlobStore,
  listPublications,
  publishDocs,
  recordPublication,
  statusDocs,
  syncFromGit,
} from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ─── Fixtures ────────────────────────────────────────────────────────────────

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'cleo-docs-idemp-'));
  // The blob store writes to `<projectRoot>/.cleo/blobs/`; create the prefix
  // so the adapter's open() can stat the parent.
  await mkdir(join(projectRoot, '.cleo'), { recursive: true });
});

afterEach(async () => {
  // Best-effort cleanup. The OS will reap /tmp eventually either way.
  const { rm } = await import('node:fs/promises');
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {
    /* never fail teardown */
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Attach a single blob under (ownerId, name) and return its sha. */
async function seedBlob(ownerId: string, name: string, content: string): Promise<string> {
  const store = new CleoBlobStore({ projectRoot });
  await store.open();
  try {
    const bytes = new TextEncoder().encode(content);
    const res = await store.attach(ownerId, name, bytes, 'text/markdown');
    return res.sha256;
  } finally {
    await store.close();
  }
}

/** Hash a file on disk for direct verification. */
async function fileSha(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

// ─── T9634 AC4 — publish idempotency ──────────────────────────────────────────

describe('T9704 — publish twice produces same file SHA + same blob sha', () => {
  it('two publishes of the same blob to the same path yield identical file SHA', async () => {
    const ownerId = 'T-publish-idemp';
    const blobName = 'spec.md';
    const content = '# Spec v1\n\nHello T9701.\n';
    const blobSha = await seedBlob(ownerId, blobName, content);

    const dest = 'docs/published/spec.md';

    const first = await publishDocs({
      ownerId,
      toPath: dest,
      projectRoot,
    });
    const second = await publishDocs({
      ownerId,
      toPath: dest,
      projectRoot,
    });

    // Envelope contract: same blob selected, same byte count, same SHA.
    expect(first.sha256).toBe(second.sha256);
    expect(first.blobSha256).toBe(blobSha);
    expect(second.blobSha256).toBe(blobSha);
    expect(first.bytes).toBe(second.bytes);

    // On-disk truth: file SHA matches the envelope SHA and is stable across
    // both publishes (tmp-then-rename is overwrite-in-place atomic).
    const diskSha = await fileSha(first.publishedPath);
    expect(diskSha).toBe(first.sha256);
    expect(diskSha).toBe(second.sha256);
  });
});

// ─── T9634 AC5 — sync --from idempotency ──────────────────────────────────────

describe('T9704 — sync --from twice on unchanged content yields no new blob', () => {
  it('returns noop on the second call when content sha matches', async () => {
    const ownerId = 'T-sync-idemp';

    // Write a git-tracked file under the project root.
    const gitFile = join(projectRoot, 'docs/source/note.md');
    await mkdir(join(projectRoot, 'docs/source'), { recursive: true });
    const content = '# Note\n\nReverse-ingest target.\n';
    await writeFile(gitFile, content, 'utf-8');

    // First sync — creates the blob.
    const first = await syncFromGit({
      ownerId,
      fromPath: 'docs/source/note.md',
      projectRoot,
    });
    expect(first.action).toBe('created');
    expect(first.oldSha).toBeUndefined();
    expect(first.newSha).toMatch(/^[0-9a-f]{64}$/);

    // Second sync against unchanged content — noop.
    const second = await syncFromGit({
      ownerId,
      fromPath: 'docs/source/note.md',
      projectRoot,
    });
    expect(second.action).toBe('noop');
    expect(second.oldSha).toBe(first.newSha);
    expect(second.newSha).toBe(first.newSha);
  });

  it('returns updated when the source file changes between calls', async () => {
    const ownerId = 'T-sync-update';
    const gitFile = join(projectRoot, 'docs/source/changing.md');
    await mkdir(join(projectRoot, 'docs/source'), { recursive: true });

    await writeFile(gitFile, '# v1\n', 'utf-8');
    const first = await syncFromGit({
      ownerId,
      fromPath: 'docs/source/changing.md',
      projectRoot,
    });
    expect(first.action).toBe('created');

    // Mutate the file — second call MUST create a new blob version.
    await writeFile(gitFile, '# v2\n', 'utf-8');
    const second = await syncFromGit({
      ownerId,
      fromPath: 'docs/source/changing.md',
      projectRoot,
    });
    expect(second.action).toBe('updated');
    expect(second.oldSha).toBe(first.newSha);
    expect(second.newSha).not.toBe(first.newSha);
  });
});

// ─── T9634 AC6 — status drift coverage + idempotency ──────────────────────────

describe('T9704 — status twice produces identical envelope output', () => {
  it('two status calls against the same state return byte-identical envelopes', async () => {
    const ownerId = 'T-status-idemp';
    const blobName = 'guide.md';
    await seedBlob(ownerId, blobName, '# Guide\n');

    // Publish + record so the ledger has something to check.
    const published = await publishDocs({
      ownerId,
      toPath: 'docs/guide.md',
      projectRoot,
    });
    await recordPublication({
      ownerId,
      blobName,
      publishedPath: published.relativePath,
      lastBlobSha: published.blobSha256,
      projectRoot,
    });

    const first = await statusDocs({ projectRoot });
    const second = await statusDocs({ projectRoot });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.allInSync).toBe(true);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.drift).toBe('in-sync');
  });

  it('classifies modified + deleted + in-sync across multiple entries', async () => {
    // ── Owner A: published, then file mutated on disk → modified
    const ownerA = 'T-status-modified';
    const blobA = 'a.md';
    await seedBlob(ownerA, blobA, '# A v1\n');
    const pubA = await publishDocs({
      ownerId: ownerA,
      toPath: 'docs/a.md',
      projectRoot,
    });
    await recordPublication({
      ownerId: ownerA,
      blobName: blobA,
      publishedPath: pubA.relativePath,
      lastBlobSha: pubA.blobSha256,
      projectRoot,
    });
    await writeFile(pubA.publishedPath, '# A mutated\n', 'utf-8');

    // ── Owner B: published, then file removed → deleted
    const ownerB = 'T-status-deleted';
    const blobB = 'b.md';
    await seedBlob(ownerB, blobB, '# B v1\n');
    const pubB = await publishDocs({
      ownerId: ownerB,
      toPath: 'docs/b.md',
      projectRoot,
    });
    await recordPublication({
      ownerId: ownerB,
      blobName: blobB,
      publishedPath: pubB.relativePath,
      lastBlobSha: pubB.blobSha256,
      projectRoot,
    });
    const { rm } = await import('node:fs/promises');
    await rm(pubB.publishedPath);

    // ── Owner C: published + untouched → in-sync
    const ownerC = 'T-status-insync';
    const blobC = 'c.md';
    await seedBlob(ownerC, blobC, '# C v1\n');
    const pubC = await publishDocs({
      ownerId: ownerC,
      toPath: 'docs/c.md',
      projectRoot,
    });
    await recordPublication({
      ownerId: ownerC,
      blobName: blobC,
      publishedPath: pubC.relativePath,
      lastBlobSha: pubC.blobSha256,
      projectRoot,
    });

    const status = await statusDocs({ projectRoot });

    expect(status.allInSync).toBe(false);
    expect(status.items).toHaveLength(3);

    const byOwner = new Map(status.items.map((i) => [i.ownerId, i]));
    expect(byOwner.get(ownerA)?.drift).toBe('modified');
    expect(byOwner.get(ownerB)?.drift).toBe('deleted');
    expect(byOwner.get(ownerC)?.drift).toBe('in-sync');

    // Ledger transparency — what status reads must match what was written.
    const ledger = await listPublications({ projectRoot });
    expect(ledger).toHaveLength(3);
  });
});
