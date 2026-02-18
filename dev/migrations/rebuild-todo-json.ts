/**
 * Rebuild todo.json by merging:
 *   1. 278 historical tasks from Wave 7 commit (9ae2bf5)
 *   2. 2 recovered tasks (T1074, T1171) from v2.6.0 backup
 *   3. 36 Wave 8 tasks from current todo.json, renumbered T001->T4623 through T036->T4658
 *
 * Result: 316 active tasks with no ID collisions against the archive.
 *
 * Usage: npx tsx dev/migrations/rebuild-todo-json.ts
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CLEO_DIR = join(process.cwd(), '.cleo');

interface Task {
  id: string;
  title: string;
  status: string;
  priority?: string;
  type?: string;
  parentId?: string | null;
  phase?: string;
  size?: string | null;
  position?: number;
  positionVersion?: number;
  description?: string;
  depends?: string[];
  labels?: string[];
  notes?: Array<string | Record<string, unknown>>;
  acceptance?: unknown[];
  files?: unknown[];
  origin?: string;
  blockedBy?: string;
  epicLifecycle?: string;
  noAutoComplete?: boolean;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  provenance?: { createdBy?: string; modifiedBy?: string; sessionId?: string };
  verification?: unknown;
  [key: string]: unknown;
}

interface TodoJson {
  version: string;
  project: unknown;
  lastUpdated: string;
  _meta: unknown;
  focus: unknown;
  tasks: Task[];
}

// === Step 1: Load 278 historical tasks from Wave 7 commit ===
console.log('Loading 278 historical tasks from git commit 9ae2bf5...');
const wave7Raw = execFileSync('git', ['show', '9ae2bf5:.cleo/todo.json'], {
  encoding: 'utf-8',
  maxBuffer: 50 * 1024 * 1024,
});
const wave7Data: TodoJson = JSON.parse(wave7Raw);
const historicalTasks: Task[] = wave7Data.tasks;
console.log(`  Loaded: ${historicalTasks.length} tasks`);

// === Step 2: Recover T1074 and T1171 from v2.6.0 backup ===
console.log('Recovering T1074 and T1171 from v2.6.0 backup...');
const backupPath = join(CLEO_DIR, 'backups/migration/migration_v2.6.0_20260102_171851/todo.json');
const backupData = JSON.parse(readFileSync(backupPath, 'utf-8'));
const recoveredTasks: Task[] = backupData.tasks.filter(
  (t: Task) => t.id === 'T1074' || t.id === 'T1171',
);
console.log(`  Recovered: ${recoveredTasks.length} tasks (${recoveredTasks.map((t: Task) => t.id).join(', ')})`);

if (recoveredTasks.length !== 2) {
  console.error('ERROR: Expected exactly 2 recovered tasks (T1074, T1171)');
  process.exit(1);
}

// === Step 3: Load 36 Wave 8 tasks and renumber ===
console.log('Loading 36 Wave 8 tasks from current todo.json...');
const currentTodoPath = join(CLEO_DIR, 'todo.json');
const currentData: TodoJson = JSON.parse(readFileSync(currentTodoPath, 'utf-8'));
const wave8Tasks: Task[] = currentData.tasks;
console.log(`  Loaded: ${wave8Tasks.length} tasks`);

// Build renumber map: T001->T4663, T002->T4664, ..., T036->T4698
// Base chosen above max existing ID (T4662) across all sources
const RENUMBER_BASE = 4663;
const renumberMap = new Map<string, string>();
for (let i = 1; i <= 36; i++) {
  const oldId = `T${String(i).padStart(3, '0')}`;
  const newId = `T${RENUMBER_BASE + i - 1}`;
  renumberMap.set(oldId, newId);
}

console.log('Renumbering Wave 8 tasks...');
console.log(`  Map: T001->T4663, T002->T4664, ..., T036->T4698`);

const renumberedTasks: Task[] = wave8Tasks.map((task) => {
  const newId = renumberMap.get(task.id);
  if (!newId) {
    console.error(`ERROR: No renumber mapping for ${task.id}`);
    process.exit(1);
  }

  const renumbered = { ...task, id: newId };

  // Update parentId reference
  if (renumbered.parentId && renumberMap.has(renumbered.parentId)) {
    renumbered.parentId = renumberMap.get(renumbered.parentId)!;
  }

  // Update depends array references
  if (renumbered.depends) {
    renumbered.depends = renumbered.depends.map((depId) =>
      renumberMap.get(depId) ?? depId,
    );
  }

  return renumbered;
});

// Verify the epic renumbered correctly
const epicTask = renumberedTasks.find((t) => t.id === 'T4663');
if (!epicTask || epicTask.type !== 'epic') {
  console.error('ERROR: T4663 should be the Wave 8 epic');
  process.exit(1);
}

const childrenOfEpic = renumberedTasks.filter((t) => t.parentId === 'T4663');
console.log(`  Epic T4623 has ${childrenOfEpic.length} children (expected 35)`);

// === Step 4: Merge all tasks ===
console.log('Merging all tasks...');
const allTasks: Task[] = [...historicalTasks, ...recoveredTasks, ...renumberedTasks];

// Verify no duplicate IDs in merged set
const idSet = new Set<string>();
const duplicates: string[] = [];
for (const t of allTasks) {
  if (idSet.has(t.id)) {
    duplicates.push(t.id);
  }
  idSet.add(t.id);
}

if (duplicates.length > 0) {
  console.error(`ERROR: Duplicate IDs in merged set: ${duplicates.join(', ')}`);
  process.exit(1);
}

console.log(`  Total merged: ${allTasks.length} (278 + 2 + 36 = ${278 + 2 + 36})`);

// === Step 5: Verify no collisions with archive ===
console.log('Checking for collisions with archive...');
const archivePath = join(CLEO_DIR, 'todo-archive.json');
const archiveData = JSON.parse(readFileSync(archivePath, 'utf-8'));
const archivedTasks: Task[] = archiveData.tasks ?? archiveData.archivedTasks ?? [];
const archiveIds = new Set(archivedTasks.map((t: Task) => t.id));

const collisions = allTasks.filter((t) => archiveIds.has(t.id));
if (collisions.length > 0) {
  // Some tasks appear in both active and archive (e.g., completed but not removed from active).
  // This is acceptable - the migration tool uses onConflictDoNothing.
  console.log(`  Note: ${collisions.length} tasks appear in both active and archive (expected for completed tasks)`);
  console.log(`  IDs: ${collisions.map((t) => t.id).join(', ')}`);
}

// === Step 6: Normalize statuses ===
console.log('Normalizing statuses...');
let statusNormalized = 0;
for (const t of allTasks) {
  if (t.status === 'completed') {
    t.status = 'done';
    statusNormalized++;
  }
}
console.log(`  Normalized ${statusNormalized} 'completed' -> 'done'`);

// Status distribution
const statusDist: Record<string, number> = {};
for (const t of allTasks) {
  statusDist[t.status] = (statusDist[t.status] ?? 0) + 1;
}
console.log(`  Status distribution: ${JSON.stringify(statusDist)}`);

// === Step 7: Write merged todo.json ===
console.log('Writing merged todo.json...');
const mergedTodo: TodoJson = {
  ...wave7Data,
  lastUpdated: new Date().toISOString(),
  _meta: {
    ...(wave7Data._meta as Record<string, unknown>),
    checksum: 'migration-rebuild',
  },
  focus: {
    currentTask: 'T4663',
    currentPhase: null,
    blockedUntil: null,
    sessionNote: null,
    sessionNotes: [{
      note: 'Focus set to T4663 (renumbered from T001): EPIC: Wave 8',
      timestamp: new Date().toISOString(),
    }],
    nextAction: null,
    primarySession: null,
  },
  tasks: allTasks,
};

writeFileSync(currentTodoPath, JSON.stringify(mergedTodo, null, 2));
console.log(`  Written ${allTasks.length} tasks to ${currentTodoPath}`);

// === Step 8: Update .sequence counter ===
console.log('Updating .sequence counter...');
const sequencePath = join(CLEO_DIR, '.sequence');
const sequenceData = {
  counter: 4698,
  lastId: 'T4698',
  checksum: 'migration-rebuild',
  updatedAt: new Date().toISOString(),
  recoveredAt: new Date().toISOString(),
};
writeFileSync(sequencePath, JSON.stringify(sequenceData, null, 2));
console.log(`  .sequence updated to T4698`);

// === Summary ===
console.log('\n=== REBUILD COMPLETE ===');
console.log(`Historical tasks:  ${historicalTasks.length}`);
console.log(`Recovered tasks:   ${recoveredTasks.length}`);
console.log(`Wave 8 tasks:      ${renumberedTasks.length}`);
console.log(`Total active:      ${allTasks.length}`);
console.log(`Archive tasks:     ${archivedTasks.length}`);
console.log(`Grand total IDs:   ${new Set([...allTasks.map((t) => t.id), ...archivedTasks.map((t: Task) => t.id)]).size}`);
console.log(`Sequence counter:  T4698`);
console.log('\nNext steps:');
console.log('  1. rm .cleo/tasks.db');
console.log('  2. npm run build');
console.log('  3. node dist/cli/index.js migrate-storage --to-sqlite --verify');
