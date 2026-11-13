/** Lossless whole-store repair: copy, salvage, merge, migrate, validate, atomic commit. */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type {
  StoreRepairOptions,
  StoreRepairPhase,
  StoreRepairReceipt,
} from '@cleocode/contracts/db-recovery.js';
import { CleoError } from '../errors.js';
import { lockCompromiseTracker, withLock } from './lock.js';
import { openCleoDbSnapshot } from './open-cleo-db.js';
import { collectSnapshotCandidatesForRole } from './recover-malformed-db.js';
import {
  assertRepairOriginals,
  assertRepairQuiescent,
  commitRepairImage,
  copyRepairOriginals,
  inspectStoreIntegrity,
  prepareRepairCommit,
  repairFileHash,
  repairFsync,
} from './repair-store-files.js';
import { repairTableCounts, salvageIntoSnapshot } from './repair-store-salvage.js';
import { holdRestoreMarker, storeCorruptError } from './restore-marker.js';

/**
 * The error's exact repair command also handles global damage encountered by
 * a project command. An explicit global scope restricts repair to that store.
 */
export async function repairStoresFromDoctor(
  opts: StoreRepairOptions,
): Promise<StoreRepairReceipt[]> {
  const stores: StoreRepairReceipt[] = [];
  if (opts.scope !== 'global') {
    const { resolveDualScopeDbPath } = await import('./dual-scope-db.js');
    const global = resolveDualScopeDbPath('global');
    if (!inspectStoreIntegrity(global).healthy || pendingCheckpoint(global, 'global')) {
      stores.push(await repairStore({ ...opts, scope: 'global' }));
    }
  }
  stores.push(await repairStore(opts));
  return stores;
}

/** Validate a private copy. Never probe the live file with SQLite. */
function verify(
  file: string,
  base: Readonly<Record<string, number>> = {},
  checkForeignKeys = true,
): Record<string, number> {
  const snap = openCleoDbSnapshot(file, { applyPragmas: false, loadSqliteVec: true });
  try {
    const checks = snap.db.prepare('PRAGMA integrity_check').all();
    if (checks.length !== 1 || checks[0]?.integrity_check !== 'ok')
      // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
      throw new Error(`integrity_check failed: ${JSON.stringify(checks)}`);
    const foreign = checkForeignKeys ? snap.db.prepare('PRAGMA foreign_key_check').all() : [];
    if (foreign.length > 0)
      // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
      throw new Error(`foreign_key_check failed: ${JSON.stringify(foreign.slice(0, 10))}`);
    const counts = repairTableCounts(snap.db);
    for (const [table, n] of Object.entries(base)) {
      if ((counts[table] ?? -1) < n)
        // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
        throw new Error(`Repair would shrink ${table}: ${n} to ${counts[table] ?? 'missing'}`);
    }
    return counts;
  } finally {
    snap.close();
  }
}

function receiptFile(receipt: StoreRepairReceipt): void {
  if (receipt.quarantineDir === null) return;
  const file = join(receipt.quarantineDir, 'receipt.json');
  const temporary = `${file}.tmp`;
  if (receipt.recovery?.rows.length) {
    receipt.recovery.file = join(receipt.quarantineDir, 'recovery.json');
    const recoveryTemp = `${receipt.recovery.file}.tmp`;
    writeFileSync(recoveryTemp, `${JSON.stringify(receipt.recovery.rows, null, 2)}\n`, {
      mode: 0o600,
    });
    repairFsync(recoveryTemp);
    renameSync(recoveryTemp, receipt.recovery.file);
  }
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  repairFsync(temporary);
  renameSync(temporary, file);
  if (process.platform !== 'win32') repairFsync(receipt.quarantineDir);
}

