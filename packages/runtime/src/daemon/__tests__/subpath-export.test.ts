/**
 * Import-smoke + subpath-export guard for `@cleocode/runtime/daemon` (T11365).
 *
 * Asserts that:
 * 1. `package.json` declares a `./daemon` export distinct from the root `.`
 *    export, both pointing at distinct `dist/**` artifacts.
 * 2. The built `dist/daemon/index.js` + `dist/daemon/index.d.ts` exist (i.e.
 *    tsup emits the subpath bundle).
 * 3. The built daemon entrypoint is importable and structurally distinct from
 *    the package root entrypoint (different exported surface).
 *
 * The build artifacts are produced by `pnpm --filter @cleocode/runtime run
 * build` (run in CI + the worktree before this suite). When the dist is absent
 * (e.g. a type-only check before build), the artifact assertions are skipped so
 * the export-map contract still validates in isolation.
 *
 * @task T11365
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// src/daemon/__tests__ → package root is three levels up.
const packageRoot = resolve(here, '..', '..', '..');

interface SubpathTarget {
  readonly types: string;
  readonly import: string;
}
interface RuntimePackageJson {
  readonly exports: Record<string, SubpathTarget>;
}

function readPackageJson(): RuntimePackageJson {
  const raw = readFileSync(join(packageRoot, 'package.json'), 'utf8');
  return JSON.parse(raw) as RuntimePackageJson;
}

describe('@cleocode/runtime/daemon subpath export (T11365)', () => {
  it('declares a ./daemon export distinct from the root . export', () => {
    const pkg = readPackageJson();
    const root = pkg.exports['.'];
    const daemon = pkg.exports['./daemon'];

    expect(root).toBeDefined();
    expect(daemon).toBeDefined();

    // The subpath must resolve to a distinct artifact from the root.
    expect(daemon?.import).toBe('./dist/daemon/index.js');
    expect(daemon?.types).toBe('./dist/daemon/index.d.ts');
    expect(daemon?.import).not.toBe(root?.import);
    expect(daemon?.types).not.toBe(root?.types);
  });

  it('emits dist/daemon/index.{js,d.ts} when built', () => {
    const js = join(packageRoot, 'dist', 'daemon', 'index.js');
    const dts = join(packageRoot, 'dist', 'daemon', 'index.d.ts');
    if (!existsSync(js)) {
      // Build not yet run in this environment; export-map contract above still
      // asserts the wiring. Skip the artifact existence check.
      return;
    }
    expect(existsSync(js)).toBe(true);
    expect(existsSync(dts)).toBe(true);
  });

  it('the built daemon entrypoint imports and is distinct from the root', async () => {
    const daemonJs = join(packageRoot, 'dist', 'daemon', 'index.js');
    const rootJs = join(packageRoot, 'dist', 'index.js');
    if (!existsSync(daemonJs) || !existsSync(rootJs)) {
      return; // dist not built in this environment — see note above.
    }
    const daemonMod = await import(pathToFileURL(daemonJs).href);
    const rootMod = await import(pathToFileURL(rootJs).href);

    // Both modules load.
    expect(daemonMod).toBeTypeOf('object');
    expect(rootMod).toBeTypeOf('object');

    // The two entrypoints expose distinct surfaces: the root exports the legacy
    // poller/SSE services; the daemon submodule does not.
    expect(rootMod).toHaveProperty('createRuntime');
    expect(daemonMod).not.toHaveProperty('createRuntime');
  });
});
