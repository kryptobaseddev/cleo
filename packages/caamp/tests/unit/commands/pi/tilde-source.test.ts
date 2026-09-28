/**
 * `caamp pi cant install` / `caamp pi extensions install` expand `~/` with
 * `os.homedir()` (T12608).
 *
 * They used `process.env.HOME ?? ''`. HOME is unset on Windows (the home dir
 * is USERPROFILE), so `~/x.cant` became the RELATIVE path `x.cant` and the
 * install failed with NOT_FOUND. HOME is removed here to reproduce that, and
 * `os.homedir()` is pointed at a temp dir so the real home is never read.
 *
 * @task T12608
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeHome = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome.dir };
});

import { resolveCantSource } from '../../../../src/commands/pi/cant.js';
import { resolveExtensionSource } from '../../../../src/commands/pi/extensions.js';

describe('pi source resolution — ~ expansion without HOME (T12608)', () => {
  beforeAll(() => {
    fakeHome.dir = mkdtempSync(join(tmpdir(), 'caamp-tilde-home-'));
    mkdirSync(join(fakeHome.dir, 'pi'), { recursive: true });
    writeFileSync(join(fakeHome.dir, 'pi', 'profile.cant'), 'agent x:\n');
    writeFileSync(join(fakeHome.dir, 'pi', 'ext.ts'), 'export default () => {};\n');
  });

  afterAll(() => {
    rmSync(fakeHome.dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubEnv('HOME', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolveCantSource expands ~/ to os.homedir()', async () => {
    const resolved = await resolveCantSource('~/pi/profile.cant');
    expect(resolved.localPath).toBe(join(fakeHome.dir, 'pi', 'profile.cant'));
  });

  it('resolveExtensionSource expands ~/ to os.homedir()', async () => {
    const resolved = await resolveExtensionSource('~/pi/ext.ts');
    expect(resolved.localPath).toBe(join(fakeHome.dir, 'pi', 'ext.ts'));
  });
});
