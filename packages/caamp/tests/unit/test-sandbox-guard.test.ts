/**
 * Guard: caamp tests must never touch the REAL CLEO data dir.
 *
 * @remarks
 * T12645 found 53 skill fixtures (`<prefix>-<uuid>`, `real-skill`,
 * `skill-alpha`, `skill-beta`) in the real
 * `~/Library/Application Support/cleo/skills`, written by
 * `skills-installer.test.ts` and `skills-installer-recordrow.test.ts`.
 * The per-fork sandbox in the root `vitest.setup.ts` only applied when the
 * ROOT config ran; `pnpm --filter @cleocode/caamp test` (and any
 * `cd packages/caamp && vitest run`) loads this package's config alone, which
 * listed no `setupFiles`, so HOME / CLEO_HOME stayed real.
 *
 * This file fails when that setup did not run, when the unmocked skills root
 * resolves outside the sandbox, or when the fs write guard stops refusing
 * writes under the real data dir.
 *
 * @task T12645
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { delimiter, join, resolve, sep } from 'node:path';
import { resolveSkillsRoot } from '@cleocode/core/skills/skill-root.js';
import { describe, expect, it } from 'vitest';

const REAL_DATA_WRITES = Symbol.for('cleo.vitest.realDataWrites');

function protectedRoots(): string[] {
  return (process.env['CLEO_TEST_PROTECTED_DATA_ROOTS'] ?? '')
    .split(delimiter)
    .filter((root) => root.length > 0);
}

function isWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

/** Drop the probe hits so the setup's afterEach does not fail this test. */
function takeRecordedWrites(): string[] {
  const writes = (globalThis as { [REAL_DATA_WRITES]?: string[] })[REAL_DATA_WRITES];
  return writes ? writes.splice(0) : [];
}

describe('caamp test sandbox (T12645)', () => {
  it('runs with vitest.setup.ts: real data roots captured, CLEO_HOME sandboxed', () => {
    const roots = protectedRoots();
    expect(roots.length, 'real data roots not captured: vitest.setup.ts write guard did not run').toBeGreaterThan(0);
    const cleoHome = resolve(process.env['CLEO_HOME'] ?? '');
    for (const root of roots) expect(isWithin(cleoHome, root)).toBe(false);
  });

  it('resolves the unmocked skills root inside the sandbox', () => {
    const skillsRoot = resolve(resolveSkillsRoot());
    expect(isWithin(skillsRoot, resolve(process.env['CLEO_HOME'] ?? '/nonexistent'))).toBe(true);
    for (const root of protectedRoots()) expect(isWithin(skillsRoot, root)).toBe(false);
  });

  it('refuses sync and promise writes under the real data dir', async () => {
    const roots = protectedRoots();
    expect(roots.length).toBeGreaterThan(0);
    const dataRoot = roots[0] as string;
    // Parents that do not exist: if the guard ever stops firing, these calls
    // fail with ENOENT and create nothing in the real data dir.
    const probe = join(dataRoot, 'skills', `.vitest-guard-probe-${randomUUID()}`);

    let syncError: unknown;
    try {
      writeFileSync(join(probe, 'SKILL.md'), 'x');
    } catch (err) {
      syncError = err;
    }
    await expect(mkdir(join(probe, 'nested'))).rejects.toMatchObject({
      code: 'E_TEST_REAL_DATA_WRITE',
    });

    expect(syncError).toMatchObject({ code: 'E_TEST_REAL_DATA_WRITE' });
    expect(takeRecordedWrites()).toHaveLength(2);
  });

  it("refuses a sibling agent's worktree under the data dir", () => {
    const dataRoot = protectedRoots()[0] as string;
    const sibling = join(dataRoot, 'worktrees', 'not-this-run', `T0-${randomUUID()}`, 'x.txt');
    expect(() => writeFileSync(sibling, 'x')).toThrow(/E_TEST_REAL_DATA_WRITE/);
    expect(takeRecordedWrites()).toHaveLength(1);
  });

  // Only meaningful when the run's own checkout lies under a protected root
  // (an agent worktree in the data dir). Anywhere else there is nothing to
  // exempt, and a write outside the roots would pass vacuously — so skip.
  const ownCheckout = (() => {
    let dir = resolve(process.cwd());
    while (!existsSync(join(dir, '.git'))) dir = resolve(dir, '..');
    return dir;
  })();
  const ownCheckoutProtected = protectedRoots().some((root) => isWithin(ownCheckout, root));

  it.skipIf(!ownCheckoutProtected)('exempts the checkout this run started in', () => {
    const own = join(ownCheckout, 'node_modules', `.vitest-guard-own-${randomUUID()}`);
    expect(protectedRoots().some((root) => isWithin(own, root))).toBe(true);
    try {
      writeFileSync(own, 'x');
    } finally {
      rmSync(own, { force: true });
    }
    expect(takeRecordedWrites()).toEqual([]);
  });
});
