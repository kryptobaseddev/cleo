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
 * @task T12724
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importTasks } from '../../admin/import.js';
import { importFromPackage } from '../../admin/import-tasks.js';
import { importSnapshot, type Snapshot } from '../../snapshot/index.js';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { addTask } from '../add.js';
import { coreTaskImport } from '../task-import.js';

/** Runs once, right after the path under test has decided on an id. */
let race: ((decidedId?: string) => void) | undefined;

vi.mock('../../sequence/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sequence/index.js')>();
  return {
    ...actual,
    allocateNextTaskId: vi.fn(async (cwd?: string) => {
      const id = await actual.allocateNextTaskId(cwd);
      const hook = race;
      race = undefined;
      hook?.(id);
      return id;
    }),
  };
});

vi.mock('../../store/data-accessor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/data-accessor.js')>();
  return {
    ...actual,
    // The importers read the stored ids once, then compute new ids from that
    // view: the race lands right after that read.
    getTaskAccessor: vi.fn(async (cwd?: string) => {
      const accessor = await actual.getTaskAccessor(cwd);
      return new Proxy(accessor, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop !== 'queryTasks' || typeof value !== 'function') return value;
          return async (...args: unknown[]) => {
            const result = await value.apply(target, args);
            const hook = race;
            race = undefined;
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

let env: TestDbEnv;

/** A SECOND connection stores a task under `id`, as another writer would. */
function otherWriterStores(id: string): void {
  const other = new DatabaseSync(join(env.cleoDir, 'cleo.db'));
  other.exec('PRAGMA busy_timeout = 5000');
  other
    .prepare(
      "INSERT INTO tasks_tasks (id, title, status, priority) VALUES (?, ?, 'pending', 'high')",
    )
    .run(id, "Other writer's task");
  other.close();
}

/** The stored title of `id`, read through a separate connection. */
function storedTitle(id: string): string | undefined {
  const reader = new DatabaseSync(join(env.cleoDir, 'cleo.db'), { readOnly: true });
  const row = reader.prepare('SELECT title FROM tasks_tasks WHERE id = ?').get(id) as
    | { title: string }
    | undefined;
  reader.close();
  return row?.title;
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
  expect(storedTitle(id())).toBe("Other writer's task");
  expect(outcome).toMatchObject({ code: ExitCode.ID_COLLISION });
}

beforeEach(async () => {
  env = await createTestDb();
  await writeFile(join(env.cleoDir, 'config.json'), NO_ENFORCEMENT_CONFIG);
  race = undefined;
});

afterEach(async () => {
  race = undefined;
  await env.cleanup();
});

describe('cleo add: allocate, then insert', () => {
  it('a task stored under the allocated id by another connection is never overwritten', async () => {
    let collided = '';
    race = (id) => {
      collided = id ?? '';
      otherWriterStores(collided);
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

describe('imports: compute ids from a read, then insert', () => {
  it('coreTaskImport', async () => {
    race = () => otherWriterStores('T050');
    await expectNoOverwrite(
      coreTaskImport(
        env.tempDir,
        JSON.stringify([{ id: 'T050', title: 'Imported', status: 'pending', priority: 'medium' }]),
      ),
      () => 'T050',
    );
  });

  it('admin importTasks', async () => {
    const file = join(env.tempDir, 'import.json');
    await writeFile(
      file,
      JSON.stringify({
        tasks: [{ id: 'T060', title: 'Imported', status: 'pending', priority: 'medium' }],
      }),
    );
    race = () => otherWriterStores('T060');
    await expectNoOverwrite(importTasks(env.tempDir, { file }), () => 'T060');
  });

  it('importFromPackage (remapped ids)', async () => {
    // The store is empty, so the package's task is remapped to T001.
    race = () => otherWriterStores('T001');
    await expectNoOverwrite(
      importFromPackage(
        {
          _meta: { format: 'cleo-export' },
          tasks: [{ id: 'T900', title: 'Packaged', status: 'pending', priority: 'medium' }],
        } as unknown as Parameters<typeof importFromPackage>[0],
        { cwd: env.tempDir, provenance: false },
      ),
      () => 'T001',
    );
  });

  it('importSnapshot (a task missing locally)', async () => {
    race = () => otherWriterStores('T070');
    const snapshot = {
      $schema: 'x',
      _meta: {},
      project: { name: 'p' },
      tasks: [
        {
          id: 'T070',
          title: 'From snapshot',
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    } as unknown as Snapshot;
    await expectNoOverwrite(importSnapshot(snapshot, env.tempDir), () => 'T070');
  });
});

describe('explicit overwrite still replaces', () => {
  it('coreTaskImport with overwrite replaces a stored task', async () => {
    otherWriterStores('T080');
    await coreTaskImport(
      env.tempDir,
      JSON.stringify([{ id: 'T080', title: 'Replaced', status: 'pending', priority: 'medium' }]),
      true,
    );
    expect(storedTitle('T080')).toBe('Replaced');
  });

  it("admin importTasks with onDuplicate 'overwrite' replaces a stored task", async () => {
    otherWriterStores('T081');
    const file = join(env.tempDir, 'overwrite.json');
    await writeFile(
      file,
      JSON.stringify({
        tasks: [{ id: 'T081', title: 'Replaced', status: 'pending', priority: 'medium' }],
      }),
    );
    await importTasks(env.tempDir, { file, onDuplicate: 'overwrite' });
    expect(storedTitle('T081')).toBe('Replaced');
  });
});
