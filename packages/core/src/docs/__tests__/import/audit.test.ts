/**
 * audit unit tests — T9713 (ST-MIG-1d).
 *
 * Covers:
 *   - writeAuditManifest writes the JSON atomically (no .tmp left behind)
 *   - parent dir is created
 *   - manifest content matches the input payload byte-for-byte
 *   - defaultManifestPath produces a sortable timestamped filename
 *
 * @epic T9628 (Saga T9625)
 * @task T9713
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCounters,
  defaultManifestPath,
  type ImportManifest,
  writeAuditManifest,
} from '../../import/audit.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cleo-import-audit-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {
    /* never fail teardown */
  });
});

describe('createCounters', () => {
  it('returns a zeroed counter struct', () => {
    expect(createCounters()).toEqual({
      scanCount: 0,
      importCount: 0,
      noopCount: 0,
      errorCount: 0,
    });
  });
});

describe('defaultManifestPath', () => {
  it('produces a docs-import-<timestamp>.json filename', () => {
    const date = new Date('2026-05-19T12:34:56.789Z');
    const path = defaultManifestPath('/tmp/audit', date);
    expect(path).toBe('/tmp/audit/docs-import-20260519T123456.json');
  });

  it('produces filenames that sort chronologically as strings', () => {
    const a = defaultManifestPath('/tmp', new Date('2026-05-19T12:00:00.000Z'));
    const b = defaultManifestPath('/tmp', new Date('2026-05-19T13:00:00.000Z'));
    expect(a < b).toBe(true);
  });
});

describe('writeAuditManifest', () => {
  const manifest: ImportManifest = {
    startedAt: '2026-05-19T12:00:00.000Z',
    completedAt: '2026-05-19T12:00:01.000Z',
    root: '/tmp/source',
    dryRun: false,
    counters: { scanCount: 2, importCount: 1, noopCount: 1, errorCount: 0 },
    entries: [
      {
        file: 'docs/a.md',
        slug: 'a',
        type: 'spec',
        action: 'created',
        sha: 'abc',
        ts: '2026-05-19T12:00:00.500Z',
        backend: 'manifest.db',
        docId: 'docid-1',
      },
      {
        file: 'docs/b.md',
        slug: 'b',
        type: 'spec',
        action: 'noop',
        sha: 'def',
        ts: '2026-05-19T12:00:00.900Z',
      },
    ],
  };

  it('writes a JSON manifest to the requested path', async () => {
    const path = join(root, 'subdir', 'docs-import-test.json');
    await writeAuditManifest({ path, manifest });
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as ImportManifest;
    expect(parsed).toEqual(manifest);
  });

  it('creates the parent directory if it does not exist', async () => {
    const path = join(root, 'a', 'b', 'c', 'manifest.json');
    await writeAuditManifest({ path, manifest });
    const raw = await readFile(path, 'utf-8');
    expect(raw).toContain('"dryRun": false');
  });

  it('does not leave a .tmp-* file behind after successful write', async () => {
    const path = join(root, 'manifest.json');
    await writeAuditManifest({ path, manifest });
    const entries = await readdir(root);
    expect(entries).toEqual(['manifest.json']);
  });
});