/** Match only a published image from an interrupted repair, never an ordinary healthy WAL. */
function pendingCheckpoint(
  target: string,
  scope: 'project' | 'global',
): StoreRepairReceipt | undefined {
  const root = join(dirname(target), 'quarantine');
  if (!existsSync(root)) return undefined;
  for (const name of readdirSync(root).sort().reverse()) {
    const dir = join(root, name);
    const file = join(dir, 'receipt.json');
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      // Completed receipts may contain large excluded payloads; read their metadata first.
      const fd = openSync(file, 'r');
      const bytes = Buffer.alloc(128 * 1024);
      let n: number;
      try {
        n = readSync(fd, bytes, 0, bytes.length, 0);
      } finally {
        closeSync(fd);
      }
      const header = bytes.subarray(0, n).toString('utf8');
      if (!header.includes(`\n  "target": ${JSON.stringify(target)},\n`)) continue;
      const status = /^ {2}"status": "([^"]+)"/m.exec(header)?.[1];
      if (status === 'repaired') return undefined;
      if (status !== 'checkpoint-pending') continue;
      const receipt = JSON.parse(readFileSync(file, 'utf8')) as StoreRepairReceipt;
      if (
        receipt.version !== 1 ||
        receipt.status !== 'checkpoint-pending' ||
        receipt.scope !== scope ||
        receipt.target !== target ||
        receipt.quarantineDir !== dir ||
        !Array.isArray(receipt.diagnostics) ||
        !receipt.tables ||
        typeof receipt.tables !== 'object' ||
        Array.isArray(receipt.tables)
      )
        continue;
      if (
        !Object.values(receipt.tables).every(
          (t) => t && typeof t.final === 'number' && Number.isSafeInteger(t.final) && t.final >= 0,
        )
      )
        continue;
      if (
        typeof receipt.commitWalSha256 !== 'string' ||
        typeof receipt.commitMainSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(receipt.commitWalSha256) ||
        !/^[a-f0-9]{64}$/.test(receipt.commitMainSha256)
      )
        continue;
      if (
        (existsSync(`${target}-wal`) &&
          repairFileHash(`${target}-wal`) === receipt.commitWalSha256) ||
        repairFileHash(target) === receipt.commitMainSha256
      )
        return receipt;
    } catch {
      /* An unrelated or unfinished receipt cannot authorize a checkpoint. */
    }
  }
  return undefined;
}

/** Checkpoint only after publication (or on a private dry-run copy), under repair exclusion. */
function checkpointImage(file: string): void {
  const handle = openCleoDbSnapshot(file, {
    readOnly: false,
    applyPragmas: false,
    loadSqliteVec: true,
  });
  try {
    const result = handle.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (Number(result?.busy) !== 0)
      // @sync-invariant none:local-only publication is valid but success waits for a verified checkpoint
      throw new Error(
        'Committed repair could not finish its checkpoint; rerun cleo doctor repair-store',
      );
  } finally {
    handle.close();
  }
  repairFsync(file);
  if (process.platform !== 'win32') repairFsync(dirname(file));
}

/** All historical whole-store snapshot labels, validated by contents before use. */
function candidates(
  target: string,
  opts: StoreRepairOptions,
): { path: string; timestampMs: number }[] {
  const home = dirname(target);
  const snapshotDir = join(home, 'backups', 'snapshot');
  const vacuumSnapshotDir = join(home, 'backups', 'sqlite');
  const out = collectSnapshotCandidatesForRole({
    role: 'tasks',
    snapshotDir,
    vacuumSnapshotDir,
    legacyArtifactDir: home,
  });
  const known = new Set(out.map((s) => s.path));
  for (const directory of [snapshotDir, vacuumSnapshotDir, home]) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      if (
        !/^(?:cleo|tasks|brain|conduit|nexus|global)(?:\.db[.-]|-.*\.db$)/.test(name) ||
        /pre-restore|\.restoring(?:\.|$)|(?:-wal|-shm|-journal|\.json)$/.test(name)
      )
        continue;
      const path = join(directory, name);
      if (known.has(path) || !statSync(path).isFile()) continue;
      out.push({ path, timestampMs: statSync(path).mtimeMs, source: 'system-snapshot' });
      known.add(path);
    }
  }
  const pin = opts.fromSnapshot;
  if (pin && isAbsolute(pin) && !known.has(pin))
    out.push({ path: resolve(pin), timestampMs: statSync(pin).mtimeMs, source: 'system-snapshot' });
  return out
    .filter((s) => !pin || s.path === resolve(opts.cwd, pin) || basename(s.path).includes(pin))
    .sort((a, b) => b.timestampMs - a.timestampMs);
}

