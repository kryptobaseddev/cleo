/**
 * The exit path is loaded at dispatch, so a command that outlives an in-place
 * upgrade still tears down and reports (T13159).
 *
 * @task T13159
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetExitPathForTest,
  exitPath,
  exitPathLoadFailureNotice,
  isVanishedModule,
  preloadExitPath,
  vanishedModuleNotice,
} from '../exit-path.js';

const vanished = (): NodeJS.ErrnoException =>
  Object.assign(
    new Error(
      "Cannot find module '/usr/lib/node_modules/@cleocode/cleo/dist/cli/shutdown-AB12CD34.js'",
    ),
    { code: 'ERR_MODULE_NOT_FOUND' },
  );

afterEach(() => {
  vi.doUnmock('@cleocode/core/shutdown');
  vi.resetModules();
  _resetExitPathForTest();
});

describe('exit path (T13159)', () => {
  it('once preloaded, it is served from memory even after its files vanish', async () => {
    const loaded = await preloadExitPath();
    expect(typeof loaded.shutdownCliRuntime).toBe('function');
    expect(typeof loaded.cliError).toBe('function');
    // The upgrade replaced the package: a fresh import of the teardown fails…
    vi.doMock('@cleocode/core/shutdown', () => {
      throw vanished();
    });
    // …but the command's end still gets the modules loaded at dispatch.
    await expect(exitPath()).resolves.toBe(loaded);
  });

  it('without a preload, the end of the command is where a vanished module fails', async () => {
    vi.resetModules();
    vi.doMock('@cleocode/core/shutdown', () => {
      throw vanished();
    });
    const fresh = await import('../exit-path.js');
    fresh._resetExitPathForTest();
    await expect(fresh.exitPath()).rejects.toThrow();
  });

  it('recognises a module that is no longer on disk', () => {
    expect(isVanishedModule(vanished())).toBe(true);
    expect(isVanishedModule(Object.assign(new Error('x'), { code: 'MODULE_NOT_FOUND' }))).toBe(
      true,
    );
    expect(isVanishedModule(new Error('boom'))).toBe(false);
    expect(isVanishedModule(null)).toBe(false);
  });

  it('says CLEO was upgraded mid-run when the installed version moved, else to reinstall', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleo-exit-path-'));
    try {
      const pkg = join(dir, 'package.json');
      writeFileSync(pkg, JSON.stringify({ version: '2026.10.5' }));
      const upgraded = vanishedModuleNotice(vanished(), '2026.10.4', pkg);
      expect(upgraded).toMatch(/upgraded from 2026\.10\.4 to 2026\.10\.5 while this command ran/);
      expect(upgraded).toContain('The command itself ran');
      expect(upgraded.endsWith('\n')).toBe(true);
      expect(vanishedModuleNotice(vanished(), '2026.10.5', pkg)).toMatch(/Reinstall CLEO/);
      expect(vanishedModuleNotice(vanished(), '2026.10.5', join(dir, 'gone.json'))).toMatch(
        /Reinstall CLEO/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints the upgrade/reinstall notice only for a missing module; any other load error as itself (#1878 review)', () => {
    expect(exitPathLoadFailureNotice(vanished(), '2026.10.5', '/nonexistent/package.json')).toMatch(
      /Reinstall CLEO/,
    );
    const broken = Object.assign(new SyntaxError("Unexpected token '<'"), {
      code: 'ERR_INVALID_SYNTAX',
    });
    const notice = exitPathLoadFailureNotice(broken, '2026.10.5', '/nonexistent/package.json');
    expect(notice).toContain('(ERR_INVALID_SYNTAX)');
    expect(notice).toContain("SyntaxError: Unexpected token '<'");
    expect(notice).not.toMatch(/Reinstall|upgraded/);
  });
});
