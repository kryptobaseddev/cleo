/**
 * Tests for the `@earendil-works/pi-tui` optional-dep loader (T11932).
 *
 * Mirrors `gondolin-loader.test.ts`: drives the loader entirely through the
 * injected import seam so "package absent", "package present", and
 * "shape-incompatible package" are all exercised WITHOUT installing pi-tui.
 *
 * @task T11932
 * @epic T11916
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetPiTuiAvailabilityCache,
  __setPiTuiTestHooks,
  isPiTuiAvailable,
  loadPiTui,
  PI_TUI_INSTALL_HINT,
} from '../pi-tui-loader.js';

/** A minimal shape-valid mock of the pi-tui module surface. */
function mockPiTuiModule(): Record<string, unknown> {
  return {
    TUI: class {},
    ProcessTerminal: class {},
    Text: class {},
  };
}

afterEach(() => {
  // Restore the real importer + clear the cache between cases.
  __setPiTuiTestHooks();
  __resetPiTuiAvailabilityCache();
});

describe('loadPiTui — package ABSENT (T11932 · AC1/AC3)', () => {
  it('returns null and never throws when the import rejects (ERR_MODULE_NOT_FOUND)', async () => {
    __setPiTuiTestHooks({
      importer: () => Promise.reject(new Error("Cannot find package '@earendil-works/pi-tui'")),
    });
    await expect(loadPiTui()).resolves.toBeNull();
  });

  it('isPiTuiAvailable() resolves false when absent', async () => {
    __setPiTuiTestHooks({
      importer: () => Promise.reject(new Error('ERR_MODULE_NOT_FOUND')),
    });
    await expect(isPiTuiAvailable()).resolves.toBe(false);
  });
});

describe('loadPiTui — package PRESENT (T11932 · AC1)', () => {
  it('returns the shape-checked module when the import resolves a valid surface', async () => {
    const mod = mockPiTuiModule();
    __setPiTuiTestHooks({ importer: () => Promise.resolve(mod) });
    const loaded = await loadPiTui();
    expect(loaded).not.toBeNull();
    expect(typeof loaded?.TUI).toBe('function');
    expect(typeof loaded?.ProcessTerminal).toBe('function');
    expect(typeof loaded?.Text).toBe('function');
  });

  it('unwraps a CJS-style `default` export', async () => {
    const mod = mockPiTuiModule();
    __setPiTuiTestHooks({ importer: () => Promise.resolve({ default: mod }) });
    const loaded = await loadPiTui();
    expect(loaded).not.toBeNull();
    expect(loaded?.TUI).toBe(mod['TUI']);
  });

  it('isPiTuiAvailable() resolves true when present', async () => {
    __setPiTuiTestHooks({ importer: () => Promise.resolve(mockPiTuiModule()) });
    await expect(isPiTuiAvailable()).resolves.toBe(true);
  });

  it('caches the availability probe (importer invoked once across repeated checks)', async () => {
    let calls = 0;
    __setPiTuiTestHooks({
      importer: () => {
        calls += 1;
        return Promise.resolve(mockPiTuiModule());
      },
    });
    await isPiTuiAvailable();
    await isPiTuiAvailable();
    expect(calls).toBe(1);
  });
});

describe('loadPiTui — shape-INCOMPATIBLE package (T11932 · AC1)', () => {
  it('returns null when a required export is missing', async () => {
    __setPiTuiTestHooks({
      // Missing `Text` — version drift / wrong package.
      importer: () => Promise.resolve({ TUI: class {}, ProcessTerminal: class {} }),
    });
    await expect(loadPiTui()).resolves.toBeNull();
  });

  it('returns null when an export is the wrong runtime type', async () => {
    __setPiTuiTestHooks({
      importer: () =>
        Promise.resolve({ TUI: class {}, ProcessTerminal: class {}, Text: 'not-a-ctor' }),
    });
    await expect(loadPiTui()).resolves.toBeNull();
  });

  it('returns null for a non-object module', async () => {
    __setPiTuiTestHooks({ importer: () => Promise.resolve(null) });
    await expect(loadPiTui()).resolves.toBeNull();
  });
});

describe('PI_TUI_INSTALL_HINT (T11932 · AC3)', () => {
  it('names the optional package and the install command', () => {
    expect(PI_TUI_INSTALL_HINT).toContain('@earendil-works/pi-tui');
    expect(PI_TUI_INSTALL_HINT).toContain('pnpm add @earendil-works/pi-tui');
  });
});
