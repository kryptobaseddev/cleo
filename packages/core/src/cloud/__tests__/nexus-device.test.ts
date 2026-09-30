/**
 * Nexus device store (`nexus-device.json`): owner-only file sealed under the
 * machine key, locked read-modify-write with a re-read under the lock
 * (M6/N1), durable mid-transaction flush (§2.5 step 3), the pending /
 * pendingSignOut / pendingRevoke slots (§2.5, §3.5), refusal of newer or
 * malformed files (finding 8), and redaction (C2).
 *
 * Every test uses its own temp directory as the CLEO home; nothing touches
 * the real one.
 *
 * @task T12867
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  applyRetiredSettled,
  applySignOutConfirmed,
  assertEnrolmentAllowed,
  isNexusDeviceEnabled,
  NEXUS_DEVICE_ENV,
  NEXUS_DEVICE_MAX_SLOT_CREDENTIALS,
  type NexusDeviceCurrentCredential,
  NexusDeviceEnrolment,
  type NexusDeviceEntry,
  type NexusDeviceKeys,
  NexusDeviceStore,
  NexusDeviceStoreError,
  nexusDevicePath,
  redactNexusDeviceSecrets,
} from '../nexus-device.js';
import { uuidv7 } from '../uuidv7.js';

const API = 'https://api.nexus.test/v1';
const ORIGIN = 'https://api.nexus.test';
const USER_A = '0198a1b2-0000-7000-8000-00000000000a';
const USER_B = '0198a1b2-0000-7000-8000-00000000000b';
const posix = process.platform !== 'win32';

const mintToken = (): string => `cnx_d1_${randomBytes(32).toString('base64url')}`;
const credId = (): string => uuidv7();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function credential(token = mintToken()): NexusDeviceCurrentCredential {
  return {
    credentialId: credId(),
    token,
    profile: 'device',
    scopes: ['account:read', 'projects:read'],
    createdAt: new Date().toISOString(),
  };
}

function enrolment(
  deviceId: string,
  token = mintToken(),
  k: NexusDeviceKeys | null = keys(),
): NexusDeviceEnrolment {
  return new NexusDeviceEnrolment({ deviceId, keys: k, credential: credential(token) });
}

function enrolled(token = mintToken(), deviceId = uuidv7()): NexusDeviceEntry {
  return applyEnrolment(null, enrolment(deviceId, token));
}

let dir: string;
let home: string;
let location: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-device-'));
  home = join(dir, 'home');
  location = join(home, 'nexus-device.json');
});

async function storeError(p: Promise<unknown>, code: string): Promise<NexusDeviceStoreError> {
  const err = await p.then(
    () => null,
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(NexusDeviceStoreError);
  expect((err as NexusDeviceStoreError).code).toBe(code);
  return err as NexusDeviceStoreError;
}

function syncError(fn: () => unknown, code: string): NexusDeviceStoreError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(NexusDeviceStoreError);
    expect((err as NexusDeviceStoreError).code).toBe(code);
    return err as NexusDeviceStoreError;
  }
  throw new Error(`expected ${code}`);
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

describe('sealed at rest (machine key)', () => {
  it('never writes a token or private key in plaintext', async () => {
    const store = new NexusDeviceStore(location);
    const token = mintToken();
    const entry = enrolled(token);
    await store.update((tx) => tx.set(API, USER_A, entry));
    const raw = readFileSync(location, 'utf-8');
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(entry.keys?.signing.privateKey);
    expect(raw).not.toContain(entry.keys?.encryption.privateKey);
    expect(raw).toContain(entry.keys?.signing.publicKey as string); // public keys stay readable
    expect((await store.get(API, USER_A))?.currentBearer()).toBe(token);
  });

  it('a file copied to another machine (another machine key) cannot be opened, and is left untouched', async () => {
    await new NexusDeviceStore(location).update((tx) => tx.set(API, USER_A, enrolled()));
    const otherHome = join(dir, 'other');
    mkdirSync(otherHome, { mode: 0o700 });
    const copy = join(otherHome, 'nexus-device.json');
    copyFileSync(location, copy);
    chmodSync(copy, 0o600);
    const before = readFileSync(copy, 'utf-8');

    const other = new NexusDeviceStore(copy);
    const err = await storeError(other.get(API, USER_A), 'E_NEXUS_DEVICE_UNSEAL_FAILED');
    expect(err.message).toContain('cleo login nexus');
    await storeError(
      other.update((tx) => tx.set(API, USER_B, enrolled())),
      'E_NEXUS_DEVICE_UNSEAL_FAILED',
    );
    expect(readFileSync(copy, 'utf-8')).toBe(before);
  });

  it('an entry moved under another user id cannot be opened (the seal binds origin and user)', async () => {
    await new NexusDeviceStore(location).update((tx) => tx.set(API, USER_A, enrolled()));
    const json = JSON.parse(readFileSync(location, 'utf-8'));
    json.devices[ORIGIN][USER_B] = json.devices[ORIGIN][USER_A];
    delete json.devices[ORIGIN][USER_A];
    writeFileSync(location, JSON.stringify(json), { mode: 0o600 });
    await storeError(
      new NexusDeviceStore(location).get(API, USER_B),
      'E_NEXUS_DEVICE_UNSEAL_FAILED',
    );
  });
});

describe('file and directory permissions', () => {
  it('creates the file 0600 in a 0700 directory, with no temp or backup copies left', async () => {
    const store = new NexusDeviceStore(location);
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
    await store.update((tx) => tx.set(API, USER_B, enrolled()));
    if (posix) {
      expect(statSync(location).mode & 0o777).toBe(0o600);
      expect(statSync(home).mode & 0o777).toBe(0o700);
    }
    const leftovers = readdirSync(home).filter(
      (f) =>
        !['nexus-device.json', 'machine-key', 'global-salt'].includes(f) && !f.endsWith('.lock'),
    );
    expect(leftovers).toEqual([]);
  });

  it.skipIf(!posix)('refuses a file with a wider mode, with chmod and sudo remedies', async () => {
    const store = new NexusDeviceStore(location);
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
    const before = readFileSync(location, 'utf-8');
    chmodSync(location, 0o644);

    const err = await storeError(store.get(API, USER_A), 'E_NEXUS_DEVICE_FILE_PERMISSIONS');
    expect(err.message).toContain('chmod 600');
    expect(err.message).toContain('sudo chown');
    expect(err.message).toContain('644');
    await storeError(
      store.update((tx) => tx.set(API, USER_B, enrolled())),
      'E_NEXUS_DEVICE_FILE_PERMISSIONS',
    );
    expect(readFileSync(location, 'utf-8')).toBe(before);

    chmodSync(location, 0o600);
    expect(await store.get(API, USER_A)).not.toBeNull();
  });

  it.skipIf(!posix)('refuses a hard-linked file (checked on the open descriptor)', async () => {
    const store = new NexusDeviceStore(location);
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
    linkSync(location, join(dir, 'second-name.json'));
    await storeError(store.get(API, USER_A), 'E_NEXUS_DEVICE_FILE_UNSAFE');
  });

  it.skipIf(!posix)('refuses a symlinked file for reads and writes', async () => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const target = join(dir, 'elsewhere.json');
    writeFileSync(target, JSON.stringify({ version: 1, devices: {} }), { mode: 0o600 });
    symlinkSync(target, location);
    const store = new NexusDeviceStore(location);
    await storeError(store.get(API, USER_A), 'E_NEXUS_DEVICE_FILE_SYMLINK');
    await storeError(
      store.update((tx) => tx.set(API, USER_A, enrolled())),
      'E_NEXUS_DEVICE_FILE_SYMLINK',
    );
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ version: 1, devices: {} });
  });

  it.skipIf(!posix)('accepts an existing 0755 directory', async () => {
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    const store = new NexusDeviceStore(location);
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
    expect(await store.get(API, USER_A)).not.toBeNull();
  });

  it.skipIf(!posix)('refuses a group- or world-writable directory, with the fix', async () => {
    for (const mode of [0o777, 0o775]) {
      rmSync(home, { recursive: true, force: true });
      mkdirSync(home);
      chmodSync(home, mode);
      const store = new NexusDeviceStore(location);
      const err = await storeError(
        store.update((tx) => tx.set(API, USER_A, enrolled())),
        'E_NEXUS_DEVICE_DIR_UNSAFE',
      );
      expect(err.message).toContain('chmod go-w');
      await storeError(store.get(API, USER_A), 'E_NEXUS_DEVICE_DIR_UNSAFE');
      expect(existsSync(location)).toBe(false);
    }
  });

  it.skipIf(!posix || process.getuid?.() === 0)(
    'maps an unwritable directory to a permissions error, not a symlink error',
    async () => {
      mkdirSync(home, { mode: 0o700 });
      chmodSync(home, 0o500);
      try {
        await storeError(
          new NexusDeviceStore(location).update((tx) => tx.set(API, USER_A, enrolled())),
          'E_NEXUS_DEVICE_FILE_PERMISSIONS',
        );
      } finally {
        chmodSync(home, 0o700);
      }
    },
  );
});

describe('format versions (finding 8: never downgrade)', () => {
  function plant(content: string): void {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(location, content, { mode: 0o600 });
  }

  it('refuses a newer version and leaves it byte-identical', async () => {
    const newer = `${JSON.stringify({ version: 2, devices: { x: { y: { secret: 'keep' } } } })}\n`;
    plant(newer);
    const store = new NexusDeviceStore(location);
    const err = await storeError(store.get(API, USER_A), 'E_NEXUS_DEVICE_FILE_NEWER');
    expect(err.message).toContain('version 2');
    await storeError(
      store.update((tx) => tx.set(API, USER_A, enrolled())),
      'E_NEXUS_DEVICE_FILE_NEWER',
    );
    expect(readFileSync(location, 'utf-8')).toBe(newer);
  });

  it('refuses a malformed file instead of reading it as empty and overwriting it', async () => {
    plant('{"version":1,"devices":');
    const store = new NexusDeviceStore(location);
    await storeError(
      store.update((tx) => tx.set(API, USER_A, enrolled())),
      'E_NEXUS_DEVICE_FILE_INVALID',
    );
    expect(readFileSync(location, 'utf-8')).toBe('{"version":1,"devices":');

    plant(JSON.stringify({ version: 1, sessions: {} })); // a nexus-credentials.json copied here
    await storeError(store.list(), 'E_NEXUS_DEVICE_FILE_INVALID');
  });

  it('keeps unknown fields at every depth when it rewrites the file (M1)', async () => {
    const store = new NexusDeviceStore(location);
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
    const json = JSON.parse(readFileSync(location, 'utf-8'));
    const entry = json.devices[ORIGIN][USER_A];
    json.extra = 'top';
    entry.futureField = { a: 1 };
    entry.current.futureCredField = 'c';
    entry.keys.futureKeysField = 'k';
    entry.keys.encryption.futurePairField = 'p';
    writeFileSync(location, JSON.stringify(json), { mode: 0o600 });

    await store.update((tx) => {
      const e = tx.get(API, USER_A) as NexusDeviceEntry;
      tx.set(API, USER_A, applyPendingRotation(e, mintToken()));
      tx.set(API, USER_B, enrolled());
    });
    const after = JSON.parse(readFileSync(location, 'utf-8'));
    const kept = after.devices[ORIGIN][USER_A];
    expect(after.extra).toBe('top');
    expect(kept.futureField).toEqual({ a: 1 });
    expect(kept.current.futureCredField).toBe('c');
    expect(kept.keys.futureKeysField).toBe('k');
    expect(kept.keys.encryption.futurePairField).toBe('p');
    expect(kept.pending).not.toBeNull();
  });
});

describe('locking (M6/N1, H2)', () => {
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
    expect((await one.list()).map((d) => d.userId)).toEqual([USER_A, USER_B]);
  });

  it('serialises the critical sections: the second sees the first write after the lock', async () => {
    const store = new NexusDeviceStore(location);
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
    const seen: Array<string | null> = [];
    const tokens = [mintToken(), mintToken()];
    await Promise.all(
      tokens.map((token, i) =>
        store.update(async (tx) => {
          const entry = tx.get(API, USER_A);
          seen.push(entry?.pending?.token ?? null);
          await sleep(i === 0 ? 150 : 10);
          // A second rotation must replay the first pending token, never mint another.
          if (entry && !entry.pending) tx.set(API, USER_A, applyPendingRotation(entry, token));
        }),
      ),
    );
    expect(seen[0]).toBeNull();
    expect(tokens).toContain(seen[1]);
    expect((await store.get(API, USER_A))?.pendingBearer()).toBe(seen[1]);
  });

  it('waits for a holder slower than the shared lock budget (about 3 s) instead of failing', async () => {
    const holder = new NexusDeviceStore(location);
    const waiter = new NexusDeviceStore(location);
    let held!: () => void;
    const acquired = new Promise<void>((r) => {
      held = r;
    });
    const slow = holder.update(async (tx) => {
      held();
      await sleep(3600);
      tx.set(API, USER_A, enrolled());
    });
    await acquired;
    await waiter.update((tx) => tx.set(API, USER_B, enrolled()));
    await slow;
    expect((await waiter.list()).map((d) => d.userId)).toEqual([USER_A, USER_B]);
  }, 20_000);

  it('gives up with a typed E_NEXUS_DEVICE_BUSY when the wait runs out', async () => {
    const holder = new NexusDeviceStore(location);
    const waiter = new NexusDeviceStore(location, { lockWaitMs: 300 });
    let held!: () => void;
    const acquired = new Promise<void>((r) => {
      held = r;
    });
    const slow = holder.update(async () => {
      held();
      await sleep(1500);
    });
    await acquired;
    await storeError(
      waiter.update((tx) => tx.set(API, USER_B, enrolled())),
      'E_NEXUS_DEVICE_BUSY',
    );
    await slow;
  });

  it('refuses re-entry at once instead of waiting on itself', async () => {
    const store = new NexusDeviceStore(location);
    const started = Date.now();
    await store.update(async () => {
      await storeError(
        new NexusDeviceStore(location).update(() => undefined),
        'E_NEXUS_DEVICE_REENTRANT',
      );
    });
    expect(Date.now() - started).toBeLessThan(2000);
    // The outer lock was released normally.
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
  });

  it('a lost lock aborts tx.signal, blocks writes, and rejects with a typed error (no uncaught throw)', async () => {
    const store = new NexusDeviceStore(location, { lockStaleMs: 2000 });
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
    const before = readFileSync(location, 'utf-8');
    let aborted = false;
    const err = await storeError(
      store.update(async (tx) => {
        // Another process takes the lock over as stale: its lock directory disappears.
        rmSync(`${location}.lock`, { recursive: true, force: true });
        await sleep(1600);
        aborted = tx.signal.aborted;
        tx.set(API, USER_B, enrolled());
      }),
      'E_NEXUS_DEVICE_LOCK_COMPROMISED',
    );
    expect(aborted).toBe(true);
    expect(err.message).toContain('Retry');
    expect(readFileSync(location, 'utf-8')).toBe(before);
  }, 10_000);

  it('re-reads after acquiring the lock, and the CAS delete never wipes a newer credential', async () => {
    const store = new NexusDeviceStore(location);
    const first = enrolled();
    await store.update((tx) => tx.set(API, USER_A, first));
    const stale = await store.get(API, USER_A); // decision made on this snapshot

    // Another process re-enrols meanwhile (a new current credential).
    const relogin = applyEnrolment(first, enrolment(first.deviceId, mintToken(), null));
    await new NexusDeviceStore(location).update((tx) => tx.set(API, USER_A, relogin));

    const deleted = await store.update((tx) =>
      tx.delete(API, USER_A, {
        deviceId: first.deviceId,
        credentialId: stale?.unseal().current?.credentialId ?? null,
      }),
    );
    expect(deleted).toBe(false);
    expect((await store.get(API, USER_A))?.currentBearer()).toBe(relogin.current?.token);

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

  it('writes nothing unflushed when the step throws', async () => {
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

  it('sweeps temp files a crashed writer left behind', async () => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const orphan = join(home, '.nexus-device.json.0123456789ab.tmp');
    writeFileSync(orphan, 'partial secrets', { mode: 0o600 });
    await new NexusDeviceStore(location).update(() => undefined);
    expect(existsSync(orphan)).toBe(false);
  });

  it('refuses an invalid entry', async () => {
    const store = new NexusDeviceStore(location);
    const good = enrolled();
    const bad = { ...good, current: { ...good.current, token: 'not-a-credential' } };
    await storeError(
      store.update((tx) => tx.set(API, USER_A, bad as NexusDeviceEntry)),
      'E_NEXUS_DEVICE_ENTRY_INVALID',
    );
  });
});

describe('flush before the network (H1, §2.5 step 3)', () => {
  it('a flushed pending credential survives a crash before the transaction ends', async () => {
    const store = new NexusDeviceStore(location);
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
    const c1 = mintToken();
    let onDiskBeforeE8: string | null = null;
    await expect(
      store.update(async (tx) => {
        const e = tx.get(API, USER_A) as NexusDeviceEntry;
        tx.set(API, USER_A, applyPendingRotation(e, c1));
        await tx.flush();
        // What another process (or the next run) would read right now, lock still held.
        onDiskBeforeE8 =
          (await new NexusDeviceStore(location).get(API, USER_A))?.pendingBearer() ?? null;
        // E8 goes out, the server applies it, and the process dies before the answer.
        throw new Error('crash after E8 was sent');
      }),
    ).rejects.toThrow('crash after E8');
    expect(onDiskBeforeE8).toBe(c1);
    expect((await store.get(API, USER_A))?.pendingBearer()).toBe(c1);
  });
});

describe('slots (§2.5, §3.5, H3)', () => {
  it('round-trips rotate, sign-out, revoke through the file, and refuses re-login while a revoke is unconfirmed', async () => {
    const store = new NexusDeviceStore(location);
    const c0 = mintToken();
    const c1 = mintToken();
    const base = enrolled(c0);
    await store.update((tx) => tx.set(API, USER_A, base));

    await store.update((tx) => {
      const e = tx.get(API, USER_A) as NexusDeviceEntry;
      tx.set(API, USER_A, applyPendingRotation(e, c1));
    });
    let read = (await new NexusDeviceStore(location).get(API, USER_A))?.unseal();
    expect(read?.pending?.token).toBe(c1);
    expect(read?.pending?.credentialId).toBeNull();
    expect(read?.current?.token).toBe(c0);
    syncError(
      () => applyPendingRotation(read as NexusDeviceEntry, mintToken()),
      'E_NEXUS_DEVICE_PENDING_EXISTS',
    );

    // Logout while the rotation is unsettled: newest (pending) first, current kept as fallback.
    await store.update((tx) => {
      tx.set(API, USER_A, applyBeginSignOut(tx.get(API, USER_A) as NexusDeviceEntry));
    });
    read = (await store.get(API, USER_A))?.unseal();
    expect(read?.current).toBeNull();
    expect(read?.pending).toBeNull();
    expect(read?.pendingSignOut?.credentials.map((c) => c.token)).toEqual([c1, c0]);
    expect(read?.keys).toEqual(base.keys); // keys survive a sign-out (D2)

    // --revoke takes over the unsettled sign-out's credentials.
    await store.update((tx) => {
      tx.set(API, USER_A, applyBeginRevoke(tx.get(API, USER_A) as NexusDeviceEntry));
    });
    read = (await store.get(API, USER_A))?.unseal();
    expect(read?.pendingSignOut).toBeNull();
    expect(read?.pendingRevoke?.credentials.map((c) => c.token)).toEqual([c1, c0]);
    expect(read?.keys).toEqual(base.keys); // keys stay until E10 is confirmed

    // Re-login on the same device is refused until the revoke is settled (owner decision).
    syncError(
      () => assertEnrolmentAllowed(read as NexusDeviceEntry, base.deviceId),
      'E_NEXUS_DEVICE_REVOKE_PENDING',
    );
    const refused = syncError(
      () => applyEnrolment(read as NexusDeviceEntry, enrolment(base.deviceId, mintToken(), null)),
      'E_NEXUS_DEVICE_REVOKE_PENDING',
    );
    expect(refused.message).toContain('cleocode.dev');

    // E10 confirmed: the entry goes (CAS on "no current credential").
    expect(
      await store.update((tx) =>
        tx.delete(API, USER_A, { deviceId: base.deviceId, credentialId: null }),
      ),
    ).toBe(true);
    expect(await store.get(API, USER_A)).toBeNull();
  });

  it('revoke puts live credentials first, newest first, ahead of an older unsettled revoke', () => {
    const base = enrolled();
    const old = mintToken();
    const withOldRevoke: NexusDeviceEntry = {
      ...base,
      pendingRevoke: {
        credentials: [{ credentialId: null, token: old }],
        requestedAt: new Date().toISOString(),
      },
    };
    const c1 = mintToken();
    const revoking = applyBeginRevoke(applyPendingRotation(withOldRevoke, c1));
    expect(revoking.pendingRevoke?.credentials.map((c) => c.token)).toEqual([
      c1,
      base.current?.token,
      old,
    ]);
  });

  it('refuses rather than truncate when a slot would overflow (never drops a live credential)', () => {
    const base = enrolled();
    const full: NexusDeviceEntry = {
      ...base,
      pendingRevoke: {
        credentials: Array.from({ length: NEXUS_DEVICE_MAX_SLOT_CREDENTIALS }, () => ({
          credentialId: null,
          token: mintToken(),
        })),
        requestedAt: new Date().toISOString(),
      },
    };
    syncError(() => applyBeginRevoke(full), 'E_NEXUS_DEVICE_SLOT_FULL');
  });

  it('E1 on the same device clears pending and pendingSignOut (M6)', () => {
    const base = enrolled();
    const signingOut = applyBeginSignOut(applyPendingRotation(base, mintToken()));
    const fresh = applyEnrolment(signingOut, enrolment(base.deviceId, mintToken(), null));
    expect(fresh.pending).toBeNull();
    expect(fresh.pendingSignOut).toBeNull();
    expect(fresh.deviceId).toBe(base.deviceId);
    expect(fresh.keys).toEqual(base.keys);
  });

  it('a device change retires the old device’s revoke and live credentials instead of dropping them', () => {
    const base = enrolled();
    const revoking = applyBeginRevoke(base);
    const newId = uuidv7();
    const moved = applyEnrolment(revoking, enrolment(newId));
    expect(moved.deviceId).toBe(newId);
    expect(moved.pendingRevoke).toBeNull();
    expect(
      moved.retired?.map((r) => [r.deviceId, r.kind, r.credentials.map((c) => c.token)]),
    ).toEqual([[base.deviceId, 'revoke', [base.current?.token]]]);
    expect(moved.retired?.[0]?.requestedAt).toBe(revoking.pendingRevoke?.requestedAt);

    const live = applyEnrolment(enrolled(), enrolment(uuidv7()));
    expect(live.retired?.[0]?.kind).toBe('sign-out');
    expect(applyRetiredSettled(moved, base.deviceId, 'revoke').retired).toBeUndefined();
  });

  it('promotes pending only when it still holds the expected token (M4), and CAS-drops the same way', () => {
    const base = enrolled();
    const c1 = mintToken();
    const rotating = applyPendingRotation(base, c1);
    expect(applyDropPending(rotating, mintToken())).toBe(rotating);
    expect(applyDropPending(rotating, c1).pending).toBeNull();

    expect(applyPromotePending(rotating, mintToken(), credId())).toBe(rotating);
    const id = credId();
    const promoted = applyPromotePending(rotating, c1, id);
    expect(promoted.current?.credentialId).toBe(id);
    expect(promoted.current?.token).toBe(c1);
    expect(promoted.current?.profile).toBe(base.current?.profile);
    expect(promoted.current?.scopes).toEqual(base.current?.scopes);
    expect(promoted.pending).toBeNull();
    expect(applySignOutConfirmed(applyBeginSignOut(promoted)).pendingSignOut).toBeNull();
  });
});

describe('redaction (C2, M3)', () => {
  it('never shows a token or private key through any handle, transaction entry, enrolment or error', async () => {
    const store = new NexusDeviceStore(location);
    const secret = mintToken();
    const entry = applyPendingRotation(enrolled(secret), mintToken());
    await store.update((tx) => tx.set(API, USER_A, entry));
    const sealed = await store.get(API, USER_A);
    const privateKey = entry.keys?.signing.privateKey as string;
    const pendingToken = entry.pending?.token as string;
    const enrol = enrolment(uuidv7(), secret);

    const shown: string[] = [
      JSON.stringify(sealed),
      JSON.stringify(await store.list()),
      inspect(sealed, { depth: 10 }),
      String(sealed),
      inspect(sealed?.unseal(), { depth: 10 }),
      JSON.stringify(sealed?.unseal()),
      inspect(sealed?.unseal().keys, { depth: 10 }),
      JSON.stringify(sealed?.unseal().current),
      inspect(entry, { depth: 10 }),
      inspect(enrol, { depth: 10 }),
      JSON.stringify(enrol),
      inspect(enrol.credential()),
      inspect(enrol.keys()),
    ];
    await store.update((tx) => {
      shown.push(inspect(tx.get(API, USER_A), { depth: 10 }));
      shown.push(JSON.stringify(tx.get(API, USER_A)));
    });
    for (const text of shown) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(pendingToken);
      expect(text).not.toContain(privateKey);
    }
    expect(JSON.stringify(sealed)).toContain(`cnx_d1_…${secret.slice(-4)}`);
    expect(sealed?.currentBearer()).toBe(secret);
    expect(sealed?.unseal().current?.token).toBe(secret); // explicit access still works

    const err = new NexusDeviceStoreError('E_NEXUS_DEVICE_FILE_INVALID', `bad token ${secret}`);
    expect(err.message).not.toContain(secret);
  });

  it('masks credentials and private-key fields in diagnostic text', () => {
    const a = mintToken();
    const b = mintToken();
    const k = keys().signing.privateKey;
    const out = redactNexusDeviceSecrets(
      `Authorization: Bearer ${a}; retry with ${b}abc; cnx_d1_x {"privateKey":"${k}"} { privateKey: '${k}' }`,
    );
    expect(out).not.toContain(a);
    expect(out).not.toContain(b);
    expect(out).not.toContain(k);
    expect(out).toContain(`Bearer cnx_d1_…${a.slice(-4)}`);
    expect(out).toContain('"privateKey":"[redacted]"');
    expect(out).not.toMatch(/cnx_d1_[A-Za-z0-9_-]{5,}/);
  });

  it('never leaves a readable copy behind: backups are purged on write', async () => {
    const store = new NexusDeviceStore(location);
    const backups = join(home, '.backups');
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, 'nexus-device.json.1'), 'old secrets', { mode: 0o600 });
    await store.update((tx) => tx.set(API, USER_A, enrolled()));
    expect(existsSync(join(backups, 'nexus-device.json.1'))).toBe(false);
  });
});
