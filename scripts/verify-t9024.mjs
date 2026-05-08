#!/usr/bin/env node
/**
 * Verifier for T9024: Re-evaluate sqlite-native leaf-module invariant for sqlite-pragmas import.
 *
 * AC: sqlite-native.ts can import sqlite-pragmas.ts without breaking the TDZ cycle.
 *   - sqlite-native.ts imports applyPerfPragmas from sqlite-pragmas.ts
 *   - sqlite-pragmas.ts has ONLY type imports from node:sqlite (no CLEO module deps)
 *   - T9024 annotation exists in sqlite-native.ts confirming the decision
 *   - applyPerfPragmas is called in sqlite-native.ts openNativeDatabase function
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const failures = [];

function fail(msg) {
  console.error('FAIL:', msg);
  failures.push(msg);
}

function pass(msg) {
  console.log('PASS:', msg);
}

function readFile(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// Check 1: sqlite-native.ts imports applyPerfPragmas from sqlite-pragmas.ts
// ---------------------------------------------------------------------------
const sqliteNative = readFile('packages/core/src/store/sqlite-native.ts');
if (sqliteNative.includes("import { applyPerfPragmas } from './sqlite-pragmas.js'")) {
  pass('sqlite-native.ts imports applyPerfPragmas from sqlite-pragmas.ts');
} else {
  fail('sqlite-native.ts must import applyPerfPragmas from sqlite-pragmas.ts (T9024)');
}

// ---------------------------------------------------------------------------
// Check 2: sqlite-pragmas.ts has ONLY type imports from node:sqlite — no CLEO module deps
// ---------------------------------------------------------------------------
const sqlitePragmas = readFile('packages/core/src/store/sqlite-pragmas.ts');

// All import lines (not type imports)
const valueImports = sqlitePragmas
  .split('\n')
  .filter(l => l.match(/^import\s+(?!type)/))
  .filter(l => !l.includes("'node:") && !l.includes('"node:'));

if (valueImports.length === 0) {
  pass('sqlite-pragmas.ts has no CLEO module value imports (only node builtins allowed)');
} else {
  fail(`sqlite-pragmas.ts has ${valueImports.length} non-node value imports — TDZ cycle risk:\n  ${valueImports.join('\n  ')}`);
}

// ---------------------------------------------------------------------------
// Check 3: T9024 annotation exists in sqlite-native.ts
// ---------------------------------------------------------------------------
if (sqliteNative.includes('T9024')) {
  pass('T9024 annotation found in sqlite-native.ts confirming invariant decision');
} else {
  fail('No T9024 annotation found in sqlite-native.ts — decision not documented');
}

// ---------------------------------------------------------------------------
// Check 4: applyPerfPragmas called in sqlite-native.ts (not just imported)
// ---------------------------------------------------------------------------
const applyCallsInNative = (sqliteNative.match(/applyPerfPragmas\(/g) || []);
if (applyCallsInNative.length >= 1) {
  pass(`sqlite-native.ts calls applyPerfPragmas ${applyCallsInNative.length} time(s)`);
} else {
  fail('sqlite-native.ts must call applyPerfPragmas() — import without call is a scaffold');
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9024 — sqlite-native leaf-module invariant confirmed for sqlite-pragmas import');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
