#!/usr/bin/env node
/**
 * Verifier for T9030: Startup latency benchmark + regression guard.
 *
 * AC:
 *   - scripts/bench/startup-latency.mjs exists
 *   - package.json has bench:startup script
 *   - The bench script documents p50/p95/p99 output shape
 *   - T9030 task annotation present
 *   - baseline.json or BENCH_UPDATE_BASELINE flow documented
 */
import { existsSync, readFileSync } from 'node:fs';
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
// Check 1: scripts/bench/startup-latency.mjs exists
// ---------------------------------------------------------------------------
const benchPath = join(REPO_ROOT, 'scripts/bench/startup-latency.mjs');
if (existsSync(benchPath)) {
  pass('scripts/bench/startup-latency.mjs exists');
} else {
  fail('scripts/bench/startup-latency.mjs does not exist (T9030 not implemented)');
}

// ---------------------------------------------------------------------------
// Check 2: package.json has bench:startup script
// ---------------------------------------------------------------------------
const pkgJson = JSON.parse(readFile('package.json'));
const scripts = pkgJson.scripts ?? {};
if (scripts['bench:startup']) {
  pass(`package.json has bench:startup: "${scripts['bench:startup']}"`);
} else {
  fail('package.json missing bench:startup script (T9030 regression guard entry point)');
}

// ---------------------------------------------------------------------------
// Check 3: bench script has T9030 annotation and p50/p95/p99 output
// ---------------------------------------------------------------------------
if (existsSync(benchPath)) {
  const benchContent = readFile('scripts/bench/startup-latency.mjs');

  if (benchContent.includes('T9030')) {
    pass('startup-latency.mjs has T9030 task annotation');
  } else {
    fail('startup-latency.mjs missing T9030 task annotation');
  }

  if (
    benchContent.includes('p50') &&
    benchContent.includes('p95') &&
    benchContent.includes('p99')
  ) {
    pass('startup-latency.mjs documents p50/p95/p99 output shape');
  } else {
    fail('startup-latency.mjs missing p50/p95/p99 output shape (AC not met)');
  }

  // Check for regression guard (exit 1 on regression)
  // Pattern: process.exit(regression.failed ? 1 : 0) or process.exit(1) directly
  if (
    benchContent.includes('regression') &&
    (benchContent.includes('exit(1)') ||
      benchContent.includes('process.exit(1)') ||
      benchContent.includes('regression.failed ? 1') ||
      benchContent.includes('.failed ? 1 : 0'))
  ) {
    pass('startup-latency.mjs has regression guard (exits 1 on regression)');
  } else {
    fail('startup-latency.mjs missing regression guard (must exit 1 when p50 regresses)');
  }
}

// ---------------------------------------------------------------------------
// Check 4: bench:startup:update-baseline script also exists
// ---------------------------------------------------------------------------
if (scripts['bench:startup:update-baseline']) {
  pass(
    `package.json has bench:startup:update-baseline: "${scripts['bench:startup:update-baseline']}"`,
  );
} else {
  fail(
    'package.json missing bench:startup:update-baseline script (needed to update baseline.json)',
  );
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9030 — startup latency benchmark + regression guard in place');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
