/** File operations for recovery: originals are read only until a single atomic commit. */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { StoreRepairFile } from '@cleocode/contracts/db-recovery.js';
import { isLocked } from './lock.js';
import {
  copyRepairOriginals,
  openCleoDbSnapshot,
  REPAIR_SIDECARS,
  repairFileHash,
  repairFsync,
} from './open-cleo-db.js';
import { foreignWriterLeases } from './writer-lease.js';

/** Shared snapshot-copy primitives remain available to recovery callers. */
export {
  copyRepairOriginals,
  inspectStoreIntegrity,
  REPAIR_SIDECARS,
  repairFileHash,
  repairFsync,
} from './open-cleo-db.js';

/** Verify that neither an original file nor its sidecar population changed during repair. */
export function assertRepairOriginals(target: string, files: readonly StoreRepairFile[]): void {
  for (const suffix of REPAIR_SIDECARS) {
    const expected = files.find((f) => f.name === basename(target + suffix));
    if (
      existsSync(target + suffix) !== (expected !== undefined) ||
      (expected && repairFileHash(target + suffix) !== expected.sha256)
    ) {
      // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
      throw new Error(`Store changed during repair: ${target + suffix}`);
    }
  }
}

/** Linux exposes SQLite's locks across users even when another account's fd directory is private. */
function linuxLockIdentity(file: string): string {
  const { dev, ino } = statSync(file, { bigint: true });
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return `${major}:${minor}:${ino}`;
}

/**
 * Prove quiescence without opening the damaged SQLite file. A normal lock
 * probe can checkpoint or delete a live WAL on close, destroying evidence.
 * The first-open lock and restore marker exclude racing CLEO opens; this
 * check also refuses pre-existing SQLite handles, including this process's.
 */
