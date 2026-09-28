/**
 * Forbid `new URL(..., import.meta.url).pathname` as a filesystem path in
 * vitest/vite configs (T12517).
 *
 * `.pathname` keeps percent-encoding, so a checkout under a path with a space
 * (every macOS CLEO worktree: `~/Library/Application Support/...`) resolved
 * every alias to `.../Application%20Support/...` and no test could load.
 * `fileURLToPath` decodes it and handles Windows drive letters.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('config path idiom (T12517)', () => {
  it('no vitest config derives a filesystem path from URL.pathname', () => {
    const files = execFileSync('git', ['ls-files', '*vitest.config.ts', '*vitest.config.mts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) =>
      /import\.meta\.url\)\.pathname/.test(readFileSync(join(REPO_ROOT, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
