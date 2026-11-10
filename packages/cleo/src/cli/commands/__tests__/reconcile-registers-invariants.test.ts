/**
 * `cleo reconcile release` registers the shipped release invariants itself
 * (T14391). Importing CORE no longer registers them, and this command runs
 * outside the dispatcher that loads `@cleocode/core/registrations`, so without
 * its explicit `registerReleaseInvariants()` call it would run zero invariants
 * and report a clean release.
 *
 * The real invariant registry runs against a throwaway git repository with no
 * tags, where the archive-reason invariant reports "no task IDs" without
 * touching a task store.
 *
 * @task T14391
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cleocode/core', async () => ({
  release: await import('@cleocode/core/release/invariants/index.js'),
}));

const outputs: unknown[] = [];
vi.mock('../../renderers/index.js', () => ({
  cliOutput: (data: unknown) => {
    outputs.push(data);
  },
}));

const { reconcileCommand } = await import('../reconcile.js');

let fixture: string;

beforeEach(() => {
  outputs.length = 0;
  fixture = mkdtempSync(join(tmpdir(), 'cleo-reconcile-'));
  mkdirSync(join(fixture, '.cleo'));
  execFileSync('git', ['init', '-q', fixture]);
  vi.stubEnv('CLEO_ROOT', fixture);
  vi.spyOn(process, 'cwd').mockReturnValue(fixture);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(fixture, { recursive: true, force: true });
});

describe('cleo reconcile release', () => {
  it('runs the shipped invariants without any prior registration', async () => {
    const { getInvariants } = await import('@cleocode/core/release/invariants/index.js');
    expect(getInvariants()).toEqual([]);

    await runCommand(reconcileCommand, {
      rawArgs: ['release', '--tag', 'v0.0.0-fixture', '--dry-run'],
    });

    expect(outputs).toHaveLength(1);
    const report = outputs[0] as { results: Array<{ id: string }> };
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.results.map((r) => r.id)).toContain('archive-reason');
  });
});