export async function assertRepairQuiescent(target: string, diagnostics: string[]): Promise<void> {
  // The first-open lock is ours; the ordinary writer lock must be unheld.
  if (await isLocked(target))
    // @sync-invariant none:local-only an existing CLEO writer excludes local store replacement
    throw new Error('Another CLEO writer holds the store lock');
  const scratch = mkdtempSync(join(tmpdir(), 'cleo-repair-lease-'));
  let held: ReturnType<typeof foreignWriterLeases> = [];
  try {
    const copy = join(scratch, 'lease.db');
    copyRepairOriginals(target, copy);
    try {
      held = foreignWriterLeases(copy);
    } catch (error) {
      // A damaged lease table cannot supersede the kernel and process-handle proof below.
      const message = `Writer lease rows unreadable: ${error instanceof Error ? error.message : String(error)}`;
      if (!diagnostics.includes(message)) diagnostics.push(message);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (held.length)
    // @sync-invariant none:local-only live CLEO lease holders exclude local store replacement
    throw new Error(
      `Store has live CLEO writer leases: ${held.map((h) => `pid ${h.holderPid} (${h.lane})`).join(', ')}`,
    );
  const paths = REPAIR_SIDECARS.map((s) => target + s).filter(existsSync);
  if (process.platform === 'linux') {
    const inodes = new Set(paths.map(linuxLockIdentity));
    for (const line of readFileSync('/proc/locks', 'utf8').split('\n')) {
      const m = /\b([0-9a-f]+):([0-9a-f]+):(\d+)\b/i.exec(line);
      if (
        m?.[1] &&
        m[2] &&
        m[3] &&
        inodes.has(`${BigInt(`0x${m[1]}`)}:${BigInt(`0x${m[2]}`)}:${BigInt(m[3])}`)
      ) {
        // @sync-invariant none:local-only a kernel lock excludes replacement of the local store
        throw new Error('Another connection holds a kernel lock on the store');
      }
    }
    const uid = statSync('/proc/self').uid;
    for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
      let descriptors: string[];
      try {
        // Other accounts' SQLite locks were checked above; inspect all of our own idle handles too.
        if (statSync(`/proc/${pid}`).uid !== uid) continue;
        descriptors = readdirSync(`/proc/${pid}/fd`);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        if (
          Number(pid) !== process.pid &&
          error instanceof Error &&
          'code' in error &&
          (error.code === 'EACCES' || error.code === 'EPERM')
        ) {
          const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
          if (!comm || /^(?:node(?:js)?|cleo|bun|deno|sqlite3?)(?:$|[ .-])/i.test(comm))
            // @sync-invariant none:local-only an uninspectable possible store holder excludes repair
            throw new Error(
              `Cannot inspect possible store holder pid ${pid} (${comm || 'unnamed'})`,
            );
          const message = `Skipped inaccessible descriptors for non-store process pid ${pid} (${comm})`;
          if (!diagnostics.includes(message)) diagnostics.push(message);
          continue;
        }
        // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
        throw new Error(`Cannot inspect open store handles for pid ${pid}`);
      }
      for (const descriptor of descriptors) {
        try {
          const identity = linuxLockIdentity(`/proc/${pid}/fd/${descriptor}`);
          // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
          if (inodes.has(identity)) throw new Error(`Store is open in pid ${pid}`);
        } catch (error) {
          if (error instanceof Error && /Store is open/.test(error.message)) throw error;
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
          throw error;
        }
      }
    }
    return;
  }
  if (process.platform === 'win32') {
    const script = paths
      .map(
        (p) => `$s=[IO.File]::Open('${p.replaceAll("'", "''")}','Open','Read','None');$s.Dispose()`,
      )
      .join(';');
    const probe = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(`$ErrorActionPreference='Stop';${script}`, 'utf16le').toString('base64'),
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    if (probe.error || probe.status !== 0)
      // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
      throw new Error(`Cannot exclusively open the store: ${probe.error?.message ?? probe.stderr}`);
    return;
  }
  const probe = spawnSync('/usr/bin/fuser', ['-f', ...paths], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  const unexpected = probe.stderr
    .split('\n')
    .filter((line) => line.trim() && !paths.some((path) => line.trim() === `${path}:`));
  if (probe.error || probe.status !== 0 || unexpected.length > 0) {
    // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
    throw new Error(`Cannot prove the store is closed: ${probe.error?.message ?? probe.stderr}`);
  }
  // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
  if (probe.stdout.trim()) throw new Error(`Store is open: ${probe.stdout.trim()}`);
}

/**
 * Build an installable, full-image WAL with SQLite itself. VACUUM in WAL mode
 * writes every output page in one transaction. Publishing that WAL is ONE
 * rename: there is no interval with a missing original WAL or an old WAL
 * overlaying a new main file. A subsequent ordinary checkpoint folds it in.
 * The WAL supplies page 1 too, so even a destroyed main header is replaced.
 * Its page size comes from the staged image, never from the damaged header.
 */
export function prepareRepairCommit(staged: string, original: string, candidate: string): void {
  const snap = openCleoDbSnapshot(staged, {
    readOnly: false,
    applyPragmas: false,
    loadSqliteVec: true,
  });
  try {
    snap.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    snap.db.exec('VACUUM; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; VACUUM');
    copyFileSync(`${staged}-wal`, candidate, constants.COPYFILE_EXCL);
    chmodSync(candidate, statSync(original).mode & 0o777);
    repairFsync(candidate);
    // Check the full-image property, rather than depending only on VACUUM's implementation.
    const walFd = openSync(candidate, 'r');
    try {
      const header = Buffer.alloc(32);
      readSync(walFd, header, 0, 32, 0);
      const frameSize = header.readUInt32BE(8) + 24;
      const n = (statSync(candidate).size - 32) / frameSize;
      const pages = new Set<number>();
      const frame = Buffer.alloc(24);
      let last = 0;
      for (let i = 0; i < n; i++) {
        readSync(walFd, frame, 0, 24, 32 + i * frameSize);
        pages.add(frame.readUInt32BE(0));
        last = frame.readUInt32BE(4);
      }
      if (
        !Number.isInteger(n) ||
        last < 1 ||
        pages.size !== last ||
        !pages.has(1) ||
        !pages.has(last) ||
        [...pages].some((page) => page < 1 || page > last)
      ) {
        // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
        throw new Error('SQLite did not produce a complete repair WAL');
      }
    } finally {
      closeSync(walFd);
    }
  } finally {
    snap.close();
  }
}

/** Atomically replace the old WAL with the validated complete database image. */
export function commitRepairImage(candidate: string, target: string): void {
  if (process.platform !== 'win32') repairFsync(dirname(candidate));
  renameSync(candidate, `${target}-wal`);
}

/** Restore only a disposable damaged view's header so intact b-trees remain readable. */
export function repairSalvageHeader(view: string, staged: string): string | null {
  const header = Buffer.alloc(100);
  const fd = openSync(view, 'r');
  try {
    readSync(fd, header, 0, 100, 0);
  } finally {
    closeSync(fd);
  }
  const rawSize = header.readUInt16BE(16);
  const size = rawSize === 1 ? 65536 : rawSize;
  if (
    header.subarray(0, 16).toString('binary') === 'SQLite format 3\0' &&
    size >= 512 &&
    size <= 65536 &&
    (size & (size - 1)) === 0
  )
    return null;
  const baseline = Buffer.alloc(100);
  const base = openSync(staged, 'r');
  try {
    readSync(base, baseline, 0, 100, 0);
  } finally {
    closeSync(base);
  }
  let pageSize = baseline.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  if (existsSync(`${view}-wal`)) {
    const wal = openSync(`${view}-wal`, 'r');
    const bytes = Buffer.alloc(12);
    try {
      readSync(wal, bytes, 0, 12, 0);
    } finally {
      closeSync(wal);
    }
    const n = bytes.readUInt32BE(8);
    if (
      (bytes.readUInt32BE(0) & 0xfffffffe) === 0x377f0682 &&
      n >= 512 &&
      n <= 65536 &&
      (n & (n - 1)) === 0
    )
      pageSize = n;
  }
  baseline.writeUInt16BE(pageSize === 65536 ? 1 : pageSize, 16);
  baseline.writeUInt32BE(Math.floor(statSync(view).size / pageSize), 28);
  baseline.fill(0, 32, 40); // A reconstructed header must never follow a snapshot's freelist.
  const recovered = `${view}.header-recovered`;
  copyRepairOriginals(view, recovered);
  const out = openSync(recovered, 'r+');
  try {
    writeSync(out, baseline, 0, baseline.length, 0);
  } finally {
    closeSync(out);
  }
  return recovered;
}
