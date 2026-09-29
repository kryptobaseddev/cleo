/**
 * Tests for `scripts/lint-no-esm-bare-require.mjs` (T12704).
 *
 * Proves a bare `require(` in an ESM package fails, the remedies pass, text in
 * comments, strings and template literals is not a violation (code inside
 * `${…}` still is), CommonJS packages and tests are out of scope, the baseline
 * ratchets, and the real repository passes.
 *
 * @task T12704
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASELINE, findBareRequires, runGate } from '../lint-no-esm-bare-require.mjs';

const SCRIPT = 'scripts/lint-no-esm-bare-require.mjs';

describe('findBareRequires', () => {
  it.each([
    "const { writeFileSync } = require('node:fs');",
    "const entries = (require('node:fs').readdirSync(dir) as string[]);",
    "const x = cond ? require('a') : null;",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    'const s = `${require("node:os").EOL}`;',
  ])('flags %s', (src) => {
    expect(findBareRequires(src)).toHaveLength(1);
  });

  it.each([
    "import { writeFileSync } from 'node:fs';",
    "const m = await import('node:fs');",
    "// require('node:fs') used to be here",
    "/* require('node:fs') */ const y = 1;",
    'const hint = "run node -e \\"require(\'node:crypto\')\\"";',
    "const script = String.raw`\nconst { spawn } = require('node:child_process');\n`;",
    "const r = createRequire(import.meta.url); r('x'); my_require('z');",
    "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nrequire('ajv');",
  ])('does not flag %s', (src) => {
    expect(findBareRequires(src)).toEqual([]);
  });

  it('reports the right line after a block comment and a multi-line template', () => {
    const src = '/*\n * doc\n */\nconst t = `a\nb`;\nconst x = require("y");\n';
    expect(findBareRequires(src)[0]?.line).toBe(6);
  });
});

describe('findBareRequires — review gaps', () => {
  it.each([
    "const p = require.resolve('ajv');",
    "const m = require?.('node:fs');",
    'const r = require;',
    "const m = module.require('node:fs');",
    'load(require);',
  ])('flags every free reference: %s', (src) => {
    expect(findBareRequires(src)).toHaveLength(1);
  });

  it.each([
    "if (typeof require !== 'undefined') {}",
    "const exportsMap = { import: './a.mjs', require: './a.cjs' };",
    'interface Entry { import?: string; require?: string }',
    'const x = pkg.require; const y = my_require(1); const z = $require(2);',
  ])('does not flag a non-reference: %s', (src) => {
    expect(findBareRequires(src)).toEqual([]);
  });

  it('a top-level createRequire binding exempts the whole file', () => {
    const src =
      "import { createRequire } from 'node:module';\n" +
      'const require = createRequire(import.meta.url);\n' +
      "function a() { return require('x'); }\n" +
      "const b = require.resolve('y');\n";
    expect(findBareRequires(src)).toEqual([]);
  });

  it('a function-local binding exempts only that function', () => {
    const src =
      'function load() {\n' +
      '  const require = createRequire(import.meta.url);\n' +
      "  return require('ajv');\n" +
      '}\n' +
      "export const fs = require('node:fs');\n";
    const hits = findBareRequires(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(5);
  });

  it('blanks regex literals but still treats division as code', () => {
    expect(findBareRequires("const re = /require\\('x'\\)/g;")).toEqual([]);
    expect(findBareRequires('const re = [/[/]require(/, 1];')).toEqual([]);
    expect(findBareRequires("const half = total / 2; const m = require('y') / 2;")).toHaveLength(1);
  });
});

describe('runGate', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'esm-bare-require-gate-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Write a file under the temp repo root. */
  function put(rel, content) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  /** Declare a package with the given module type. */
  function pkg(name, type) {
    put(`packages/${name}/package.json`, JSON.stringify(type ? { name, type } : { name }));
  }

  it('fails on a bare require in an ESM package and names file:line', () => {
    pkg('core', 'module');
    put('packages/core/src/a.ts', "export const a = 1;\nconst { x } = require('node:fs');\n");
    const result = runGate(root);
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain('packages/core/src/a.ts:2');
  });

  it('passes the remedies', () => {
    pkg('core', 'module');
    put(
      'packages/core/src/a.ts',
      "import { x } from 'node:fs';\nconst y = await import('node:os');\n",
    );
    expect(runGate(root).ok).toBe(true);
  });

  it('ignores CommonJS packages, tests and __tests__', () => {
    pkg('core', 'module');
    put('packages/core/src/ok.ts', 'export const ok = 1;\n');
    put('packages/core/src/a.test.ts', "require('node:fs');\n");
    put('packages/core/src/__tests__/b.ts', "require('node:fs');\n");
    pkg('cant');
    put('packages/cant/src/native-loader.ts', "require('./napi/index.cjs');\n");
    expect(runGate(root)).toMatchObject({ ok: true, scanned: 1 });
  });

  it('allows a baselined count, fails above it, and --strict ignores it', () => {
    const [rel, count] = Object.entries(BASELINE)[0];
    pkg(rel.split('/')[1], 'module');
    put(rel, "const a = require('./x.js');\n".repeat(count));
    expect(runGate(root).ok).toBe(true);
    expect(runGate(root, { strict: true }).ok).toBe(false);
    put(rel, "const a = require('./x.js');\n".repeat(count + 1));
    expect(runGate(root).ok).toBe(false);
  });

  it('fails when there is nothing to scan', () => {
    expect(runGate(root)).toMatchObject({ ok: false, scanned: 0 });
  });
});

describe('the real repository', () => {
  it('passes the gate', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/OK — \d+ ESM source file/);
  });
});
