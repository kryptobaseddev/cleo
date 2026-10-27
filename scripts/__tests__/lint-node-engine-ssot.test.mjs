/** T14055: CI must test the engines floor and may add newer Node versions, never older ones. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ciNodeVersionViolations } from '../lint-node-engine-ssot.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('ciNodeVersionViolations (T14055)', () => {
  it('accepts the floor alone and the floor with Node 26', () => {
    expect(ciNodeVersionViolations(['24.16.0'], '24.16.0')).toEqual([]);
    expect(ciNodeVersionViolations(['24.16.0', '26', '26.12.1'], '24.16.0')).toEqual([]);
  });

  it('refuses a version below the floor, naming it', () => {
    const out = ciNodeVersionViolations(['24.16.0', '24.15.0', '22'], '24.16.0');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/'24\.15\.0' is below the root floor 24\.16\.0/);
    expect(out[1]).toMatch(/'22' is below/);
  });

  it('refuses CI that never tests the floor, and an unparseable version', () => {
    expect(ciNodeVersionViolations(['26'], '24.16.0')).toEqual([
      'no CI Node version is the root floor 24.16.0 (CI must test the floor)',
    ]);
    expect(ciNodeVersionViolations(['24.16.0', 'lts/*'], '24.16.0')[0]).toMatch(
      /'lts\/\*' is not a version/,
    );
  });

  it('the repository passes the gate', () => {
    const run = spawnSync(process.execPath, ['scripts/lint-node-engine-ssot.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
  });
});
