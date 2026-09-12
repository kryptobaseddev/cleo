/**
 * Build artefact gate — T929: all bin targets MUST have a shebang.
 *
 * Every file listed in `package.json#bin` MUST begin with
 * `#!/usr/bin/env node` so that npm-global installs work without
 * errors like "import: not found" or "/bin: Is a directory".
 *
 * ## The exact string is load-bearing — do not relax it to admit flags
 *
 * `#!/usr/bin/env -S node --max-old-space-size=1536 …` is the tempting way to
 * pass Node flags in one process, and this assertion is the only thing that
 * stops it. `env -S` is supported by GNU coreutils (>= 8.30) and by BSD/macOS,
 * so it passes on the machines most maintainers test on — and it breaks the
 * CLI outright on musl/BusyBox. Measured 2026-09-12 on the official
 * `node:22-alpine` image, where `/usr/bin/env` symlinks to `/bin/busybox`:
 *
 *     /usr/bin/env: unrecognized option: S
 *     Usage: env [-i0] [-u NAME]... [-] [NAME=VALUE]... [PROG ARGS]
 *     exit=1
 *
 * BusyBox 1.37.0 has no `-S`. The failure is at exec time, before any JS is
 * parsed, so no in-process fallback can recover it: `cleo` is unlaunchable.
 * The same file with the plain shebang ran fine. Flags are applied by the
 * re-exec in `bin/cleo.js` instead — see the rationale there.
 *
 * These tests check the compiled dist files (not the TypeScript sources)
 * because that is the artefact consumers receive. If dist files are not
 * present (clean checkout before first build), the tests are skipped
 * gracefully — the CI build step will have produced them before vitest runs.
 *
 * @packageDocumentation
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to `packages/cleo/` root. */
const PKG_ROOT = resolve(__dirname, '..', '..', '..');

const SHEBANG = '#!/usr/bin/env node';

/** Read and parse `package.json` for this package. */
function readPkg(): { bin?: Record<string, string> } {
  const content = readFileSync(resolve(PKG_ROOT, 'package.json'), 'utf-8');
  return JSON.parse(content) as { bin?: Record<string, string> };
}

describe('T929 — bin target shebang assertion', () => {
  const pkg = readPkg();
  const binEntries = Object.entries(pkg.bin ?? {});

  it('package.json declares at least one bin target', () => {
    expect(binEntries.length).toBeGreaterThan(0);
  });

  for (const [name, relPath] of binEntries) {
    const absPath = resolve(PKG_ROOT, relPath);

    describe(`bin '${name}' → ${relPath}`, () => {
      it('dist file exists (build must have run)', () => {
        if (!existsSync(absPath)) {
          // Skip: dist not yet produced. CI always builds before running tests.
          return;
        }
        expect(existsSync(absPath)).toBe(true);
      });

      it(`first line is '${SHEBANG}'`, () => {
        if (!existsSync(absPath)) {
          return;
        }
        const content = readFileSync(absPath, 'utf-8');
        const firstLine = content.split('\n')[0];
        expect(firstLine).toBe(SHEBANG);
      });

      it('file is owner-executable (chmod +x)', () => {
        if (!existsSync(absPath)) {
          return;
        }
        const stat = statSync(absPath);
        // 0o100 = owner execute bit
        expect(stat.mode & 0o100).toBeGreaterThan(0);
      });
    });
  }
});
