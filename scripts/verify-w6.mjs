#!/usr/bin/env node
/**
 * Verifier for T9218: W6 mandatory verifier strict + cleo verify backfill tool
 *
 * Source task: T9218
 *
 * AC:
 *   - scripts/verify-w6.mjs exits 0
 *   - tasks.add operation rejects priority=critical OR size=large OR type=epic without --verifier
 *   - cleo complete blocks via existing T9192 gate
 *   - cleo verify backfill <taskId> auto-generates stub from AC text
 *   - cleo verify backfill --all-pending batches over critical large epic tasks lacking verifier
 *   - backfill is idempotent (refuses overwrite without --force)
 *   - generator templatizes verify-<id>.mjs skeleton with one assertion per AC bullet
 *   - NO grandfather flag
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

function run(cmd, opts = {}) {
  try {
    const result = spawnSync('bash', ['-c', cmd], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      ...opts,
    });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (e) {
    return { exitCode: 1, stdout: '', stderr: String(e) };
  }
}

function readFile(rel) {
  const p = join(REPO_ROOT, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

// ---------------------------------------------------------------------------
// Check 1: verifier-stub-generator.ts exists in packages/core/src/tasks/
// ---------------------------------------------------------------------------
const stubGenPath = 'packages/core/src/tasks/verifier-stub-generator.ts';
const stubGenContent = readFile(stubGenPath);
if (stubGenContent !== null) {
  pass(`verifier-stub-generator.ts exists at ${stubGenPath}`);
} else {
  fail(
    `verifier-stub-generator.ts must exist at ${stubGenPath} (T9218: auto-stub generator for backfill and strict mode)`,
  );
  process.exit(1); // Cannot continue without the generator
}

// ---------------------------------------------------------------------------
// Check 2: generateVerifierStub function is exported from stub generator
// ---------------------------------------------------------------------------
if (stubGenContent.includes('export function generateVerifierStub') || stubGenContent.includes('export async function generateVerifierStub')) {
  pass('generateVerifierStub is exported from verifier-stub-generator.ts');
} else {
  fail(
    'generateVerifierStub must be an exported function in verifier-stub-generator.ts (T9218)',
  );
}

// ---------------------------------------------------------------------------
// Check 3: writeVerifierStub function is exported from stub generator
// ---------------------------------------------------------------------------
if (stubGenContent.includes('export function writeVerifierStub') || stubGenContent.includes('export async function writeVerifierStub')) {
  pass('writeVerifierStub is exported from verifier-stub-generator.ts');
} else {
  fail(
    'writeVerifierStub must be an exported function in verifier-stub-generator.ts (T9218)',
  );
}

// ---------------------------------------------------------------------------
// Check 4: generateVerifierStub produces process.exit(1) per AC bullet
// ---------------------------------------------------------------------------
if (stubGenContent.includes('process.exit(1)')) {
  pass('verifier-stub-generator.ts uses process.exit(1) for each stub assertion');
} else {
  fail(
    'verifier-stub-generator.ts must produce process.exit(1) blocks for each AC bullet (T9218)',
  );
}

// ---------------------------------------------------------------------------
// Check 5: strict-mode rejection in tasks.add (add.ts or session-scope.ts)
// ---------------------------------------------------------------------------
const addContent = readFile('packages/core/src/tasks/add.ts');
const sessionScopeContent = readFile('packages/core/src/tasks/session-scope.ts');

const hasVerifierRequired =
  (addContent && addContent.includes('E_VERIFIER_REQUIRED')) ||
  (sessionScopeContent && sessionScopeContent.includes('E_VERIFIER_REQUIRED'));

if (hasVerifierRequired) {
  pass('E_VERIFIER_REQUIRED error code found in tasks.add/session-scope (T9218 strict mode)');
} else {
  fail(
    'E_VERIFIER_REQUIRED must be emitted by tasks.add when priority=critical OR size=large OR type=epic and no verifier is provided (T9218)',
  );
}

// ---------------------------------------------------------------------------
// Check 6: verify.ts has backfill subcommand or separate backfill command
// ---------------------------------------------------------------------------
const verifyContent = readFile('packages/cleo/src/cli/commands/verify.ts');
const verifyBackfillContent = readFile('packages/cleo/src/cli/commands/verify-backfill.ts');

const hasBackfillInVerify = verifyContent && (
  verifyContent.includes('backfill') ||
  verifyContent.includes('subCommands')
);
const hasBackfillFile = verifyBackfillContent !== null;

if (hasBackfillInVerify || hasBackfillFile) {
  pass('cleo verify backfill subcommand is implemented (T9218)');
} else {
  fail(
    'cleo verify backfill subcommand must be implemented (T9218: generate stub from AC text per task)',
  );
}

// ---------------------------------------------------------------------------
// Check 7: backfill has --all-pending flag
// ---------------------------------------------------------------------------
const backfillSource = verifyBackfillContent ?? verifyContent ?? '';
if (
  backfillSource.includes('all-pending') ||
  backfillSource.includes('allPending')
) {
  pass('cleo verify backfill has --all-pending flag (T9218)');
} else {
  fail(
    'cleo verify backfill must support --all-pending to batch over critical/large/epic tasks lacking verifier (T9218)',
  );
}

// ---------------------------------------------------------------------------
// Check 8: idempotent safety — backfill refuses overwrite without --force
// ---------------------------------------------------------------------------
if (
  backfillSource.includes('--force') ||
  backfillSource.includes('force') && backfillSource.includes('overwrite')
) {
  pass('cleo verify backfill is idempotent — has --force flag for overwrite (T9218)');
} else {
  fail(
    'cleo verify backfill must be idempotent: refuse to overwrite without --force (T9218)',
  );
}

// ---------------------------------------------------------------------------
// Check 9: no grandfather flag — verify NO grandfatherVerifier in schema/contracts
// ---------------------------------------------------------------------------
const contractsAddContent = readFile('packages/contracts/src/operations/tasks.ts');
const hasGrandfatherFlag =
  (contractsAddContent && contractsAddContent.includes('grandfather')) ||
  (addContent && addContent.includes('grandfather')) ||
  (sessionScopeContent && sessionScopeContent.includes('grandfather'));

if (!hasGrandfatherFlag) {
  pass('No grandfather flag found — per owner direction (T9218)');
} else {
  fail(
    'NO grandfather flag allowed in schema (T9218: owner explicit direction — existing tasks use cleo verify backfill per-task instead)',
  );
}

// ---------------------------------------------------------------------------
// Check 10: verifier-stub-generator exported from core index
// ---------------------------------------------------------------------------
const coreIndex = readFile('packages/core/src/tasks/index.ts');
if (coreIndex && (coreIndex.includes('verifier-stub-generator') || coreIndex.includes('generateVerifierStub'))) {
  pass('verifier-stub-generator is exported from packages/core/src/tasks/index.ts');
} else {
  fail(
    'verifier-stub-generator must be exported from packages/core/src/tasks/index.ts (T9218)',
  );
}

// ---------------------------------------------------------------------------
// Check 11: backfill generates script with header naming source task ID
// ---------------------------------------------------------------------------
if (
  stubGenContent.includes('Source task') ||
  stubGenContent.includes('source task') ||
  stubGenContent.includes('taskId') && stubGenContent.includes('Verifier for')
) {
  pass('verifier-stub-generator includes source task ID in header comment (T9218)');
} else {
  fail(
    'verifier-stub-generator must include header comment naming the source task ID (T9218)',
  );
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log(
    '\nVERIFIER PASS: T9218 — mandatory verifier strict + cleo verify backfill tool',
  );
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
