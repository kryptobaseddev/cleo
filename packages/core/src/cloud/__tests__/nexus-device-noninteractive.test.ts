/**
 * Reading the device credentials never prompts (T13308): the hourly presence
 * refresh (T13289) runs in the background of unrelated commands, so the read
 * it makes, `NexusDeviceStore.list()`, must not reach an OS keychain or any
 * other process that could raise a prompt. It unseals with the machine key and
 * global salt, plain 0600 files under the CLEO home. This pins that, against
 * both kinds of keychain access: a CLI (`security`, `secret-tool`: a child
 * process) and a native addon (keytar, a napi keyring: `process.dlopen`, and a
 * module name in the import graph). A future keychain-backed store has to be
 * wired so this read stays non-interactive.
 *
 * @task T13308
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    exec: vi.fn(real.exec),
    execFile: vi.fn(real.execFile),
    execFileSync: vi.fn(real.execFileSync),
    execSync: vi.fn(real.execSync),
    fork: vi.fn(real.fork),
    spawn: vi.fn(real.spawn),
    spawnSync: vi.fn(real.spawnSync),
  };
});

const childProcess = await import('node:child_process');
/** Every process start the mocked module saw, by function name. */
const spawnedSince = (): string[] =>
  (
    [
      ['exec', childProcess.exec],
      ['execFile', childProcess.execFile],
      ['execFileSync', childProcess.execFileSync],
      ['execSync', childProcess.execSync],
      ['fork', childProcess.fork],
      ['spawn', childProcess.spawn],
      ['spawnSync', childProcess.spawnSync],
    ] as const
  ).flatMap(([name, fn]) => (vi.isMockFunction(fn) && fn.mock.calls.length > 0 ? [name] : []));
const { generateEd25519, generateX25519 } = await import('../crypto.js');
const { applyEnrolment, NexusDeviceEnrolment, NexusDeviceStore, SealedNexusDevice } = await import(
  '../nexus-device.js'
);

const ORIGIN = 'https://api.nexus.test';
const USER = '0198a1b2-0000-7000-8000-00000000000a';
const DEVICE = '0198a1b2-0000-7000-8000-0000000000d1';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-device-noninteractive-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('device credential read (T13308)', () => {
  it('list() unseals a stored device without starting any process', async () => {
    const home = join(dir, 'home');
    const location = join(home, 'nexus-device.json');
    const enc = generateX25519();
    const sig = generateEd25519();
    const token = `cnx_d1_${randomBytes(32).toString('base64url')}`;
    await new NexusDeviceStore(location, { cleoHome: home }).update((tx) =>
      tx.set(
        ORIGIN,
        USER,
        applyEnrolment(
          null,
          new NexusDeviceEnrolment({
            deviceId: DEVICE,
            keys: {
              encryption: {
                publicKey: enc.publicKey.toString('base64'),
                privateKey: enc.privateKey.toString('base64'),
              },
              signing: {
                publicKey: sig.publicKey.toString('base64'),
                privateKey: sig.privateKey.toString('base64'),
              },
            },
            credential: {
              credentialId: '0198a1b2-0000-7000-8000-0000000000c1',
              token,
              profile: 'device',
              scopes: ['account:read'],
              createdAt: new Date().toISOString(),
            },
          }),
        ),
      ),
    );

    vi.clearAllMocks();
    const dlopen = vi.spyOn(process, 'dlopen');
    const devices = await new NexusDeviceStore(location, { cleoHome: home }).list();
    // No native addon was loaded to read it (T13321).
    expect(dlopen).not.toHaveBeenCalled();
    dlopen.mockRestore();
    const device = devices.find((d) => d instanceof SealedNexusDevice);
    expect(device).toBeInstanceOf(SealedNexusDevice);
    expect(device instanceof SealedNexusDevice ? device.currentBearer() : null).toBe(token);
    expect(spawnedSince()).toEqual([]);
  });
});

/** Module names of OS keychain bindings: native addons and their wrappers. */
const KEYCHAIN_MODULE =
  /keytar|keyring|keychain|libsecret|secret-service|wincred|credential-manager/i;

/**
 * Every module specifier statically reachable from `entry` through relative
 * imports (type-only imports are skipped: they never load).
 */
function importGraph(entry: string): { files: string[]; specifiers: string[] } {
  const files: string[] = [];
  const specifiers: string[] = [];
  const pending = [entry];
  const seen = new Set<string>();
  const IMPORT =
    /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*(?:\/\*[^*]*\*\/\s*)?['"]([^'"]+)['"]\s*\)/g;
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const spec = m[1] ?? m[2];
      if (spec === undefined) continue;
      specifiers.push(spec);
      if (!spec.startsWith('.')) continue;
      const next = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
      if (existsSync(next)) pending.push(next);
    }
  }
  return { files, specifiers };
}

describe('the device store imports no keychain module (T13321)', () => {
  it('nothing statically reachable from nexus-device.ts names a keychain binding', () => {
    const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'nexus-device.ts');
    const { files, specifiers } = importGraph(entry);
    // The walk really covers the read path: the store, the credentials module and the salt.
    expect(files.some((f) => f.endsWith('crypto/credentials.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('store/global-salt.ts'))).toBe(true);
    expect(specifiers.filter((s) => KEYCHAIN_MODULE.test(s))).toEqual([]);
  });
});
