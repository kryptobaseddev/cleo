#!/usr/bin/env node
/**
 * assert-runner.mjs — Reads proof-output.json and asserts all invariants.
 *
 * Called by assertions.sh. Exits 0 on success, 1 on any failure.
 *
 * @task T1112
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    output: { type: 'string' },
  },
  strict: false,
});

const outputPath = args.output;
if (!outputPath) {
  console.error('[T1112] ERROR: --output path required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load proof output
// ---------------------------------------------------------------------------

let output;
try {
  output = JSON.parse(readFileSync(outputPath, 'utf8'));
} catch (err) {
  console.error('[T1112] ERROR: Cannot parse proof-output.json:', err.message);
  process.exit(1);
}

if (!output || typeof output !== 'object') {
  console.error('[T1112] FAIL: proof-output.json is not a valid JSON object');
  process.exit(1);
}

if (!Array.isArray(output.anomalyResults)) {
  console.error('[T1112] FAIL: anomalyResults field missing from proof-output.json');
  process.exit(1);
}

if (!Array.isArray(output.falsePositiveControl)) {
  console.error('[T1112] FAIL: falsePositiveControl field missing from proof-output.json');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Expected assertions (detector type → weight table)
// ---------------------------------------------------------------------------

const EXPECTED_ANOMALIES = [
  {
    anomalyType: 'orphaned-callee',
    expectedSourceId: 'ORPHAN_SINK',
    expectedWeight: 0.3,
    weightLabel: 'base (0.3)',
  },
  {
    anomalyType: 'over-coupled-node',
    expectedSourceId: 'MEGA_HUB',
    expectedWeight: 0.3,
    weightLabel: 'base (0.3)',
  },
  {
    anomalyType: 'community-fragmentation',
    expectedSourceId: 'comm:alpha',
    expectedWeight: 0.4,
    weightLabel: 'fragmentation (0.4)',
  },
  {
    anomalyType: 'entry-erosion',
    expectedSourceId: 'DEAD_PROC',
    expectedWeight: 0.5,
    weightLabel: 'entry-erosion (0.5)',
  },
  {
    anomalyType: 'cross-community-spike',
    expectedSourceId: 'BRIDGE_NODE',
    expectedWeight: 0.35,
    weightLabel: 'cross-coupling (0.35)',
  },
];

const CONTROL_SYMBOLS = ['CLEAN_FUNC', 'CLEAN_CALLER', 'NORMAL_HUB'];

// ---------------------------------------------------------------------------
// Build lookups
// ---------------------------------------------------------------------------

const anomalyByType = new Map(output.anomalyResults.map((r) => [r.anomalyType, r]));
const fpBySourceId = new Map(output.falsePositiveControl.map((r) => [r.sourceId, r]));

let failures = 0;

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

console.log('[T1112] ========================================');
console.log('[T1112]   Sentient Anomaly Proof — Assertions');
console.log('[T1112] ========================================');
console.log('');
console.log(`[T1112] Total candidates from ingester: ${output.totalCandidates}`);
console.log('');

// ---------------------------------------------------------------------------
// Assert: anomaly detection (sourceId + weight per detector type)
// ---------------------------------------------------------------------------

console.log('[T1112] --- Anomaly Detection Assertions ---');
console.log('');

for (const expected of EXPECTED_ANOMALIES) {
  const result = anomalyByType.get(expected.anomalyType);

  if (!result) {
    console.error(`[T1112] FAIL: anomalyType "${expected.anomalyType}" missing from results`);
    failures++;
    continue;
  }

  if (!result.found) {
    console.error(
      `[T1112] FAIL: ${expected.anomalyType} — sourceId "${expected.expectedSourceId}" NOT detected by ingester`,
    );
    failures++;
    continue;
  }

  if (result.expectedSourceId !== expected.expectedSourceId) {
    console.error(
      `[T1112] FAIL: ${expected.anomalyType} — sourceId mismatch: ` +
        `got "${result.expectedSourceId}", want "${expected.expectedSourceId}"`,
    );
    failures++;
    continue;
  }

  if (!result.weightMatched) {
    console.error(
      `[T1112] FAIL: ${expected.anomalyType} — weight mismatch: ` +
        `got ${result.actualWeight}, want ${expected.expectedWeight} (${expected.weightLabel})`,
    );
    failures++;
    continue;
  }

  console.log(`[T1112] PASS: ${expected.anomalyType}`);
  console.log(`         sourceId=${expected.expectedSourceId}  weight=${result.actualWeight}  (${expected.weightLabel})`);
  console.log(`         title: "${result.title}"`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Assert: zero false positives on clean control symbols
// ---------------------------------------------------------------------------

console.log('[T1112] --- Zero-False-Positive Control ---');
console.log('');

for (const cleanId of CONTROL_SYMBOLS) {
  const fpResult = fpBySourceId.get(cleanId);

  if (!fpResult) {
    // Symbol wasn't in the control list at all — treat as passing (correct absence)
    console.log(`[T1112] PASS: ${cleanId} — not in proposals (correct absence)`);
    continue;
  }

  if (fpResult.falsePositive) {
    console.error(`[T1112] FAIL: ${cleanId} appeared in proposals — FALSE POSITIVE`);
    failures++;
  } else {
    console.log(`[T1112] PASS: ${cleanId} — correctly absent from proposals`);
  }
}

// ---------------------------------------------------------------------------
// Weight match table
// ---------------------------------------------------------------------------

console.log('');
console.log('[T1112] ========================================');
console.log('[T1112]   Anomaly → Weight Match Table');
console.log('[T1112] ========================================');
console.log('');

const COL1 = 28;
const COL2 = 16;
const COL3 = 10;
const COL4 = 10;

console.log(
  `${'Anomaly Type'.padEnd(COL1)} ${'sourceId'.padEnd(COL2)} ${'Expected'.padEnd(COL3)} ${'Actual'.padEnd(COL4)} Pass`,
);
console.log(
  `${'-'.repeat(COL1)} ${'-'.repeat(COL2)} ${'-'.repeat(COL3)} ${'-'.repeat(COL4)} -----`,
);

for (const expected of EXPECTED_ANOMALIES) {
  const result = anomalyByType.get(expected.anomalyType) ?? {};
  const actualW = result.actualWeight != null ? result.actualWeight.toFixed(2) : 'N/A';
  const passStr = result.pass ? 'PASS' : 'FAIL';
  console.log(
    `${expected.anomalyType.padEnd(COL1)} ${expected.expectedSourceId.padEnd(COL2)} ${expected.expectedWeight.toFixed(2).padEnd(COL3)} ${actualW.padEnd(COL4)} ${passStr}`,
  );
}

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------

const { summary } = output;
console.log('');
console.log(`[T1112] Anomaly detection: ${summary.anomalyDetectionPassed}/${summary.anomalyDetectionTotal} passed`);
console.log(`[T1112] False positives: ${summary.falsePositivesFailed} (expected 0)`);
console.log('');

if (failures > 0) {
  console.error(`[T1112] ASSERTIONS FAILED: ${failures} failure(s) — see above`);
  process.exit(1);
}

console.log('[T1112] ALL ASSERTIONS PASSED');
process.exit(0);
