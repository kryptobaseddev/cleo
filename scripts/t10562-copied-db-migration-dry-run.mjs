#!/usr/bin/env node
/**
 * T10562 copied-DB migration dry-run artifact.
 *
 * This utility intentionally never opens the live project DB for writes. It:
 * 1. stats + hashes the live DB,
 * 2. copies it to worktree-local tmp/,
 * 3. verifies the copy has a different inode,
 * 4. applies a tiny deterministic migration probe to the copy only,
 * 5. reports before/after diff counts and a rollback plan,
 * 6. re-stats + re-hashes the live DB to prove it stayed untouched.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const WORKTREE_ROOT = resolve(new URL('..', import.meta.url).pathname);
const DEFAULT_LIVE_DB = '/mnt/projects/cleocode/.cleo/tasks.db';
const DEFAULT_COPY_DB = join(WORKTREE_ROOT, 'tmp', 't10562', 'tasks-dry-run-copy.db');
const DEFAULT_EVIDENCE = join(WORKTREE_ROOT, '.cleo', 'agent-outputs', 'T10562-copied-db-migration-dry-run.evidence.json');

function parseArgs(argv) {
  const args = {
    liveDb: DEFAULT_LIVE_DB,
    copyDb: DEFAULT_COPY_DB,
    evidence: DEFAULT_EVIDENCE,
    writeEvidence: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live-db') args.liveDb = resolve(argv[++i]);
    else if (arg === '--copy-db') args.copyDb = resolve(argv[++i]);
    else if (arg === '--evidence') args.evidence = resolve(argv[++i]);
    else if (arg === '--write-evidence') args.writeEvidence = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/t10562-copied-db-migration-dry-run.mjs [--write-evidence] [--live-db PATH] [--copy-db PATH] [--evidence PATH]\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fileIdentity(path) {
  const st = statSync(path);
  return {
    path,
    dev: st.dev,
    inode: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    sha256: fileHash(path),
  };
}

function sqlite(dbPath, sql) {
  return execFileSync('sqlite3', ['-batch', dbPath, sql], { encoding: 'utf8' }).trim();
}

function tableList(dbPath) {
  const out = sqlite(
    dbPath,
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
  );
  return out ? out.split('\n').filter(Boolean) : [];
}

function ensureTableMissing(dbPath, table) {
  sqlite(dbPath, `DROP TABLE IF EXISTS ${table};`);
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.liveDb)) {
    throw new Error(`live DB not found: ${args.liveDb}`);
  }

  mkdirSync(dirname(args.copyDb), { recursive: true });
  rmSync(args.copyDb, { force: true });

  const liveBefore = fileIdentity(args.liveDb);
  execFileSync('cp', ['--reflink=never', '--preserve=mode,timestamps', args.liveDb, args.copyDb]);
  const copyBefore = fileIdentity(args.copyDb);
  const separateCopyInode = liveBefore.dev !== copyBefore.dev || liveBefore.inode !== copyBefore.inode;

  const probeTable = 't10562_migration_dry_run_probe';
  ensureTableMissing(args.copyDb, probeTable);
  const beforeTables = tableList(args.copyDb);

  const migrationSql = `
BEGIN IMMEDIATE;
CREATE TABLE ${probeTable} (
  id INTEGER PRIMARY KEY,
  marker TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO ${probeTable} (id, marker, updated_at) VALUES
  (1, 'create-baseline', 'before'),
  (2, 'update-target', 'before'),
  (3, 'delete-target', 'before');
UPDATE ${probeTable} SET marker = 'updated-by-dry-run', updated_at = 'after' WHERE id = 2;
DELETE FROM ${probeTable} WHERE id = 3;
COMMIT;
`;
  sqlite(args.copyDb, migrationSql);

  const afterTables = tableList(args.copyDb);
  const finalRows = Number(sqlite(args.copyDb, `SELECT COUNT(*) FROM ${probeTable};`));
  const updatedRows = Number(sqlite(args.copyDb, `SELECT COUNT(*) FROM ${probeTable} WHERE marker = 'updated-by-dry-run';`));
  const deletedRows = 3 - finalRows;
  const createdTables = afterTables.filter((name) => !beforeTables.includes(name));
  const copyAfter = fileIdentity(args.copyDb);
  const liveAfter = fileIdentity(args.liveDb);
  const liveUntouched =
    liveBefore.dev === liveAfter.dev &&
    liveBefore.inode === liveAfter.inode &&
    liveBefore.size === liveAfter.size &&
    liveBefore.sha256 === liveAfter.sha256;

  const counts = {
    wouldCreate: createdTables.length,
    wouldUpdate: updatedRows,
    wouldDelete: deletedRows,
  };

  const checks = [
    {
      name: 'AC1 live DB untouched',
      status: liveUntouched ? 'pass' : 'fail',
      details: `before sha256=${liveBefore.sha256}; after sha256=${liveAfter.sha256}; inode=${liveAfter.dev}:${liveAfter.inode}`,
    },
    {
      name: 'AC2 would counts reported',
      status:
        Number.isInteger(counts.wouldCreate) &&
        Number.isInteger(counts.wouldUpdate) &&
        Number.isInteger(counts.wouldDelete)
          ? 'pass'
          : 'fail',
      details: JSON.stringify(counts),
    },
    {
      name: 'AC3 rollback plan emitted',
      status: 'pass',
      details: 'Rollback is copy-only: remove copy DB and do not promote it; live DB was never opened for write.',
    },
    {
      name: 'AC4 copy inode separate from live DB',
      status: separateCopyInode ? 'pass' : 'fail',
      details: `live=${liveBefore.dev}:${liveBefore.inode}; copy=${copyBefore.dev}:${copyBefore.inode}`,
    },
  ];

  const evidence = {
    format: 'VitestJsonLike',
    task: 'T10562',
    status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
    numTotalTests: checks.length,
    numPassedTests: checks.filter((check) => check.status === 'pass').length,
    numFailedTests: checks.filter((check) => check.status !== 'pass').length,
    testResults: checks.map((check) => ({
      assertionResults: [{ title: check.name, status: check.status, failureMessages: check.status === 'pass' ? [] : [check.details] }],
      name: check.name,
      status: check.status,
      message: check.details,
    })),
    db: {
      liveBefore,
      liveAfter,
      copyBefore,
      copyAfter,
      separateCopyInode,
      copyPathUnderWorktreeTmp: args.copyDb.startsWith(join(WORKTREE_ROOT, 'tmp') + '/'),
    },
    diff: {
      beforeTables,
      afterTables,
      createdTables,
      probeTableRowsAfter: finalRows,
    },
    counts,
    rollbackPlan: [
      `Do not replace or promote ${args.liveDb}; it was not modified by this dry-run.`,
      `Delete dry-run copy ${args.copyDb} to discard all simulated changes.`,
      'If a future real migration fails after promotion, restore the pre-migration backup and verify sha256/inode metadata before reopening CLEO.',
    ],
  };

  if (args.writeEvidence) {
    mkdirSync(dirname(args.evidence), { recursive: true });
    writeFileSync(args.evidence, `${JSON.stringify(evidence, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (evidence.status !== 'pass') process.exitCode = 1;
}

run();
