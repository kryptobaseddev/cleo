/**
 * Integration test for `cleo docs` dispatch flow (T947 Wave B).
 *
 * Exercises the add/list handlers end-to-end against a real tasks.db +
 * real filesystem. A temp project dir replaces `CLEO_DIR` so the
 * tests don't touch the user's actual DB. Each test cleans up its
 * DB singleton via `closeDb()` to avoid cross-test interference.
 *
 * Gate: `meta.attachmentBackend` is populated on every response — this
 * is the observability signal that confirms Wave B wiring is live.
 *
 * @epic T947
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocsHandler } from '../docs.js';

let tempDir: string;
let fixtureFile: string;

describe('docs dispatch integration (T947)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-integration-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');

    // Write a small fixture the dispatch handler can ingest.
    fixtureFile = join(tempDir, 'fixture.md');
    await writeFile(fixtureFile, '# fixture\n\nintegration-test attachment', 'utf-8');
  });

  afterEach(async () => {
    const { closeDb } = await import('@cleocode/core/internal');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('docs.add persists the file and returns sha256 + backend metadata', async () => {
    const handler = new DocsHandler();

    const response = await handler.mutate('add', {
      ownerId: 'T900',
      file: fixtureFile,
      attachedBy: 'integration-test',
    });

    expect(response.success).toBe(true);
    expect(response.error).toBeUndefined();

    const data = response.data as {
      attachmentId: string;
      sha256: string;
      refCount: number;
      kind: string;
      ownerId: string;
      ownerType: string;
    };
    expect(data.attachmentId).toBeTruthy();
    expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.kind).toBe('local-file');
    expect(data.ownerType).toBe('task');
    expect(data.ownerId).toBe('T900');
    expect(data.refCount).toBeGreaterThanOrEqual(1);

    // Wave B observability — every mutating docs call reports which
    // backend persisted the bytes.
    expect(['llmtxt', 'legacy']).toContain(response.meta['attachmentBackend']);
  });

  it('docs.list returns the attachment registered via docs.add', async () => {
    const handler = new DocsHandler();

    const addResp = await handler.mutate('add', {
      ownerId: 'T901',
      file: fixtureFile,
      desc: 'integration fixture',
      labels: 'integration,smoke',
      attachedBy: 'integration-test',
    });
    expect(addResp.success).toBe(true);
    const addData = addResp.data as { attachmentId: string; sha256: string };

    const listResp = await handler.query('list', { task: 'T901' });
    expect(listResp.success).toBe(true);

    const list = listResp.data as {
      ownerId: string;
      ownerType: string;
      count: number;
      attachments: Array<{
        id: string;
        sha256: string;
        kind: string;
        description?: string;
        labels?: string[];
      }>;
    };

    expect(list.ownerId).toBe('T901');
    expect(list.ownerType).toBe('task');
    expect(list.count).toBe(1);
    expect(list.attachments).toHaveLength(1);

    const entry = list.attachments[0];
    expect(entry).toBeDefined();
    expect(entry?.id).toBe(addData.attachmentId);
    expect(entry?.kind).toBe('local-file');
    expect(entry?.description).toBe('integration fixture');
    expect(entry?.labels).toEqual(['integration', 'smoke']);
    // Truncated sha256 ("<first-8>…") in list responses
    expect(entry?.sha256.startsWith(addData.sha256.slice(0, 8))).toBe(true);

    // Backend observability on read path too.
    expect(['llmtxt', 'legacy']).toContain(listResp.meta['attachmentBackend']);
  });
});
