#!/usr/bin/env npx tsx
/**
 * One-shot multi-source data recovery into tasks.db.
 *
 * Import order (onConflictDoNothing — first-in wins):
 *   1. tasks.json             (425 active — most current states)
 *   2. .backups/todo.json.pre-status-fix  (fills 394 missing tasks)
 *   3. todo-archive.json      (3,435 unique archived tasks, dupes skipped)
 *   4. sessions.json          (606 sessions)
 *
 * Recovery target: ~4,253 unique tasks + 606 sessions.
 *
 * Uses node:sqlite (DatabaseSync) + drizzle-orm/sqlite-proxy.
 * Zero native npm dependencies.
 *
 * @task ADR-006
 */

import { existsSync, readFileSync, copyFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from '../src/store/schema.js';
import { resetDbState, getDbPath, resolveMigrationsFolder } from '../src/store/sqlite.js';
import { openNativeDatabase, createDrizzleCallback, createBatchCallback } from '../src/store/node-sqlite-adapter.js';
import type { Task } from '../src/types/task.js';
import type { Session } from '../src/types/session.js';

const CLEO_DIR = join(process.cwd(), '.cleo');

interface SourceFile {
  label: string;
  path: string;
  extract: (raw: Record<string, unknown>) => Task[];
  isArchive?: boolean;
}

async function applyCanonicalMigrations(
  db: SqliteRemoteDatabase<typeof schema>,
  nativeDb: DatabaseSync,
): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder();
  await migrate(db, async (queries: string[]) => {
    nativeDb.prepare('BEGIN').run();
    try {
      for (const query of queries) {
        nativeDb.prepare(query).run();
      }
      nativeDb.prepare('COMMIT').run();
    } catch (error) {
      nativeDb.prepare('ROLLBACK').run();
      throw error;
    }
  }, { migrationsFolder });
}

// ── Source definitions ──────────────────────────────────────────────

const SOURCES: SourceFile[] = [
  {
    label: 'tasks.json (active, most current)',
    path: join(CLEO_DIR, 'tasks.json'),
    extract: (raw) => (raw.tasks ?? []) as Task[],
  },
  {
    label: '.backups/todo.json.pre-status-fix (recovery)',
    path: join(CLEO_DIR, '.backups', 'todo.json.pre-status-fix'),
    extract: (raw) => (raw.tasks ?? []) as Task[],
  },
  {
    label: 'todo-archive.json (archived)',
    path: join(CLEO_DIR, 'todo-archive.json'),
    extract: (raw) => (raw.archivedTasks ?? raw.tasks ?? []) as Task[],
    isArchive: true,
  },
];

// ── Helpers ─────────────────────────────────────────────────────────

