/**
 * `docs add` owner-type inference for bare D#### decision IDs — T13358.
 *
 * `inferOwnerType` matched `D-`/`dec_` prefixes, but real brain decision
 * IDs are bare `D####` (e.g. `D11164`), so decision-owned docs silently
 * fell through to `ownerType: 'task'` — the mechanism behind "none of the
 * ~360 decisions are linked to a doc" in the CleoDocs re-arch audit.
 *
 * Exercises `docs add` end-to-end against an isolated temp `CLEO_DIR`
 * (same harness as docs-add-content.test.ts) and asserts the attachment
 * ref is registered under `decision`, reachable from both directions.
 *
 * @task T13358 (Epic T13340 / Saga T13339)
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentStore } from '@cleocode/core/store/attachment-store';
import { awaitBackgroundOps } from '@cleocode/core/store/background-ops';
import { closeAllDatabases } from '@cleocode/core/store/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsHandler } from '../docs.js';

let tempDir: string;

describe('docs.add owner-type inference for D#### ids (T13358)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-ownertype-'));
    vi.stubEnv('CLEO_ROOT', tempDir);
    vi.stubEnv('CLEO_DIR', join(tempDir, '.cleo'));
    vi.stubEnv('CLEO_BRAIN_BYPASS_WRITER_THREAD', '1');
    await mkdir(join(tempDir, '.cleo'));
    await writeFile(
      join(tempDir, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'handler-decision', projectRoot: tempDir }),
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

  it('registers a doc added with ownerId D11164 under ownerType decision', async () => {
    const handler = new DocsHandler();
    const added = await handler.mutate('add', {
      ownerId: 'D11164',
      content: '# ADR candidate\n\nBody.\n',
      slug: 'adr-064-decision-linkage',
      type: 'adr',
    });
    expect(added.success, JSON.stringify(added)).toBe(true);

    // Reachable from the decision side…
    const store = createAttachmentStore();
    const metas = await store.listByOwner('decision', 'D11164', tempDir);
    expect(metas.length).toBe(1);

    // …and NOT misfiled under a task with the same id string.
    const misfiled = await store.listByOwner('task', 'D11164', tempDir);
    expect(misfiled.length).toBe(0);
  });

  it('keeps the existing prefixes working (D-, dec_, T####)', async () => {
    const handler = new DocsHandler();
    const dash = await handler.mutate('add', {
      ownerId: 'D-42',
      content: 'x\n',
      slug: 't13358-d-dash',
    });
    expect(dash.success, JSON.stringify(dash)).toBe(true);
    const task = await handler.mutate('add', {
      ownerId: 'T200',
      content: 'x\n',
      slug: 't13358-t-task',
    });
    expect(task.success, JSON.stringify(task)).toBe(true);

    const store = createAttachmentStore();
    expect((await store.listByOwner('decision', 'D-42', tempDir)).length).toBe(1);
    expect((await store.listByOwner('task', 'T200', tempDir)).length).toBe(1);
  });
});