/** Report commit-message references; absence is evidence to investigate, never a new task. */
function missingTasks(staged: string, receipt: StoreRepairReceipt, projectRoot: string): string[] {
  if (receipt.scope !== 'project') return [];
  const args = [
    'log',
    '--format=%B',
    ...(receipt.snapshotAt ? [`--since=${receipt.snapshotAt}`] : []),
  ];
  const log = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (log.error || log.status !== 0) {
    receipt.diagnostics.push(`git log unavailable: ${log.error?.message ?? log.stderr.trim()}`);
    return [];
  }
  const ids = new Set(log.stdout.match(/\bT\d+\b/g) ?? []);
  const db = openCleoDbSnapshot(staged, { applyPragmas: false, loadSqliteVec: true });
  try {
    const has = db.db.prepare('SELECT 1 FROM main.tasks_tasks WHERE id = ?');
    return [...ids].filter((id) => has.get(id) === undefined).sort();
  } finally {
    db.close();
  }
}

async function migrate(staged: string, scope: 'project' | 'global'): Promise<void> {
  const { openDualScopeDbAtPath } = await import('./dual-scope-db.js');
  const handle =
    scope === 'project'
      ? await openDualScopeDbAtPath('project', staged, undefined, { dedicated: true })
      : await openDualScopeDbAtPath('global', staged, undefined, { dedicated: true });
  handle.close();
}

/**
 * Repair project or global cleo.db with no destructive pre-commit step.
 * Quarantine originals are never opened by SQLite; all work uses expendable
 * copies. Publishing a validated, full-image WAL is the only live mutation.
 */
