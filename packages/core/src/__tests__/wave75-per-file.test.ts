/**
 * Build Wave 7.5 re-emits core's `@cleocode/utils` consumers per file (T13129).
 *
 * Wave 7.5 used to emit three of these files as self-contained esbuild bundles
 * that inlined part of core and all of `@cleocode/contracts`, so a process that
 * loaded `docs/export-document.js` ran a second copy of `store/data-accessor`
 * (its own store registry), `paths` and every module they import. These tests
 * pin the fix against the BUILT dist:
 *
 * - each re-emitted file imports exactly what its source imports (minus the
 *   inlined `@cleocode/utils`), so no other module's code is copied into it;
 * - loading one in a fresh process loads the canonical dist module of each of
 *   its relative imports, which is where that module's state lives.
 *
 * `build.mjs` enforces the same rule at build time from esbuild's metafile.
 * These assertions need `pnpm run build`; without a dist they are skipped, as
 * the other dist-dependent suites here are (CI restores the build first).
 *
 * @task T13129
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = join(PACKAGE_DIR, 'src');
const DIST_DIR = join(PACKAGE_DIR, 'dist');

/** Core source files that import `@cleocode/utils`, i.e. what Wave 7.5 re-emits. */
const WAVE75_SOURCES = [
  'docs/export-document.ts',
  'llm/plugin-facade.ts',
  'memory/redaction.ts',
  'selfimprove/fix-gen.ts',
];

const distBuilt = WAVE75_SOURCES.every((rel) =>
  existsSync(join(DIST_DIR, rel.replace(/\.ts$/, '.js'))),
);

/** Import specifiers of a JavaScript module's static imports and re-exports. */
function staticSpecifiers(js: string): string[] {
  const specifiers = new Set<string>();
  const statement =
    /(?:^|[\n;])[ \t]*(?:import|export)\b(?![ \t]*\()[^'"`;()=]*?(?:\bfrom[ \t]*)?["']([^"']+)["']/g;
  for (const match of js.matchAll(statement)) {
    if (match[1]) specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

/**
 * The runtime imports tsc emits for `source`: TypeScript's own transpile elides
 * type-only imports exactly as the tsc build of the rest of core does.
 */
function tscRuntimeSpecifiers(source: string): string[] {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      removeComments: true,
    },
  });
  return staticSpecifiers(outputText);
}

describe('Wave 7.5 output is per file, not self-contained (T13129)', () => {
  it.skipIf(!distBuilt).each(WAVE75_SOURCES)(
    '%s imports what its source imports, minus @cleocode/utils',
    (rel) => {
      const source = readFileSync(join(SRC_DIR, rel), 'utf8');
      const emitted = readFileSync(join(DIST_DIR, rel.replace(/\.ts$/, '.js')), 'utf8');
      const expected = tscRuntimeSpecifiers(source).filter(
        (spec) => !spec.startsWith('@cleocode/utils'),
      );
      expect(staticSpecifiers(emitted)).toEqual(expected);
      expect(emitted).not.toMatch(/@cleocode\/utils/);
    },
  );

  it.skipIf(!distBuilt)(
    'loading export-document.js loads the canonical store/data-accessor, paths and blob-ops modules',
    () => {
      const entry = join(DIST_DIR, 'docs', 'export-document.js');
      const probe = [
        "import { registerHooks } from 'node:module';",
        'const urls = [];',
        'registerHooks({ load(url, context, next) { urls.push(url); return next(url, context); } });',
        `await import(${JSON.stringify(pathToFileURL(entry).href)});`,
        'process.stdout.write(JSON.stringify(urls));',
      ].join('\n');
      // A throwaway HOME: importing core must not touch the developer's stores.
      const home = mkdtempSync(join(tmpdir(), 'wave75-probe-'));
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, HOME: home, CLEO_HOME: join(home, '.cleo') },
      });
      rmSync(home, { recursive: true, force: true });
      expect(child.status, child.stderr).toBe(0);
      const loaded = (JSON.parse(child.stdout) as string[])
        .filter((url) => url.startsWith('file:'))
        .map((url) => relative(DIST_DIR, fileURLToPath(url)));
      for (const canonical of ['store/data-accessor.js', 'paths.js', 'store/blob-ops.js']) {
        expect(loaded).toContain(canonical);
      }
    },
  );
});
