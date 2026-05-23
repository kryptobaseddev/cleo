/**
 * Tests for scripts/lint-dual-implementation.mjs (T10199 / Saga T10176 / ADR-078).
 *
 * Strategy:
 *   - Create an isolated tmpdir with synthetic crates/ + packages/ subtrees.
 *   - Stage a fake compiled BOUNDARY_REGISTRY under packages/contracts/dist/boundary.js.
 *   - Drive the lint script with that tmpdir as CWD.
 *   - Assert stdout/stderr content and exit codes for each scenario.
 *
 * Cases covered:
 *   - PASS: no Rust crates → no scan, exit 0
 *   - PASS: Rust crate exists but no TS package → no matches, exit 0
 *   - PASS: TS package exists but no Rust crate with same base name → no matches
 *   - PASS: ffi-surface allowlisted via boundary registry (intentional mirror)
 *   - PASS: migration-pending crate (external canonical home) — transitory dupe allowed
 *   - PASS: per-pair inline allowlist with rationale — pair silenced
 *   - FAIL: Rust+TS pair with NO registry allowlist → exit 1 (poison test)
 *   - JSON: --json mode emits parseable summary
 *   - STRICT: --strict surfaces allowed pairs as violations
 *   - REJECT: inline allowlist entry with missing rationale → script errors at load
 *
 * @task T10199
 * @saga T10176 SG-BOUNDARY-REGISTRY
 * @adr ADR-078
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-dual-implementation.mjs');

/** Synthetic project root for each test. */
let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-dual-impl-lint-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Write a fake compiled boundary registry into the tmpdir so the script can
 * import it. The script imports from `packages/contracts/dist/boundary.js`.
 *
 * @param {readonly object[]} entries
 */
function writeRegistry(entries) {
  const distDir = join(tmpRoot, 'packages', 'contracts', 'dist');
  mkdirSync(distDir, { recursive: true });
  const src = `export const BOUNDARY_REGISTRY = ${JSON.stringify(entries, null, 2)};\n`;
  writeFileSync(join(distDir, 'boundary.js'), src);
}

/**
 * Write a Rust source file with one public function.
 *
 * @param {string} crate e.g. `worktrunk-core`
 * @param {string} file relative path inside the crate's src dir, e.g. `git_wt.rs`
 * @param {string} funcName e.g. `list_worktrees`
 * @param {string} [body='']
 */
function writeRustFn(crate, file, funcName, body = '') {
  const crateSrc = join(tmpRoot, 'crates', crate, 'src');
  mkdirSync(crateSrc, { recursive: true });
  const abs = join(crateSrc, file);
  const dirPart = abs.substring(0, abs.lastIndexOf('/'));
  mkdirSync(dirPart, { recursive: true });
  const src =
    `//! Synthetic test file for ${crate}\n` + `pub fn ${funcName}() {\n` + `${body}\n` + `}\n`;
  writeFileSync(abs, src);
}

/**
 * Write a TS package source file with one exported function.
 *
 * @param {string} pkg e.g. `worktree`
 * @param {string} file relative path under packages/<pkg>/src, e.g. `list.ts`
 * @param {string} funcName e.g. `listWorktrees`
 * @param {string} [body='return null;']
 */
function writeTsFn(pkg, file, funcName, body = 'return null;') {
  const pkgSrc = join(tmpRoot, 'packages', pkg, 'src');
  mkdirSync(pkgSrc, { recursive: true });
  const abs = join(pkgSrc, file);
  const dirPart = abs.substring(0, abs.lastIndexOf('/'));
  mkdirSync(dirPart, { recursive: true });
  const src =
    `// Synthetic test file for ${pkg}\n` +
    `export function ${funcName}() {\n` +
    `  ${body}\n` +
    `}\n`;
  writeFileSync(abs, src);
}

/**
 * Run the lint script with tmpRoot as cwd.
 *
 * @param {string[]} [extraArgs=[]]
 */
function runLint(extraArgs = []) {
  return spawnSync('node', [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: tmpRoot,
  });
}

