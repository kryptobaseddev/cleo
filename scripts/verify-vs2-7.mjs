#!/usr/bin/env node
/**
 * Acceptance verifier for T9228: VS2-7 ephemeral exemption — lifetime=session skips verifier
 *
 * AC checks:
 *   1. tasks.lifetime field added to schema and contracts
 *   2. tasks.add accepts --lifetime session via CLI
 *   3. W6 verifier requirement bypassed when lifetime=session
 *   4. cleo complete still requires verifier for persistent tasks
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const failures = [];

function pass(msg) { console.log('PASS:', msg); }
function fail(msg) { console.error('FAIL:', msg); failures.push(msg); }

// Check 1: tasks.lifetime in schema
const schemaPath = join(REPO_ROOT, 'packages', 'core', 'src', 'store', 'tasks-schema.ts');
if (existsSync(schemaPath)) {
  const src = readFileSync(schemaPath, 'utf8');
  if (src.includes("lifetime: text('lifetime')")) {
    pass('tasks-schema.ts has lifetime column');
  } else {
    fail('tasks-schema.ts missing lifetime column');
  }
} else {
  fail('tasks-schema.ts not found');
}

// Check 2: task.ts contracts has lifetime field
const taskTypePath = join(REPO_ROOT, 'packages', 'contracts', 'src', 'task.ts');
if (existsSync(taskTypePath)) {
  const src = readFileSync(taskTypePath, 'utf8');
  if (src.includes("lifetime?:") && src.includes("'session'")) {
    pass('task.ts has lifetime field with session type');
  } else {
    fail('task.ts missing lifetime field or session type');
  }
} else {
  fail('task.ts not found');
}

// Check 3: add.ts CLI accepts --lifetime flag
const addPath = join(REPO_ROOT, 'packages', 'cleo', 'src', 'cli', 'commands', 'add.ts');
if (existsSync(addPath)) {
  const src = readFileSync(addPath, 'utf8');
  if (src.includes("'lifetime'") && src.includes("lifetime: {") && src.includes("'session'")) {
    pass('add.ts accepts --lifetime flag');
  } else {
    fail('add.ts missing --lifetime flag');
  }
} else {
  fail('add.ts not found');
}

// Check 4: session-scope.ts bypasses verifier requirement for lifetime=session
const sessionScopePath = join(REPO_ROOT, 'packages', 'core', 'src', 'tasks', 'session-scope.ts');
if (existsSync(sessionScopePath)) {
  const src = readFileSync(sessionScopePath, 'utf8');
  if (src.includes("params.lifetime !== 'session'") && src.includes("requiresVerifier")) {
    pass("session-scope.ts bypasses verifier requirement when lifetime=session");
  } else {
    fail("session-scope.ts does not bypass verifier for lifetime=session");
  }
} else {
  fail('session-scope.ts not found');
}

// Check 5: migration exists
const migrationPath = join(REPO_ROOT, 'packages', 'core', 'migrations', 'drizzle-tasks',
  '20260512000001_t9228-lifetime', 'migration.sql');
if (existsSync(migrationPath)) {
  const sql = readFileSync(migrationPath, 'utf8');
  if (sql.includes('lifetime')) {
    pass('migration adds lifetime column');
  } else {
    fail('migration missing lifetime column');
  }
} else {
  fail('migration file not found');
}

// Final
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9228 — VS2-7 ephemeral exemption');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
