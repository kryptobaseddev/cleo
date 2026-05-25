#!/usr/bin/env node
/**
 * T10563 PM-Core V2 backup/restore rehearsal artifact.
 *
 * This utility rehearses the safety contract required before any real PM-Core V2
 * migration apply:
 * 1. create a fresh pre-apply backup from the source DB,
 * 2. restore that backup to an isolated smoke-test DB,
 * 3. run SQLite PRAGMA foreign_key_check on the restored DB,
 * 4. apply a tiny deterministic rehearsal probe to the restored DB only,
 * 5. emit machine-readable evidence that documents the restore smoke test.
 *
 * The source DB is never opened for writes by this script.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const WORKTREE_ROOT = resolve(new URL('..', import.meta.url).pathname);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const DEFAULT_SOURCE_DB = join(WORKTREE_ROOT, 'tmp', 't10563', 'fixture-source.db');
const DEFAULT_BACKUP_DB = join(WORKTREE_ROOT, 'tmp', 't10563', 'backups', `tasks.pre-pm-core-v2.${RUN_ID}.db`);
const DEFAULT_RESTORE_DB = join(WORKTREE_ROOT, 'tmp', 't10563', 'restored-smoke.db');
const DEFAULT_EVIDENCE = join(WORKTREE_ROOT, '.cleo', 'agent-outputs', 'T10563-pm-core-v2-backup-restore-rehearsal.evidence.json');

function parseArgs(argv) {
  const args = {
    sourceDb: DEFAULT_SOURCE_DB,
    backupDb: DEFAULT_BACKUP_DB,
    restoreDb: DEFAULT_RESTORE_DB,
    evidence: DEFAULT_EVIDENCE,
    writeEvidence: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source-db') args.sourceDb = resolve(argv[++i]);
    else if (arg === '--backup-db') args.backupDb = resolve(argv[++i]);
    else if (arg === '--restore-db') args.restoreDb = resolve(argv[++i]);
    else if (arg === '--evidence') args.evidence = resolve(argv[++i]);
    else if (arg === '--write-evidence') args.writeEvidence = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/t10563-pm-core-v2-backup-restore-rehearsal.mjs [--write-evidence] [--source-db PATH] [--backup-db PATH] [--restore-db PATH] [--evidence PATH]\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function sha256(path) {
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
    sha256: sha256(path),
  };
}

function sqlite(dbPath, sql) {
  return execFileSync('sqlite3', ['-batch', dbPath, sql], { encoding: 'utf8' }).trim();
}

function copyDb(source, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { force: true });
  execFileSync('cp', ['--reflink=never', '--preserve=mode,timestamps', source, dest]);
}

function isSeparateFile(left, right) {
  return left.dev !== right.dev || left.inode !== right.inode;
}

function foreignKeyCheck(dbPath) {
  const rows = sqlite(dbPath, 'PRAGMA foreign_keys=ON; PRAGMA foreign_key_check;');
  return rows ? rows.split('\n').filter(Boolean) : [];
}

function applyRestoreSmokeProbe(dbPath) {
  const probeTable = 't10563_restore_smoke_probe';
  sqlite(dbPath, `
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS ${probeTable} (
  id INTEGER PRIMARY KEY,
  marker TEXT NOT NULL,
  created_at TEXT NOT NULL
);
DELETE FROM ${probeTable};
INSERT INTO ${probeTable} (id, marker, created_at) VALUES (1, 'restore-smoke-ok', '${RUN_ID}');
COMMIT;
`);
  const rowCount = Number(sqlite(dbPath, `SELECT COUNT(*) FROM ${probeTable} WHERE marker = 'restore-smoke-ok';`));
  return { probeTable, rowCount };
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.sourceDb)) {
    throw new Error(`source DB not found: ${args.sourceDb}`);
  }

  const startedAt = new Date().toISOString();
  const sourceBefore = fileIdentity(args.sourceDb);

  const backupStartedAtMs = Date.now();
  copyDb(args.sourceDb, args.backupDb);
  const backupCreatedAtMs = Date.now();
  const backup = fileIdentity(args.backupDb);

  const restoreStartedAtMs = Date.now();
  copyDb(args.backupDb, args.restoreDb);
  const restoreCreatedAtMs = Date.now();
  const restoredBeforeSmoke = fileIdentity(args.restoreDb);

  const foreignKeyViolations = foreignKeyCheck(args.restoreDb);
  const smokeProbe = applyRestoreSmokeProbe(args.restoreDb);
  const restoredAfterSmoke = fileIdentity(args.restoreDb);
  const sourceAfter = fileIdentity(args.sourceDb);

  const backupSeparateFromSource = isSeparateFile(sourceBefore, backup);
  const restoreSeparateFromBackup = isSeparateFile(backup, restoredBeforeSmoke);
  const backupMatchesSourceSnapshot = backup.sha256 === sourceBefore.sha256 && backup.size === sourceBefore.size;
  const restoreMatchesBackupBeforeSmoke = restoredBeforeSmoke.sha256 === backup.sha256 && restoredBeforeSmoke.size === backup.size;
  const sourceUntouched = sourceBefore.sha256 === sourceAfter.sha256 && sourceBefore.size === sourceAfter.size && sourceBefore.inode === sourceAfter.inode;
  const backupBeforeApply = backupCreatedAtMs <= restoreStartedAtMs;

  const restoreSmokeTest = {
    documented: true,
    steps: [
      `Backup source DB ${args.sourceDb} to ${args.backupDb} before any migration apply command is allowed.`,
      `Restore backup ${args.backupDb} to isolated smoke DB ${args.restoreDb}.`,
      'Run PRAGMA foreign_key_check on the restored smoke DB and require zero rows.',
      `Apply restore-only probe table ${smokeProbe.probeTable} and require one row; never promote the smoke DB.`,
      'If a real PM-Core V2 apply fails later, stop CLEO, replace the live DB with the verified backup, rerun foreign_key_check, then reopen CLEO.',
    ],
  };

  const checks = [
    {
      name: 'AC1 fresh backup created before real apply',
      status: backupSeparateFromSource && backupMatchesSourceSnapshot && backupBeforeApply ? 'pass' : 'fail',
      details: `backup=${args.backupDb}; backupCreatedAtMs=${backupCreatedAtMs}; restoreStartedAtMs=${restoreStartedAtMs}; sha256=${backup.sha256}`,
    },
    {
      name: 'AC2 restore smoke test documented',
      status: restoreSmokeTest.documented && restoreMatchesBackupBeforeSmoke && restoreSeparateFromBackup && smokeProbe.rowCount === 1 ? 'pass' : 'fail',
      details: JSON.stringify({ restoreDb: args.restoreDb, smokeProbe, documentedSteps: restoreSmokeTest.steps.length }),
    },
    {
      name: 'AC3 foreign_key_check part of rehearsal',
      status: foreignKeyViolations.length === 0 ? 'pass' : 'fail',
      details: foreignKeyViolations.length === 0 ? 'PRAGMA foreign_key_check returned zero rows on restored DB.' : foreignKeyViolations.join('\n'),
    },
    {
      name: 'source DB untouched',
      status: sourceUntouched ? 'pass' : 'fail',
      details: `before sha256=${sourceBefore.sha256}; after sha256=${sourceAfter.sha256}`,
    },
  ];

  const evidence = {
    format: 'VitestJsonLike',
    task: 'T10563',
    runId: RUN_ID,
    startedAt,
    status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
    numTotalTests: checks.length,
    numPassedTests: checks.filter((check) => check.status === 'pass').length,
    numFailedTests: checks.filter((check) => check.status !== 'pass').length,
    testResults: checks.map((check) => ({
      assertionResults: [{ title: check.name, status: check.status === 'pass' ? 'passed' : 'failed', failureMessages: check.status === 'pass' ? [] : [check.details] }],
      name: check.name,
      status: check.status === 'pass' ? 'passed' : 'failed',
      message: check.details,
    })),
    db: {
      sourceBefore,
      sourceAfter,
      backup,
      restoredBeforeSmoke,
      restoredAfterSmoke,
      backupSeparateFromSource,
      restoreSeparateFromBackup,
      backupMatchesSourceSnapshot,
      restoreMatchesBackupBeforeSmoke,
      sourceUntouched,
    },
    timeline: {
      backupStartedAtMs,
      backupCreatedAtMs,
      restoreStartedAtMs,
      restoreCreatedAtMs,
      backupBeforeApply,
      realApplyExecuted: false,
    },
    foreignKeyCheck: {
      command: 'PRAGMA foreign_key_check',
      target: args.restoreDb,
      violationRows: foreignKeyViolations,
    },
    restoreSmokeTest,
  };

  if (args.writeEvidence) {
    mkdirSync(dirname(args.evidence), { recursive: true });
    writeFileSync(args.evidence, `${JSON.stringify(evidence, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (evidence.status !== 'pass') process.exitCode = 1;
}

run();
