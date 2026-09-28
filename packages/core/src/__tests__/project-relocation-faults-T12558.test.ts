/**
 * Relocation fault paths that need an injected failure (T12558 · T12556).
 *
 * - A reroot whose identity write fails after the rename is ROLLED BACK:
 *   `.cleo/` returns to the old root, no tombstone, registry untouched.
 * - A move whose rename fails with EXDEV is refused as `E_CROSS_DEVICE` and
 *   moves nothing.
 * - A dry run compares `st_dev` and reports the cross-device refusal.
 *
 * Each case loads a fresh module graph after `vi.doMock`, so the mocks apply
 * only here.
 *
 * @task T12556
 * @task T12558
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDir: string;
let originalCwd: string;

beforeEach(async () => {
  vi.resetModules();
  testDir = realpathSync(await mkdtemp(join(tmpdir(), 'cleo-relocate-faults-')));
  vi.stubEnv('CLEO_HOME', join(testDir, 'cleo-home'));
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_PROJECT_ROOT', undefined);
  vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', undefined);
  mkdirSync(join(testDir, 'cleo-home'), { recursive: true });
  const caller = join(testDir, 'caller');
  mkdirSync(join(caller, '.cleo'), { recursive: true });
  mkdirSync(join(caller, '.git'), { recursive: true });
  vi.stubEnv('CLEO_ROOT', caller);
  originalCwd = process.cwd();
  process.chdir(caller);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  process.chdir(originalCwd);
  const { resetDbState } = await import('../store/sqlite.js');
  resetDbState();
  const { resetNexusDbState } = await import('../store/nexus-sqlite.js');
  resetNexusDbState();
  vi.doUnmock('../scaffold/project-identity.js');
  vi.doUnmock('node:fs/promises');
  vi.doUnmock('node:fs');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

/** A registered project (git repo, project-id, project-info.json). */
async function makeProject(root: string, projectId: string): Promise<string> {
  mkdirSync(join(root, '.cleo'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.cleo', 'project-id'), `${projectId}\n`);
  writeFileSync(join(root, '.cleo', 'project-info.json'), JSON.stringify({ projectId }));
  const { nexusRegister } = await import('../nexus/registry.js');
  await nexusRegister(root, projectId, 'write');
  return root;
}

async function registryPath(projectId: string): Promise<string | undefined> {
  const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
  const { projectRegistry } = await import('../store/schema/nexus-schema.js');
  const { getCleoHome } = await import('../paths.js');
  const { eq } = await import('drizzle-orm');
  return (await getNexusRegistryDb(getCleoHome()))
    .select()
    .from(projectRegistry)
    .where(eq(projectRegistry.projectId, projectId))
    .get()?.projectPath;
}

describe('reroot rollback (T12558)', () => {
  it('an identity write failure after the rename puts .cleo back and changes nothing', async () => {
    vi.doMock('../scaffold/project-identity.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../scaffold/project-identity.js')>()),
      ensurePortableProjectId: async () => {
        throw new Error('simulated ENOSPC writing .cleo/project-id');
      },
    }));
    const root = await makeProject(join(testDir, 'mono'), 'rollback-T12558');
    const child = join(root, 'app');
    mkdirSync(child);
    const { rerootProject } = await import('../project-lifecycle.js');

    const result = await rerootProject(child, root);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('E_REROOT_FAILED');
      expect(result.error.message).toContain('simulated ENOSPC');
    }
    expect(existsSync(join(root, '.cleo', 'project-info.json'))).toBe(true);
    expect(existsSync(join(child, '.cleo'))).toBe(false);
    expect(existsSync(join(root, '.cleo-moved.json'))).toBe(false);
    expect(await registryPath('rollback-T12558')).toBe(root);
  });
});

describe('move across devices (T12556)', () => {
  it('EXDEV from the rename is E_CROSS_DEVICE and nothing moves', async () => {
    const root = await makeProject(join(testDir, 'src'), 'exdev-T12556');
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        rename: async (from: string, to: string) => {
          if (from === root) {
            throw Object.assign(new Error('EXDEV: cross-device link not permitted'), {
              code: 'EXDEV',
            });
          }
          return actual.rename(from, to);
        },
      };
    });
    const { moveProject } = await import('../project-lifecycle.js');

    const result = await moveProject(join(testDir, 'dst'), root);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('E_CROSS_DEVICE');
      expect(result.error.fix).toContain(`mv "${root}"`);
    }
    expect(existsSync(join(root, '.cleo', 'project-info.json'))).toBe(true);
    expect(await registryPath('exdev-T12556')).toBe(root);
  });

  it('the dry run compares st_dev and reports the refusal; the real run refuses before any IO', async () => {
    const root = await makeProject(join(testDir, 'src2'), 'stdev-T12556');
    const otherDevice = join(testDir, 'other-device');
    mkdirSync(otherDevice);
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      const statSync = ((p: string, o?: object) => {
        const st = actual.statSync(p, o as undefined);
        return p === otherDevice ? Object.assign(Object.create(st), { dev: st.dev + 1 }) : st;
      }) as typeof actual.statSync;
      return { ...actual, statSync, default: { ...actual, statSync } };
    });
    const { moveProject } = await import('../project-lifecycle.js');
    const target = join(otherDevice, 'proj');

    const plan = await moveProject(target, root, { dryRun: true });
    expect(plan.success && plan.data.blockers.some((b) => b.startsWith('E_CROSS_DEVICE'))).toBe(
      true,
    );
    const result = await moveProject(target, root);
    expect(!result.success && result.error.code).toBe('E_CROSS_DEVICE');
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(root, '.cleo', 'project-info.json'))).toBe(true);
  });
});
