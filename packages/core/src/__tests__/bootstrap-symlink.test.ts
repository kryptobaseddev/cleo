/**
 * Test: `~/.cleo` canonical symlink (Step 0.5 of bootstrapGlobalCleo).
 *
 * Verifies that the bootstrap installs `~/.cleo` as a symlink to the
 * OS-appropriate canonical CLEO data directory (`getCleoHome()`), making
 * `@~/.cleo/*` injection references universally resolvable across OSes
 * while the actual files live at the XDG / AppData / Library location.
 *
 * @task install-canonical-layout
 */

import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BootstrapContext, ensureCleoSymlink } from '../bootstrap.js';

describe('bootstrap: ~/.cleo canonical symlink', () => {
  let fakeHome: string;
  let cleoHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let origCleoHome: string | undefined;

  function normalizeLinkTarget(path: string): string {
    return normalize(path.replace(/^\\\\\?\\/, ''));
  }

  function makeContext(): BootstrapContext {
    return { created: [], warnings: [], isDryRun: false };
  }

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'cleo-symlink-test-'));
    fakeHome = join(base, 'home');
    cleoHome = join(base, 'xdg-data-cleo');
    mkdirSync(fakeHome, { recursive: true });

    origHome = process.env['HOME'];
    origUserProfile = process.env['USERPROFILE'];
    origCleoHome = process.env['CLEO_HOME'];
    process.env['HOME'] = fakeHome;
    process.env['USERPROFILE'] = fakeHome;
    process.env['CLEO_HOME'] = cleoHome;

    const { _resetPlatformPathsCache } = await import('../system/platform-paths.js');
    _resetPlatformPathsCache();
  });

  afterEach(async () => {
    if (origHome !== undefined) process.env['HOME'] = origHome;
    else delete process.env['HOME'];
    if (origUserProfile !== undefined) process.env['USERPROFILE'] = origUserProfile;
    else delete process.env['USERPROFILE'];
    if (origCleoHome !== undefined) process.env['CLEO_HOME'] = origCleoHome;
    else delete process.env['CLEO_HOME'];

    const { _resetPlatformPathsCache } = await import('../system/platform-paths.js');
    _resetPlatformPathsCache();
    // Best-effort cleanup of the temp root
    try {
      const base = dirname(fakeHome);
      await rm(base, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('creates ~/.cleo as a symlink to getCleoHome() when ~/.cleo does not exist', async () => {
    const ctx = makeContext();
    await ensureCleoSymlink(ctx);
    const legacyPath = join(fakeHome, '.cleo');

    expect(existsSync(legacyPath)).toBe(true);
    const stat = lstatSync(legacyPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = await readlink(legacyPath);
    expect(normalizeLinkTarget(target)).toBe(normalize(cleoHome));

    expect(ctx.created.some((c) => c.includes('~/.cleo →'))).toBe(true);
  });

  it('no-ops when ~/.cleo is already the correct symlink', async () => {
    // Prime: run bootstrap once to install the symlink
    await ensureCleoSymlink(makeContext());

    // Run again — should recognise the correct link and leave it alone
    const ctx = makeContext();
    await ensureCleoSymlink(ctx);

    const legacyPath = join(fakeHome, '.cleo');
    const stat = lstatSync(legacyPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(normalizeLinkTarget(await readlink(legacyPath))).toBe(normalize(cleoHome));

    const newLinkEntry = ctx.created.find((c) => c.includes('~/.cleo →'));
    expect(newLinkEntry).toBeUndefined();
  });

  it('migrates a legacy real directory to backup and replaces with symlink', async () => {
    const legacyPath = join(fakeHome, '.cleo');
    // Simulate contaminated dev-env state: a real dir with a stale file
    mkdirSync(legacyPath, { recursive: true });
    writeFileSync(join(legacyPath, 'stale.txt'), 'legacy content');

    const ctx = makeContext();
    await ensureCleoSymlink(ctx);

    // ~/.cleo is now a symlink
    const stat = lstatSync(legacyPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(normalizeLinkTarget(await readlink(legacyPath))).toBe(normalize(cleoHome));

    // A backup should exist
    const backupMention = ctx.created.find((c) => c.includes('backed up to'));
    expect(backupMention).toBeDefined();
    // Warning should tell the user where to find it
    const warningMention = ctx.warnings.find((w) => w.includes('migrated to'));
    expect(warningMention).toBeDefined();
  });
});
