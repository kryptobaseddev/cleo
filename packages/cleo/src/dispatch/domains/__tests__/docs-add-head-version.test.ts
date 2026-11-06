/**
 * `docs add` records the doc's identity, first version and head (T14329).
 *
 * Before T14329 a doc had no conduit identity until its first update, so
 * `docs fetch` carried no `metadata.headVersionUid` and the expected-base
 * fence (`docs update --base-version-uid`) was unavailable. Every add branch
 * with a slug (inline content, a text file, a binary file, a URL) now returns
 * `headVersionUid`, fetch shows the same uid, and an update declaring it as
 * its base lands.
 *
 * @task T14329
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocsAddResult, DocsFetchResult } from '@cleocode/contracts/operations/docs';
import { awaitBackgroundOps } from '@cleocode/core/store/background-ops';
import { closeAllDatabases } from '@cleocode/core/store/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsHandler } from '../docs.js';

let tempDir: string;

/** Add through the dispatch handler and return the result envelope's data. */
async function add(params: Record<string, unknown>): Promise<DocsAddResult> {
  const response = await new DocsHandler().mutate('add', {
    ownerId: 'T14329',
    attachedBy: 'head-test',
    ...params,
  });
  expect(response.error).toBeUndefined();
  expect(response.success).toBe(true);
  return response.data as DocsAddResult;
}

/** The fetched doc's head version uid. */
async function fetchedHead(slug: string): Promise<string | undefined> {
  const response = await new DocsHandler().query('fetch', { attachmentRef: slug });
  expect(response.success).toBe(true);
  return (response.data as DocsFetchResult).metadata.headVersionUid;
}

describe('docs.add records a head version for every doc it adds (T14329)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-add-head-'));
    vi.stubEnv('CLEO_ROOT', tempDir);
    vi.stubEnv('CLEO_DIR', join(tempDir, '.cleo'));
    vi.stubEnv('CLEO_BRAIN_BYPASS_WRITER_THREAD', '1');
    await mkdir(join(tempDir, '.cleo'));
    await writeFile(
      join(tempDir, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'head-test', projectRoot: tempDir }),
    );
  });

  afterEach(async () => {
    await awaitBackgroundOps();
    const { shutdownBrainWriter, _resetBrainWriterForTests } = await import(
      '@cleocode/core/memory/brain-writer-thread'
    );
    await shutdownBrainWriter();
    _resetBrainWriterForTests();
    await closeAllDatabases();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('inline content: add returns the head, fetch shows it, and an update on that base lands', async () => {
    const body = '# Research note\n\nFirst findings.\n';
    const added = await add({ content: body, slug: 'inline-research-note' });
    expect(added.headVersionUid).toMatch(/^[0-9a-f-]{36}$/);
    expect(await fetchedHead('inline-research-note')).toBe(added.headVersionUid);

    const updated = await new DocsHandler().mutate('update', {
      slug: 'inline-research-note',
      content: `${body}\n## More\n\nSecond pass.\n`,
      baseVersionUid: added.headVersionUid,
    });
    expect(updated.error).toBeUndefined();
    expect(updated.success).toBe(true);
    const nextHead = await fetchedHead('inline-research-note');
    expect(nextHead).toBeDefined();
    expect(nextHead).not.toBe(added.headVersionUid);
  });

  it('a text file, a binary file and a URL each get a head', async () => {
    const textPath = join(tempDir, 'spec.md');
    await writeFile(textPath, '# Spec\n\nBody.\n');
    const binaryPath = join(tempDir, 'diagram.png');
    await writeFile(binaryPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0x00]));

    const text = await add({ file: textPath, slug: 'text-file-spec' });
    const binary = await add({ file: binaryPath, slug: 'binary-file-diagram' });
    const url = await add({ url: 'https://example.com/t14329', slug: 'external-reference' });

    for (const [slug, result] of [
      ['text-file-spec', text],
      ['binary-file-diagram', binary],
      ['external-reference', url],
    ] as const) {
      expect(result.headVersionUid, slug).toBeDefined();
      expect(await fetchedHead(slug), slug).toBe(result.headVersionUid);
    }
  });

  it('a slug-less attachment carries no head (it is not addressable as a doc)', async () => {
    const added = await add({ content: '# Untitled scratch\n\nno slug\n' });
    expect(added.headVersionUid).toBeUndefined();
  });
});
