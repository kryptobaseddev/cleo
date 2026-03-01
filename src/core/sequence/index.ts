/**
 * Task ID sequence management core module.
 * @task T4538
 * @epic T4454
 */

import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getDb, getNativeDb } from '../../store/sqlite.js';
import { schemaMeta } from '../../store/schema.js';
import { setMetaValue } from '../../store/sqlite-data-accessor.js';
import { createDataAccessor, type DataAccessor } from '../../store/data-accessor.js';

const SEQUENCE_META_KEY = 'task_id_sequence';

function getLegacySequenceJsonPath(cwd?: string): string {
  return join(cwd ?? process.cwd(), '.cleo', '.sequence.json');
}

function getLegacySequencePath(cwd?: string): string {
  return join(cwd ?? process.cwd(), '.cleo', '.sequence');
}

interface SequenceState {
  counter: number;
  lastId: string;
  checksum: string;
}

function isValidSequenceState(value: unknown): value is SequenceState {
  if (!value || typeof value !== 'object') return false;
  const seq = value as Partial<SequenceState>;
  return typeof seq.counter === 'number'
    && typeof seq.lastId === 'string'
    && typeof seq.checksum === 'string';
}

function isSeedSequence(value: SequenceState): boolean {
  return value.counter === 0 && value.lastId === 'T000' && value.checksum === 'seed';
}

function readLegacySequenceFile(path: string): SequenceState | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return isValidSequenceState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function renameLegacyFile(path: string): void {
  if (!existsSync(path)) return;
  const migratedPath = `${path}.migrated`;
  try {
    if (!existsSync(migratedPath)) {
      renameSync(path, migratedPath);
      return;
    }
    renameSync(path, `${migratedPath}.${Date.now()}`);
  } catch {
    // Non-fatal; sequence data has already been persisted in SQLite.
  }
}

async function readSequenceFromDb(cwd?: string, accessor?: DataAccessor): Promise<SequenceState | null> {
  if (accessor?.getMetaValue) {
    const value = await accessor.getMetaValue<unknown>(SEQUENCE_META_KEY);
    return isValidSequenceState(value) ? value : null;
  }

  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schemaMeta)
    .where(eq(schemaMeta.key, SEQUENCE_META_KEY))
    .all();
  const raw = rows[0]?.value;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isValidSequenceState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeSequenceToDb(state: SequenceState, cwd?: string, accessor?: DataAccessor): Promise<void> {
  if (accessor?.setMetaValue) {
    await accessor.setMetaValue(SEQUENCE_META_KEY, state);
    return;
  }
  await setMetaValue(cwd, SEQUENCE_META_KEY, state);
}

async function maybeMigrateLegacySequence(
  dbState: SequenceState | null,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<SequenceState | null> {
  const legacyJsonPath = getLegacySequenceJsonPath(cwd);
  const legacyPath = getLegacySequencePath(cwd);

  const candidates = [
    readLegacySequenceFile(legacyJsonPath),
    readLegacySequenceFile(legacyPath),
  ].filter((value): value is SequenceState => value !== null);

  if (candidates.length === 0) {
    return dbState;
  }

  const preferredLegacy = candidates.reduce((best, current) => (
    current.counter > best.counter ? current : best
  ));

  const shouldMigrate = !dbState || isSeedSequence(dbState) || preferredLegacy.counter > dbState.counter;
  if (shouldMigrate) {
    await writeSequenceToDb(preferredLegacy, cwd, accessor);
  }

  // Legacy files are obsolete once validated. Rename to prevent drift.
  renameLegacyFile(legacyJsonPath);
  renameLegacyFile(legacyPath);

  return shouldMigrate ? preferredLegacy : dbState;
}

async function readSequence(cwd?: string, accessor?: DataAccessor): Promise<SequenceState | null> {
  const fromDb = await readSequenceFromDb(cwd, accessor);
  return maybeMigrateLegacySequence(fromDb, cwd, accessor);
}

function getMaxIdFromTasks(tasks: Array<{ id: string }>): number {
  let max = 0;
  for (const t of tasks) {
    const match = t.id.match(/^T(\d+)$/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > max) max = num;
    }
  }
  return max;
}

/** Show current sequence state. */
export async function showSequence(cwd?: string): Promise<Record<string, unknown>> {
  const seq = await readSequence(cwd);
  if (!seq) {
    throw new CleoError(ExitCode.NOT_FOUND, 'Sequence state not found in SQLite schema_meta');
  }
  return {
    counter: seq.counter,
    lastId: seq.lastId,
    checksum: seq.checksum,
    nextId: `T${seq.counter + 1}`,
  };
}

async function loadAllTasks(cwd?: string, accessor?: DataAccessor): Promise<Array<{ id: string }>> {
  let localAccessor: DataAccessor | null = null;
  const activeAccessor = accessor ?? await createDataAccessor(undefined, cwd);
  if (!accessor) {
    localAccessor = activeAccessor;
  }

  try {
    const taskData = await activeAccessor.loadTaskFile();
    const archiveData = await activeAccessor.loadArchive();
    return [
      ...(taskData?.tasks ?? []),
      ...(archiveData?.archivedTasks ?? []),
    ];
  } finally {
    if (localAccessor) {
      await localAccessor.close();
    }
  }
}

