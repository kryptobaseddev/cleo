/**
 * Regression coverage for `saga.create` dry-run/preflight semantics.
 *
 * T10647: guards the historical T10537 accidental-create bug where
 * `cleo saga create --dry-run` validated but still persisted a Saga task.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TasksHandler } from '../tasks.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { open?: boolean; readOnly?: boolean },
  ) => {
    prepare(sql: string): { get(): Record<string, unknown> | undefined };
    close(): void;
  };
};

interface SagaCreateData {
  task: { id: string; labels?: string[]; type?: string };
  duplicate: boolean;
  dryRun?: boolean;
  wouldCreate?: number;
  wouldAffect?: number;
  validatedCount?: number;
  insertedCount?: number;
}

let tempDir: string;

function countRows(table: string): number {
  const db = new DatabaseSync(join(tempDir, '.cleo', 'tasks.db'), { open: true, readOnly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    return Number(row?.['count'] ?? 0);
  } finally {
    db.close();
  }
}

function countDryRunGuardTables(): Record<string, number> {
  return {
    tasks: countRows('tasks'),
    task_acceptance_criteria: countRows('task_acceptance_criteria'),
    task_relations: countRows('task_relations'),
    attachments: countRows('attachments'),
    attachment_refs: countRows('attachment_refs'),
  };
}

describe('T10647: saga.create dry-run', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-saga-dry-run-'));
    const cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({
        lifecycle: { mode: 'off' },
        enforcement: {
          acceptance: { mode: 'off' },
          session: { requiredForMutate: false },
        },
      }),
      'utf-8',
    );
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeDb, closeAllDatabases } = await import('@cleocode/core/internal');
    try {
      closeDb();
    } catch {
      // ignore close errors
    }
    try {
      await closeAllDatabases();
    } catch {
      // ignore close errors
    }
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('validates and previews without inserting task, saga, doc, or relation rows', async () => {
    const handler = new TasksHandler();

    // Initialize the schema before the before/after snapshot so this assertion
    // proves the dry-run itself performs zero persistent writes.
    const initialResp = await handler.query('saga.list', {});
    expect(initialResp.success).toBe(true);
    const beforeCounts = countDryRunGuardTables();

    const createResp = await handler.mutate('saga.create', {
      title: 'Dry Run Saga T10537 Regression',
      description: 'Historical T10537 accidental-create regression guard',
      acceptance: ['dry-run validates only', 'zero persistent rows inserted'],
      dryRun: true,
    });

    expect(createResp.success, 'saga.create --dry-run must succeed').toBe(true);
    expect(createResp.error).toBeUndefined();

    const createData = createResp.data as SagaCreateData;
    expect(createData.task.id).toBe('T???');
    expect(createData.task.type).toBe('saga');
    expect(createData.dryRun).toBe(true);
    expect(createData.wouldCreate).toBe(1);
    expect(createData.wouldAffect).toBe(1);
    expect(createData.validatedCount).toBe(1);
    expect(createData.insertedCount).toBe(0);

    expect(countDryRunGuardTables()).toEqual(beforeCounts);
  });
});
