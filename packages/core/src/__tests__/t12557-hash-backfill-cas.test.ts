/**
 * The legacy `projectHash` backfill never clobbers a concurrent re-key (T12557).
 *
 * `readProjectInfoAtDirectory` reads the file, derives a hash and persists it.
 * If `cleo doctor project-identity --resolve` re-keys the file between that
 * read and the write, a blind `{ ...staleData, projectHash }` rename would put
 * the OLD projectId back. The read is simulated as stale by serving the
 * pre-re-key bytes from `readFile` while the disk already holds the re-key.
 *
 * @task T12557
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stale = vi.hoisted(() => ({ bytes: undefined as string | undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (stale.bytes !== undefined) {
        const bytes = stale.bytes;
        stale.bytes = undefined;
        return bytes;
      }
      return actual.readFile(...args);
    }) as typeof actual.readFile,
  };
});

import { readProjectInfoAtDirectory } from '../project-scope.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-t12557-cas-'));
  mkdirSync(join(root, '.cleo'));
});

afterEach(() => {
  stale.bytes = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('T12557: hashless backfill is compare-and-swap', () => {
  it('does not overwrite a file re-keyed after the read', async () => {
    const infoPath = join(root, '.cleo', 'project-info.json');
    const rekeyed = { projectId: 'tracked-b', previousProjectIds: ['local-a'] };
    writeFileSync(infoPath, JSON.stringify(rekeyed));
    stale.bytes = JSON.stringify({ projectId: 'local-a' });

    const info = await readProjectInfoAtDirectory(root, join(root, '.cleo'));
    expect(info.projectId).toBe('local-a');
    expect(info.projectHash).toMatch(/^[a-f0-9]{12}$/);
    expect(JSON.parse(readFileSync(infoPath, 'utf-8'))).toEqual(rekeyed);
  });

  it('still backfills once when the file is unchanged', async () => {
    const infoPath = join(root, '.cleo', 'project-info.json');
    writeFileSync(infoPath, JSON.stringify({ projectId: 'same' }));
    const info = await readProjectInfoAtDirectory(root, join(root, '.cleo'));
    expect(JSON.parse(readFileSync(infoPath, 'utf-8'))).toEqual({
      projectId: 'same',
      projectHash: info.projectHash,
    });
  });
});
