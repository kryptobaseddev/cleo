/**
 * Regression guard for T9582 — project-root normalization in the CLI
 * + dispatch surfaces for `agent`, `nexus`, and `conduit`.
 *
 * The original T9580 audit identified 52 raw `process.cwd()` call sites
 * across four files that forwarded an un-normalized working directory to
 * downstream functions in `@cleocode/core`. When a `cleo` command is
 * invoked from a monorepo subdirectory, every one of those sites would
 * silently create or read state under `<subdir>/.cleo/` instead of the
 * canonical `<projectRoot>/.cleo/`.
 *
 * This test does not exercise the CLI commands end-to-end — those have
 * full handler tests under `__tests__/` already. Instead, it asserts the
 * structural property that closes the regression: each file (a) imports
 * `getProjectRoot`, and (b) contains zero raw `process.cwd()` references
 * at the source level. If a future PR re-introduces `process.cwd()` in
 * any of these files, this test fails before the change reaches main.
 *
 * @task T9582
 * @epic T9580
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');

const GUARDED_FILES = [
  'packages/cleo/src/cli/commands/agent.ts',
  'packages/cleo/src/cli/commands/nexus.ts',
  'packages/cleo/src/dispatch/domains/conduit.ts',
  'packages/cleo/src/dispatch/domains/nexus.ts',
] as const;

describe('T9582 — project-root normalization guard', () => {
  for (const relPath of GUARDED_FILES) {
    describe(relPath, () => {
      const abs = join(REPO_ROOT, relPath);
      const source = readFileSync(abs, 'utf8');

      it('imports getProjectRoot from @cleocode/core', () => {
        // Match `import { ... getProjectRoot ... } from '@cleocode/core(/internal)?'`
        // across single-line and multi-line bracket forms. Using [\s\S] (DOTALL
        // shim) handles imports that span many lines (e.g. dispatch/nexus.ts
        // pulls 50+ symbols from @cleocode/core/internal in a multi-line block).
        const pattern =
          /import\s*\{[\s\S]*?getProjectRoot[\s\S]*?\}\s*from\s*['"]@cleocode\/core(\/internal)?['"]/;
        expect(
          pattern.test(source),
          `expected a multi-line import of getProjectRoot from @cleocode/core(/internal)? in ${relPath}`,
        ).toBe(true);
      });

      it('contains zero raw process.cwd() references', () => {
        // Strip comments to avoid false positives from doc references.
        const stripped = source
          .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
          .replace(/^\s*\/\/.*$/gm, ''); // line comments
        const matches = stripped.match(/process\.cwd\(\)/g) ?? [];
        expect(
          matches.length,
          `expected zero process.cwd() call sites in ${relPath}, found ${matches.length}`,
        ).toBe(0);
      });
    });
  }
});
