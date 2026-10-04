/**
 * Tests for the CLI's ESM resolve fast path (T13126).
 *
 * The hook must answer exactly what Node's resolver would for the cases it
 * takes, and hand every other case to `nextResolve` untouched. These tests use
 * a real temporary package tree so the realpath, `package.json` scope walk and
 * `node_modules` boundary behave as they do at runtime. The hook is exercised
 * as a function; it is never registered in the test process.
 *
 * @task T13126
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { ResolveFnOutput, ResolveHookContext } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createFastResolve,
  installModuleResolveFastPath,
  NODE_EXPORTS_REPARSE_FIXED_IN,
} from '../module-resolve-fast-path.js';

const IMPORT_CONDITIONS = ['node', 'import', 'module-sync', 'node-addons'];
const REQUIRE_CONDITIONS = ['require', 'node', 'node-addons', 'module-sync'];

let root = '';

/** Write `contents` to `root/<rel>`, creating parent directories. */
function put(rel: string, contents = 'export {};\n'): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

/** `file:` URL of `root/<rel>`. */
function url(rel: string): string {
  return pathToFileURL(join(root, rel)).href;
}

/** Resolve-hook context for an `import` from `parentRel`. */
function ctx(parentRel: string, overrides: Partial<ResolveHookContext> = {}): ResolveHookContext {
  return {
    conditions: IMPORT_CONDITIONS,
    importAttributes: {},
    parentURL: url(parentRel),
    ...overrides,
  };
}

