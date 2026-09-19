/**
 * Integration test for `cleo docs add --content` inline authoring (T10965).
 *
 * Exercises the inline-content branch of the docs.add dispatch handler
 * end-to-end against a real tasks.db + manifest.db mirror in an isolated
 * temp `CLEO_DIR`. Asserts that an inline body:
 *   - persists as a content-addressed `blob` attachment,
 *   - round-trips byte-for-byte through the canonical DocsReadModel
 *     (so the manifest.db mirror is wired exactly as a file-sourced add),
 *   - rejects multi-source input and missing-source input.
 *
 * @task T10965
 */

import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocsAddResult, DocsFetchResult } from '@cleocode/contracts/operations/docs';
import { createDocsReadModel } from '@cleocode/core/docs/docs-read-model';
import { generateProjectHash } from '@cleocode/core/nexus/hash';
import { worktreeScope } from '@cleocode/core/paths.js';
import { awaitBackgroundOps } from '@cleocode/core/store/background-ops';
import { closeAllDatabases } from '@cleocode/core/store/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsHandler } from '../docs.js';

let tempDir: string;

describe('docs.add --content inline authoring (T10965)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-add-content-'));
    vi.stubEnv('CLEO_ROOT', tempDir);
    vi.stubEnv('CLEO_DIR', join(tempDir, '.cleo'));
    vi.stubEnv('CLEO_BRAIN_BYPASS_WRITER_THREAD', '1');
    await mkdir(join(tempDir, '.cleo'));
    await writeFile(
      join(tempDir, '.cleo/project-info.json'),
      JSON.stringify({
        projectId: 'handler-A',
        projectRoot: tempDir,
      }),
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

  it('persists inline content as a blob and round-trips via the read model', async () => {
    const handler = new DocsHandler();
    const body = '# Inline Doc\n\nAuthored with --content, no file on disk.\n';

    const response = await handler.mutate('add', {
      ownerId: 'T960',
      content: body,
      slug: 'inline-doc',
      attachedBy: 'content-test',
    });

    expect(response.success).toBe(true);
    expect(response.error).toBeUndefined();

    const data = response.data as DocsAddResult;
    expect(data.kind).toBe('blob');
    expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.ownerId).toBe('T960');
    expect(data.slug).toBe('inline-doc');
    expect(data.refCount).toBeGreaterThanOrEqual(1);

    // Round-trip: the canonical read model must resolve the slug AND return
    // the exact bytes — proving the manifest.db mirror is wired like a
    // file-sourced add (not a tasks.db-only orphan).
    const model = createDocsReadModel();
    const decoded = await model.fetchDecoded('inline-doc');
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.content).toBe(body);
      expect(decoded.doc.sha256).toBe(data.sha256);
    }
  });

  it('reads body from a string and reports E_INVALID_INPUT when no source is given', async () => {
    const handler = new DocsHandler();
    const response = await handler.mutate('add', { ownerId: 'T961' });
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_INVALID_INPUT');
  });

  it('rejects combining --content with a file source', async () => {
    const handler = new DocsHandler();
    const response = await handler.mutate('add', {
      ownerId: 'T962',
      content: 'inline',
      file: '/tmp/does-not-need-to-exist.md',
    });
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_INVALID_INPUT');
    expect(response.error?.message).toContain('mutually exclusive');
  });

  it('rejects combining --content with a url source', async () => {
    const handler = new DocsHandler();
    const response = await handler.mutate('add', {
      ownerId: 'T963',
      content: 'inline',
      url: 'https://example.com/spec',
    });
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_INVALID_INPUT');
  });

  it('accepts an empty inline body (valid zero-length doc)', async () => {
    const handler = new DocsHandler();
    const response = await handler.mutate('add', {
      ownerId: 'T964',
      content: '',
      slug: 'empty-doc',
    });
    expect(response.success).toBe(true);
    const data = response.data as DocsAddResult;
    expect(data.kind).toBe('blob');
    expect(data.slug).toBe('empty-doc');
  });

  it.each([
    'contradictory',
    'changed-after-start',
  ] as const)('captures A before asynchronous work when root settings are %s', async (mode) => {
    const other = join(tempDir, 'project-B');
    if (mode === 'contradictory') vi.stubEnv('CLEO_DIR', join(other, '.cleo'));
    const body = 'Captured A: π | "A | B"\n';
    const startedAt = Date.now();
    const pending = new DocsHandler().mutate('add', {
      ownerId: 'T965',
      content: body,
      slug: 'captured-root',
      attachedBy: 'scope-proof',
    });
    const firstAwaitAt = Date.now();
    if (mode === 'changed-after-start') {
      vi.stubEnv('CLEO_ROOT', other);
      vi.stubEnv('CLEO_DIR', join(other, '.cleo'));
    }
    const result = await pending;
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    const data = result.data as DocsAddResult;
    const decoded = await worktreeScope.run(
      { worktreeRoot: tempDir, projectHash: generateProjectHash(tempDir) },
      () => createDocsReadModel(tempDir).fetchDecoded('captured-root'),
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.content).toBe(body);
    expect(data.projection).toMatchObject({
      projectRoot: tempDir,
      projectId: 'handler-A',
      status: 'completed',
      coverage: 'current',
    });
    expect(data.projection!.deadlineAt).toBeGreaterThanOrEqual(startedAt + 2000);
    expect(data.projection!.deadlineAt).toBeLessThanOrEqual(firstAwaitAt + 2000);
    const stored = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1],{readOnly:true}); process.stdout.write(JSON.stringify({jobs:db.prepare('SELECT status,proposal_json,result FROM background_jobs').all(),observations:db.prepare('SELECT project,narrative FROM brain_observations').all()})); db.close();",
          join(tempDir, '.cleo/cleo.db'),
        ],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    expect(stored.jobs).toHaveLength(1);
    expect(stored.jobs[0].status).toBe('complete');
    expect(JSON.parse(stored.jobs[0].proposal_json).identity.projectRoot).toBe(tempDir);
    expect(stored.observations).toHaveLength(1);
    expect(stored.observations[0].project).toBe('handler-A');
    await expect(access(other)).rejects.toThrow();
  });

  it('preserves canonical bytes and reports unavailable projection when identity is missing', async () => {
    await rm(join(tempDir, '.cleo/project-info.json'));
    const body = 'Recoverable canonical bytes\n';
    const result = await new DocsHandler().mutate('add', {
      ownerId: 'T966',
      content: body,
      slug: 'missing-identity',
    });
    expect(result.success).toBe(true);
    const data = result.data as DocsAddResult;
    expect(data.projection).toMatchObject({
      status: 'failed',
      coverage: 'missing',
      projectId: null,
    });
    expect(data.projection!.diagnostics.join(' ')).toContain('projectId');
    const decoded = await createDocsReadModel(tempDir).fetchDecoded('missing-identity');
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.content).toBe(body);
  });

  it('returns explicit pending after the original deadline and refuses a late graph opener after cleanup', async () => {
    const graph = await import('@cleocode/core/memory/graph-auto-populate');
    const original = graph.ensureLlmtxtNodeScoped;
    let release = () => {};
    let enter = () => {};
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      enter = resolve;
    });
    vi.spyOn(graph, 'ensureLlmtxtNodeScoped').mockImplementation(async (...args) => {
      enter();
      await pause;
      return original(...args);
    });
    const startedAt = Date.now();
    const pending = new DocsHandler().mutate('add', {
      ownerId: 'T967',
      content: 'Accepted before pending\n',
      slug: 'late-projection',
    });
    const firstAwaitAt = Date.now();
    try {
      await ready;
      const result = await pending;
      expect(result.success).toBe(true);
      const data = result.data as DocsAddResult;
      expect(data.projection).toMatchObject({
        status: 'pending',
        coverage: 'partial',
        deadlineExceeded: true,
      });
      expect(data.projection!.jobId).toBeTruthy();
      expect(data.projection!.deadlineAt).toBeGreaterThanOrEqual(startedAt + 2000);
      expect(data.projection!.deadlineAt).toBeLessThanOrEqual(firstAwaitAt + 2000);
      const decoded = await createDocsReadModel(tempDir).fetchDecoded('late-projection');
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.content).toBe('Accepted before pending\n');
      await closeAllDatabases();
      await rm(join(tempDir, '.cleo'), { recursive: true });
      release();
      await awaitBackgroundOps();
      await expect(access(join(tempDir, '.cleo'))).rejects.toThrow();
    } finally {
      release();
      await pending;
    }
  });

  it('keeps update, supersede, and fetch in their captured project across contradictory settings and awaits', async () => {
    const handler = new DocsHandler();
    for (const slug of ['operation-old', 'operation-new']) {
      const added = await handler.mutate('add', {
        ownerId: 'T968',
        slug,
        content: `${slug} initial\n`,
      });
      expect(added.success).toBe(true);
    }
    const other = join(tempDir, 'project-B');
    vi.stubEnv('CLEO_DIR', join(other, '.cleo'));
    const update = handler.mutate('update', { slug: 'operation-new', content: 'Updated A π\n' });
    vi.stubEnv('CLEO_ROOT', other);
    expect(await update).toMatchObject({ success: true });
    vi.stubEnv('CLEO_ROOT', tempDir);
    const supersede = handler.mutate('supersede', {
      oldSlug: 'operation-old',
      newSlug: 'operation-new',
    });
    vi.stubEnv('CLEO_ROOT', other);
    expect(await supersede).toMatchObject({ success: true });
    vi.stubEnv('CLEO_ROOT', tempDir);
    const query = handler.query('fetch', { attachmentRef: 'operation-new' });
    vi.stubEnv('CLEO_ROOT', other);
    const fetched = await query;
    expect(fetched.success).toBe(true);
    const data = fetched.data as DocsFetchResult;
    expect(Buffer.from(data.bytesBase64!, 'base64').toString('utf8')).toBe('Updated A π\n');
    await expect(access(other)).rejects.toThrow();
  });
});
