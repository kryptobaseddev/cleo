/** Fresh CLI processes must agree on global dependency evidence (T12293). */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalProjectId } from '@cleocode/core/nexus/identity';
import {
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '@cleocode/core/store/__tests__/test-db-helper';
import { getDb, getNativeDb } from '@cleocode/core/store/sqlite';
import * as schema from '@cleocode/core/store/tasks-schema';
import { archiveTasks } from '@cleocode/core/tasks/archive';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cliPath =
  process.env['CLEO_READINESS_CLI'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../bin/cleo.js');
const built = existsSync(resolve(dirname(cliPath), '../dist/cli/index.js'));
let fixture: TestDbEnv;

beforeEach(async () => {
  fixture = await createTestDb();
  mkdirSync(join(fixture.tempDir, 'home'));
  const { id } = await canonicalProjectId(fixture.tempDir);
  writeFileSync(
    join(fixture.tempDir, '.cleo/project.json'),
    JSON.stringify({ schemaVersion: '1.0.0', id, name: 'Cross-epic readiness oracle' }),
  );
});

afterEach(async () => {
  await fixture.cleanup();
});

/** Run the real CLI with only fixture-owned project and global stores. */
function cli(args: readonly string[], failure = false): string {
  const run = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: fixture.tempDir,
    env: {
      PATH: process.env['PATH'],
      HOME: join(fixture.tempDir, 'home'),
      CLEO_HOME: join(fixture.tempDir, '.cleo-home'),
      NEXUS_HOME: join(fixture.tempDir, 'nexus-home'),
      XDG_DATA_HOME: join(fixture.tempDir, 'data'),
      XDG_CONFIG_HOME: join(fixture.tempDir, 'config'),
      XDG_CACHE_HOME: join(fixture.tempDir, 'cache'),
      NO_COLOR: '1',
    },
    encoding: 'utf8',
    timeout: 45_000,
  });
  expect(run.error, args.join(' ')).toBeUndefined();
  expect(run.signal, args.join(' ')).toBeNull();
  if (failure) expect(run.status, `${args.join(' ')}: ${run.stdout}`).not.toBe(0);
  else expect(run.status, `${args.join(' ')}: ${run.stderr}\n${run.stdout}`).toBe(0);
  return run.stdout;
}

