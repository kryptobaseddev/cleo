/**
 * Runner script: populate brain_page_nodes and brain_page_edges from all
 * surviving typed table rows in brain.db.
 *
 * Usage:
 *   pnpm dlx tsx scripts/brain-backfill-runner.ts
 *
 * This script delegates to the cleo CLI (packages/cleo/dist/cli/index.js)
 * to ensure the compiled migration path is used, which correctly handles
 * the brain.db migration journal reconciliation.
 *
 * Safe to re-run — duplicate nodes and edges are silently skipped.
 *
 * @task T530
 * @epic T523
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');
const cleoEntry = join(projectRoot, 'packages', 'cleo', 'dist', 'cli', 'index.js');

console.log(`Brain graph back-fill — project root: ${projectRoot}`);
console.log(`CLI: ${cleoEntry}`);
console.log('---');

const proc = spawnSync('node', [cleoEntry, 'brain', 'backfill', '--json'], {
  cwd: projectRoot,
  encoding: 'utf8',
  env: { ...process.env, LOG_LEVEL: 'silent' },
});

if (proc.error) {
  console.error('Back-fill FAILED (spawn error):', proc.error.message);
  process.exit(1);
}

if (proc.stderr) {
  // Print any stderr (node warnings, etc.) to our stderr
  process.stderr.write(proc.stderr);
}

const rawOutput = (proc.stdout ?? '').trim();

// The CLI outputs pretty-printed JSON. Find the start of the JSON object
// by locating the first '{' line, then parse from there to the end.
const lines = rawOutput.split('\n');
const jsonStartIdx = lines.findIndex((l) => l.trim().startsWith('{'));

if (jsonStartIdx === -1) {
  console.error('Back-fill FAILED: No JSON output received');
  if (rawOutput) console.error('Raw stdout:', rawOutput);
  process.exit(1);
}

const jsonText = lines.slice(jsonStartIdx).join('\n');

let result: {
  success: boolean;
  data?: {
    before: {
      nodes: number;
      edges: number;
      decisions: number;
      patterns: number;
      learnings: number;
      observations: number;
      stickyNotes: number;
    };
    after: { nodes: number; edges: number };
    nodesInserted: number;
    edgesInserted: number;
    stubsCreated: number;
    byType: Record<string, number>;
  };
  error?: string;
};

try {
  result = JSON.parse(jsonText) as typeof result;
} catch (parseErr) {
  console.error('Back-fill FAILED: Could not parse JSON output');
  console.error('Raw output:', rawOutput);
  process.exit(1);
}

if (!result.success || !result.data) {
  console.error('Back-fill reported failure:', result.error ?? 'unknown error');
  process.exit(proc.status ?? 1);
}

const { data } = result;

console.log('\n=== BACK-FILL COMPLETE ===');
console.log('\nBefore:');
console.log(`  Nodes:        ${data.before.nodes}`);
console.log(`  Edges:        ${data.before.edges}`);
console.log('\nSource rows processed:');
console.log(`  Decisions:    ${data.before.decisions}`);
console.log(`  Patterns:     ${data.before.patterns}`);
console.log(`  Learnings:    ${data.before.learnings}`);
console.log(`  Observations: ${data.before.observations}`);
console.log(`  Sticky notes: ${data.before.stickyNotes}`);
console.log('\nInserted this run:');
console.log(`  Nodes:        ${data.nodesInserted} (includes ${data.stubsCreated} stub nodes)`);
console.log(`  Edges:        ${data.edgesInserted}`);
console.log('\nAfter:');
console.log(`  Nodes:        ${data.after.nodes}`);
console.log(`  Edges:        ${data.after.edges}`);
console.log('\nBy node type:');
for (const [type, count] of Object.entries(data.byType)) {
  console.log(`  ${type}: ${count}`);
}
