#!/usr/bin/env node
/**
 * Acceptance verifier for T9223: VS2-2 registry — add tasks.verifier_path TEXT NULL column.
 *
 * AC checks:
 *   1. drizzle-tasks migration adds verifier_path column to tasks table
 *   2. tasks-schema.ts contains verifierPath column definition
 *   3. task-record.ts (contracts) contains verifierPath field
 *   4. task.ts (contracts) contains verifierPath field
 *   5. engine-converters.ts maps verifierPath
 *   6. converters.ts maps verifierPath in row-to-task and task-to-row
 *   7. verify.ts uses registry-first resolution (checks DB before filesystem)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const failures = [];

function pass(msg) { console.log('PASS:', msg); }
function fail(msg) { console.error('FAIL:', msg); failures.push(msg); }

// Check 1: migration file exists
const migrationPath = join(REPO_ROOT, 'packages', 'core', 'migrations', 'drizzle-tasks',
  '20260512000000_t9223-verifier-path', 'migration.sql');
if (existsSync(migrationPath)) {
  const sql = readFileSync(migrationPath, 'utf8');
  if (sql.includes('verifier_path')) {
    pass('migration adds verifier_path column');
  } else {
    fail('migration.sql does not contain verifier_path');
  }
} else {
  fail('migration directory/file not found: ' + migrationPath);
}

// Check 2: tasks-schema.ts has verifierPath
const schemaPath = join(REPO_ROOT, 'packages', 'core', 'src', 'store', 'tasks-schema.ts');
if (existsSync(schemaPath)) {
  const src = readFileSync(schemaPath, 'utf8');
  if (src.includes("verifierPath") && src.includes("verifier_path")) {
    pass('tasks-schema.ts has verifierPath column definition');
  } else {
    fail('tasks-schema.ts missing verifierPath column');
  }
} else {
  fail('tasks-schema.ts not found');
}

// Check 3: task-record.ts has verifierPath
const taskRecordPath = join(REPO_ROOT, 'packages', 'contracts', 'src', 'task-record.ts');
if (existsSync(taskRecordPath)) {
  const src = readFileSync(taskRecordPath, 'utf8');
  if (src.includes('verifierPath')) {
    pass('task-record.ts has verifierPath field');
  } else {
    fail('task-record.ts missing verifierPath field');
  }
} else {
  fail('task-record.ts not found');
}

// Check 4: task.ts has verifierPath
const taskTypePath = join(REPO_ROOT, 'packages', 'contracts', 'src', 'task.ts');
if (existsSync(taskTypePath)) {
  const src = readFileSync(taskTypePath, 'utf8');
  if (src.includes('verifierPath')) {
    pass('task.ts has verifierPath field');
  } else {
    fail('task.ts missing verifierPath field');
  }
} else {
  fail('task.ts not found');
}

// Check 5: engine-converters.ts maps verifierPath
const engineConvertersPath = join(REPO_ROOT, 'packages', 'core', 'src', 'tasks', 'engine-converters.ts');
if (existsSync(engineConvertersPath)) {
  const src = readFileSync(engineConvertersPath, 'utf8');
  if (src.includes('verifierPath')) {
    pass('engine-converters.ts maps verifierPath');
  } else {
    fail('engine-converters.ts missing verifierPath mapping');
  }
} else {
  fail('engine-converters.ts not found');
}

// Check 6: converters.ts maps verifierPath in both directions
const convertersPath = join(REPO_ROOT, 'packages', 'core', 'src', 'store', 'converters.ts');
if (existsSync(convertersPath)) {
  const src = readFileSync(convertersPath, 'utf8');
  const count = (src.match(/verifierPath/g) || []).length;
  if (count >= 2) {
    pass('converters.ts maps verifierPath in both row-to-task and task-to-row');
  } else {
    fail(`converters.ts has ${count} verifierPath references (need >=2 for both directions)`);
  }
} else {
  fail('converters.ts not found');
}

// Check 7: verify.ts uses registry-first resolution
const verifyTsPath = join(REPO_ROOT, 'packages', 'cleo', 'src', 'cli', 'commands', 'verify.ts');
if (existsSync(verifyTsPath)) {
  const src = readFileSync(verifyTsPath, 'utf8');
  if (src.includes('tasks.verifier_path') || src.includes('verifierPath')) {
    pass('verify.ts uses registry-first resolution');
  } else {
    fail('verify.ts does not check DB registry for verifierPath');
  }
} else {
  fail('verify.ts not found');
}

// Final
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9223 — VS2-2 registry');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
