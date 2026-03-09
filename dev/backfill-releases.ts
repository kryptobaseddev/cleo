/**
 * Backfill 6 missing release records in tasks.db for provenance tracking.
 * Versions v2026.3.21 through v2026.3.26 shipped but were never recorded
 * because the release add/plan CLI was removed in T5615.
 *
 * Usage: npx tsx dev/backfill-releases.ts
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

const DB_PATH = resolve(import.meta.dirname!, '..', '.cleo', 'tasks.db');

interface ReleaseRecord {
  version: string;
  epicId: string;
  previousVersion: string;
}

const releases: ReleaseRecord[] = [
  { version: 'v2026.3.21', epicId: 'T5517', previousVersion: 'v2026.3.20' },
  { version: 'v2026.3.22', epicId: 'T5671', previousVersion: 'v2026.3.21' },
  { version: 'v2026.3.23', epicId: 'T5671', previousVersion: 'v2026.3.22' },
  { version: 'v2026.3.24', epicId: 'T5671', previousVersion: 'v2026.3.23' },
  { version: 'v2026.3.25', epicId: 'T5671', previousVersion: 'v2026.3.24' },
  { version: 'v2026.3.26', epicId: 'T5671', previousVersion: 'v2026.3.25' },
];

function getTagInfo(tag: string): { sha: string; date: string } {
  const sha = execFileSync('git', ['rev-parse', tag], { encoding: 'utf-8' }).trim();
  const date = execFileSync('git', ['log', '-1', '--format=%aI', tag], { encoding: 'utf-8' }).trim();
  return { sha, date };
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL');

const insert = db.prepare(`
  INSERT OR IGNORE INTO release_manifests (
    id, version, status, pipeline_id, epic_id,
    tasks_json, changelog, notes, previous_version,
    commit_sha, git_tag, npm_dist_tag,
    created_at, prepared_at, committed_at, tagged_at, pushed_at
  ) VALUES (
    ?, ?, 'pushed', NULL, ?,
    '[]', NULL, ?, ?,
    ?, ?, 'latest',
    ?, ?, ?, ?, ?
  )
`);

for (const rel of releases) {
  const { sha, date } = getTagInfo(rel.version);
  const patchNum = rel.version.split('.').pop();
  const id = `rel-v2026-3-${patchNum}`;
  const notes = 'Backfilled for provenance tracking (T5671 Phase 5)';

  try {
    const result = insert.run(
      id, rel.version, rel.epicId,
      notes, rel.previousVersion,
      sha, rel.version,
      date, date, date, date, date,
    );
    if (result.changes > 0) {
      console.log(`Inserted: ${rel.version} (${id}) sha=${sha} date=${date}`);
    } else {
      console.log(`Skipped:  ${rel.version} (already exists)`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE')) {
      console.log(`Skipped:  ${rel.version} (already exists)`);
    } else {
      throw err;
    }
  }
}

db.close();
console.log('\nBackfill complete.');
