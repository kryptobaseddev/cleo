/**
 * Tests for core upgrade module.
 * @task T4699
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkStorageMigration } from '../migration/preflight.js';

describe('checkStorageMigration', () => {
  let tmpDir: string;
  let cleoDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cleo-upgrade-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cleoDir = join(tmpDir, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects JSON data with no config (v1→v2 upgrade)', () => {
    writeFileSync(join(cleoDir, 'todo.json'), JSON.stringify({
      tasks: [{ id: 'T1', title: 'Test', status: 'pending', createdAt: '2026-01-01' }],
      _meta: { schemaVersion: '2.10.0' },
    }));
    writeFileSync(join(cleoDir, 'config.json'), '{}');

    const result = checkStorageMigration(tmpDir);
    expect(result.migrationNeeded).toBe(true);
    expect(result.summary).toContain('SQLite is the default');
    expect(result.fix).toContain('migrate-storage');
  });

  it('does not flag migration for explicit JSON engine', () => {
    writeFileSync(join(cleoDir, 'todo.json'), JSON.stringify({
      tasks: [{ id: 'T1', title: 'Test', status: 'pending', createdAt: '2026-01-01' }],
      _meta: { schemaVersion: '2.10.0' },
    }));
    writeFileSync(join(cleoDir, 'config.json'), JSON.stringify({ storage: { engine: 'json' } }));

    const result = checkStorageMigration(tmpDir);
    expect(result.migrationNeeded).toBe(false);
    expect(result.currentEngine).toBe('json');
  });

  it('flags broken state: config says sqlite but no DB', () => {
    writeFileSync(join(cleoDir, 'todo.json'), JSON.stringify({
      tasks: [{ id: 'T1', title: 'Test', status: 'pending', createdAt: '2026-01-01' }],
      _meta: { schemaVersion: '2.10.0' },
    }));
    writeFileSync(join(cleoDir, 'config.json'), JSON.stringify({ storage: { engine: 'sqlite' } }));

    const result = checkStorageMigration(tmpDir);
    expect(result.migrationNeeded).toBe(true);
    expect(result.summary).toContain('tasks.db is missing');
  });

  it('does not flag when config says sqlite and DB exists', () => {
    writeFileSync(join(cleoDir, 'todo.json'), JSON.stringify({
      tasks: [{ id: 'T1', title: 'Test', status: 'pending', createdAt: '2026-01-01' }],
      _meta: { schemaVersion: '2.10.0' },
    }));
    writeFileSync(join(cleoDir, 'config.json'), JSON.stringify({ storage: { engine: 'sqlite' } }));
    // Create a tiny DB file (simulating post-migration)
    writeFileSync(join(cleoDir, 'tasks.db'), Buffer.alloc(4096));

    const result = checkStorageMigration(tmpDir);
    expect(result.migrationNeeded).toBe(false);
    expect(result.currentEngine).toBe('sqlite');
  });

  it('reports no data for empty project', () => {
    writeFileSync(join(cleoDir, 'config.json'), '{}');

    const result = checkStorageMigration(tmpDir);
    expect(result.migrationNeeded).toBe(false);
    expect(result.summary).toContain('No data found');
  });

  it('counts archive tasks in total', () => {
    writeFileSync(join(cleoDir, 'todo.json'), JSON.stringify({
      tasks: [],
      _meta: { schemaVersion: '2.10.0' },
    }));
    writeFileSync(join(cleoDir, 'todo-archive.json'), JSON.stringify({
      tasks: [
        { id: 'T1', title: 'Done', status: 'done' },
        { id: 'T2', title: 'Done2', status: 'done' },
      ],
    }));
    writeFileSync(join(cleoDir, 'config.json'), '{}');

    const result = checkStorageMigration(tmpDir);
    expect(result.migrationNeeded).toBe(true);
    expect(result.details.archiveJsonTaskCount).toBe(2);
    expect(result.summary).toContain('2 task(s)');
  });
});
