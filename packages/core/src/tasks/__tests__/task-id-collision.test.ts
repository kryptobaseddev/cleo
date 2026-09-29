/**
 * A task id collision never overwrites a different task (T12724).
 *
 * Every path that creates a task under a freshly allocated or computed id
 * decides the id first and writes the row later. If another connection
 * stores a task under that id in between, the old upsert
 * (`onConflictDoUpdate`) silently replaced that task with the new one. These
 * tests run the race for real: a second SQLite connection inserts the
 * colliding row between the id decision and the write. Each path must then
 * fail with `ID_COLLISION` (exit code 22) and leave the other task intact.
 *
 * Paths: `cleo add`, `coreTaskImport`, the admin `importTasks`,
 * `importFromPackage`, and snapshot import. `add-batch` calls `addTask` too,
 * but inside one BEGIN IMMEDIATE transaction that spans every allocation and
 * insert, so no other connection can store a row in between; it gets the
 * same non-overwriting insert through `addTask`.
 *
 * Review round 1 (cleo-dev) added three import properties:
 *   - an ARCHIVED task still owns its id: the importers decide ids against
 *     every stored task, and new ids come from the allocator, so an archived
 *     highest id never makes an import fail forever;
 *   - an import writes in ONE transaction: a collision on any task leaves
 *     zero rows, so a re-run cannot duplicate a partial import;
 *   - the collision hint is true for every path: a re-run succeeds.
 *
 * @task T12724
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExitCode, type Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importTasks } from '../../admin/import.js';
import { importFromPackage } from '../../admin/import-tasks.js';
import { importSnapshot, type Snapshot, type SnapshotTask } from '../../snapshot/index.js';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { ExportPackage } from '../../store/export.js';
import { addTask } from '../add.js';
import { coreTaskImport } from '../task-import.js';

/** Runs once, right after the path under test has READ the stored ids. */
let raceAfterRead: (() => void) | undefined;
/** Runs once, right after the N-th id allocation (default: the first). */
let raceAfterAllocate: { nth: number; fn: (id: string) => void } | undefined;
let allocations = 0;

vi.mock('../../sequence/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sequence/index.js')>();
  return {
    ...actual,
    allocateNextTaskId: vi.fn(async (cwd?: string) => {
      const id = await actual.allocateNextTaskId(cwd);
      allocations++;
      const hook = raceAfterAllocate;
      if (hook && allocations === hook.nth) {
        raceAfterAllocate = undefined;
        hook.fn(id);
      }
      return id;
    }),
  };
});

vi.mock('../../store/data-accessor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/data-accessor.js')>();
  return {
    ...actual,
    // The importers read the stored ids once, then decide ids from that view:
    // the read-side race lands right after that read.
    getTaskAccessor: vi.fn(async (cwd?: string) => {
      const accessor = await actual.getTaskAccessor(cwd);
      return new Proxy(accessor, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop !== 'queryTasks' || typeof value !== 'function') return value;
          return async (...args: unknown[]) => {
            const result = await value.apply(target, args);
            const hook = raceAfterRead;
            raceAfterRead = undefined;
            hook?.();
            return result;
          };
        },
      });
    }),
  };
});

const NO_ENFORCEMENT_CONFIG = JSON.stringify({
  lifecycle: { mode: 'off' },
  enforcement: {
    session: { requiredForMutate: false },
    acceptance: { mode: 'off' },
  },
  verification: { enabled: false },
});

const OTHER = "Other writer's task";
let env: TestDbEnv;

/** A SECOND connection stores a task under `id`, as another writer would. */
function otherWriterStores(id: string, title = OTHER): void {
  const other = new DatabaseSync(join(env.cleoDir, 'cleo.db'));
  other.exec('PRAGMA busy_timeout = 5000');
  other
    .prepare(
      "INSERT INTO tasks_tasks (id, title, status, priority) VALUES (?, ?, 'pending', 'high')",
    )
    .run(id, title);
  other.close();
}

/** Store `id`, then archive it through the accessor. */
async function storeArchived(id: string, title: string): Promise<void> {
  otherWriterStores(id, title);
  await env.accessor.archiveSingleTask(id, {});
}

/** The stored title and status of `id`, read through a separate connection. */
function stored(id: string): { title: string; status: string } | undefined {
  const reader = new DatabaseSync(join(env.cleoDir, 'cleo.db'), { readOnly: true });
  const row = reader.prepare('SELECT title, status FROM tasks_tasks WHERE id = ?').get(id) as
    | { title: string; status: string }
    | undefined;
  reader.close();
  return row;
}
const storedTitle = (id: string): string | undefined => stored(id)?.title;

