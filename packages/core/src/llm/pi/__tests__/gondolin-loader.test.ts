/**
 * Unit tests for the Gondolin optional-dep loader + availability probe
 * (T11908 · T11888-A).
 *
 * Mirrors the merged T1742 Playwright-optional pattern: the dynamic `import()` and
 * the host probes (`/dev/kvm`, QEMU) are injected via `__setGondolinTestHooks` so
 * EVERY case is deterministic — NO real `@earendil-works/gondolin` is required and
 * NO real QEMU VM is ever launched. A real-VM exercise is a separate opt-in
 * integration test gated on `/dev/kvm`+QEMU (out of scope here).
 *
 * @task T11908
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetGondolinAvailabilityCache,
  __setGondolinTestHooks,
  GONDOLIN_INSTALL_HINT,
  type GondolinModule,
  isGondolinAvailable,
  loadGondolin,
} from '../gondolin-loader.js';

/**
 * A structurally-valid mock of the consumed Gondolin surface — enough to pass the
 * loader's shape-check. No method is ever invoked here (the loader only inspects
 * `typeof`), so no VM boots.
 */
const validMockModule = {
  VM: { create: async () => ({}) },
  RealFSProvider: class {},
  createHttpHooks: () => ({ __httpHooks: true }),
} as const;

afterEach(() => {
  // Restore the real importer + probes and clear the cache between cases.
  __setGondolinTestHooks();
});

describe('loadGondolin', () => {
  it('returns null when the package is absent (import() rejects)', async () => {
    __setGondolinTestHooks({
      importer: () => Promise.reject(new Error("Cannot find module '@earendil-works/gondolin'")),
    });
    await expect(loadGondolin()).resolves.toBeNull();
  });

  it('never throws — a rejected import resolves to null, not an exception', async () => {
    __setGondolinTestHooks({
      importer: () => {
        throw new Error('synchronous import explosion');
      },
    });
    await expect(loadGondolin()).resolves.toBeNull();
  });

  it('returns the typed module when the package loads with the expected surface', async () => {
    __setGondolinTestHooks({ importer: () => Promise.resolve(validMockModule) });
    const mod = await loadGondolin();
    expect(mod).not.toBeNull();
    expect(typeof (mod as GondolinModule).VM.create).toBe('function');
    expect(typeof (mod as GondolinModule).createHttpHooks).toBe('function');
  });

  it('unwraps an ESM default export', async () => {
    __setGondolinTestHooks({ importer: () => Promise.resolve({ default: validMockModule }) });
    await expect(loadGondolin()).resolves.not.toBeNull();
  });

  it('returns null when the loaded module is missing a required export (shape-check)', async () => {
    __setGondolinTestHooks({
      // Missing `createHttpHooks` → shape-check fails → unavailable, not a crash.
      importer: () =>
        Promise.resolve({ VM: { create: async () => ({}) }, RealFSProvider: class {} }),
    });
    await expect(loadGondolin()).resolves.toBeNull();
  });

  it('returns null when VM lacks a create() factory', async () => {
    __setGondolinTestHooks({
      importer: () =>
        Promise.resolve({
          VM: {},
          RealFSProvider: class {},
          createHttpHooks: () => ({}),
        }),
    });
    await expect(loadGondolin()).resolves.toBeNull();
  });
});

describe('isGondolinAvailable — AND-gates package + /dev/kvm + QEMU', () => {
  it('is false when the package is absent (even with kvm + qemu present)', async () => {
    __setGondolinTestHooks({
      importer: () => Promise.reject(new Error('not installed')),
      hasKvm: () => true,
      hasQemu: () => true,
    });
    await expect(isGondolinAvailable()).resolves.toBe(false);
  });

  it('is false when /dev/kvm is absent (package + qemu present)', async () => {
    __setGondolinTestHooks({
      importer: () => Promise.resolve(validMockModule),
      hasKvm: () => false,
      hasQemu: () => true,
    });
    await expect(isGondolinAvailable()).resolves.toBe(false);
  });

  it('is false when QEMU is absent (package + kvm present)', async () => {
    __setGondolinTestHooks({
      importer: () => Promise.resolve(validMockModule),
      hasKvm: () => true,
      hasQemu: () => false,
    });
    await expect(isGondolinAvailable()).resolves.toBe(false);
  });

  it('is true ONLY when package + /dev/kvm + QEMU are all present', async () => {
    __setGondolinTestHooks({
      importer: () => Promise.resolve(validMockModule),
      hasKvm: () => true,
      hasQemu: () => true,
    });
    await expect(isGondolinAvailable()).resolves.toBe(true);
  });

  it('caches the result so a later probe-mutation is ignored until __resetGondolinAvailabilityCache', async () => {
    // Use a MUTABLE kvm flag so we can flip the probe WITHOUT calling
    // __setGondolinTestHooks (which itself resets the cache).
    let kvmPresent = true;
    __setGondolinTestHooks({
      importer: () => Promise.resolve(validMockModule),
      hasKvm: () => kvmPresent,
      hasQemu: () => true,
    });

    // First probe: everything present → true (and cached).
    await expect(isGondolinAvailable()).resolves.toBe(true);

    // Flip the underlying probe to "no kvm" — but the cached `true` must STAND
    // because the cache short-circuits before re-probing.
    kvmPresent = false;
    await expect(isGondolinAvailable()).resolves.toBe(true);

    // Manual reset clears the cache → the next probe reflects the new value.
    __resetGondolinAvailabilityCache();
    await expect(isGondolinAvailable()).resolves.toBe(false);
  });
});

describe('GONDOLIN_INSTALL_HINT', () => {
  it('names the package and the QEMU/KVM host requirement', () => {
    expect(GONDOLIN_INSTALL_HINT).toContain('@earendil-works/gondolin');
    expect(GONDOLIN_INSTALL_HINT).toMatch(/QEMU|KVM|kvm|qemu/);
  });
});
