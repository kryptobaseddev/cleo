/**
 * T13251 — only the brain writer isolate re-points `CLEO_DIR` to each op's
 * project. A worker thread that is not the writer (embedding-queue,
 * background-review) can run `handleWriteOp` through the inline fallback; with
 * `!isMainThread` as the gate it kept `CLEO_DIR` pinned to the last op's
 * project for the rest of its life. Here every isolate reports itself a
 * worker thread, and the embed op fails right after the re-point (no brain
 * handle), so only the env side effect is observed.
 *
 * @task T13251
 */

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return { ...actual, isMainThread: false };
});

vi.mock('../../store/memory-sqlite.js', () => ({
  getBrainDb: vi.fn().mockResolvedValue(undefined),
  getBrainNativeDb: vi.fn().mockReturnValue(null),
}));

const OWN = join('/tmp', 'own-project', '.cleo');
const OTHER = join('/tmp', 'other-project');

beforeEach(() => {
  vi.stubEnv('CLEO_DIR', OWN);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const { _resetLongLivedBrainHostForTests } = await import('../brain-host.js');
  _resetLongLivedBrainHostForTests();
});

async function runEmbed(): Promise<void> {
  const { handleWriteOp } = await import('../brain-writer-handlers.js');
  await expect(handleWriteOp({ kind: 'embed', projectRoot: OTHER, rows: [] })).rejects.toThrow(
    /brain native DB unavailable/,
  );
}

describe('syncWorkerCleoDir gates on the writer isolate (T13251)', () => {
  it('a worker thread that is not the writer keeps its own CLEO_DIR', async () => {
    await runEmbed();
    expect(process.env['CLEO_DIR']).toBe(OWN);
  });

  it("the writer isolate adopts the op's project", async () => {
    const { markBrainWriterIsolate } = await import('../brain-host.js');
    markBrainWriterIsolate();
    await runEmbed();
    expect(process.env['CLEO_DIR']).toBe(join(OTHER, '.cleo'));
  });
});