/** A task record for an import source. */
function task(id: string, title: string): Task {
  return {
    id,
    title,
    description: `${title} description`,
    status: 'pending',
    priority: 'medium',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A complete export package holding `tasks`. */
function exportPackage(tasks: Task[]): ExportPackage {
  return {
    $schema: 'https://cleo.dev/schemas/export-package.json',
    _meta: {
      format: 'cleo-export',
      version: '1.0.0',
      exportedAt: '2026-01-01T00:00:00.000Z',
      source: { project: 'elsewhere', cleo_version: '0.0.0', nextId: 1 },
      checksum: '0',
      taskCount: tasks.length,
      exportMode: 'full',
    },
    selection: { mode: 'full', rootTaskIds: [], includeChildren: false },
    idMap: {},
    tasks,
    relationshipGraph: { hierarchy: {}, dependencies: {}, roots: [] },
  };
}

/** A snapshot task with fixed timestamps. */
function snapshotTask(id: string, title: string, status = 'pending'): SnapshotTask {
  return {
    id,
    title,
    status,
    priority: 'medium',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A complete snapshot holding `tasks`. */
function snapshot(tasks: SnapshotTask[]): Snapshot {
  return {
    $schema: 'https://cleo.dev/schemas/snapshot.json',
    _meta: {
      format: 'cleo-snapshot',
      version: '1.0.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      source: { project: 'elsewhere', cleoVersion: '0.0.0' },
      checksum: '0',
      taskCount: tasks.length,
    },
    project: { name: 'p' },
    tasks,
  };
}

/** Write an admin import file and return its path. */
async function importFile(name: string, tasks: Task[]): Promise<string> {
  const file = join(env.tempDir, name);
  await writeFile(file, JSON.stringify({ tasks }));
  return file;
}

/**
 * Run the write, then check the other writer's row FIRST (so the old code's
 * failure shows the overwrite itself), then the typed error.
 */
async function expectNoOverwrite(write: Promise<unknown>, id: () => string): Promise<void> {
  const outcome = await write.then(
    () => 'resolved: the write reported success',
    (error: unknown) => error,
  );
  expect(storedTitle(id())).toBe(OTHER);
  expect(outcome).toMatchObject({ code: ExitCode.ID_COLLISION });
}

beforeEach(async () => {
  env = await createTestDb();
  await writeFile(join(env.cleoDir, 'config.json'), NO_ENFORCEMENT_CONFIG);
  raceAfterRead = undefined;
  raceAfterAllocate = undefined;
  allocations = 0;
});

afterEach(async () => {
  raceAfterRead = undefined;
  raceAfterAllocate = undefined;
  await env.cleanup();
});

describe('cleo add: allocate, then insert', () => {
  it('a task stored under the allocated id by another connection is never overwritten', async () => {
    let collided = '';
    raceAfterAllocate = {
      nth: 1,
      fn: (id) => {
        collided = id;
        otherWriterStores(id);
      },
    };
    await expectNoOverwrite(
      addTask(
        { title: 'Mine', description: 'my own task', skipContainmentInvariant: true },
        env.tempDir,
        env.accessor,
      ),
      () => collided,
    );
  });
});

describe('imports: decide ids, then insert', () => {
  it('coreTaskImport', async () => {
    raceAfterRead = () => otherWriterStores('T050');
    await expectNoOverwrite(
      coreTaskImport(env.tempDir, JSON.stringify([task('T050', 'Imported')])),
      () => 'T050',
    );
  });

  it('admin importTasks', async () => {
    const file = await importFile('import.json', [task('T060', 'Imported')]);
    raceAfterRead = () => otherWriterStores('T060');
    await expectNoOverwrite(importTasks(env.tempDir, { file }), () => 'T060');
  });

  it('importFromPackage (ids from the allocator)', async () => {
    let collided = '';
    raceAfterAllocate = {
      nth: 1,
      fn: (id) => {
        collided = id;
        otherWriterStores(id);
      },
    };
    await expectNoOverwrite(
      importFromPackage(exportPackage([task('T900', 'Packaged')]), {
        cwd: env.tempDir,
        provenance: false,
      }),
      () => collided,
    );
  });

  it('importSnapshot (a task missing locally)', async () => {
    raceAfterRead = () => otherWriterStores('T070');
    await expectNoOverwrite(
      importSnapshot(snapshot([snapshotTask('T070', 'From snapshot')]), env.tempDir),
      () => 'T070',
    );
  });
});

describe('explicit overwrite still replaces', () => {
  it('coreTaskImport with overwrite replaces a stored task', async () => {
    otherWriterStores('T080');
    await coreTaskImport(env.tempDir, JSON.stringify([task('T080', 'Replaced')]), true);
    expect(storedTitle('T080')).toBe('Replaced');
  });

  it("admin importTasks with onDuplicate 'overwrite' replaces a stored task", async () => {
    otherWriterStores('T081');
    const file = await importFile('overwrite.json', [task('T081', 'Replaced')]);
    await importTasks(env.tempDir, { file, onDuplicate: 'overwrite' });
    expect(storedTitle('T081')).toBe('Replaced');
  });
});

describe('an ARCHIVED task still owns its id (review round 1, finding 1)', () => {
  beforeEach(async () => {
    otherWriterStores('T001', 'Live');
    await storeArchived('T002', 'Archived, highest id');
  });

  it('importFromPackage takes a new id past the archived one', async () => {
    const result = await importFromPackage(exportPackage([task('T900', 'Packaged')]), {
      cwd: env.tempDir,
      provenance: false,
    });
    const newId = result.idRemap?.T900 ?? '';
    expect(newId).toMatch(/^T\d+$/);
    expect(Number(newId.slice(1))).toBeGreaterThan(2);
    expect(storedTitle(newId)).toBe('Packaged');
    expect(stored('T002')).toEqual({ title: 'Archived, highest id', status: 'archived' });
  });

  it('coreTaskImport skips the archived id, and --overwrite replaces it', async () => {
    const skipped = await coreTaskImport(env.tempDir, JSON.stringify([task('T002', 'Again')]));
    expect(skipped).toMatchObject({ imported: 0, skipped: 1 });
    expect(storedTitle('T002')).toBe('Archived, highest id');

    await coreTaskImport(env.tempDir, JSON.stringify([task('T002', 'Replaced')]), true);
    expect(storedTitle('T002')).toBe('Replaced');
  });

  it('admin importTasks treats the archived id as a duplicate (skip, then rename)', async () => {
    const file = await importFile('archived.json', [task('T002', 'Again')]);
    expect(await importTasks(env.tempDir, { file })).toMatchObject({ imported: 0, skipped: 1 });
    const renamed = await importTasks(env.tempDir, { file, onDuplicate: 'rename' });
    const newId = renamed.renamed[0]?.newId ?? '';
    expect(Number(newId.slice(1))).toBeGreaterThan(2);
    expect(storedTitle(newId)).toBe('Again');
    expect(storedTitle('T002')).toBe('Archived, highest id');
  });

  it('importSnapshot holding the archived task is idempotent', async () => {
    const snap = snapshot([snapshotTask('T002', 'Archived, highest id', 'archived')]);
    await expect(importSnapshot(snap, env.tempDir)).resolves.toMatchObject({ added: 0 });
    await expect(importSnapshot(snap, env.tempDir)).resolves.toMatchObject({ added: 0 });
  });
});

describe('an import writes all or nothing (review round 1, finding 3)', () => {
  const three = [task('T201', 'First'), task('T202', 'Second'), task('T203', 'Third')];

  it('coreTaskImport: a collision on the 2nd task leaves zero imported rows', async () => {
    raceAfterRead = () => otherWriterStores('T202');
    await expectNoOverwrite(coreTaskImport(env.tempDir, JSON.stringify(three)), () => 'T202');
    expect(stored('T201')).toBeUndefined();
    expect(stored('T203')).toBeUndefined();
  });

  it('admin importTasks: a collision on the 2nd task leaves zero imported rows', async () => {
    const file = await importFile('three.json', three);
    raceAfterRead = () => otherWriterStores('T202');
    await expectNoOverwrite(importTasks(env.tempDir, { file }), () => 'T202');
    expect(stored('T201')).toBeUndefined();
    expect(stored('T203')).toBeUndefined();
  });

  it('importFromPackage: a collision on the 2nd allocated id leaves zero imported rows', async () => {
    const ids: string[] = [];
    raceAfterAllocate = { nth: 2, fn: (id) => otherWriterStores(id) };
    await expect(
      importFromPackage(exportPackage(three), { cwd: env.tempDir, provenance: false }),
    ).rejects.toMatchObject({ code: ExitCode.ID_COLLISION });
    const reader = new DatabaseSync(join(env.cleoDir, 'cleo.db'), { readOnly: true });
    for (const r of reader.prepare('SELECT id, title FROM tasks_tasks').all() as Array<{
      id: string;
      title: string;
    }>)
      ids.push(`${r.id}:${r.title}`);
    reader.close();
    // Only the other writer's row exists: no First, no Third.
    expect(ids).toEqual([expect.stringMatching(new RegExp(`^T\\d+:${OTHER}$`))]);
  });

  it('importSnapshot: a collision on the 2nd task leaves zero imported rows', async () => {
    raceAfterRead = () => otherWriterStores('T202');
    const snap = snapshot(three.map((t) => snapshotTask(t.id, t.title)));
    await expectNoOverwrite(importSnapshot(snap, env.tempDir), () => 'T202');
    expect(stored('T201')).toBeUndefined();
    expect(stored('T203')).toBeUndefined();
  });
});

describe('the collision hint is true for every path (review round 1, finding 2)', () => {
  it('says what happened, and a re-run of the import succeeds instead of looping', async () => {
    const source = JSON.stringify([task('T301', 'First'), task('T302', 'Second')]);
    raceAfterRead = () => otherWriterStores('T302');
    const error = await coreTaskImport(env.tempDir, source).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: ExitCode.ID_COLLISION,
      message: expect.stringMatching(/Task id T302 .*nothing was written/),
      fix: expect.stringMatching(
        /Run the command again.*the allocator skips every stored id.*imports re-read every stored id, archived included/,
      ),
    });

    // The re-run the hint promises: the other writer's task is now an
    // existing id, so the import skips it and writes the rest.
    await expect(coreTaskImport(env.tempDir, source)).resolves.toMatchObject({
      imported: 1,
      skipped: 1,
    });
    expect(storedTitle('T301')).toBe('First');
    expect(storedTitle('T302')).toBe(OTHER);
  });
});