describe.skipIf(!built)('cross-epic dependency readiness through the compiled CLI', () => {
  it('emits a failed envelope and exit code when saga readiness cannot be assessed', () => {
    expect(JSON.parse(cli(['saga', 'next', 'T999'], true))).toMatchObject({
      success: false,
      error: { codeName: 'E_NOT_FOUND' },
    });
  });

  it.each([
    ['done', true],
    ['archived', true],
    ['pending', false],
    ['cancelled', false],
    ['missing', false],
  ] as const)('uses independent %s prerequisite evidence', async (status, ready) => {
    await seedTasks(fixture.accessor, [
      { id: 'T100', type: 'saga' },
      { id: 'T110', type: 'epic', parentId: 'T100' },
      { id: 'T120', type: 'epic', parentId: 'T100' },
      {
        id: 'T111',
        parentId: 'T110',
        status: status === 'archived' || status === 'missing' ? 'done' : status,
      },
      { id: 'T121', parentId: 'T120', depends: ['T111'], priority: 'high' },
    ]);
    if (status === 'archived') {
      expect(
        await archiveTasks({ taskIds: ['T111'] }, fixture.tempDir, fixture.accessor),
      ).toMatchObject({ archived: ['T111'] });
      expect((await fixture.accessor.queryTasks({})).tasks.map((task) => task.id)).not.toContain(
        'T111',
      );
    }
    if (status === 'missing') {
      const db = await getDb(fixture.tempDir);
      const native = getNativeDb(fixture.tempDir);
      if (!native) throw new Error('Expected canonical native fixture handle');
      native.exec('PRAGMA foreign_keys = OFF');
      try {
        await db.update(schema.taskDependencies).set({ dependsOn: 'T999' }).run();
      } finally {
        native.exec('PRAGMA foreign_keys = ON');
      }
      expect(native.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
      expect(native.prepare('PRAGMA foreign_key_check').all()).toHaveLength(1);
    }
    const ids = ['T100', 'T110', 'T120', 'T111', 'T121'];
    const before = (await fixture.accessor.loadTasks(ids)).map(({ id, parentId, depends }) => ({
      id,
      parentId,
      depends,
    }));
    const projectFile = join(fixture.tempDir, '.cleo/project.json');
    const identity = readFileSync(projectFile, 'utf8');
    const dependent = expect.objectContaining({ id: 'T121' });
    const blocker = status === 'missing' ? 'T999' : 'T111';
    for (const scope of ['T100', 'T120']) {
      expect(JSON.parse(cli(['orchestrate', 'waves', scope]))).toMatchObject({
        success: true,
        data: {
          waves: expect.arrayContaining([
            expect.objectContaining({
              tasks: expect.arrayContaining([
                expect.objectContaining({ id: 'T121', ready, blockedBy: ready ? [] : [blocker] }),
              ]),
            }),
          ]),
        },
      });
      expect(JSON.parse(cli(['orchestrate', 'ready', scope]))).toMatchObject({
        success: true,
        data: {
          readyTasks: ready
            ? expect.arrayContaining([dependent])
            : expect.not.arrayContaining([dependent]),
          ...(!ready
            ? {
                admission: {
                  admitted: expect.not.arrayContaining(['T121']),
                  deferred: expect.not.arrayContaining(['T121']),
                },
              }
            : {}),
        },
      });
    }
    expect(JSON.parse(cli(['orchestrate', 'analyze', 'T120']))).toMatchObject({
      success: true,
      data: {
        totalTasks: 1,
        missingDependencies: status === 'missing' ? [{ taskId: 'T121', missingDep: 'T999' }] : [],
      },
    });
    expect(JSON.parse(cli(['orchestrate', 'report', 'T120']))).toMatchObject({
      success: true,
      data: {
        totalTasks: 1,
        groups: expect.arrayContaining([
          expect.objectContaining({ group: 'ready', count: ready ? 1 : 0 }),
          expect.objectContaining({ group: 'invalid', count: status === 'missing' ? 1 : 0 }),
          expect.objectContaining({
            group: 'blockedBy',
            count: !ready && status !== 'missing' ? 1 : 0,
          }),
        ]),
      },
    });
    expect(JSON.parse(cli(['deps', 'overview']))).toMatchObject({
      success: true,
      data: {
        totalTasks: status === 'archived' ? 4 : 5,
        readyTasks: ready
          ? expect.arrayContaining([dependent])
          : expect.not.arrayContaining([dependent]),
        blockedTasks: ready
          ? []
          : [expect.objectContaining({ id: 'T121', unblockedBy: [blocker] })],
        validation: { valid: status !== 'missing', errorCount: status === 'missing' ? 1 : 0 },
      },
    });
    expect(JSON.parse(cli(['next', '--count', '20']))).toMatchObject({
      success: true,
      data: {
        suggestions: ready
          ? expect.arrayContaining([dependent])
          : expect.not.arrayContaining([dependent]),
      },
    });
    expect(JSON.parse(cli(['saga', 'next', 'T100']))).toMatchObject({
      success: true,
      data: {
        readyFrontier: ready
          ? expect.arrayContaining(['T121'])
          : expect.not.arrayContaining(['T121']),
      },
    });
    expect(readFileSync(projectFile, 'utf8')).toBe(identity);
    expect(
      (await fixture.accessor.loadTasks(ids)).map(({ id, parentId, depends }) => ({
        id,
        parentId,
        depends,
      })),
    ).toEqual(before);
  });
});