// ============================================================================
// PASS — empty repo
// ============================================================================

describe('lint-dual-implementation — empty / no-overlap repos', () => {
  it('exits 0 when no crates and no packages exist (only registry)', () => {
    writeRegistry([]);
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('exits 0 when only a Rust crate exists (no TS counterpart)', () => {
    writeRegistry([
      {
        module: 'foo-core',
        intent: 'cpu-bound',
        rustCore: 'crates/foo-core',
        canonicalHome: 'cleocode',
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'test',
      },
    ]);
    writeRustFn('foo-core', 'lib.rs', 'do_unique_thing');
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('exits 0 when only a TS package exists (no Rust crate)', () => {
    writeRegistry([]);
    writeTsFn('only-ts-pkg', 'index.ts', 'doSomethingOnlyTs');
    const result = runLint();
    expect(result.status).toBe(0);
  });

  it('exits 0 when crate and package have unrelated symbol names', () => {
    writeRegistry([
      {
        module: 'foo-core',
        intent: 'cpu-bound',
        rustCore: 'crates/foo-core',
        tsWrapper: 'packages/foo',
        canonicalHome: 'cleocode',
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'test',
      },
    ]);
    writeRustFn('foo-core', 'lib.rs', 'do_a');
    writeTsFn('foo', 'index.ts', 'doSomethingElse');
    const result = runLint();
    expect(result.status).toBe(0);
  });
});

// ============================================================================
// FAIL — un-allowlisted dupe (poison test)
// ============================================================================

describe('lint-dual-implementation — un-allowlisted dupes (POISON)', () => {
  it('exits 1 on un-allowlisted Rust+TS dupe (poison test)', () => {
    writeRegistry([
      {
        module: 'widget-core',
        intent: 'cpu-bound',
        rustCore: 'crates/widget-core',
        canonicalHome: 'cleocode',
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'Rust-canonical, no tsWrapper declared',
      },
    ]);
    writeRustFn('widget-core', 'core.rs', 'render_widget');
    writeTsFn('widget', 'render.ts', 'renderWidget');

    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DUAL-IMPLEMENTATION VIOLATION');
    expect(result.stderr).toContain('render_widget');
    expect(result.stderr).toContain('renderWidget');
  });

  it('exits 1 when registry has NO entry for the crate (orphan crate)', () => {
    writeRegistry([]); // empty registry
    writeRustFn('orphan-core', 'lib.rs', 'frobnicate_widget');
    writeTsFn('orphan', 'index.ts', 'frobnicateWidget');

    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no BOUNDARY_REGISTRY entry');
  });

  it('reports remediation hints in failure output', () => {
    writeRegistry([
      {
        module: 'badpair-core',
        intent: 'cpu-bound',
        rustCore: 'crates/badpair-core',
        canonicalHome: 'cleocode',
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'test',
      },
    ]);
    writeRustFn('badpair-core', 'lib.rs', 'process_thing');
    writeTsFn('badpair', 'index.ts', 'processThing');

    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Remediation options');
    expect(result.stderr).toContain('ADR-078');
  });
});

// ============================================================================
// PASS — boundary-registry allowlist (ffi-surface + napiBinding)
// ============================================================================

describe('lint-dual-implementation — boundary-registry allowlist', () => {
  it('allows ffi-surface pair with napiBinding + tsWrapper', () => {
    writeRegistry([
      {
        module: 'wt-napi',
        intent: 'ffi-surface',
        napiBinding: 'crates/wt-napi',
        tsWrapper: 'packages/wt',
        canonicalHome: 'cleocode',
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'thin ffi wrapper',
      },
      {
        module: 'wt-core',
        intent: 'ffi-surface',
        rustCore: 'crates/wt-core',
        napiBinding: 'crates/wt-napi',
        tsWrapper: 'packages/wt',
        canonicalHome: 'cleocode',
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'rust core consumed via napi binding',
      },
    ]);
    writeRustFn('wt-core', 'lib.rs', 'compute_thing');
    writeTsFn('wt', 'compute.ts', 'computeThing');

    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
    expect(result.stdout).toContain('8 match(es)'.replace('8', '1'));
  });

  it('allows tsWrapper-declared pair regardless of intent', () => {
    writeRegistry([
      {
        module: 'shim-core',
        intent: 'cpu-bound',
        rustCore: 'crates/shim-core',
        tsWrapper: 'packages/shim',
        canonicalHome: 'cleocode',
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'declared rust + thin ts wrapper pair',
      },
    ]);
    writeRustFn('shim-core', 'lib.rs', 'shim_op');
    writeTsFn('shim', 'index.ts', 'shimOp');

    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('allows migration-pending crates (external canonical home)', () => {
    writeRegistry([
      {
        module: 'leaving-core',
        intent: 'migration-pending',
        rustCore: 'crates/leaving-core',
        canonicalHome: { external: '/mnt/projects/elsewhere/' },
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'migrating out',
      },
    ]);
    writeRustFn('leaving-core', 'lib.rs', 'leaving_op');
    writeTsFn('leaving', 'index.ts', 'leavingOp');

    const result = runLint();
    expect(result.status).toBe(0);
  });
});

// ============================================================================
// PASS — per-pair inline allowlist
// ============================================================================

describe('lint-dual-implementation — inline allowlist', () => {
  it('honors inline allowlist for a specific Rust+TS pair', () => {
    writeRegistry([
      {
        module: 'collision-core',
        intent: 'cpu-bound',
        rustCore: 'crates/collision-core',
        canonicalHome: 'cleocode',
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'rust canonical',
      },
    ]);
    writeRustFn('collision-core', 'lib.rs', 'name_clash');
    writeTsFn('collision', 'index.ts', 'nameClash');

    const allowlistDir = join(tmpRoot, 'scripts');
    mkdirSync(allowlistDir, { recursive: true });
    writeFileSync(
      join(allowlistDir, '.lint-dual-impl-allowlist.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            rustFile: 'crates/collision-core/src/lib.rs',
            rustName: 'name_clash',
            tsFile: 'packages/collision/src/index.ts',
            tsName: 'nameClash',
            rationale: 'Semantically distinct: rust parses X, ts parses Y',
          },
        ],
      }),
    );

    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('rejects allowlist entries missing rationale', () => {
    writeRegistry([]);
    const allowlistDir = join(tmpRoot, 'scripts');
    mkdirSync(allowlistDir, { recursive: true });
    writeFileSync(
      join(allowlistDir, '.lint-dual-impl-allowlist.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            rustFile: 'crates/x/src/lib.rs',
            rustName: 'foo',
            tsFile: 'packages/y/src/i.ts',
            tsName: 'foo',
            rationale: '',
          },
        ],
      }),
    );

    const result = runLint();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('rationale');
  });

  it('rejects malformed JSON in allowlist', () => {
    writeRegistry([]);
    const allowlistDir = join(tmpRoot, 'scripts');
    mkdirSync(allowlistDir, { recursive: true });
    writeFileSync(join(allowlistDir, '.lint-dual-impl-allowlist.json'), '{ not valid json');

    const result = runLint();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Malformed JSON');
  });
});

// ============================================================================
// --json mode
// ============================================================================

describe('lint-dual-implementation — --json mode', () => {
  it('emits parseable JSON to stdout', () => {
    writeRegistry([]);
    const result = runLint(['--json']);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('gate', 'dual-implementation');
    expect(parsed).toHaveProperty('totals');
    expect(parsed).toHaveProperty('violations');
    expect(parsed).toHaveProperty('allowed');
    expect(Array.isArray(parsed.violations)).toBe(true);
  });

  it('JSON includes violation metadata on a real hit', () => {
    writeRegistry([
      {
        module: 'json-core',
        intent: 'cpu-bound',
        rustCore: 'crates/json-core',
        canonicalHome: 'cleocode',
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'test',
      },
    ]);
    writeRustFn('json-core', 'lib.rs', 'render_json_thing');
    writeTsFn('json', 'index.ts', 'renderJsonThing');

    const result = runLint(['--json']);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.totals.violations).toBe(1);
    const v = parsed.violations[0];
    expect(v.rustName).toBe('render_json_thing');
    expect(v.tsName).toBe('renderJsonThing');
    expect(v.canonical).toBe('renderjsonthing');
    expect(v.reason).toMatch(/declare allowlist|delete the TS dupe/);
  });
});

// ============================================================================
// --strict mode
// ============================================================================

describe('lint-dual-implementation — --strict mode', () => {
  it('exits 1 in strict mode even when only allowlisted pairs exist', () => {
    writeRegistry([
      {
        module: 'strict-core',
        intent: 'ffi-surface',
        rustCore: 'crates/strict-core',
        napiBinding: 'crates/strict-napi',
        tsWrapper: 'packages/strict',
        canonicalHome: 'cleocode',
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'ffi wrapper',
      },
    ]);
    writeRustFn('strict-core', 'lib.rs', 'strict_op');
    writeTsFn('strict', 'index.ts', 'strictOp');

    const result = runLint(['--strict']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Allowlisted');
  });

  it('exits 0 in strict mode when no matches at all', () => {
    writeRegistry([]);
    const result = runLint(['--strict']);
    expect(result.status).toBe(0);
  });
});

// ============================================================================
// Skip patterns
// ============================================================================

describe('lint-dual-implementation — skip patterns', () => {
  it('skips test files in TS scan', () => {
    writeRegistry([
      {
        module: 'skip-core',
        intent: 'cpu-bound',
        rustCore: 'crates/skip-core',
        canonicalHome: 'cleocode',
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'test',
      },
    ]);
    writeRustFn('skip-core', 'lib.rs', 'skip_thing');
    writeTsFn('skip', 'index.test.ts', 'skipThing');

    const result = runLint();
    expect(result.status).toBe(0);
  });

  it('skips .d.ts declaration files in TS scan', () => {
    writeRegistry([
      {
        module: 'dts-core',
        intent: 'cpu-bound',
        rustCore: 'crates/dts-core',
        canonicalHome: 'cleocode',
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'test',
      },
    ]);
    writeRustFn('dts-core', 'lib.rs', 'dts_thing');
    // .d.ts files must NOT be scanned even if they export a function decl.
    const pkgSrc = join(tmpRoot, 'packages', 'dts', 'src');
    mkdirSync(pkgSrc, { recursive: true });
    writeFileSync(join(pkgSrc, 'types.d.ts'), 'export function dtsThing(): void;\n');

    const result = runLint();
    expect(result.status).toBe(0);
  });

  it('skips Rust functions prefixed with underscore', () => {
    writeRegistry([
      {
        module: 'underscore-core',
        intent: 'cpu-bound',
        rustCore: 'crates/underscore-core',
        canonicalHome: 'cleocode',
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'test',
      },
    ]);
    writeRustFn('underscore-core', 'lib.rs', '_internal_helper');
    writeTsFn('underscore', 'index.ts', 'internalHelper');

    const result = runLint();
    expect(result.status).toBe(0);
  });

  it('skips trivial utility names (parse, list, etc.)', () => {
    writeRegistry([
      {
        module: 'util-core',
        intent: 'cpu-bound',
        rustCore: 'crates/util-core',
        canonicalHome: 'cleocode',
        perfBudget: {},
        safetyBudget: {},
        amendments: [],
        rationale: 'test',
      },
    ]);
    writeRustFn('util-core', 'lib.rs', 'parse');
    writeTsFn('util', 'index.ts', 'parse');

    const result = runLint();
    expect(result.status).toBe(0);
  });
});

// ============================================================================
// Boundary registry loading errors
// ============================================================================

describe('lint-dual-implementation — registry loading', () => {
  it('errors when BOUNDARY_REGISTRY is missing', () => {
    // Don't write registry file — script must fail loudly.
    const result = runLint();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Boundary registry not built');
  });
});
