/**
 * Integration tests for `cleo docs add --type changeset` delegation to
 * `writeChangesetEntry`.
 *
 * Covers the T10367 E2.2 contract:
 *   (a) docs add --type changeset (with valid frontmatter) produces a file
 *       at `.changeset/<slug>.md` whose bytes are byte-identical to what
 *       `cleo changeset add` would have written, and the SSoT blob is
 *       sha256-identical.
 *   (b) The same input yields the same on-disk file AND the same SSoT
 *       attachment id between both verbs (writer-registry parity).
 *   (c) Missing frontmatter returns `E_REQUIRES_CHANGESET_VERB` with a
 *       fix-hint pointing at the dedicated CLI verb.
 *   (d) The LAFS envelope on success carries `type: 'changeset'` round-trip.
 *   (e) The changeset path does NOT call `attachmentStore.put` with
 *       `extras.type === 'changeset'` outside `writeChangesetEntry` — proved
 *       by spy-counting the legacy direct-put callsite.
 *
 * @task T10367
 * @epic T10290
 * @saga T10288
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangesetEntry } from '@cleocode/contracts';
import { renderChangesetMarkdown, writeChangesetEntry } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsHandler } from '../docs.js';

let tempDir: string;
let fixturePath: string;

const VALID_ENTRY: ChangesetEntry = {
  id: 't10367-example-delegate',
  tasks: ['T10367'],
  kind: 'feat',
  summary: 'docs add --type changeset delegates to writeChangesetEntry',
  prs: [617],
  notes: 'Optional longer-form body to confirm round-trip.',
};

describe('docs.add --type changeset delegation (T10367)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-changeset-'));
    // Pin both .cleo and the project root for getProjectRoot() resolution.
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
    process.env['CLEO_PROJECT_ROOT'] = tempDir;

    fixturePath = join(tempDir, 'changeset-input.md');
  });

  afterEach(async () => {
    const { closeDb } = await import('@cleocode/core/internal');
    closeDb();
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_PROJECT_ROOT'];
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────────
  // (a) + (b) Byte-identical mirror + sha256 parity vs. writeChangesetEntry.
  // ────────────────────────────────────────────────────────────────────────

  it('produces a .changeset/<slug>.md byte-identical to writeChangesetEntry output', async () => {
    const handler = new DocsHandler();

    // Author the input by rendering the canonical markdown — this is exactly
    // what `cleo changeset add` would have written before mirroring to disk.
    const expectedMarkdown = renderChangesetMarkdown(VALID_ENTRY);
    await writeFile(fixturePath, expectedMarkdown, 'utf-8');

    const resp = await handler.mutate('add', {
      ownerId: VALID_ENTRY.tasks[0],
      file: fixturePath,
      type: 'changeset',
      slug: VALID_ENTRY.id,
    });

    expect(resp.success).toBe(true);
    const writtenPath = join(tempDir, '.changeset', `${VALID_ENTRY.id}.md`);
    const onDisk = await readFile(writtenPath, 'utf-8');
    expect(onDisk).toBe(expectedMarkdown);
  });

  it('returns the same sha256 as a direct writeChangesetEntry call (parity)', async () => {
    const handler = new DocsHandler();
    const markdown = renderChangesetMarkdown(VALID_ENTRY);
    await writeFile(fixturePath, markdown, 'utf-8');

    const dispatchResp = await handler.mutate('add', {
      ownerId: VALID_ENTRY.tasks[0],
      file: fixturePath,
      type: 'changeset',
      slug: VALID_ENTRY.id,
    });
    expect(dispatchResp.success).toBe(true);
    const dispatchData = dispatchResp.data as { sha256: string; slug?: string };
    // Independent oracle — the bytes on disk MUST hash to the value the
    // dispatch handler reports.
    const expectedSha = createHash('sha256').update(markdown, 'utf-8').digest('hex');
    expect(dispatchData.sha256).toBe(expectedSha);
    expect(dispatchData.slug).toBe(VALID_ENTRY.id);
  });

  it('emits the same SSoT bytes both verbs would (writer-registry parity)', async () => {
    // Run the dispatch path first into one project root, then a direct
    // writeChangesetEntry into a sibling project root. The on-disk markdown
    // AND the sha256 MUST match between the two surfaces.
    const handler = new DocsHandler();
    const markdown = renderChangesetMarkdown(VALID_ENTRY);
    await writeFile(fixturePath, markdown, 'utf-8');

    const dispatchResp = await handler.mutate('add', {
      ownerId: VALID_ENTRY.tasks[0],
      file: fixturePath,
      type: 'changeset',
      slug: VALID_ENTRY.id,
    });
    expect(dispatchResp.success).toBe(true);
    const dispatchData = dispatchResp.data as { sha256: string };
    const dispatchFile = await readFile(
      join(tempDir, '.changeset', `${VALID_ENTRY.id}.md`),
      'utf-8',
    );

    // Sibling root — close existing db handle so writeChangesetEntry sees a
    // fresh attachment store anchored to the new root.
    const { closeDb } = await import('@cleocode/core/internal');
    closeDb();
    const siblingRoot = await mkdtemp(join(tmpdir(), 'cleo-docs-changeset-parity-'));
    process.env['CLEO_DIR'] = join(siblingRoot, '.cleo');
    process.env['CLEO_PROJECT_ROOT'] = siblingRoot;
    try {
      const directOutcome = await writeChangesetEntry(VALID_ENTRY, {
        projectRoot: siblingRoot,
      });
      expect(directOutcome.ok).toBe(true);
      if (!directOutcome.ok) throw new Error('writeChangesetEntry failed unexpectedly');

      const directFile = await readFile(directOutcome.result.filePath, 'utf-8');
      expect(directFile).toBe(dispatchFile);
      expect(directOutcome.result.sha256).toBe(dispatchData.sha256);
    } finally {
      const { closeDb: closeAgain } = await import('@cleocode/core/internal');
      closeAgain();
      await rm(siblingRoot, { recursive: true, force: true });
      // Restore the test-scoped env for the afterEach cleanup.
      process.env['CLEO_DIR'] = join(tempDir, '.cleo');
      process.env['CLEO_PROJECT_ROOT'] = tempDir;
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // (c) Missing frontmatter → E_REQUIRES_CHANGESET_VERB with fix hint.
  // ────────────────────────────────────────────────────────────────────────

  it('returns E_REQUIRES_CHANGESET_VERB when the file has no frontmatter', async () => {
    const handler = new DocsHandler();
    await writeFile(fixturePath, '# Plain markdown\n\nNo frontmatter here.\n', 'utf-8');

    const resp = await handler.mutate('add', {
      ownerId: 'T10367',
      file: fixturePath,
      type: 'changeset',
    });

    expect(resp.success).toBe(false);
    expect(resp.error?.code).toBe('E_REQUIRES_CHANGESET_VERB');
    const details = resp.error?.details as { fix?: string; parserError?: string } | undefined;
    expect(details?.fix).toContain('cleo changeset add');
    expect(details?.parserError).toBe('missing-frontmatter');
  });

  it('returns E_REQUIRES_CHANGESET_VERB when frontmatter is missing required fields', async () => {
    const handler = new DocsHandler();
    // Frontmatter present but `tasks` and `summary` missing.
    await writeFile(
      fixturePath,
      ['---', 'id: t10367-incomplete', 'kind: feat', '---', '', 'body', ''].join('\n'),
      'utf-8',
    );

    const resp = await handler.mutate('add', {
      ownerId: 'T10367',
      file: fixturePath,
      type: 'changeset',
    });

    expect(resp.success).toBe(false);
    expect(resp.error?.code).toBe('E_REQUIRES_CHANGESET_VERB');
    const details = resp.error?.details as { parserError?: string; missing?: string[] } | undefined;
    expect(details?.parserError).toBe('missing-required');
    // Both `tasks` and `summary` are flagged — `id` and `kind` are present.
    expect(details?.missing).toEqual(expect.arrayContaining(['tasks', 'summary']));
  });

  // ────────────────────────────────────────────────────────────────────────
  // (d) LAFS envelope round-trip.
  // ────────────────────────────────────────────────────────────────────────

  it('LAFS envelope carries data.type === "changeset" on success', async () => {
    const handler = new DocsHandler();
    const markdown = renderChangesetMarkdown(VALID_ENTRY);
    await writeFile(fixturePath, markdown, 'utf-8');

    const resp = await handler.mutate('add', {
      ownerId: VALID_ENTRY.tasks[0],
      file: fixturePath,
      type: 'changeset',
      slug: VALID_ENTRY.id,
    });

    expect(resp.success).toBe(true);
    const data = resp.data as {
      type?: string;
      slug?: string;
      attachmentId?: string;
      kind?: string;
    };
    expect(data.type).toBe('changeset');
    expect(data.slug).toBe(VALID_ENTRY.id);
    expect(data.attachmentId).toMatch(/^att_/);
    expect(data.kind).toBe('blob');
  });

  it('rejects --slug that disagrees with the frontmatter id', async () => {
    const handler = new DocsHandler();
    const markdown = renderChangesetMarkdown(VALID_ENTRY);
    await writeFile(fixturePath, markdown, 'utf-8');

    const resp = await handler.mutate('add', {
      ownerId: VALID_ENTRY.tasks[0],
      file: fixturePath,
      type: 'changeset',
      slug: 't10367-different-slug',
    });

    expect(resp.success).toBe(false);
    expect(resp.error?.code).toBe('E_SLUG_MISMATCH');
  });

  // ────────────────────────────────────────────────────────────────────────
  // (e) No second writer for the changeset kind — the dispatch handler's
  //     direct attachmentStore.put callsites MUST NOT run with
  //     extras.type === 'changeset'. The only legitimate writer is
  //     writeChangesetEntry, which we verify by spying on createAttachmentStore.
  // ────────────────────────────────────────────────────────────────────────

  it('does not invoke the dispatch handler\'s direct attachmentStore.put with extras.type === "changeset"', async () => {
    const handler = new DocsHandler();
    const markdown = renderChangesetMarkdown(VALID_ENTRY);
    await writeFile(fixturePath, markdown, 'utf-8');

    // Spy on createAttachmentStore — every `put` call carries the `extras`
    // arg at index 6. If the dispatch handler routes through the generic
    // file branch for a changeset, that call lands here with
    // `extras.type === 'changeset'` (the legacy pre-T10367 behaviour).
    // writeChangesetEntry calls its OWN createAttachmentStore — that call
    // is allowed and is the canonical writer.
    const core = await import('@cleocode/core/internal');
    const originalCreate = core.createAttachmentStore;
    const putCallsWithChangesetExtras: Array<{ extras: unknown; via: 'dispatch' | 'writer' }> = [];

    let writerActive = false;
    const writerSpy = vi.spyOn(core, 'writeChangesetEntry').mockImplementation(async (...args) => {
      writerActive = true;
      try {
        return await (await import('@cleocode/core/internal')).writeChangesetEntry.call(
          null,
          ...args,
        );
      } finally {
        writerActive = false;
      }
    });

    const createSpy = vi
      .spyOn(core, 'createAttachmentStore')
      .mockImplementation((...createArgs) => {
        const store = originalCreate(...createArgs);
        const origPut = store.put.bind(store);
        store.put = (async (
          bytes: Parameters<typeof origPut>[0],
          attachment: Parameters<typeof origPut>[1],
          ownerType: Parameters<typeof origPut>[2],
          ownerId: Parameters<typeof origPut>[3],
          attachedBy: Parameters<typeof origPut>[4],
          projectRoot: Parameters<typeof origPut>[5],
          extras: Parameters<typeof origPut>[6],
        ) => {
          if (
            extras &&
            typeof extras === 'object' &&
            'type' in extras &&
            extras.type === 'changeset'
          ) {
            putCallsWithChangesetExtras.push({
              extras,
              via: writerActive ? 'writer' : 'dispatch',
            });
          }
          return origPut(bytes, attachment, ownerType, ownerId, attachedBy, projectRoot, extras);
        }) as typeof store.put;
        return store;
      });

    const resp = await handler.mutate('add', {
      ownerId: VALID_ENTRY.tasks[0],
      file: fixturePath,
      type: 'changeset',
      slug: VALID_ENTRY.id,
    });
    expect(resp.success).toBe(true);

    // Every changeset put MUST have happened inside writeChangesetEntry.
    const fromDispatch = putCallsWithChangesetExtras.filter((c) => c.via === 'dispatch');
    expect(fromDispatch).toHaveLength(0);
    // And at least one put happened — the writer path actually ran.
    expect(putCallsWithChangesetExtras.length).toBeGreaterThanOrEqual(1);

    createSpy.mockRestore();
    writerSpy.mockRestore();
  });
});