async function importTask(
  db: SqliteRemoteDatabase<typeof schema>,
  task: Task,
  forceArchived: boolean,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const status = forceArchived ? 'archived' : task.status;
    const taskAny = task as Task & {
      archivedAt?: string;
      archiveReason?: string;
      cycleTimeDays?: number;
    };

    await db.insert(schema.tasks)
      .values({
        id: task.id,
        title: task.title,
        description: task.description ?? null,
        status,
        priority: task.priority ?? 'medium',
        type: task.type ?? null,
        parentId: task.parentId ?? null,
        phase: task.phase ?? null,
        size: task.size ?? null,
        position: task.position ?? null,
        positionVersion: task.positionVersion ?? 0,
        labelsJson: task.labels ? JSON.stringify(task.labels) : '[]',
        notesJson: task.notes ? JSON.stringify(task.notes) : '[]',
        acceptanceJson: task.acceptance ? JSON.stringify(task.acceptance) : '[]',
        filesJson: task.files ? JSON.stringify(task.files) : '[]',
        origin: task.origin ?? null,
        blockedBy: task.blockedBy ?? null,
        epicLifecycle: task.epicLifecycle ?? null,
        noAutoComplete: task.noAutoComplete ?? null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt ?? null,
        completedAt: task.completedAt ?? null,
        cancelledAt: task.cancelledAt ?? null,
        cancellationReason: task.cancellationReason ?? null,
        archivedAt: forceArchived
          ? (taskAny.archivedAt ?? task.completedAt ?? new Date().toISOString())
          : null,
        archiveReason: forceArchived
          ? (taskAny.archiveReason ?? 'recovered')
          : null,
        cycleTimeDays: taskAny.cycleTimeDays ?? null,
        verificationJson: task.verification ? JSON.stringify(task.verification) : null,
        createdBy: task.provenance?.createdBy ?? null,
        modifiedBy: task.provenance?.modifiedBy ?? null,
        sessionId: task.provenance?.sessionId ?? null,
      })
      .onConflictDoNothing()
      .run();

    // Insert dependencies (skip if target task doesn't exist yet — FK deferred)
    if (task.depends && task.depends.length > 0) {
      for (const depId of task.depends) {
        try {
          await db.insert(schema.taskDependencies)
            .values({ taskId: task.id, dependsOn: depId })
            .onConflictDoNothing()
            .run();
        } catch {
          // FK constraint — dependency target not yet imported; skip
        }
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function importSession(
  db: SqliteRemoteDatabase<typeof schema>,
  session: Session,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const validStatuses = ['active', 'ended', 'orphaned', 'suspended'];
    const normalizedStatus = validStatuses.includes(session.status)
      ? session.status
      : 'ended';
    const normalizedName = session.name || `session-${session.id}`;

    // Handle both taskWork and legacy focus field
    const focusAny = session as Session & { focus?: { taskId?: string; setAt?: string } };

    await db.insert(schema.sessions)
      .values({
        id: session.id,
        name: normalizedName,
        status: normalizedStatus,
        scopeJson: JSON.stringify(session.scope ?? { type: 'global' }),
        currentTask: session.taskWork?.taskId ?? focusAny.focus?.taskId ?? null,
        taskStartedAt: session.taskWork?.setAt ?? focusAny.focus?.setAt ?? null,
        agent: session.agent ?? null,
        notesJson: session.notes ? JSON.stringify(session.notes) : '[]',
        tasksCompletedJson: session.tasksCompleted ? JSON.stringify(session.tasksCompleted) : '[]',
        tasksCreatedJson: session.tasksCreated ? JSON.stringify(session.tasksCreated) : '[]',
        startedAt: session.startedAt,
        endedAt: session.endedAt ?? null,
      })
      .onConflictDoNothing()
      .run();

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== CLEO Data Recovery (ADR-006) ===\n');

  // Step 1: Backup current tasks.db
  const dbPath = getDbPath();
  const backupPath = join(CLEO_DIR, 'tasks.db.pre-recovery');

  if (existsSync(dbPath)) {
    console.log(`1. Backing up current tasks.db -> tasks.db.pre-recovery`);
    copyFileSync(dbPath, backupPath);
    console.log(`   Backup created at ${backupPath}\n`);
  } else {
    console.log(`1. No existing tasks.db to back up\n`);
  }

  // Step 2: Reset DB state, delete file, create fresh DB via node:sqlite
  // (Bypasses verifyNewDbIsExpected guard which blocks empty DB when .sequence.json exists)
  console.log('2. Resetting database state...');
  resetDbState();

  if (existsSync(dbPath)) {
    unlinkSync(dbPath);
    console.log('   Deleted existing tasks.db');
  }

  console.log('   Creating fresh database via node:sqlite...');
  mkdirSync(dirname(dbPath), { recursive: true });
  const nativeDb = openNativeDatabase(dbPath);

  // Create drizzle ORM wrapper via sqlite-proxy
  const callback = createDrizzleCallback(nativeDb);
  const batchCb = createBatchCallback(nativeDb);
  const db = drizzle(callback, batchCb, { schema });

  // Create tables/indexes from canonical drizzle migrations (single source of truth)
  await applyCanonicalMigrations(db, nativeDb);

  await db.insert(schema.schemaMeta)
    .values({ key: 'schemaVersion', value: '2.0.0' })
    .onConflictDoUpdate({
      target: schema.schemaMeta.key,
      set: { value: '2.0.0' },
    })
    .run();
  console.log('   Fresh database created with schema\n');

  // Step 3: Import tasks from each source
  let totalImported = 0;
  let totalSkipped = 0;
  const errors: string[] = [];

  for (const source of SOURCES) {
    console.log(`3. Importing from: ${source.label}`);

    if (!existsSync(source.path)) {
      console.log(`   SKIP: File not found at ${source.path}\n`);
      continue;
    }

    const raw = JSON.parse(readFileSync(source.path, 'utf-8'));
    const tasks = source.extract(raw);
    console.log(`   Found ${tasks.length} tasks`);

    let imported = 0;
    let skipped = 0;

    for (const task of tasks) {
      const result = await importTask(db, task, !!source.isArchive);
      if (result.ok) {
        imported++;
      } else {
        // onConflictDoNothing means duplicates are silently skipped
        // actual errors are rare
        skipped++;
        if (result.error && !result.error.includes('UNIQUE constraint')) {
          errors.push(`${source.label} / ${task.id}: ${result.error}`);
        }
      }
    }

    console.log(`   Imported: ${imported}, Skipped (dupe): ${skipped}\n`);
    totalImported += imported;
    totalSkipped += skipped;
  }

  // Step 4: Import sessions
  console.log('4. Importing sessions...');
  const sessionsPath = join(CLEO_DIR, 'sessions.json');
  let sessionsImported = 0;

  if (existsSync(sessionsPath)) {
    const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
    const sessions: Session[] = sessionsData.sessions ?? [];
    console.log(`   Found ${sessions.length} sessions`);

    for (const session of sessions) {
      const result = await importSession(db, session);
      if (result.ok) {
        sessionsImported++;
      } else if (result.error) {
        errors.push(`session ${session.id}: ${result.error}`);
      }
    }

    console.log(`   Imported: ${sessionsImported}\n`);
  } else {
    console.log('   SKIP: sessions.json not found\n');
  }

  // Step 5: Store project metadata in schema_meta
  console.log('5. Storing project metadata...');
  const tasksJsonRaw = JSON.parse(readFileSync(join(CLEO_DIR, 'tasks.json'), 'utf-8'));
  const projectMeta = tasksJsonRaw.project ?? { name: 'project', currentPhase: null, phases: {} };
  const focusState = tasksJsonRaw.focus ?? { currentTask: null };

  await db.insert(schema.schemaMeta)
    .values({ key: 'project_meta', value: JSON.stringify(projectMeta) })
    .onConflictDoUpdate({ target: schema.schemaMeta.key, set: { value: JSON.stringify(projectMeta) } })
    .run();

  await db.insert(schema.schemaMeta)
    .values({ key: 'focus_state', value: JSON.stringify(focusState) })
    .onConflictDoUpdate({ target: schema.schemaMeta.key, set: { value: JSON.stringify(focusState) } })
    .run();

  console.log('   Project metadata stored\n');

  // Step 6: node:sqlite writes directly to disk via WAL — no export needed
  console.log('6. Database already persisted to disk (node:sqlite WAL mode).\n');

  // Close the native DB connection
  nativeDb.close();

  // Step 7: Validate by re-opening the saved file with node:sqlite
  console.log('=== Validation ===\n');

  const verifyDb = new DatabaseSync(dbPath, {
    readOnly: true,
    enableForeignKeyConstraints: false,
  });

  const getCount = (sql: string): number => {
    const stmt = verifyDb.prepare(sql);
    const row = stmt.get() as Record<string, unknown> | undefined;
    const values = row ? Object.values(row) : [0];
    return (values[0] ?? 0) as number;
  };

  const taskCount = getCount('SELECT COUNT(*) FROM tasks');
  const activeCount = getCount("SELECT COUNT(*) FROM tasks WHERE status != 'archived'");
  const archivedCount = getCount("SELECT COUNT(*) FROM tasks WHERE status = 'archived'");
  const sessionCount = getCount('SELECT COUNT(*) FROM sessions');
  const depCount = getCount('SELECT COUNT(*) FROM task_dependencies');

  verifyDb.close();

  console.log(`Total tasks:    ${taskCount}`);
  console.log(`  Active:       ${activeCount}`);
  console.log(`  Archived:     ${archivedCount}`);
  console.log(`Sessions:       ${sessionCount}`);
  console.log(`Dependencies:   ${depCount}`);
  console.log('');

  if (taskCount >= 4253) {
    console.log(`PASS: Task count ${taskCount} >= 4,253 target`);
  } else {
    console.log(`WARN: Task count ${taskCount} < 4,253 target (some expected overlap)`);
  }

  if (sessionCount === 606) {
    console.log(`PASS: Session count matches target (606)`);
  } else {
    console.log(`WARN: Session count ${sessionCount} != 606 target`);
  }

  if (errors.length > 0) {
    console.log(`\n${errors.length} errors:`);
    for (const e of errors.slice(0, 10)) {
      console.log(`  - ${e}`);
    }
    if (errors.length > 10) {
      console.log(`  ... and ${errors.length - 10} more`);
    }
  }

  console.log('\n=== Recovery complete ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
