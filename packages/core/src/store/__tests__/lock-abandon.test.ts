/**
 * T13299 — an abandoned lock never removes its directory: proper-lockfile's
 * release removes `<file>.lock` without checking who owns it, so a lock lost
 * to another process must be let go of, not released.
 *
 * @task T13299
 */

import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireAbandonableLock } from '../lock.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-t13299-lock-'));
  file = join(dir, 'target');
  writeFileSync(file, '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireAbandonableLock (T13299)', () => {
  it('release removes the lock directory', async () => {
    const held = await acquireAbandonableLock(file, { retries: 0 });
    expect(existsSync(`${file}.lock`)).toBe(true);
    await held.release();
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('abandon leaves a lock another process took meanwhile in place, and frees ours for re-acquisition', async () => {
    const held = await acquireAbandonableLock(file, { retries: 0, onCompromised: () => {} });
    // Another process took the lock as stale: removed ours, made its own.
    rmdirSync(`${file}.lock`);
    mkdirSync(`${file}.lock`);
    await held.abandon();
    expect(existsSync(`${file}.lock`)).toBe(true);
    // Abandoning a second time (already released) never throws.
    await held.abandon();
    // This process no longer holds it: once the other holder lets go, it can be taken again.
    rmdirSync(`${file}.lock`);
    const again = await acquireAbandonableLock(file, { retries: 0 });
    await again.release();
  });
});
