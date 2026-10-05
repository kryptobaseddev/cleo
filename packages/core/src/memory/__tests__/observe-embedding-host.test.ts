/**
 * T13126 — only a long-lived host embeds an observation as it is stored.
 *
 * Loading the local embedding model costs ~280 MB, and a one-shot
 * `cleo memory observe` paid it on every call for a single vector. A one-shot
 * process now stores the row unembedded (the background backfill fills it); a
 * declared long-lived host still embeds inline. The embedding module is
 * replaced by counters, so the test observes whether the model path was taken,
 * not whether a model exists on this machine.
 *
 * @task T13126
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ ensure: 0, embed: 0 }));

vi.mock('../brain-embedding.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../brain-embedding.js')>()),
  ensureEmbeddingProvider: async () => {
    calls.ensure += 1;
    return false;
  },
  embedText: async () => {
    calls.embed += 1;
    return null;
  },
}));

let tempDir: string;

beforeEach(async () => {
  calls.ensure = 0;
  calls.embed = 0;
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-observe-host-'));
  await mkdir(join(tempDir, '.cleo'), { recursive: true });
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  const { getDb } = await import('../../store/sqlite.js');
  await getDb(tempDir);
});

afterEach(async () => {
  const { shutdownBrainWriter, _resetBrainWriterForTests } = await import(
    '../brain-writer-thread.js'
  );
  await shutdownBrainWriter();
  _resetBrainWriterForTests();
  const { closeBrainDb } = await import('../../store/memory-sqlite.js');
  closeBrainDb();
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
  delete process.env['CLEO_DIR'];
  delete process.env['CLEO_BRAIN_WRITER_THREAD'];
  await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});

/** Let the observe path's setImmediate side effects run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

async function observe(title: string) {
  const { observeBrain } = await import('../retrieval/observe.js');
  return observeBrain(tempDir, {
    text: `Observation ${title} about the embedding host decision and its memory cost`,
    title,
    sourceType: 'manual',
  });
}

describe('observeBrain embedding by host kind (T13126)', () => {
  it('a one-shot process stores the observation without touching the model', async () => {
    const { isLongLivedBrainHost } = await import('../brain-host.js');
    expect(isLongLivedBrainHost()).toBe(false);
    const result = await observe('one-shot');
    await settle();
    expect(result.id).toMatch(/^O-/);
    expect(calls.ensure).toBe(0);
    expect(calls.embed).toBe(0);
  });

  it('a declared long-lived host embeds the new observation', async () => {
    const { useBrainWriterThread } = await import('../brain-writer-thread.js');
    useBrainWriterThread();
    const result = await observe('host');
    await settle();
    expect(result.id).toMatch(/^O-/);
    expect(calls.ensure).toBe(1);
  });
});
