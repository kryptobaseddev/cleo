#!/usr/bin/env node
/**
 * Acceptance verifier for T9229: FISE-3 ADR Bypass-Prevention Substrate
 *
 * AC checks:
 *   1. .cleo/adrs/ADR-071-bypass-prevention-substrate.md filed
 *   2. ADR documents three-layer defense: verifier-backed AC, session-end gate, spawn authorship check
 *   3. ADR references three Lead bypass incidents from 2026-05-08/09/11 campaign
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const failures = [];

function pass(msg) { console.log('PASS:', msg); }
function fail(msg) { console.error('FAIL:', msg); failures.push(msg); }

const adrPath = join(REPO_ROOT, '.cleo', 'adrs', 'ADR-071-bypass-prevention-substrate.md');

// Check 1: ADR file exists
if (existsSync(adrPath)) {
  pass('.cleo/adrs/ADR-071-bypass-prevention-substrate.md exists');
} else {
  fail('.cleo/adrs/ADR-071-bypass-prevention-substrate.md not found');
  // Can't check content if file doesn't exist
  console.error('\nVERIFIER FAIL: 1 check(s) failed');
  process.exit(1);
}

const content = readFileSync(adrPath, 'utf8');

// Check 2: three-layer defense documented
const hasLayer1 = content.includes('Layer 1') && (content.includes('verifier') || content.includes('ADR-070'));
const hasLayer2 = content.includes('Layer 2') && (content.includes('session') || content.includes('FISE-1'));
const hasLayer3 = content.includes('Layer 3') && (content.includes('authorship') || content.includes('spawn') || content.includes('FISE-2'));

if (hasLayer1 && hasLayer2 && hasLayer3) {
  pass('ADR documents three-layer defense (verifier AC, session-end gate, spawn authorship check)');
} else {
  fail(`ADR three-layer defense incomplete: Layer1=${hasLayer1}, Layer2=${hasLayer2}, Layer3=${hasLayer3}`);
}

// Check 3: references bypass incidents from 2026-05-08/09/11
const has0508 = content.includes('2026-05-08') || content.includes('05-08');
const has0509 = content.includes('2026-05-09') || content.includes('05-09');
const has0511 = content.includes('2026-05-11') || content.includes('05-11');

if (has0508 && has0509 && has0511) {
  pass('ADR references bypass incidents from 2026-05-08, 2026-05-09, and 2026-05-11');
} else {
  fail(`ADR missing incident dates: 05-08=${has0508}, 05-09=${has0509}, 05-11=${has0511}`);
}

// Final
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9229 — FISE-3 ADR Bypass-Prevention Substrate');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
