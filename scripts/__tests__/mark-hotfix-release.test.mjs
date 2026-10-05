/**
 * release.yml flags a hotfix inside @cleocode/cleo's published manifest, from
 * the committed plan's releaseKind (T13184).
 *
 * @task T13184
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLEO_MANIFEST, markHotfixRelease } from '../mark-hotfix-release.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'mark-hotfix-release.mjs');

describe('mark-hotfix-release (T13184)', () => {
  let root;

  /** Seed a repo with a cleo manifest and, optionally, a plan for `version`. */
  function seed(manifest, plan, version = '2026.10.5') {
    mkdirSync(join(root, 'packages', 'cleo'), { recursive: true });
    writeFileSync(join(root, CLEO_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    if (plan !== undefined) {
      mkdirSync(join(root, '.cleo', 'release'), { recursive: true });
      writeFileSync(
        join(root, '.cleo', 'release', `v${version}.plan.json`),
        typeof plan === 'string' ? plan : JSON.stringify(plan),
      );
    }
  }
  const manifest = () => JSON.parse(readFileSync(join(root, CLEO_MANIFEST), 'utf8'));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cleo-mark-hotfix-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('flags a hotfix plan in the manifest, keeping other fields', () => {
    seed(
      { name: '@cleocode/cleo', version: '2026.10.5', cleo: { other: 1 } },
      { resolvedVersion: 'v2026.10.5', releaseKind: 'hotfix' },
    );
    expect(markHotfixRelease(root, '2026.10.5')).toMatchObject({ hotfix: true, changed: true });
    expect(manifest()).toEqual({
      name: '@cleocode/cleo',
      version: '2026.10.5',
      cleo: { other: 1, hotfix: true },
    });
  });

  it('leaves a regular release untouched', () => {
    const before = { name: '@cleocode/cleo', version: '2026.10.5' };
    seed(before, { releaseKind: 'regular' });
    expect(markHotfixRelease(root, '2026.10.5')).toMatchObject({ hotfix: false, changed: false });
    expect(manifest()).toEqual(before);
  });

  it('removes a stale flag from a regular release', () => {
    seed({ name: '@cleocode/cleo', cleo: { hotfix: true } }, { releaseKind: 'regular' });
    expect(markHotfixRelease(root, '2026.10.5')).toMatchObject({ hotfix: false, changed: true });
    expect(manifest()).toEqual({ name: '@cleocode/cleo' });
  });

  it('treats a release with no plan (break-glass dispatch) as regular', () => {
    seed({ name: '@cleocode/cleo' });
    const result = markHotfixRelease(root, '2026.10.5');
    expect(result).toMatchObject({ hotfix: false, changed: false });
    expect(result.reason).toMatch(/^no plan/);
  });

  it('reads only the plan for this version', () => {
    seed({ name: '@cleocode/cleo' }, { releaseKind: 'hotfix' }, '2026.10.4');
    expect(markHotfixRelease(root, '2026.10.5').hotfix).toBe(false);
  });

  it('fails on a malformed plan rather than guessing', () => {
    seed({ name: '@cleocode/cleo' }, '{not json');
    expect(() => markHotfixRelease(root, '2026.10.5')).toThrow();
    seed({ name: '@cleocode/cleo' }, { resolvedVersion: 'v2026.10.5' });
    expect(() => markHotfixRelease(root, '2026.10.5')).toThrow(/no releaseKind/);
  });

  it('as the release.yml step: exits 0 and flags; exits 1 on a malformed plan', () => {
    seed({ name: '@cleocode/cleo' }, { releaseKind: 'hotfix' });
    const ok = spawnSync(process.execPath, [SCRIPT, '2026.10.5'], { cwd: root, encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('IS flagged as a hotfix');
    expect(manifest().cleo).toEqual({ hotfix: true });

    seed({ name: '@cleocode/cleo' }, '{not json');
    const bad = spawnSync(process.execPath, [SCRIPT, '2026.10.5'], { cwd: root, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('::error::');

    const usage = spawnSync(process.execPath, [SCRIPT, 'v2026.10.5'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(usage.status).toBe(2);
  });

  it('release.yml runs it after the version sync and before the cleo tarball gates', () => {
    const workflow = readFileSync(
      resolve(dirname(SCRIPT), '..', '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    const at = (needle) => {
      const index = workflow.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const step = at('node scripts/mark-hotfix-release.mjs "$VERSION"');
    expect(at('- name: Sync package versions from tag')).toBeLessThan(step);
    expect(step).toBeLessThan(at('- name: Verify @cleocode/cleo tarball contents (T12011)'));
    expect(step).toBeLessThan(at('- name: Package build output for publish'));
    expect(step).toBeLessThan(at('- name: Publish packages to npm'));
  });
});
