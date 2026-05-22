#!/usr/bin/env node
/**
 * T9987 / T10054 — Multi-language smoke runner.
 *
 * Creates three ephemeral fixture repos (Rust, Python, Node) each with a
 * `.worktreeinclude` declaring the language's heavy artifact dir, then
 * exercises the napi `applyInclude` path:
 *
 *   1. Provision a fresh worktree under a temp CLEO_HOME.
 *   2. Confirm declared paths are copied/symlinked into the worktree.
 *   3. Confirm NOT-declared paths are absent.
 *   4. Destroy + clean up.
 *
 * @task T10054
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createWorktree, destroyWorktree } = await import('@cleocode/worktree');

/**
 * @param {string} cwd
 */
function gitInit(cwd) {
  execFileSync('git', ['init', '--initial-branch=main'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'smoke@example.com'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Smoke'], { cwd, stdio: 'pipe' });
}

function gitCommit(cwd) {
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd, stdio: 'pipe' });
}

/**
 * Helper: emit a .gitignore listing the artifact dirs so they stay outside
 * git's index — that's the realistic shape for node_modules, target/, .venv/.
 * Untracked dirs are the ONLY thing .worktreeinclude can carry into a fresh
 * worktree (tracked files come automatically via `git worktree add`).
 *
 * @param {string} dir
 * @param {string[]} entries
 */
function writeGitignore(dir, entries) {
  writeFileSync(join(dir, '.gitignore'), entries.join('\n') + '\n');
}

/**
 * Build a Rust fixture: Cargo.toml + src/main.rs + an UNTRACKED target/
 * (heavy artifact, gitignored), .worktreeinclude listing `target/`.
 */
function rustFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-rust-'));
  writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "fx"\nversion = "0.1.0"\nedition = "2024"\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/main.rs'), 'fn main() { println!("rust fixture"); }\n');
  writeFileSync(join(dir, '.worktreeinclude'), 'target/\n');
  writeGitignore(dir, ['target/', 'tmp-cache/']);

  gitInit(dir);
  gitCommit(dir);

  // Create UNTRACKED artifacts AFTER commit so .worktreeinclude is the only
  // mechanism that can carry them into the worktree.
  mkdirSync(join(dir, 'target', 'debug'), { recursive: true });
  writeFileSync(join(dir, 'target', 'debug', 'fx.bin'), 'BINARY-DATA-PLACEHOLDER');
  mkdirSync(join(dir, 'tmp-cache'));
  writeFileSync(join(dir, 'tmp-cache', 'junk.txt'), 'junk');
  return dir;
}

function pythonFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-py-'));
  writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "fx"\nversion = "0.1.0"\n');
  writeFileSync(join(dir, 'app.py'), 'print("python fixture")\n');
  writeFileSync(join(dir, '.worktreeinclude'), '.venv/\n');
  writeGitignore(dir, ['.venv/', '__pycache__/']);

  gitInit(dir);
  gitCommit(dir);

  mkdirSync(join(dir, '.venv', 'bin'), { recursive: true });
  writeFileSync(join(dir, '.venv', 'bin', 'python'), '#!/usr/bin/env python\n');
  writeFileSync(join(dir, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
  mkdirSync(join(dir, '__pycache__'));
  writeFileSync(join(dir, '__pycache__', 'app.cpython-312.pyc'), 'BYTECODE');
  return dir;
}

function nodeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-node-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fx', version: '0.1.0', private: true }, null, 2),
  );
  writeFileSync(join(dir, 'index.mjs'), 'console.log("node fixture");\n');
  writeFileSync(join(dir, '.worktreeinclude'), 'node_modules/\n');
  writeGitignore(dir, ['node_modules/', 'cache-junk/']);

  gitInit(dir);
  gitCommit(dir);

  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', 'left-pad', 'package.json'),
    '{"name":"left-pad","version":"1.0.0"}\n',
  );
  mkdirSync(join(dir, 'cache-junk'));
  writeFileSync(join(dir, 'cache-junk', 'x.tmp'), 'temp');
  return dir;
}

