#!/usr/bin/env node
/**
 * Verifier for T9072: W2 — Hard-rename --role to --kind everywhere (NO backwards compat).
 *
 * AC:
 *   - No --role flag definition in add.ts, update.ts CLI commands
 *   - --kind is the canonical flag (defined as a key in the args object)
 *   - T9072 annotation in at least one of the changed files
 *   - agent.ts error message references --role as a fix suggestion is acceptable (it's a user-facing error)
 *     but there must be NO --role *option definition* in task commands
 *
 * NEGATIVE SPACE: The check is for flag DEFINITIONS, not string mentions.
 * "role" in error messages / comments is fine; "role:" as a flag key is not.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
// Check 1: add.ts has NO 'role:' flag definition (object key in args definition)
// ---------------------------------------------------------------------------
const addTs = readFile('packages/cleo/src/cli/commands/add.ts');

// Look for role as an object key in an args/options object (not in comments or strings)
const addRoleAsKey = addTs.match(/^\s+role:\s*\{/m);
if (!addRoleAsKey) {
  pass('add.ts has no "role:" flag definition (properly renamed to --kind)');
} else {
  fail('add.ts still has "role:" as a flag definition — T9072 not complete');
}

// Verify kind: IS defined as a flag
const addKindDefined = addTs.match(/^\s+kind:\s*\{/m);
if (addKindDefined) {
  pass('add.ts has "kind:" flag definition (T9072 canonical flag)');
} else {
  fail('add.ts missing "kind:" flag definition (--kind must be canonical per T9072)');
}

// ---------------------------------------------------------------------------
// Check 2: update.ts has NO 'role:' flag definition
// ---------------------------------------------------------------------------
const updateTs = readFile('packages/cleo/src/cli/commands/update.ts');
const updateRoleAsKey = updateTs.match(/^\s+role:\s*\{/m);
if (!updateRoleAsKey) {
  pass('update.ts has no "role:" flag definition (properly renamed to --kind)');
} else {
  fail('update.ts still has "role:" as a flag definition — T9072 not complete');
}

// ---------------------------------------------------------------------------
// Check 3: T9072 annotation referenced in add.ts or update.ts
// ---------------------------------------------------------------------------
if (addTs.includes('T9072') || updateTs.includes('T9072')) {
  pass('T9072 annotation found in add.ts or update.ts');
} else {
  fail('Missing T9072 annotation in add.ts or update.ts');
}

// ---------------------------------------------------------------------------
// Check 4: No active --role flag in generated command manifest
// ---------------------------------------------------------------------------
const manifest = readFile('packages/cleo/src/cli/generated/command-manifest.ts');

// Look for 'role' as an argument name in manifest entries for add/update commands
// This is a LAFS-safe check: the manifest shouldn't list --role as an arg for add/update
const manifestHasRoleForTaskCmds = manifest.match(
  /(?:name: 'add'|name: 'update')[\s\S]{0,1000}name: 'role'/,
);
if (!manifestHasRoleForTaskCmds) {
  pass('Command manifest does not list --role as an arg for add/update commands');
} else {
  fail('Command manifest still lists --role for add/update — T9072 not fully implemented');
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9072 — --role renamed to --kind with no backwards compat alias');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