/** A `nextResolve` stand-in that records calls and answers with a sentinel. */
function fakeNext() {
  return vi.fn(
    (specifier: string): ResolveFnOutput => ({ url: `next:${specifier}`, format: 'module' }),
  );
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-fast-resolve-')));
  put('esm/package.json', JSON.stringify({ name: 'esm', type: 'module' }));
  put('esm/src/a.js');
  put('esm/src/b.js');
  put('esm/src/c.cjs', 'module.exports = 1;\n');
  put('esm/src/nested/d.js');
  put('esm/lib/node_modules/.keep', '');
  put('esm/lib/x.js');
  put('esm/lib/deep/y.js');
  put('esm/lib/deep/z.js');
  put('cjs/package.json', JSON.stringify({ name: 'cjs', type: 'commonjs' }));
  put('cjs/a.js', 'module.exports = 1;\n');
  put('cjs/b.js', 'module.exports = 2;\n');
  put('cjs/m.mjs');
  put('untyped/package.json', JSON.stringify({ name: 'untyped' }));
  put('untyped/a.js');
  put('untyped/b.js');
  put('oddtype/package.json', JSON.stringify({ name: 'oddtype', type: 'esm' }));
  put('oddtype/a.js');
  put('oddtype/b.js');
  put('badjson/package.json', '{ "type": "module", ');
  put('badjson/a.js');
  put('badjson/b.js');
  // A package dir with no package.json of its own, directly under node_modules:
  // Node never treats node_modules/package.json as a scope.
  put('app/package.json', JSON.stringify({ name: 'app', type: 'module' }));
  put('app/node_modules/bare/a.js');
  put('app/node_modules/bare/b.js');
  put('esm/real/target.js');
  symlinkSync(join(root, 'esm/real/target.js'), join(root, 'esm/src/link.js'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createFastResolve — relative specifiers', () => {
  it('answers a relative .js import in a "type": "module" package', () => {
    const next = fakeNext();
    const result = createFastResolve()('./b.js', ctx('esm/src/a.js'), next);
    expect(result).toEqual({ url: url('esm/src/b.js'), format: 'module', shortCircuit: true });
    expect(next).not.toHaveBeenCalled();
  });

  it('walks up to the nearest package.json and resolves ../ specifiers', () => {
    const result = createFastResolve()('../a.js', ctx('esm/src/nested/d.js'), fakeNext());
    expect(result).toEqual({ url: url('esm/src/a.js'), format: 'module', shortCircuit: true });
  });

  it('answers "commonjs" for a .js file in a "type": "commonjs" package', () => {
    const result = createFastResolve()('./b.js', ctx('cjs/a.js'), fakeNext());
    expect(result.format).toBe('commonjs');
  });

  it('decides .mjs and .cjs by extension, whatever the package type says', () => {
    const resolve = createFastResolve();
    expect(resolve('./m.mjs', ctx('cjs/a.js'), fakeNext()).format).toBe('module');
    expect(resolve('./c.cjs', ctx('esm/src/a.js'), fakeNext()).format).toBe('commonjs');
  });

  it('returns the realpath of a symlinked file, as Node does', () => {
    const result = createFastResolve()('./link.js', ctx('esm/src/a.js'), fakeNext());
    expect(result.url).toBe(url('esm/real/target.js'));
  });

  it('defers to Node when package.json declares no type (Node detects syntax)', () => {
    const next = fakeNext();
    const result = createFastResolve()('./b.js', ctx('untyped/a.js'), next);
    expect(result.url).toBe('next:./b.js');
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ['oddtype', 'a "type" Node does not recognise'],
    ['badjson', 'an unparseable package.json (Node reports it)'],
  ])('defers a package with %s (%s)', (pkg) => {
    const next = fakeNext();
    expect(createFastResolve()('./b.js', ctx(`${pkg}/a.js`), next).url).toBe('next:./b.js');
  });

  it('stops at a node_modules boundary instead of using the outer package.json', () => {
    const next = fakeNext();
    const result = createFastResolve()('./b.js', ctx('app/node_modules/bare/a.js'), next);
    expect(result.url).toBe('next:./b.js');
  });

  it('defers a missing file so Node raises its own ERR_MODULE_NOT_FOUND', () => {
    const next = fakeNext();
    expect(createFastResolve()('./missing.js', ctx('esm/src/a.js'), next).url).toBe(
      'next:./missing.js',
    );
  });

  it.each([
    ['./b.js?query', 'a query suffix'],
    ['./b.js#hash', 'a hash suffix'],
    ['./b%2Ejs', 'percent-encoding'],
    ['./nested', 'a directory'],
    ['./b.json', 'a non-JS extension'],
  ])('defers %s (%s)', (specifier) => {
    const next = fakeNext();
    createFastResolve()(specifier, ctx('esm/src/a.js'), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('defers require() resolutions — only import conditions take the fast path', () => {
    const next = fakeNext();
    createFastResolve()('./b.js', ctx('cjs/a.js', { conditions: REQUIRE_CONDITIONS }), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('defers imports that carry import attributes', () => {
    const next = fakeNext();
    createFastResolve()(
      './b.js',
      ctx('esm/src/a.js', { importAttributes: { type: 'json' } }),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('defers when the parent is not a file: URL', () => {
    const next = fakeNext();
    createFastResolve()(
      './b.js',
      ctx('esm/src/a.js', { parentURL: 'data:text/javascript,' }),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('createFastResolve — bare specifiers', () => {
  it('asks Node once per (specifier, package root, conditions)', () => {
    const next = fakeNext();
    const resolve = createFastResolve();
    const first = resolve('zod', ctx('esm/src/a.js'), next);
    const sameDir = resolve('zod', ctx('esm/src/b.js'), next);
    const nestedDir = resolve('zod', ctx('esm/src/nested/d.js'), next);
    expect(next).toHaveBeenCalledOnce();
    expect(sameDir).toEqual({ url: first.url, format: first.format, shortCircuit: true });
    expect(nestedDir).toEqual(sameDir);

    resolve('zod', ctx('esm/src/a.js', { conditions: ['node', 'import', 'custom'] }), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('never shares an answer across packages', () => {
    const next = fakeNext();
    const resolve = createFastResolve();
    resolve('zod', ctx('esm/src/a.js'), next);
    resolve('zod', ctx('cjs/a.js'), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('a directory with a node_modules between it and the package root keeps its own entry', () => {
    // esm/lib/node_modules exists: Node's walk from esm/lib (and below) reaches
    // it before the package root, so those directories may resolve differently.
    const next = fakeNext();
    const resolve = createFastResolve();
    resolve('zod', ctx('esm/src/a.js'), next);
    resolve('zod', ctx('esm/lib/x.js'), next);
    resolve('zod', ctx('esm/lib/deep/y.js'), next);
    expect(next).toHaveBeenCalledTimes(3);
    resolve('zod', ctx('esm/lib/deep/z.js'), next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('a package directory under node_modules without its own package.json keeps its own entry', () => {
    const next = fakeNext();
    const resolve = createFastResolve();
    resolve('zod', ctx('app/node_modules/bare/a.js'), next);
    resolve('zod', ctx('app/a.js'), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('never caches node: builtins, #imports or absolute specifiers', () => {
    const next = fakeNext();
    const resolve = createFastResolve();
    for (const specifier of ['node:fs', '#internal', '/abs/x.js', 'file:///abs/x.js']) {
      resolve(specifier, ctx('esm/src/a.js'), next);
      resolve(specifier, ctx('esm/src/b.js'), next);
    }
    expect(next).toHaveBeenCalledTimes(8);
  });
});

describe('installModuleResolveFastPath', () => {
  it('stays off when CLEO_RESOLVE_FAST_PATH=0', () => {
    const previous = process.env['CLEO_RESOLVE_FAST_PATH'];
    process.env['CLEO_RESOLVE_FAST_PATH'] = '0';
    try {
      expect(installModuleResolveFastPath()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['CLEO_RESOLVE_FAST_PATH'];
      else process.env['CLEO_RESOLVE_FAST_PATH'] = previous;
    }
  });
});

describe('the workaround stays until nodejs/node#66485 is fixed AND the floor includes the fix', () => {
  /** `[major, minor, patch]` of a `x.y.z` version (leading `>=`/`v` ignored). */
  function parseVersion(raw: string): [number, number, number] {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
    if (!match) throw new Error(`not a version: ${raw}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  /** True when version `a` is lower than version `b`. */
  function lowerThan(a: string, b: string): boolean {
    const [x, y] = [parseVersion(a), parseVersion(b)];
    for (let i = 0; i < 3; i++) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
    }
    return false;
  }

  it('cli/index.ts still installs the fast path while a supported Node lacks the fix', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rootPackage = JSON.parse(
      readFileSync(join(here, '..', '..', '..', '..', '..', 'package.json'), 'utf8'),
    ) as { engines?: { node?: string } };
    const floor = rootPackage.engines?.node;
    expect(floor, 'root package.json declares engines.node').toBeTypeOf('string');
    const stillNeeded =
      NODE_EXPORTS_REPARSE_FIXED_IN === null ||
      lowerThan(floor ?? '0.0.0', NODE_EXPORTS_REPARSE_FIXED_IN);
    if (!stillNeeded) return;
    const entry = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    expect(entry).toMatch(/^installModuleResolveFastPath\(\);$/m);
    expect(entry).toContain("from './module-resolve-fast-path.js'");
  });
});
