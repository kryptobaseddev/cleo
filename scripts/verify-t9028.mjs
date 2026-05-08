#!/usr/bin/env node
/**
 * Verifier for T9028: One-shot marker for detectAndRemoveLegacy* startup cleanups.
 *
 * AC:
 *   - getCleanupMarkerPath, isCleanupMarkerSet, setCleanupMarker exported from cleanup-legacy.ts
 *   - CLI startup (index.ts) gates detectAndRemoveLegacy* calls behind isCleanupMarkerSet check
 *   - Marker functions have T9028 task annotation
 *   - The one-shot gate is NOT bypassed (detectAndRemoveLegacyGlobalFiles not called unconditionally)
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
// Check 1: cleanup-legacy.ts exports the 3 marker functions
// ---------------------------------------------------------------------------
const cleanupLegacy = readFile('packages/core/src/store/cleanup-legacy.ts');

for (const fn of ['getCleanupMarkerPath', 'isCleanupMarkerSet', 'setCleanupMarker']) {
  if (cleanupLegacy.includes(`export function ${fn}`)) {
    pass(`cleanup-legacy.ts exports ${fn}`);
  } else {
    fail(`cleanup-legacy.ts must export ${fn} (T9028)`);
  }
}

// ---------------------------------------------------------------------------
// Check 2: T9028 annotation present in cleanup-legacy.ts marker functions
// ---------------------------------------------------------------------------
const t9028Count = (cleanupLegacy.match(/T9028/g) || []).length;
if (t9028Count >= 3) {
  pass(`T9028 referenced ${t9028Count} times in cleanup-legacy.ts (at least once per marker fn)`);
} else {
  fail(`Expected >= 3 T9028 references in cleanup-legacy.ts, found ${t9028Count}`);
}

// ---------------------------------------------------------------------------
// Check 3: CLI startup index.ts uses isCleanupMarkerSet gate
// ---------------------------------------------------------------------------
const cliIndex = readFile('packages/cleo/src/cli/index.ts');
if (cliIndex.includes('isCleanupMarkerSet') && cliIndex.includes('!isCleanupMarkerSet(')) {
  pass('CLI startup uses isCleanupMarkerSet gate for one-shot cleanup');
} else {
  fail('CLI startup (index.ts) must use isCleanupMarkerSet() to gate legacy sweep calls (T9028)');
}

// ---------------------------------------------------------------------------
// Check 4: detectAndRemoveLegacyGlobalFiles is inside the !isCleanupMarkerSet block
// The code structure must have detectAndRemoveLegacyGlobalFiles after the gate check
// ---------------------------------------------------------------------------
const markerGateIdx = cliIndex.indexOf('!isCleanupMarkerSet(');
const detectCallIdx = cliIndex.indexOf('detectAndRemoveLegacyGlobalFiles()');
if (markerGateIdx > 0 && detectCallIdx > markerGateIdx) {
  pass('detectAndRemoveLegacyGlobalFiles() called AFTER the isCleanupMarkerSet gate');
} else {
  fail('detectAndRemoveLegacyGlobalFiles() must appear after the !isCleanupMarkerSet() check (T9028)');
}

// ---------------------------------------------------------------------------
// Check 5: setCleanupMarker called after sweep within the gated block
// ---------------------------------------------------------------------------
const setMarkerIdx = cliIndex.indexOf('setCleanupMarker(');
if (setMarkerIdx > detectCallIdx) {
  pass('setCleanupMarker() called after sweep (closing the one-shot gate)');
} else {
  fail('setCleanupMarker() must be called after the sweep completes to close the one-shot gate (T9028)');
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9028 — one-shot marker gates detectAndRemoveLegacy* calls');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
