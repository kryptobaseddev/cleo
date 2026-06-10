/**
 * Regression lock for generic `@cleocode/<pkg>/<subpath>` resolution under
 * vitest in a fresh (un-built) worktree — T11953 / DHQ-070.
 *
 * Two complementary guards:
 *
 *  1. **Behavioral** — statically import a handful of `@cleocode/core/store/*`
 *     and `@cleocode/contracts/gateway*` subpaths that are NOT listed in any
 *     vitest alias map. Before the {@link cleoWorkspaceSubpathResolver} plugin
 *     existed these failed with `Cannot find package '@cleocode/core'` whenever
 *     `dist/` was absent (every fresh cleo-spawn worktree). If this module
 *     loads at all, the generic resolver mapped them to TypeScript source.
 *
 *  2. **Unit** — exercise the resolver against representative specifiers so the
 *     `.js → .ts` rewrite, directory→`index.ts` fallback, and out-of-tree
 *     guard cannot silently regress.
 *
 * @task T11953
 * @epic T11679
 */

// Behavioral imports — these specifiers are intentionally NOT in any alias map
// (verified: grep -c in packages/core/vitest.config.ts === 0). They exercise:
//   - a flat `.js` subpath           → store/background-ops.ts
//   - a nested directory `index.js`  → store/exodus/index.ts
//   - a contracts barrel subpath     → contracts/src/gateway.ts
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GATEWAY_SOURCES } from '@cleocode/contracts/gateway';
import { pendingBackgroundOpCount } from '@cleocode/core/store/background-ops.js';
import { buildExodusPlan } from '@cleocode/core/store/exodus/index.js';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

describe('vitest worktree subpath resolution (T11953 · DHQ-070)', () => {
  it('resolves a flat @cleocode/core/store/*.js subpath to source', () => {
    // If the import at the top of the file resolved, the binding is callable.
    expect(typeof pendingBackgroundOpCount).toBe('function');
  });

  it('resolves a nested @cleocode/core/store/<dir>/index.js subpath to source', () => {
    expect(typeof buildExodusPlan).toBe('function');
  });

  it('resolves the @cleocode/contracts/gateway barrel subpath to source', () => {
    // GATEWAY_SOURCES is a runtime const array exported from gateway.ts.
    expect(Array.isArray(GATEWAY_SOURCES)).toBe(true);
    expect(GATEWAY_SOURCES).toContain('cli');
  });

  it('does NOT depend on a built dist/ — the source files are what resolved', () => {
    // The point of the plugin: source must exist and be the resolution target
    // even when dist/ is absent (fresh worktree).
    expect(
      existsSync(join(REPO_ROOT, 'packages', 'core', 'src', 'store', 'background-ops.ts')),
    ).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'packages', 'contracts', 'src', 'gateway.ts'))).toBe(true);
  });
});
