/**
 * pre-commit-docs-drift hook (T13362) — the ledger read moved from the
 * deprecated `.cleo/docs-publications.json` sidecar to the
 * `docs_publications` table of `.cleo/cleo.db`.
 *
 * These tests spawn the real hook against a throwaway git repo:
 *   - store-table hit → drift advisory on the staged file (exit 0, advisory);
 *   - store table absent/empty + legacy JSON → JSON fallback still catches drift;
 *   - no ledger at all → silent no-op.
 *
 * @task T13362
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'hooks',
  'pre-commit-docs-drift.mjs',
);

let repo;

/** @param {string[]} args */
function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
}

/** Stage `relPath` with `content` (a base commit makes `diff --cached` meaningful). */
function stageFile(relPath, content) {
  mkdirSync(dirname(join(repo, relPath)), { recursive: true });
  writeFileSync(join(repo, relPath), content);
  git(['add', relPath]);
}

function runHook() {
  const r = spawnSync('node', [HOOK], { cwd: repo, encoding: 'utf-8' });
  return { status: r.status, stderr: r.stderr ?? '' };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cleo-docs-drift-hook-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Hook Test']);
  writeFileSync(join(repo, 'README.md'), '# base\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'base']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('pre-commit-docs-drift ledger read (T13362)', () => {
  it('reads the docs_publications store table and warns on staged drift', () => {
    const staged = '# staged edit\n';
    const stagedSha = createHash('sha256').update(staged).digest('hex');
    stageFile('docs/spec.md', staged);

    mkdirSync(join(repo, '.cleo'), { recursive: true });
    const db = new DatabaseSync(join(repo, '.cleo', 'cleo.db'));
    db.exec(`CREATE TABLE docs_publications (
      owner_id text NOT NULL,
      blob_name text NOT NULL,
      published_path text NOT NULL,
      last_blob_sha text NOT NULL,
      published_at text NOT NULL,
      uid text,
      PRIMARY KEY (owner_id, blob_name, published_path)
    )`);
    db.prepare(
      'INSERT INTO docs_publications (owner_id, blob_name, published_path, last_blob_sha, published_at) VALUES (?, ?, ?, ?, ?)',
    ).run('T1', 'spec.md', 'docs/spec.md', 'f'.repeat(64), '2026-01-01T00:00:00.000Z');
    db.close();

    const { status, stderr } = runHook();

    expect(status).toBe(0); // advisory — never blocks
    expect(stderr).toContain('docs-drift');
    expect(stderr).toContain('docs/spec.md');
    expect(stderr).toContain('ffffffffffff'); // the ledger blobSha, not the staged fileSha
    expect(stderr).toContain(stagedSha.slice(0, 12)); // fileSha of the staged drift
  });

  it('falls back to the legacy JSON when the store table has no rows', () => {
    stageFile('docs/old.md', '# edited\n');

    mkdirSync(join(repo, '.cleo'), { recursive: true });
    writeFileSync(
      join(repo, '.cleo', 'docs-publications.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            ownerId: 'T9',
            blobName: 'old.md',
            publishedPath: 'docs/old.md',
            lastBlobSha: 'e'.repeat(64),
            publishedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );

    const { status, stderr } = runHook();

    expect(status).toBe(0);
    expect(stderr).toContain('docs/old.md');
  });

  it('is a silent no-op when no ledger exists anywhere', () => {
    stageFile('docs/free.md', '# free edit\n');
    const { status, stderr } = runHook();
    expect(status).toBe(0);
    expect(stderr).toBe('');
  });
});
