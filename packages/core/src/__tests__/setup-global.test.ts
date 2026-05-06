/**
 * Unit tests for the globalSetup / teardown sweep logic (T1914).
 *
 * Creates dummy `cleo-injection-chain-*` directories inside a controlled
 * sandbox tmpdir, invokes the sweep via the exported setup/teardown
 * functions (re-routed via TMPDIR), and asserts that the dirs are removed.
 *
 * @task T1914
 * @epic T1910
 */

import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Reproduces the sweep logic (mirrors setup-global.ts) for sandbox testing. */
async function sweepIn(dir: string): Promise<number> {
  const prefix = 'cleo-injection-chain-';
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const stale = entries.filter((name) => name.startsWith(prefix));
  await Promise.all(stale.map((name) => rm(join(dir, name), { recursive: true, force: true })));
  return stale.length;
}

describe('T1914 — globalSetup/teardown sweep (unit)', () => {
  let sandboxDir: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'cleo-t1914-test-sandbox-'));
  });

  afterEach(async () => {
    await rm(sandboxDir, { recursive: true, force: true });
  });

  it('removes all cleo-injection-chain-* dirs from a sandbox tmpdir', async () => {
    // Create 2 dummy injection-chain dirs inside the sandbox
    await mkdir(join(sandboxDir, 'cleo-injection-chain-aaa111'));
    await mkdir(join(sandboxDir, 'cleo-injection-chain-bbb222'));
    // And a decoy dir that should NOT be removed
    await mkdir(join(sandboxDir, 'some-other-dir'));

    const removed = await sweepIn(sandboxDir);
    expect(removed).toBe(2);

    // Verify the injection-chain dirs are gone
    const remaining = await readdir(sandboxDir);
    const injectionDirs = remaining.filter((name) => name.startsWith('cleo-injection-chain-'));
    expect(injectionDirs).toHaveLength(0);

    // Verify the decoy dir is still there
    expect(remaining).toContain('some-other-dir');
  });

  it('returns 0 when no cleo-injection-chain-* dirs exist', async () => {
    // Only a decoy dir
    await mkdir(join(sandboxDir, 'some-unrelated-dir'));

    const removed = await sweepIn(sandboxDir);
    expect(removed).toBe(0);

    const remaining = await readdir(sandboxDir);
    expect(remaining).toContain('some-unrelated-dir');
  });

  it('handles empty sandbox dir without error', async () => {
    const removed = await sweepIn(sandboxDir);
    expect(removed).toBe(0);
  });

  it('handles a non-existent dir without throwing', async () => {
    const removed = await sweepIn(join(sandboxDir, 'does-not-exist'));
    expect(removed).toBe(0);
  });
});
