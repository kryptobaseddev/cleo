/**
 * Runner script for brain.db noise purge.
 *
 * Usage:
 *   pnpm dlx tsx scripts/brain-purge-runner.ts
 *
 * SAFETY: Take a backup first with `cleo backup add` before running.
 *
 * @task T524
 */

import { purgeBrainNoise } from '../packages/core/src/memory/brain-purge.js';

const projectRoot = process.cwd();

console.log(`Brain purge starting — project root: ${projectRoot}`);
console.log('---');

try {
  const result = await purgeBrainNoise(projectRoot);

  console.log('\n=== PURGE COMPLETE ===');
  console.log(`Patterns deleted:     ${result.patternsDeleted}`);
  console.log(`Learnings deleted:    ${result.learningsDeleted}`);
  console.log(`Decisions deleted:    ${result.decisionsDeleted}`);
  console.log(`Observations deleted: ${result.observationsDeleted}`);
  console.log('\nPost-purge state:');
  console.log(`  Patterns:     ${result.after.patterns}`);
  console.log(`  Learnings:    ${result.after.learnings}`);
  console.log(`  Decisions:    ${result.after.decisions}`);
  console.log(`  Observations: ${result.after.observations}`);
  console.log(`  FTS5 rebuilt: ${result.fts5Rebuilt}`);
} catch (err) {
  console.error('Purge FAILED:', err);
  process.exit(1);
}
