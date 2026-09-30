/**
 * First-time creation of `machine-key` and `global-salt` must never replace
 * a file another process created first (T12867 review N2). Two first-time
 * creators that each wrote their own would go on sealing under different
 * keys. The race window is simulated by making the existence probe miss a
 * file that is already there, exactly as it would for the losing process.
 *
 * @task T12867
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({ missOnce: new Set<string>() }));

/** ENOENT for the first probe of a path in `race.missOnce`, as if it did not exist yet. */
function missFirst(path: unknown): void {
  if (typeof path === 'string' && race.missOnce.has(path)) {
    race.missOnce.delete(path);
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  }
}

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const patched = {
    ...real,
    existsSync: ((p: Parameters<typeof real.existsSync>[0]) => {
      if (typeof p === 'string' && race.missOnce.has(p)) {
        race.missOnce.delete(p);
        return false;
      }
      return real.existsSync(p);
    }) as typeof real.existsSync,
    statSync: ((...args: Parameters<typeof real.statSync>) => {
      missFirst(args[0]);
      return real.statSync(...args);
    }) as typeof real.statSync,
  };
  return { ...patched, default: patched };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const patched = {
    ...real,
    stat: (async (...args: Parameters<typeof real.stat>) => {
      missFirst(args[0]);
      return real.stat(...args);
    }) as typeof real.stat,
  };
  return { ...patched, default: patched };
});

import { loadGlobalSaltAt } from '../../store/global-salt.js';
import { decryptGlobal, encryptGlobal } from '../credentials.js';

describe('first-time key material creation never replaces a winner (N2)', () => {
  it('global-salt: the loser of the race reads the existing salt instead of overwriting it', () => {
    const home = mkdtempSync(join(tmpdir(), 'salt-race-'));
    const saltPath = join(home, 'global-salt');
    const winner = randomBytes(32);
    writeFileSync(saltPath, winner, { mode: 0o600 });

    race.missOnce.add(saltPath); // our probe misses the winner's file
    const salt = loadGlobalSaltAt(home);

    expect(salt.equals(winner)).toBe(true);
    expect(readFileSync(saltPath).equals(winner)).toBe(true);
  });

  it('machine-key: the loser of the race reads the existing key, so both seal under one key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'key-race-'));
    // The winner creates the key and seals a secret with it.
    const sealed = await encryptGlobal('secret', 'id', { cleoHome: home });
    const keyPath = join(home, 'machine-key');
    const winnerKey = readFileSync(keyPath);

    race.missOnce.add(keyPath); // the loser's probe misses the winner's key
    const loserSealed = await encryptGlobal('other', 'id', { cleoHome: home });

    expect(readFileSync(keyPath).equals(winnerKey)).toBe(true);
    expect(await decryptGlobal(sealed, 'id', { cleoHome: home })).toBe('secret');
    expect(await decryptGlobal(loserSealed, 'id', { cleoHome: home })).toBe('other');
  });
});
