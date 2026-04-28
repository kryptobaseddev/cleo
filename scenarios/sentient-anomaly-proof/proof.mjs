#!/usr/bin/env node
/**
 * proof.mjs — Sentient Tier-2 real-world proof script.
 *
 * Injects deliberate anomalies into an in-memory nexus.db, runs the
 * runNexusIngester directly, and writes a structured JSON result that
 * assertions.sh can validate.
 *
 * Anomaly types verified:
 *   A. orphaned-callee       → ProposalCandidate, sourceId=ORPHAN_SINK, weight=0.3
 *   B. over-coupled-node     → ProposalCandidate, sourceId=MEGA_HUB, weight=0.3
 *   C. community-frag        → ProposalCandidate, sourceId=comm:alpha, weight=0.4
 *   D. entry-erosion         → ProposalCandidate, sourceId=DEAD_PROC, weight=0.5
 *   E. cross-community-spike → ProposalCandidate, sourceId=BRIDGE_NODE, weight=0.35
 *
 * Zero-false-positive control:
 *   CLEAN_FUNC, NORMAL_HUB — must NOT appear in proposals.
 *
 * @task T1112
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    'project-root': { type: 'string' },
    output: { type: 'string' },
  },
  strict: false,
});

const projectRoot = args['project-root'] ?? process.cwd();
const outputPath = args['output'] ?? join(__dirname, 'proof-output.json');

// ---------------------------------------------------------------------------
// Resolve dist/ imports using createRequire (ESM compat)
// ---------------------------------------------------------------------------

const distPath = join(projectRoot, 'packages', 'core', 'dist');

// We use dynamic import() to load the ESM dist module.
const ingesterPath = new URL(
  `file://${join(distPath, 'sentient', 'ingesters', 'nexus-ingester.js')}`,
).href;

console.log('[T1112] Loading nexus-ingester from:', ingesterPath);

const {
  runNexusIngester,
  NEXUS_BASE_WEIGHT,
  NEXUS_COMMUNITY_FRAGMENTATION_WEIGHT,
  NEXUS_ENTRY_EROSION_WEIGHT,
  NEXUS_CROSS_COUPLING_WEIGHT,
} = await import(ingesterPath);

console.log('[T1112] Ingester loaded successfully');
console.log(`[T1112] Constants: BASE=${NEXUS_BASE_WEIGHT}, FRAG=${NEXUS_COMMUNITY_FRAGMENTATION_WEIGHT}, EROSION=${NEXUS_ENTRY_EROSION_WEIGHT}, CROSS=${NEXUS_CROSS_COUPLING_WEIGHT}`);

// ---------------------------------------------------------------------------
// Load fixture seed helpers
// ---------------------------------------------------------------------------

const { createNexusTables, insertNode, insertRelation, seedAnomalies } = await import(
  new URL(`file://${join(__dirname, 'fixtures', 'anomaly-seed.mjs')}`).href
);

// ---------------------------------------------------------------------------
// Create in-memory nexus DB and seed anomalies
// ---------------------------------------------------------------------------

console.log('\n[T1112] Creating in-memory nexus DB...');
const db = new DatabaseSync(':memory:');
createNexusTables(db);
seedAnomalies(db);
console.log('[T1112] Anomalies seeded into in-memory nexus DB');

// Verify seeded node count
const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nexus_nodes').get();
const relCount = db.prepare('SELECT COUNT(*) as c FROM nexus_relations').get();
console.log(`[T1112]   Nodes: ${nodeCount.c}, Relations: ${relCount.c}`);

// ---------------------------------------------------------------------------
// Run the nexus ingester
// ---------------------------------------------------------------------------

console.log('\n[T1112] Running runNexusIngester on anomalous DB...');
const candidates = runNexusIngester(db);
console.log(`[T1112] Ingester returned ${candidates.length} proposal candidate(s)`);

// ---------------------------------------------------------------------------
// Analyze results
// ---------------------------------------------------------------------------

const expectedAnomalies = [
  {
    anomalyType: 'orphaned-callee',
    detectorQuery: 'A',
    expectedSourceId: 'ORPHAN_SINK',
    expectedWeight: NEXUS_BASE_WEIGHT,
    expectedWeightLabel: '0.3 (base)',
    description: 'Function orphanedSink: 6 callers, zero outbound calls',
  },
  {
    anomalyType: 'over-coupled-node',
    detectorQuery: 'B',
    expectedSourceId: 'MEGA_HUB',
    expectedWeight: NEXUS_BASE_WEIGHT,
    expectedWeightLabel: '0.3 (base)',
    description: 'Function megaHub: 25 outbound edges (>20 threshold)',
  },
  {
    anomalyType: 'community-fragmentation',
    detectorQuery: 'C',
    expectedSourceId: 'comm:alpha',
    expectedWeight: NEXUS_COMMUNITY_FRAGMENTATION_WEIGHT,
    expectedWeightLabel: '0.4 (fragmentation)',
    description: 'Community comm:alpha: 7 symbols (was 10) → 30% drop > 20%',
  },
  {
    anomalyType: 'entry-erosion',
    detectorQuery: 'D',
    expectedSourceId: 'DEAD_PROC',
    expectedWeight: NEXUS_ENTRY_EROSION_WEIGHT,
    expectedWeightLabel: '0.5 (entry-erosion)',
    description: 'Process deadProcess points to unexported hiddenEntry',
  },
  {
    anomalyType: 'cross-community-spike',
    detectorQuery: 'E',
    expectedSourceId: 'BRIDGE_NODE',
    expectedWeight: NEXUS_CROSS_COUPLING_WEIGHT,
    expectedWeightLabel: '0.35 (cross-coupling)',
    description: 'bridgeNode: degree 32, 17 cross-community edges to comm:epsilon',
  },
];

const controlSymbols = ['CLEAN_FUNC', 'CLEAN_CALLER', 'NORMAL_HUB'];

// Build lookup by sourceId
const bySourceId = new Map(candidates.map((c) => [c.sourceId, c]));

const results = [];

console.log('\n[T1112] === Anomaly Detection Results ===\n');

for (const expected of expectedAnomalies) {
  const found = bySourceId.get(expected.expectedSourceId);
  const matched = found !== undefined;
  const weightMatch = found ? Math.abs(found.weight - expected.expectedWeight) < 0.001 : false;

  results.push({
    anomalyType: expected.anomalyType,
    detectorQuery: expected.detectorQuery,
    expectedSourceId: expected.expectedSourceId,
    expectedWeight: expected.expectedWeight,
    expectedWeightLabel: expected.expectedWeightLabel,
    description: expected.description,
    found: matched,
    actualWeight: found?.weight ?? null,
    weightMatched: weightMatch,
    title: found?.title ?? null,
    pass: matched && weightMatch,
  });

  const status = matched && weightMatch ? 'PASS' : 'FAIL';
  console.log(`[T1112] [${status}] Query ${expected.detectorQuery}: ${expected.anomalyType}`);
  console.log(`         sourceId=${expected.expectedSourceId}`);
  console.log(`         expectedWeight=${expected.expectedWeight} (${expected.expectedWeightLabel})`);
  if (found) {
    console.log(`         actualWeight=${found.weight}, title="${found.title}"`);
  } else {
    console.log(`         NOT FOUND in proposals`);
  }
  console.log('');
}

// Zero-false-positive control check
console.log('[T1112] === Zero-False-Positive Control ===\n');

const fpResults = [];
for (const cleanId of controlSymbols) {
  const found = bySourceId.has(cleanId);
  fpResults.push({ sourceId: cleanId, falsePositive: found });
  const status = found ? 'FAIL (false positive)' : 'PASS (no false positive)';
  console.log(`[T1112] [${status}] ${cleanId}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const totalAnomaly = results.length;
const passedAnomaly = results.filter((r) => r.pass).length;
const fpFailed = fpResults.filter((r) => r.falsePositive).length;
const overallPass = passedAnomaly === totalAnomaly && fpFailed === 0;

console.log('\n[T1112] === Summary ===');
console.log(`[T1112] Anomaly detection: ${passedAnomaly}/${totalAnomaly} passed`);
console.log(`[T1112] False positives: ${fpFailed} (expected 0)`);
console.log(`[T1112] Overall: ${overallPass ? 'PASS' : 'FAIL'}`);

// ---------------------------------------------------------------------------
// Write JSON output for assertions.sh
// ---------------------------------------------------------------------------

const output = {
  schemaVersion: '1.0',
  task: 'T1112',
  timestamp: new Date().toISOString(),
  totalCandidates: candidates.length,
  candidates: candidates.map((c) => ({
    source: c.source,
    sourceId: c.sourceId,
    weight: c.weight,
    title: c.title,
  })),
  anomalyResults: results,
  falsePositiveControl: fpResults,
  summary: {
    anomalyDetectionPassed: passedAnomaly,
    anomalyDetectionTotal: totalAnomaly,
    falsePositivesFailed: fpFailed,
    overallPass,
  },
};

// Ensure output directory exists
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`\n[T1112] Output written to: ${outputPath}`);

// Exit 0 on success, 1 on failure
if (!overallPass) {
  console.error('\n[T1112] PROOF FAILED — see above for details');
  process.exit(1);
}

console.log('\n[T1112] PROOF PASSED — all anomaly detections correct, zero false positives');
process.exit(0);
