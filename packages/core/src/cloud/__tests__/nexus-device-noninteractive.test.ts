/**
 * Reading the device credentials never prompts (T13308): the hourly presence
 * refresh (T13289) runs in the background of unrelated commands, so the read
 * it makes, `NexusDeviceStore.list()`, must not reach an OS keychain or any
 * other process that could raise a prompt. It unseals with the machine key and
 * global salt, plain 0600 files under the CLEO home. This pins that: a future
 * keychain-backed store has to be wired so this read stays non-interactive.
 *
 * @task T13308
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const devices = await new NexusDeviceStore(location, { cleoHome: home }).list();
    const device = devices.find((d) => d instanceof SealedNexusDevice);
    expect(device).toBeInstanceOf(SealedNexusDevice);
    expect(device instanceof SealedNexusDevice ? device.currentBearer() : null).toBe(token);
    expect(spawnedSince()).toEqual([]);
  });
});
