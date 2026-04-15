/**
 * Backfill pipeline_stage for tasks that have no pipeline_stage set.
 *
 * Policy (T719):
 *   status='done'              → 'release'
 *   status='active'            → 'implementation'
 *   type='epic', pending       → 'research'
 *   type!='epic', pending      → 'implementation'
 *   status='cancelled'         → skip (not actionable work)
 *   already has pipeline_stage → skip (idempotent)
 *
 * Uses direct SQLite writes (not cleo CLI) to avoid rate-limiting and
 * to operate atomically on all 98 unassigned tasks in one transaction.
 *
 * Safe to re-run — WHERE pipeline_stage IS NULL ensures idempotency.
 *
 * @task T719
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');
const dbPath = join(projectRoot, '.cleo', 'tasks.db');

interface TaskRow {
  id: string;
  status: string;
  type: string;
  pipeline_stage: string | null;
}

function resolveStage(task: TaskRow): string {
  if (task.status === 'done') return 'release';
  if (task.status === 'active') return 'implementation';
  if (task.type === 'epic') return 'research';
  return 'implementation';
}

function run(): void {
  const db = new Database(dbPath);

  const rows = db
    .prepare(
      `SELECT id, status, type, pipeline_stage
       FROM tasks
       WHERE pipeline_stage IS NULL AND status != 'archived' AND status != 'cancelled'`,
    )
    .all() as TaskRow[];

  if (rows.length === 0) {
    console.log('No tasks with missing pipeline_stage. Nothing to do.');
    db.close();
    return;
  }

  console.log(`Found ${rows.length} tasks with pipeline_stage IS NULL. Backfilling...`);

  const update = db.prepare(
    `UPDATE tasks SET pipeline_stage = ?, updated_at = ? WHERE id = ? AND pipeline_stage IS NULL`,
  );

  const now = new Date().toISOString();

  const counts: Record<string, number> = {};

  const runAll = db.transaction(() => {
    for (const task of rows) {
      const stage = resolveStage(task);
      update.run(stage, now, task.id);
      counts[stage] = (counts[stage] ?? 0) + 1;
    }
  });

  runAll();

  console.log('Backfill complete. Stage distribution applied:');
  for (const [stage, count] of Object.entries(counts).sort()) {
    console.log(`  ${stage}: ${count}`);
  }

  // Verify
  const remaining = (
    db
      .prepare(
        `SELECT count(*) as cnt FROM tasks WHERE pipeline_stage IS NULL AND status != 'archived' AND status != 'cancelled'`,
      )
      .get() as { cnt: number }
  ).cnt;

  if (remaining > 0) {
    console.error(`ERROR: ${remaining} tasks still have pipeline_stage IS NULL after backfill!`);
    process.exit(1);
  }

  const total = (
    db
      .prepare(
        `SELECT pipeline_stage, count(*) as cnt FROM tasks WHERE status != 'archived' GROUP BY pipeline_stage ORDER BY cnt DESC`,
      )
      .all() as Array<{ pipeline_stage: string | null; cnt: number }>
  );

  console.log('\nFinal pipeline_stage distribution (non-archived):');
  for (const row of total) {
    console.log(`  ${row.pipeline_stage ?? 'NULL'}: ${row.cnt}`);
  }

  db.close();
}

run();