export async function repairStore(opts: StoreRepairOptions): Promise<StoreRepairReceipt> {
  const scope = opts.scope ?? 'project';
  const { resolveDualScopeDbPath } = await import('./dual-scope-db.js');
  const target =
    scope === 'project'
      ? resolveDualScopeDbPath('project', opts.projectRoot)
      : resolveDualScopeDbPath('global');
  let receipt: StoreRepairReceipt = {
    version: 1,
    scope,
    target,
    startedAt: new Date().toISOString(),
    status: 'prepared',
    quarantineDir: null,
    snapshot: null,
    snapshotAt: null,
    delta: opts.noDelta !== true,
    files: [],
    tables: {},
    missingTaskIds: [],
    diagnostics: [],
    integrityOK: false,
  };
  Object.setPrototypeOf(receipt.tables, null);
  if (!existsSync(target)) {
    receipt.status = 'absent';
    receipt.integrityOK = true;
    return receipt;
  }
  if (
    opts.restoreSnapshot !== true &&
    inspectStoreIntegrity(target).healthy &&
    !pendingCheckpoint(target, scope)
  ) {
    receipt.status = 'healthy';
    receipt.integrityOK = true;
    return receipt;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'cleo-store-repair-'));
  let assertCommitGuard = (): void => {};
  const phase = (name: StoreRepairPhase): void => {
    receiptFile(receipt);
    opts.onPhase?.(name);
  };
  const execute = async (): Promise<StoreRepairReceipt> => {
    let committed = false;
    let checkpointed = false;
    const finishCheckpoint = (file: string, expected: Readonly<Record<string, number>>): void => {
      phase('checkpoint');
      checkpointImage(file);
      phase('checkpointed');
      const alone = join(scratch, 'checkpoint-main.db');
      copyRepairOriginals(file, alone, false);
      verify(alone, expected);
      checkpointed = true;
      receipt.integrityOK = true;
      receipt.status = opts.dryRun ? 'dry-run' : 'repaired';
      phase('receipt');
    };
    try {
      // Re-check after admission: a different repair may have won the race.
      if (opts.restoreSnapshot !== true && inspectStoreIntegrity(target).healthy) {
        const pending = pendingCheckpoint(target, scope);
        if (!pending) {
          receipt.status = 'healthy';
          receipt.integrityOK = true;
          return receipt;
        }
        receipt = opts.dryRun ? { ...pending, quarantineDir: null } : pending;
        receipt.diagnostics.push('Resuming the checkpoint of an already-published repair image');
        const counts = Object.fromEntries(
          Object.entries(receipt.tables).map(([table, t]) => [table, t.final]),
        );
        if (opts.dryRun) {
          const preview = join(scratch, 'checkpoint-preview.db');
          copyRepairOriginals(target, preview);
          finishCheckpoint(preview, counts);
        } else {
          committed = true;
          assertRepairQuiescent(target);
          assertCommitGuard();
          finishCheckpoint(target, counts);
        }
        return receipt;
      }
      if (!opts.dryRun) {
        assertRepairQuiescent(target);
        const root = join(dirname(target), 'quarantine');
        mkdirSync(root, { recursive: true, mode: 0o700 });
        receipt.quarantineDir = mkdtempSync(
          join(root, `${receipt.startedAt.replace(/[:.]/g, '-')}-`),
        );
      }
      const work = receipt.quarantineDir ?? scratch;
      const original = join(work, basename(target));
      receipt.files = copyRepairOriginals(target, original);
      phase('quarantine');
      const withWal = join(scratch, 'with-wal.db');
      const withoutWal = join(scratch, 'without-wal.db');
      copyRepairOriginals(original, withWal);
      copyRepairOriginals(original, withoutWal, false);
      phase('diagnose');
      const staged = join(work, 'merged.db');
      for (const candidate of candidates(target, opts)) {
        const probe = join(scratch, 'snapshot.db');
        try {
          copyRepairOriginals(candidate.path, probe);
          const counts = verify(probe, {}, false);
          const db = openCleoDbSnapshot(probe, { applyPragmas: false, loadSqliteVec: true });
          let shape = false;
          try {
            const has = (name: string): boolean =>
              db.db
                .prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?")
                .get(name) !== undefined;
            shape =
              scope === 'project'
                ? has('tasks_tasks')
                : has('nexus_project_registry') && !has('tasks_tasks');
            if (shape) db.db.exec(`VACUUM INTO '${staged.replaceAll("'", "''")}'`);
          } finally {
            db.close();
          }
          if (!shape) continue;
          receipt.snapshot = candidate.path;
          receipt.snapshotAt = new Date(candidate.timestampMs).toISOString();
          for (const [table, n] of Object.entries(counts))
            receipt.tables[table] = {
              snapshot: n,
              salvaged: 0,
              merged: 0,
              unreadable: 0,
              final: n,
            };
          break;
        } catch (error) {
          receipt.diagnostics.push(
            `snapshot ${candidate.path}: ${error instanceof Error ? error.message : String(error)}`,
          );
          rmSync(staged, { force: true });
        } finally {
          for (const s of ['', '-wal', '-shm', '-journal']) rmSync(probe + s, { force: true });
        }
      }
      if (!existsSync(staged) && (opts.fromSnapshot || opts.noDelta))
        // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
        throw new Error('No validated whole-store snapshot matches the requested recovery');
      // Upgrade the base before selecting shared columns; newer damaged values must fit.
      await migrate(staged, scope);
      phase('salvage');
      const finishJournal = receipt.delta
        ? salvageIntoSnapshot(staged, [withWal, withoutWal], receipt)
        : undefined;
      phase('merge');
      await migrate(staged, scope);
      finishJournal?.();
      const { markSuspect } = await import('./sync/structural.js');
      const { syncSetTables } = await import('./sync/capture.js');
      const db = openCleoDbSnapshot(staged, {
        readOnly: false,
        applyPragmas: false,
        loadSqliteVec: true,
      });
      try {
        markSuspect(db.db, scope, syncSetTables(scope));
      } finally {
        db.close();
      }
      phase('migrate');
      const base = Object.fromEntries(
        Object.entries(receipt.tables)
          .filter(([, t]) => !t.rebuilt)
          .map(([table, t]) => [table, Math.max(0, t.snapshot - (t.baseRemoved ?? 0))]),
      );
      const counts = verify(staged, base);
      for (const [table, n] of Object.entries(counts)) {
        receipt.tables[table] ??= {
          snapshot: 0,
          salvaged: 0,
          merged: 0,
          unreadable: 0,
          final: 0,
        };
        receipt.tables[table].final = n;
      }
      receipt.missingTaskIds = missingTasks(staged, receipt, opts.projectRoot);
      const wal = join(work, 'install.wal');
      prepareRepairCommit(staged, original, wal);
      // Validate exactly the bytes that the single rename will make visible,
      // including the original main and SHM, before touching either original.
      const proof = join(scratch, 'commit-proof.db');
      copyRepairOriginals(original, proof);
      copyFileSync(wal, `${proof}-wal`);
      verify(proof, counts);
      receipt.integrityOK = true;
      phase('validate');
      if (opts.dryRun) {
        finishCheckpoint(proof, counts);
        return receipt;
      }
      await setImmediate();
      assertCommitGuard();
      assertRepairQuiescent(target);
      assertRepairOriginals(target, receipt.files);
      receipt.commitWalSha256 = repairFileHash(wal);
      receipt.commitMainSha256 = repairFileHash(staged);
      receipt.status = 'checkpoint-pending';
      phase('commit');
      assertCommitGuard();
      commitRepairImage(wal, target);
      committed = true;
      if (process.platform !== 'win32') repairFsync(dirname(target));
      finishCheckpoint(target, counts);
      return receipt;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      if (committed && checkpointed) {
        receipt.status = 'repaired';
        receipt.diagnostics.push(`Repair checkpointed; receipt finalization: ${cause.message}`);
        return receipt;
      }
      if (committed) {
        receipt.status = 'checkpoint-pending';
        receipt.integrityOK = false;
        receipt.diagnostics.push(`Repair image committed; checkpoint pending: ${cause.message}`);
        receiptFile(receipt);
        // @sync-invariant none:local-only success requires verifying the checkpointed main image
        throw storeCorruptError(target, cause);
      }
      receipt.status = 'failed';
      receipt.diagnostics.push(cause.message);
      receiptFile(receipt);
      // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
      throw storeCorruptError(target, cause);
    }
  };
  try {
    if (opts.dryRun) return await execute();
    if (scope === 'project') {
      const { assertOwnerStoreRewriteConfirmed } = await import('./worktree-isolation-guard.js');
      assertOwnerStoreRewriteConfirmed('doctor repair-store', target, opts);
    }
    const { FIRST_OPEN_LOCK_SUFFIX } = await import('./sqlite.js');
    const compromise = lockCompromiseTracker();
    return await withLock(
      `${target}${FIRST_OPEN_LOCK_SUFFIX}`,
      async () => {
        const marker = holdRestoreMarker(target, 'restore');
        assertCommitGuard = (): void => {
          if (!marker.intact() || compromise.reason())
            // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
            throw new Error(
              'Repair lost its first-open lock or restore marker; no commit is permitted',
            );
        };
        try {
          const result = await execute();
          if (compromise.reason())
            result.diagnostics.push(`first-open lock: ${compromise.reason()}`);
          return result;
        } finally {
          marker.release();
        }
      },
      { retries: 20, onCompromised: compromise.onCompromised },
    );
  } catch (error) {
    if (error instanceof CleoError) throw error;
    // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
    throw storeCorruptError(target, error instanceof Error ? error : new Error(String(error)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Disposable-copy integrity inspection used by doctor and recovery. */
export { inspectStoreIntegrity } from './repair-store-files.js';
