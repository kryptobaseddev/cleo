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
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({ missOnce: new Set<string>(), crashBeforeUnlink: false }));

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
    unlinkSync: ((p: Parameters<typeof real.unlinkSync>[0]) => {
      // A crash between the link and the unlink leaves the temp file behind.
      if (race.crashBeforeUnlink && typeof p === 'string' && p.includes('tmp')) return;
      return real.unlinkSync(p);
    }) as typeof real.unlinkSync,
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

import { loadGlobalSaltAt, readGlobalSaltAt } from '../../store/global-salt.js';
import { GLOBAL_HOME_RULES, scanSection } from '../../store/portable-bundle-scan.js';
import { decryptGlobal, encryptGlobal, loadGlobalKeyMaterial } from '../credentials.js';

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

describe('leftover secret temp files (a crash between link and unlink)', () => {
  it('are never exported in a backup bundle', async () => {
    const home = mkdtempSync(join(tmpdir(), 'secret-temp-scan-'));
    race.crashBeforeUnlink = true;
    try {
      await encryptGlobal('secret', 'id', { cleoHome: home }); // creates machine-key and global-salt
    } finally {
      race.crashBeforeUnlink = false;
    }
    const leftovers = readdirSync(home).filter((f) => f.includes('tmp'));
    expect(leftovers.length).toBe(2); // one per secret: a second hard link to each
    const scan = scanSection(home, GLOBAL_HOME_RULES);
    const exported = [...scan.files, ...scan.sqlite, ...scan.secrets.map((x) => x.relPath)];
    for (const leftover of leftovers) {
      expect(exported).not.toContain(leftover);
      expect(scan.excluded.map((e) => e.relPath)).toContain(leftover);
    }
  });

  it('are swept once stale, on the next read or create; a fresh one is left alone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'secret-temp-sweep-'));
    await loadGlobalKeyMaterial({ cleoHome: home, create: true });
    const old = new Date(Date.now() - 10 * 60_000);
    const staleKey = join(home, '.machine-key.0123456789ab.tmp');
    const staleSalt = join(home, '.global-salt.0123456789ab.tmp');
    const fresh = join(home, '.machine-key.fedcba987654.tmp');
    for (const f of [staleKey, staleSalt, fresh]) writeFileSync(f, 'x', { mode: 0o600 });
    utimesSync(staleKey, old, old);
    utimesSync(staleSalt, old, old);

    expect(readGlobalSaltAt(home)).not.toBeNull();
    expect(await loadGlobalKeyMaterial({ cleoHome: home, create: false })).not.toBeNull();

    expect(existsSync(staleKey)).toBe(false);
    expect(existsSync(staleSalt)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // may be another process's in-flight create
  });
});
