/**
 * Every evidence `gh` query is bounded (T12671 review): `pr:`/`ci:` lookups
 * and component-PR reads sit on the `cleo done` and `cleo complete` paths, so
 * a hung `gh` must fail with a gh-named reason, never hang them.
 *
 * @task T12671
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultViewComponentPr } from '../../tasks/component-pr.js';
import {
  defaultFetchGhBranchProtection,
  defaultFetchGhPrFilesPage,
  defaultFetchGhPrPayload,
} from '../pr-evidence.js';

let repo: string;
let bin: string;
let savedPath: string | undefined;
let savedTimeout: string | undefined;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'gh-timeout-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  bin = mkdtempSync(join(tmpdir(), 'gh-timeout-bin-'));
  // Answers `--version` (so gh counts as installed), hangs on anything else.
  writeFileSync(
    join(bin, 'gh'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi\nsleep 5\necho "{}"\n',
    { mode: 0o755 },
  );
  savedPath = process.env['PATH'];
  savedTimeout = process.env['CLEO_GH_TIMEOUT_MS'];
  process.env['PATH'] = `${bin}:${savedPath ?? ''}`;
  process.env['CLEO_GH_TIMEOUT_MS'] = '300';
});

afterEach(() => {
  process.env['PATH'] = savedPath;
  if (savedTimeout === undefined) delete process.env['CLEO_GH_TIMEOUT_MS'];
  else process.env['CLEO_GH_TIMEOUT_MS'] = savedTimeout;
  rmSync(repo, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await run();
  return { value, ms: Date.now() - started };
}

describe('a hung gh fails fast with a gh-named reason', () => {
  it('pr: payload (gh pr view)', async () => {
    const { value, ms } = await timed(() => defaultFetchGhPrPayload(42, repo));
    expect(ms).toBeLessThan(4000);
    expect(!value.ok && value.reason).toMatch(/gh pr view 42 timed out.*gh auth status/);
  });

  it('pr: changed-files page (gh api)', async () => {
    const { value, ms } = await timed(() => defaultFetchGhPrFilesPage(42, 1, repo));
    expect(ms).toBeLessThan(4000);
    expect(!value.ok && value.reason).toMatch(/gh api PR #42 files page 1 timed out/);
  });

  it('branch protection (gh repo view / gh api)', async () => {
    const { value, ms } = await timed(() => defaultFetchGhBranchProtection(repo));
    expect(ms).toBeLessThan(4000);
    expect(!value.ok && value.reason).toMatch(/gh branch-protection lookup timed out/);
  });

  it('component PR view (gh pr view)', async () => {
    const { value, ms } = await timed(() => defaultViewComponentPr(42, repo));
    expect(ms).toBeLessThan(4000);
    expect(value).toBeNull();
  });
});

describe('the gh availability probe is bounded (T12689)', () => {
  it('a gh that hangs on --version counts as unavailable, fast', async () => {
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nsleep 5\necho "gh version 2.0.0"\n', {
      mode: 0o755,
    });
    const { isGhCliAvailable } = await import('../github-pr.js');
    const started = Date.now();
    expect(isGhCliAvailable()).toBe(false);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