/** Check sequence integrity. */
export async function checkSequence(cwd?: string, accessor?: DataAccessor): Promise<Record<string, unknown>> {
  const seq = await readSequence(cwd, accessor);
  if (!seq) {
    // File missing — return invalid state so callers trigger auto-repair instead of crashing.
    // repairSequence() handles null state and will initialize the counter from task data.
    return { valid: false, counter: 0, maxIdInData: 0, missing: true };
  }

  const allTasks = await loadAllTasks(cwd, accessor);

  const maxId = getMaxIdFromTasks(allTasks);
  const valid = seq.counter >= maxId;

  return {
    counter: seq.counter,
    maxIdInData: maxId,
    valid,
    ...(valid ? {} : {
      issue: `Counter (${seq.counter}) is behind max ID (T${maxId})`,
      fix: 'Run cleo sequence repair',
    }),
  };
}

/** Repair result with proper typing. */
export interface RepairResult {
  repaired: boolean;
  message: string;
  counter: number;
  oldCounter?: number;
  newCounter?: number;
}

/** Repair sequence if behind. */
export async function repairSequence(cwd?: string, accessor?: DataAccessor): Promise<RepairResult> {
  const seq = await readSequence(cwd, accessor);
  const allTasks = await loadAllTasks(cwd, accessor);

  const maxId = getMaxIdFromTasks(allTasks);
  const oldCounter = seq?.counter ?? 0;

  if (!seq) {
    const initialized: SequenceState = {
      counter: maxId,
      lastId: `T${maxId}`,
      checksum: `seed-${Date.now()}`,
    };
    await writeSequenceToDb(initialized, cwd, accessor);
    return {
      repaired: true,
      counter: initialized.counter,
      oldCounter,
      newCounter: initialized.counter,
      message: `Sequence initialized at ${initialized.counter}`,
    };
  }

  if (oldCounter >= maxId) {
    return { repaired: false, message: 'Sequence already valid', counter: oldCounter, oldCounter, newCounter: oldCounter };
  }

  const newCounter = maxId;
  const newSeq: SequenceState = {
    counter: newCounter,
    lastId: `T${newCounter}`,
    checksum: `repair-${Date.now()}`,
  };
  await writeSequenceToDb(newSeq, cwd, accessor);

  return {
    repaired: true,
    counter: newCounter,
    oldCounter,
    newCounter,
    message: `Sequence repaired: ${oldCounter} -> ${newCounter}`,
  };
}

/** Maximum retries for allocateNextTaskId when collision detected. */
const MAX_ALLOC_RETRIES = 3;

/**
 * Atomically allocate the next task ID via SQLite.
 *
 * Uses BEGIN IMMEDIATE to guarantee no two concurrent callers
 * receive the same ID, even across processes (WAL mode).
 *
 * Falls back to repair+retry if the sequence counter is behind
 * the actual max task ID (e.g., stale counter from installations
 * that never incremented it).
 *
 * @task T5184
 */
export async function allocateNextTaskId(cwd?: string, retryCount = 0): Promise<string> {
  // Ensure DB is initialized (triggers migrations, seeds sequence counter)
  await getDb(cwd);
  const nativeDb = getNativeDb();
  if (!nativeDb) {
    throw new CleoError(ExitCode.FILE_ERROR, 'Native database not available for atomic ID allocation');
  }

  // Atomic transaction: increment counter and read new value
  nativeDb.prepare('BEGIN IMMEDIATE').run();
  try {
    // Increment counter atomically
    nativeDb.prepare(`
      UPDATE schema_meta
      SET value = json_set(value,
        '$.counter', json_extract(value, '$.counter') + 1,
        '$.lastId', 'T' || printf('%03d', json_extract(value, '$.counter') + 1),
        '$.checksum', 'alloc-' || strftime('%s','now')
      )
      WHERE key = 'task_id_sequence'
    `).run();

    // Read new counter value
    const row = nativeDb.prepare(`
      SELECT json_extract(value, '$.counter') AS counter
      FROM schema_meta WHERE key = 'task_id_sequence'
    `).get() as { counter: number } | undefined;

    if (!row) {
      throw new CleoError(ExitCode.FILE_ERROR, 'Sequence counter not found after increment');
    }

    const newId = `T${String(row.counter).padStart(3, '0')}`;

    // Collision check: verify no existing task with this ID
    const existing = nativeDb.prepare(
      'SELECT id FROM tasks WHERE id = ?',
    ).get(newId) as { id: string } | undefined;

    if (existing) {
      // Counter was behind actual data — rollback, repair, and retry
      nativeDb.prepare('ROLLBACK').run();

      if (retryCount >= MAX_ALLOC_RETRIES) {
        throw new CleoError(
          ExitCode.ID_COLLISION,
          `Failed to allocate unique task ID after ${MAX_ALLOC_RETRIES} retries (last attempted: ${newId})`,
        );
      }

      await repairSequence(cwd);
      return allocateNextTaskId(cwd, retryCount + 1);
    }

    nativeDb.prepare('COMMIT').run();
    return newId;
  } catch (err) {
    // Ensure transaction is rolled back on any error
    try { nativeDb.prepare('ROLLBACK').run(); } catch { /* ignore rollback errors */ }
    throw err;
  }
}
