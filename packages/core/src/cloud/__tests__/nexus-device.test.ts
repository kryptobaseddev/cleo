/**
 * Nexus device store (`nexus-device.json`): owner-only file, locked
 * read-modify-write with a re-read under the lock (M6/N1), atomic writes,
 * the pending / pendingSignOut / pendingRevoke slots (§2.5, §3.5), refusal of
 * newer or malformed files (finding 8), and redaction (C2).
 *
 * Every test uses its own temp directory; nothing touches the real CLEO home.
 *
 * @task T12867
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { getCleoHome } from '@cleocode/paths';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateEd25519, generateX25519 } from '../crypto.js';
import { nexusCredentialsPath } from '../nexus-credentials.js';
import {
  applyBeginRevoke,
  applyBeginSignOut,
  applyDropPending,
  applyEnrolment,
  applyPendingRotation,
  applyPromotePending,
  applySignOutConfirmed,
  isNexusDeviceEnabled,
  NEXUS_DEVICE_ENV,
  type NexusDeviceEntry,
  type NexusDeviceKeys,
  NexusDeviceStore,
  NexusDeviceStoreError,
  nexusDevicePath,
  redactNexusDeviceSecrets,
} from '../nexus-device.js';
import { uuidv7 } from '../uuidv7.js';

const API = 'https://api.nexus.test/v1';
const USER_A = '0198a1b2-0000-7000-8000-00000000000a';
const USER_B = '0198a1b2-0000-7000-8000-00000000000b';

const mintToken = (): string => `cnx_d1_${randomBytes(32).toString('base64url')}`;
const credId = (): string => uuidv7();

function keys(): NexusDeviceKeys {
  const enc = generateX25519();
  const sig = generateEd25519();
  return {
    encryption: {
      publicKey: enc.publicKey.toString('base64'),
      privateKey: enc.privateKey.toString('base64'),
    },
    signing: {
      publicKey: sig.publicKey.toString('base64'),
      privateKey: sig.privateKey.toString('base64'),
    },
  };
}

function enrolled(token = mintToken(), deviceId = uuidv7()): NexusDeviceEntry {
  return applyEnrolment(null, {
    deviceId,
    keys: keys(),
    credential: {
      credentialId: credId(),
      token,
      profile: 'device',
      scopes: ['account:read', 'projects:read'],
      createdAt: new Date().toISOString(),
    },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let location: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-device-'));
  location = join(dir, 'home', 'nexus-device.json');
});

async function expectStoreError(p: Promise<unknown>, code: string): Promise<NexusDeviceStoreError> {
  const err = await p.then(
    () => null,
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(NexusDeviceStoreError);
  expect((err as NexusDeviceStoreError).code).toBe(code);
  return err as NexusDeviceStoreError;
}

describe('path and switch', () => {
  it('resolves under the CLEO home through @cleocode/paths', () => {
    expect(nexusDevicePath()).toBe(join(getCleoHome(), 'nexus-device.json'));
    // The v1 session store stays a separate file (finding 8), at its unchanged path.
    expect(nexusCredentialsPath()).toBe(join(getCleoHome(), 'nexus-credentials.json'));
  });

  it('is on only for CLEO_NEXUS_DEVICE=1', () => {
    expect(isNexusDeviceEnabled({})).toBe(false);
    expect(isNexusDeviceEnabled({ [NEXUS_DEVICE_ENV]: 'true' })).toBe(false);
    expect(isNexusDeviceEnabled({ [NEXUS_DEVICE_ENV]: '1' })).toBe(true);
  });
});

describe('file permissions', () => {
  it('creates the file 0600 in a 0700 directory, with no temp or backup copies left', async () => {
    const store = new NexusDeviceStore(location);
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
    await store.update((tx) => tx.set(API, USER_B, enrolled()));
    if (process.platform !== 'win32') {
      expect(statSync(location).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'home')).mode & 0o777).toBe(0o700);
    }
    const leftovers = readdirSync(join(dir, 'home')).filter(
      (f) => f !== 'nexus-device.json' && !f.endsWith('.lock'),
    );
    expect(leftovers).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses to read or write a file with a wider mode, and says how to fix it',
    async () => {
      const store = new NexusDeviceStore(location);
      await store.update((tx) => tx.set(API, USER_A, enrolled()));
      const before = readFileSync(location, 'utf-8');
      chmodSync(location, 0o644);

      const err = await expectStoreError(store.get(API, USER_A), 'E_NEXUS_DEVICE_FILE_PERMISSIONS');
      expect(err.message).toContain('chmod 600');
      expect(err.message).toContain('644');
      await expectStoreError(
        store.update((tx) => tx.set(API, USER_B, enrolled())),
        'E_NEXUS_DEVICE_FILE_PERMISSIONS',
      );
      expect(readFileSync(location, 'utf-8')).toBe(before);

      chmodSync(location, 0o600);
      expect(await store.get(API, USER_A)).not.toBeNull();
    },
  );

  it.skipIf(process.platform === 'win32')('refuses a symlinked file', async () => {
    mkdirSync(join(dir, 'home'), { recursive: true, mode: 0o700 });
    const target = join(dir, 'elsewhere.json');
    writeFileSync(target, JSON.stringify({ version: 1, devices: {} }), { mode: 0o600 });
    symlinkSync(target, location);
    const store = new NexusDeviceStore(location);
    await expectStoreError(store.get(API, USER_A), 'E_NEXUS_DEVICE_FILE_SYMLINK');
    await expectStoreError(
      store.update((tx) => tx.set(API, USER_A, enrolled())),
      'E_NEXUS_DEVICE_FILE_SYMLINK',
    );
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ version: 1, devices: {} });
  });
});

describe('format versions (finding 8: never downgrade)', () => {
  function plant(content: string): void {
    mkdirSync(join(dir, 'home'), { recursive: true, mode: 0o700 });
    writeFileSync(location, content, { mode: 0o600 });
  }

  it('refuses a newer version and leaves it byte-identical', async () => {
    const newer = `${JSON.stringify({ version: 2, devices: { x: { y: { secret: 'keep' } } } })}\n`;
    plant(newer);
    const store = new NexusDeviceStore(location);
    const err = await expectStoreError(store.get(API, USER_A), 'E_NEXUS_DEVICE_FILE_NEWER');
    expect(err.message).toContain('version 2');
    await expectStoreError(
      store.update((tx) => tx.set(API, USER_A, enrolled())),
      'E_NEXUS_DEVICE_FILE_NEWER',
    );
    expect(readFileSync(location, 'utf-8')).toBe(newer);
  });

  it('refuses a malformed file instead of reading it as empty and overwriting it', async () => {
    plant('{"version":1,"devices":');
    const store = new NexusDeviceStore(location);
    await expectStoreError(
      store.update((tx) => tx.set(API, USER_A, enrolled())),
      'E_NEXUS_DEVICE_FILE_INVALID',
    );
    expect(readFileSync(location, 'utf-8')).toBe('{"version":1,"devices":');

    plant(JSON.stringify({ version: 1, sessions: {} })); // a nexus-credentials.json copied here
    await expectStoreError(store.list(), 'E_NEXUS_DEVICE_FILE_INVALID');
  });

  it('keeps unknown fields of a known version when it rewrites the file', async () => {
    const entry = { ...enrolled(), futureField: { a: 1 } };
    plant(
      JSON.stringify({ version: 1, devices: { 'https://other.test': { u: entry } }, extra: 'x' }),
    );
    const store = new NexusDeviceStore(location);
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
    const after = JSON.parse(readFileSync(location, 'utf-8'));
    expect(after.extra).toBe('x');
    expect(after.devices['https://other.test'].u.futureField).toEqual({ a: 1 });
    expect(after.devices['https://api.nexus.test'][USER_A]).toBeDefined();
  });
});

describe('locking (M6/N1)', () => {
  it('two concurrent writers both land: none is lost', async () => {
    const one = new NexusDeviceStore(location);
    const two = new NexusDeviceStore(location);
    // Each writer holds the lock across an await, as a real HTTP call would.
    await Promise.all([
      one.update(async (tx) => {
        await sleep(150);
        tx.set(API, USER_A, enrolled());
      }),
      two.update(async (tx) => {
        await sleep(150);
        tx.set(API, USER_B, enrolled());
      }),
    ]);
    const users = (await one.list()).map((d) => d.userId);
    expect(users).toEqual([USER_A, USER_B]);
  });

  it('serialises the critical sections: the second sees the first write after the lock', async () => {
    const store = new NexusDeviceStore(location);
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
    const seen: Array<string | null> = [];
    const tokenA = mintToken();
    const tokenB = mintToken();
    await Promise.all([
      store.update(async (tx) => {
        const entry = tx.get(API, USER_A);
        seen.push(entry?.pending?.token ?? null);
        await sleep(150);
        if (entry && !entry.pending) tx.set(API, USER_A, applyPendingRotation(entry, tokenA));
      }),
      store.update(async (tx) => {
        const entry = tx.get(API, USER_A);
        seen.push(entry?.pending?.token ?? null);
        await sleep(10);
        // A second rotation must replay the first pending token, never mint another.
        if (entry && !entry.pending) tx.set(API, USER_A, applyPendingRotation(entry, tokenB));
      }),
    ]);
    expect(seen[0]).toBeNull();
    expect([tokenA, tokenB]).toContain(seen[1]);
    const sealed = await store.get(API, USER_A);
    expect(sealed?.pendingBearer()).toBe(seen[1]);
  });

  it('re-reads after acquiring the lock, not from a snapshot taken before', async () => {
    const store = new NexusDeviceStore(location);
    const first = enrolled();
    await store.update((tx) => tx.set(API, USER_A, first));
    const stale = await store.get(API, USER_A); // decision made on this snapshot

    // Another process re-enrols meanwhile (a new current credential).
    const other = new NexusDeviceStore(location);
    const relogin = applyEnrolment(first, {
      deviceId: first.deviceId,
      keys: null,
      credential: {
        ...(first.current as NonNullable<NexusDeviceEntry['current']>),
        credentialId: credId(),
        token: mintToken(),
      },
    });
    await other.update((tx) => tx.set(API, USER_A, relogin));

    // The CAS delete keyed on the stale credential id must not wipe the newer credential.
    const deleted = await store.update((tx) =>
      tx.delete(API, USER_A, {
        deviceId: first.deviceId,
        credentialId: stale?.unseal().current?.credentialId ?? null,
      }),
    );
    expect(deleted).toBe(false);
    expect((await store.get(API, USER_A))?.currentBearer()).toBe(relogin.current?.token);

    // With the current id it does delete.
    expect(
      await store.update((tx) =>
        tx.delete(API, USER_A, {
          deviceId: first.deviceId,
          credentialId: relogin.current?.credentialId ?? null,
        }),
      ),
    ).toBe(true);
    expect(await store.get(API, USER_A)).toBeNull();
  });

  it('writes nothing when the step throws', async () => {
    const store = new NexusDeviceStore(location);
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
    const before = readFileSync(location, 'utf-8');
    await expect(
      store.update((tx) => {
        tx.set(API, USER_B, enrolled());
        throw new Error('network down');
      }),
    ).rejects.toThrow('network down');
    expect(readFileSync(location, 'utf-8')).toBe(before);
  });

  it('refuses an invalid entry', async () => {
    const store = new NexusDeviceStore(location);
    const bad = { ...enrolled(), current: { ...enrolled().current, token: 'not-a-credential' } };
    await expectStoreError(
      store.update((tx) => tx.set(API, USER_A, bad as NexusDeviceEntry)),
      'E_NEXUS_DEVICE_ENTRY_INVALID',
    );
  });
});

describe('slots (§2.5, §3.5)', () => {
  it('round-trips current, pending, pendingSignOut and pendingRevoke through the file', async () => {
    const store = new NexusDeviceStore(location);
    const c0 = mintToken();
    const c1 = mintToken();
    const base = enrolled(c0);
    await store.update((tx) => tx.set(API, USER_A, base));

    // Rotation: pending minted and stored before the POST.
    await store.update((tx) => {
      const e = tx.get(API, USER_A) as NexusDeviceEntry;
      tx.set(API, USER_A, applyPendingRotation(e, c1));
    });
    let read = (await new NexusDeviceStore(location).get(API, USER_A))?.unseal();
    expect(read?.pending?.token).toBe(c1);
    expect(read?.pending?.credentialId).toBeNull();
    expect(read?.current?.token).toBe(c0);
    expect(() => applyPendingRotation(read as NexusDeviceEntry, mintToken())).toThrow(
      NexusDeviceStoreError,
    );

    // Logout while the rotation is unsettled: newest (pending) first, current kept as fallback.
    await store.update((tx) => {
      const e = tx.get(API, USER_A) as NexusDeviceEntry;
      tx.set(API, USER_A, applyBeginSignOut(e));
    });
    read = (await store.get(API, USER_A))?.unseal();
    expect(read?.current).toBeNull();
    expect(read?.pending).toBeNull();
    expect(read?.pendingSignOut?.credentials.map((c) => c.token)).toEqual([c1, c0]);
    expect(read?.keys).toEqual(base.keys); // keys survive a sign-out (D2)

    // --revoke takes over the unsettled sign-out's credentials.
    await store.update((tx) => {
      const e = tx.get(API, USER_A) as NexusDeviceEntry;
      tx.set(API, USER_A, applyBeginRevoke(e));
    });
    read = (await store.get(API, USER_A))?.unseal();
    expect(read?.pendingSignOut).toBeNull();
    expect(read?.pendingRevoke?.credentials.map((c) => c.token)).toEqual([c1, c0]);
    expect(read?.keys).toEqual(base.keys); // keys stay until E10 is confirmed

    // Re-login (E1) clears pending and pendingSignOut but keeps pendingRevoke.
    const c2 = mintToken();
    const relogin = applyEnrolment(read as NexusDeviceEntry, {
      deviceId: base.deviceId,
      keys: null,
      credential: {
        ...(base.current as NonNullable<NexusDeviceEntry['current']>),
        credentialId: credId(),
        token: c2,
      },
    });
    expect(relogin.keys).toEqual(base.keys);
    expect(relogin.current?.token).toBe(c2);
    expect(relogin.pendingRevoke?.credentials).toHaveLength(2);
  });

  it('E1 clears pending and pendingSignOut (M6)', () => {
    const base = enrolled();
    const withPending = applyPendingRotation(base, mintToken());
    const signingOut = applyBeginSignOut(withPending);
    const fresh = applyEnrolment(signingOut, {
      deviceId: base.deviceId,
      keys: null,
      credential: {
        ...(base.current as NonNullable<NexusDeviceEntry['current']>),
        credentialId: credId(),
        token: mintToken(),
      },
    });
    expect(fresh.pending).toBeNull();
    expect(fresh.pendingSignOut).toBeNull();
    expect(fresh.deviceId).toBe(base.deviceId);
  });

  it('promotes pending with the same profile and scopes, and CAS-drops only the expected pending', () => {
    const base = enrolled();
    const c1 = mintToken();
    const rotating = applyPendingRotation(base, c1);
    expect(applyDropPending(rotating, mintToken())).toBe(rotating); // a different pending: untouched
    expect(applyDropPending(rotating, c1).pending).toBeNull();

    const id = credId();
    const promoted = applyPromotePending(rotating, id);
    expect(promoted.current).toMatchObject({
      credentialId: id,
      token: c1,
      profile: base.current?.profile,
      scopes: base.current?.scopes,
    });
    expect(promoted.pending).toBeNull();
    expect(applySignOutConfirmed(applyBeginSignOut(promoted)).pendingSignOut).toBeNull();
  });
});

describe('redaction (C2)', () => {
  it('never shows a token or private key through the sealed handle, errors or JSON', async () => {
    const store = new NexusDeviceStore(location);
    const secret = mintToken();
    const entry = applyPendingRotation(enrolled(secret), mintToken());
    await store.update((tx) => tx.set(API, USER_A, entry));
    const sealed = await store.get(API, USER_A);
    const privateKey = entry.keys?.signing.privateKey as string;
    const pendingToken = entry.pending?.token as string;

    for (const shown of [
      JSON.stringify(sealed),
      JSON.stringify(await store.list()),
      inspect(sealed, { depth: 10 }),
      String(sealed),
      `${sealed}`,
    ]) {
      expect(shown).not.toContain(secret);
      expect(shown).not.toContain(pendingToken);
      expect(shown).not.toContain(privateKey);
    }
    expect(JSON.stringify(sealed)).toContain(`cnx_d1_…${secret.slice(-4)}`);
    expect(sealed?.currentBearer()).toBe(secret);

    const err = new NexusDeviceStoreError('E_NEXUS_DEVICE_FILE_INVALID', `bad token ${secret}`);
    expect(err.message).not.toContain(secret);
  });

  it('masks every credential in diagnostic text', () => {
    const a = mintToken();
    const b = mintToken();
    const out = redactNexusDeviceSecrets(
      `Authorization: Bearer ${a}; retry with ${b}abc; cnx_d1_x`,
    );
    expect(out).not.toContain(a);
    expect(out).not.toContain(b);
    expect(out).toContain(`Bearer cnx_d1_…${a.slice(-4)}`);
    expect(out).not.toMatch(/cnx_d1_[A-Za-z0-9_-]{5,}/);
  });

  it('never leaves a readable copy behind: no backups after writes', async () => {
    const store = new NexusDeviceStore(location);
    const backups = join(dir, 'home', '.backups');
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, 'nexus-device.json.1'), 'old secrets', { mode: 0o600 });
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
    expect(existsSync(join(backups, 'nexus-device.json.1'))).toBe(false);
  });
});
