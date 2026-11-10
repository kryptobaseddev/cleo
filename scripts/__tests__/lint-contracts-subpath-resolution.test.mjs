/**
 * Unit tests for the contracts subpath resolution gate (T14412).
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkSpecifier,
  distTargetToSource,
  findCollisions,
  findSubpathSpecifiers,
  resolveExportsTarget,
  vitestSource,
} from '../lint-contracts-subpath-resolution.mjs';

const SCRIPT = resolve(import.meta.dirname, '..', 'lint-contracts-subpath-resolution.mjs');

/** The real contracts `exports` shape: exact keys plus `./*` and `./*.js` patterns. */
const EXPORTS = {
  '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  './config': { types: './dist/config/index.d.ts', import: './dist/config/index.js' },
  './config.js': { types: './dist/config/index.d.ts', import: './dist/config/index.js' },
  './memory/*': { types: './dist/memory/*.d.ts', import: './dist/memory/*.js' },
  './memory/*.js': { types: './dist/memory/*.d.ts', import: './dist/memory/*.js' },
  './*': { types: './dist/*.d.ts', import: './dist/*.js' },
  './*.js': { types: './dist/*.d.ts', import: './dist/*.js' },
};

/** An `exists` probe over a fixed file list. */
const existsIn = (files) => (rel) => files.includes(rel);

describe('resolveExportsTarget (Node PACKAGE_EXPORTS_RESOLVE)', () => {
  it.each([
    ['config.js', './dist/config/index.js', 'an exact key beats every pattern'],
    ['exit-codes.js', './dist/exit-codes.js', './*.js beats ./* (equal prefix, longer key)'],
    ['exit-codes', './dist/exit-codes.js', 'an extensionless subpath takes ./*'],
    ['memory/observe.js', './dist/memory/observe.js', 'the longer prefix wins'],
    ['operations/tasks.js', './dist/operations/tasks.js', '* spans a slash'],
  ])('%s -> %s (%s)', (subpath, target) => {
    expect(resolveExportsTarget(EXPORTS, subpath, 'import')).toBe(target);
  });

  it('resolves the types condition', () => {
    expect(resolveExportsTarget(EXPORTS, 'config.js', 'types')).toBe('./dist/config/index.d.ts');
  });

  it('returns null for an unexported subpath', () => {
    expect(resolveExportsTarget({ '.': './dist/index.js' }, 'x.js', 'import')).toBeNull();
  });
});

describe('distTargetToSource / vitestSource', () => {
  it('maps dist targets back to their src module', () => {
    expect(distTargetToSource('./dist/config/index.js')).toBe('src/config/index.ts');
    expect(distTargetToSource('./dist/tasks.d.ts')).toBe('src/tasks.ts');
    expect(distTargetToSource('./lib/x.js')).toBeNull();
  });

  it('prefers <base>.ts over <base>/index.ts, as the vitest resolver does', () => {
    const both = existsIn(['src/config.ts', 'src/config/index.ts']);
    expect(vitestSource('config.js', both)).toBe('src/config.ts');
    expect(vitestSource('config.js', existsIn(['src/config/index.ts']))).toBe(
      'src/config/index.ts',
    );
    expect(vitestSource('nope.js', both)).toBeNull();
  });
});

describe('checkSpecifier', () => {
  it('fails the #2772 case: vitest reads src/config.ts, dist resolves config/index.js', () => {
    const problems = checkSpecifier(
      '@cleocode/contracts/config.js',
      EXPORTS,
      existsIn(['src/config.ts', 'src/config/index.ts']),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('but vitest reads src/config.ts');
  });

  it('passes when dist and vitest name the same module', () => {
    const exists = existsIn(['src/config/index.ts', 'src/exit-codes.ts', 'src/memory/observe.ts']);
    for (const spec of ['config.js', 'config', 'exit-codes.js', 'memory/observe.js']) {
      expect(checkSpecifier(`@cleocode/contracts/${spec}`, EXPORTS, exists)).toEqual([]);
    }
  });

  it('fails a subpath with no source', () => {
    expect(checkSpecifier('@cleocode/contracts/gone.js', EXPORTS, existsIn([]))).toContain(
      'no source: neither src/<subpath>.ts nor src/<subpath>/index.ts exists',
    );
  });

  it('fails a subpath the exports map does not export', () => {
    const problems = checkSpecifier(
      '@cleocode/contracts/x.js',
      { '.': './dist/index.js' },
      existsIn(['src/x.ts']),
    );
    expect(problems.some((p) => p.includes('ERR_PACKAGE_PATH_NOT_EXPORTED'))).toBe(true);
  });

  it('fails a directory module whose pattern export misses its index', () => {
    // `./*.js` sends tasks.js to dist/tasks.js, but the source is src/tasks/index.ts.
    const problems = checkSpecifier(
      '@cleocode/contracts/tasks.js',
      EXPORTS,
      existsIn(['src/tasks/index.ts']),
    );
    expect(problems[0]).toContain('./dist/tasks.js, which no src/ file compiles to');
  });
});

describe('findCollisions', () => {
  it('flags x.ts beside x/ and nothing else', () => {
    expect(
      findCollisions([
        'src/config.ts',
        'src/config/index.ts',
        'src/gateway/rpc/index.ts',
        'src/gateway/rpc.ts',
        'src/tasks/index.ts',
        'src/types.d.ts',
      ]),
    ).toEqual([
      { module: 'src/config.ts', dir: 'src/config/' },
      { module: 'src/gateway/rpc.ts', dir: 'src/gateway/rpc/' },
    ]);
  });
});

describe('findSubpathSpecifiers', () => {
  it('finds imports, re-exports, type imports and dynamic imports, not the bare barrel', () => {
    const source = [
      "import { A } from '@cleocode/contracts/a.js';",
      "import type { B } from '@cleocode/contracts/b.js';",
      "export { C } from '@cleocode/contracts/c.js';",
      "const d = await import('@cleocode/contracts/d.js');",
      "type E = import('@cleocode/contracts/e.js').E;",
      "import { F } from '@cleocode/contracts';",
      "import { G } from '@cleocode/core/g.js';",
    ].join('\n');
    expect(findSubpathSpecifiers('x.ts', source).map((h) => [h.line, h.specifier])).toEqual([
      [1, '@cleocode/contracts/a.js'],
      [2, '@cleocode/contracts/b.js'],
      [3, '@cleocode/contracts/c.js'],
      [4, '@cleocode/contracts/d.js'],
      [5, '@cleocode/contracts/e.js'],
    ]);
  });
});

describe('the repository', () => {
  it('passes the gate (no collisions; every subpath import resolves consistently)', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
    expect(out).toContain('lint-contracts-subpath-resolution: OK');
  });
});
