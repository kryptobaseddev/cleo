/**
 * Tests for snapshot export/import module.
 * @task T4882
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  exportSnapshot,
  writeSnapshot,
  readSnapshot,
  importSnapshot,
  getDefaultSnapshotPath,
} from '../snapshot/index.js';
import type { Snapshot } from '../snapshot/index.js';

describe('snapshot', () => {
  let tempDir: string;
  const origDir = process.env['CLEO_DIR'];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-snapshot-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
    else delete process.env['CLEO_DIR'];
  });

  describe('writeSnapshot / readSnapshot', () => {
    it('round-trips a snapshot to/from disk', async () => {
      const snapshot: Snapshot = {
        $schema: 'https://lafs.dev/schemas/v1/cleo-snapshot.schema.json',
        _meta: {
          format: 'cleo-snapshot',
          version: '1.0.0',
          createdAt: '2026-02-25T00:00:00.000Z',
          source: { project: 'test', cleoVersion: '0.90.0' },
          checksum: 'abc123',
          taskCount: 1,
        },
        project: { name: 'test' },
        tasks: [
          {
            id: 'T001',
            title: 'Test task',
            status: 'pending',
            priority: 'medium',
            createdAt: '2026-02-25T00:00:00.000Z',
          },
        ],
      };

      const filePath = join(tempDir, 'snapshots', 'test-snapshot.json');
      await writeSnapshot(snapshot, filePath);

      const loaded = await readSnapshot(filePath);
      expect(loaded._meta.format).toBe('cleo-snapshot');
      expect(loaded._meta.taskCount).toBe(1);
      expect(loaded.tasks).toHaveLength(1);
      expect(loaded.tasks[0].id).toBe('T001');
      expect(loaded.tasks[0].title).toBe('Test task');
    });

    it('rejects invalid snapshot format', async () => {
      const invalidPath = join(tempDir, 'invalid.json');
      await writeFile(invalidPath, JSON.stringify({ _meta: { format: 'wrong' } }));

      await expect(readSnapshot(invalidPath)).rejects.toThrow('Invalid snapshot format');
    });
  });

  describe('getDefaultSnapshotPath', () => {
    it('returns a path in .cleo/snapshots/', () => {
      const cleoDir = join(tempDir, '.cleo');
      process.env['CLEO_DIR'] = cleoDir;
      const path = getDefaultSnapshotPath(tempDir);
      expect(path).toContain('snapshots');
      expect(path).toContain('snapshot-');
      expect(path).toMatch(/\.json$/);
    });
  });
});