const cleoHome = mkdtempSync(join(tmpdir(), 'cleo-home-smoke-'));
process.env['CLEO_HOME'] = cleoHome;

/**
 * @typedef {{lang:string, fixtureRoot:string, expectPresent:string[], expectAbsent:string[]}} Spec
 */

/** @type {Spec[]} */
const specs = [
  {
    lang: 'rust',
    fixtureRoot: rustFixture(),
    expectPresent: ['target/debug/fx.bin'],
    expectAbsent: ['tmp-cache/junk.txt'],
  },
  {
    lang: 'python',
    fixtureRoot: pythonFixture(),
    expectPresent: ['.venv/pyvenv.cfg', '.venv/bin/python'],
    expectAbsent: ['__pycache__/app.cpython-312.pyc'],
  },
  {
    lang: 'node',
    fixtureRoot: nodeFixture(),
    expectPresent: ['node_modules/left-pad/package.json'],
    expectAbsent: ['cache-junk/x.tmp'],
  },
];

console.log('# T9987 multi-language smoke');
console.log(`# cleo-home: ${cleoHome}`);
console.log('');

const results = [];
let allPass = true;
for (const spec of specs) {
  const taskId = `T9987-SMOKE-${spec.lang.toUpperCase()}`;
  let result;
  try {
    result = await createWorktree(spec.fixtureRoot, {
      taskId,
      lockWorktree: false,
      applyIncludePatterns: true,
    });
  } catch (err) {
    console.log(`[${spec.lang}] FAIL: createWorktree threw: ${err instanceof Error ? err.message : err}`);
    results.push({ lang: spec.lang, pass: false, error: String(err) });
    allPass = false;
    continue;
  }

  const wtPath = result.path;
  /** @type {{path:string, present:boolean, expectPresent:boolean}[]} */
  const checks = [];

  for (const rel of spec.expectPresent) {
    const p = join(wtPath, rel);
    let exists = false;
    try {
      lstatSync(p);
      exists = true;
    } catch {}
    checks.push({ path: rel, present: exists, expectPresent: true });
  }
  for (const rel of spec.expectAbsent) {
    const p = join(wtPath, rel);
    let exists = false;
    try {
      lstatSync(p);
      exists = true;
    } catch {}
    checks.push({ path: rel, present: exists, expectPresent: false });
  }

  const langPass = checks.every((c) => c.present === c.expectPresent);
  if (!langPass) allPass = false;

  console.log(`[${spec.lang}] taskId=${taskId} wt=${wtPath}`);
  for (const c of checks) {
    const ok = c.present === c.expectPresent;
    console.log(
      `  ${ok ? 'OK' : 'FAIL'}  ${c.expectPresent ? 'expect-present' : 'expect-absent'}  ${c.path}  (actually ${c.present ? 'present' : 'absent'})`,
    );
  }
  console.log(`[${spec.lang}] appliedPatterns=${JSON.stringify(result.appliedPatterns)}`);

  results.push({
    lang: spec.lang,
    pass: langPass,
    taskId,
    appliedPatterns: result.appliedPatterns,
    checks,
  });

  // Cleanup
  try {
    await destroyWorktree(spec.fixtureRoot, {
      taskId,
      deleteBranch: true,
      force: true,
      reason: 'smoke-cleanup',
    });
  } catch {}
  try { rmSync(spec.fixtureRoot, { recursive: true, force: true }); } catch {}
}

try { rmSync(cleoHome, { recursive: true, force: true }); } catch {}

console.log('');
console.log(`# RESULT: ${allPass ? 'PASS' : 'FAIL'}`);
console.log(`JSON_SUMMARY=${JSON.stringify({ task: 'T10054', allPass, results })}`);
process.exit(allPass ? 0 : 1);
